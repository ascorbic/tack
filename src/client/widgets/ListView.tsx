import {
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useId,
	useMemo,
	useState,
} from "react";
import type { Card } from "../../shared/cards.ts";
import type { MatchStep } from "../../shared/search.ts";
import { mightMiss } from "../../shared/queryHelp.ts";
import { mentionsMe, parseSearch } from "../../shared/search.ts";
import type { QueryError, SearchResult } from "../../shared/widgets.ts";
import { StateIcon } from "../CardView.tsx";
import {
	Count,
	PersonalChip,
	QueryErrorEmpty,
	SkeletonRows,
	WidgetEmpty,
	WidgetFoot,
	copyText,
	useNow,
} from "./chrome.tsx";
import { type Motion, rowActivation, useRowMotion } from "./rows.tsx";
import { queryChips } from "./describe.ts";
import {
	DropIcon,
	ExternalIcon,
	ListIcon,
	PinIcon,
	RefreshIcon,
	SearchIcon,
	SettingsIcon,
	StepIcon,
	WarnIcon,
} from "./icons.tsx";

// The list widget (#38), drawn without the board around it, so the gallery
// can show every state: not set up, loading, rows (live, stale, refreshing),
// nothing matching, every kind of error, and cards hovering to be dropped.

export type ListStatus =
	| { kind: "unconfigured" }
	| { kind: "loading" }
	| { kind: "ready"; result: SearchResult; at: number; stale: boolean }
	| { kind: "error"; error: QueryError };

/** What dropping the cards being dragged over the list would do. */
export type DropPreview =
	| { status: "changes"; steps: Pick<MatchStep, "kind" | "label">[]; cards: number }
	| { status: "matches"; cards: number }
	| { status: "impossible"; reason: string };

export interface ListViewProps {
	title: string;
	q: string;
	/** The forge it searches, for "Open on GitHub". */
	host?: string;
	status: ListStatus;
	selected?: boolean;
	readOnly?: boolean;
	/** Animate in, for a widget that was just added. */
	enter?: boolean;
	refreshing?: boolean;
	/** Whether an item already has a card on the board. */
	onBoard?: (key: string) => boolean;
	/** The item someone's pointing at on the board, whose row lights up. */
	linked?: string | null;
	/** Cards being dragged over the list. */
	drop?: DropPreview | null;
	/** A row being dragged out, which shows where it came from. */
	lifted?: string | null;
	/** For the gallery: a fixed "now". */
	now?: number;
	/** Ready-made searches to offer while it's not set up. */
	presets?: { label: string; q: string; title: string }[];
	onPreset?: (preset: { q: string; title: string }) => void;
	onRefresh?: () => void;
	onConfigure?: () => void;
	onRowHover?: (key: string | null) => void;
	onRowPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	/** Show the item's card on the board. */
	onReveal?: (key: string) => void;
	/** A row clicked, or Enter: its card shown, or added beside the list. */
	onRowActivate?: (card: Card) => void;
	/** Extra UI in the header, e.g. the config panel. */
	children?: ReactNode;
}

export function ListView(props: ListViewProps) {
	const { status, title, q, selected, enter, refreshing, readOnly, drop } = props;
	const chips = useMemo(() => queryChips(parseSearch(q)), [q]);
	const queryId = useId();
	const result = status.kind === "ready" ? status.result : null;
	const total = result?.total ?? null;
	const stale = status.kind === "ready" && status.stale;

	return (
		<section
			className="widget widget-list"
			data-selected={selected || undefined}
			data-enter={enter || undefined}
			data-status={status.kind}
			data-stale={stale || undefined}
			data-drop={drop?.status}
			aria-label={title}
		>
			<header className="widget-head widget-handle">
				<span className="widget-kind" aria-hidden="true">
					<ListIcon />
				</span>
				<div className="widget-heading">
					<h3 className="widget-title" title={title}>
						{title}
					</h3>
					{chips.length > 0 && (
						<div className="widget-query-wrap">
							<p className="widget-query" tabIndex={0} aria-describedby={queryId}>
								{mentionsMe(q) && <PersonalChip />}
								{chips.map((chip, i) => (
									<span
										key={`${i}:${chip.text}`}
										className="widget-chip mono"
										data-tone={chip.tone}
										data-negated={chip.negated || undefined}
									>
										{chip.text}
									</span>
								))}
							</p>
							<QueryPeek id={queryId} q={q} host={props.host} />
						</div>
					)}
				</div>
				{total !== null && <Count value={total} />}
				<div className="widget-tools nodrag nopan">
					{status.kind !== "unconfigured" && props.onRefresh && (
						<button
							type="button"
							className="widget-tool"
							aria-label="Refresh"
							data-tooltip="Refresh"
							data-spinning={refreshing || undefined}
							onClick={props.onRefresh}
						>
							<RefreshIcon />
						</button>
					)}
					{!readOnly && props.onConfigure && (
						<button
							type="button"
							className="widget-tool"
							aria-label="Edit list"
							data-tooltip="Edit list"
							data-config-toggle
							onClick={props.onConfigure}
						>
							<SettingsIcon />
						</button>
					)}
				</div>
				{props.children}
			</header>
			<div className="widget-main">
				<div className="widget-body nowheel">
					<Body {...props} />
				</div>
				{drop && <DropOverlay drop={drop} />}
			</div>
			<Footer status={status} refreshing={refreshing} now={props.now} onRefresh={props.onRefresh} />
		</section>
	);
}

function Body(props: ListViewProps) {
	const { status } = props;
	switch (status.kind) {
		case "unconfigured":
			return (
				<WidgetEmpty
					icon={<SearchIcon size={20} />}
					title="What should this list show?"
					detail="Any search, kept live. Pick one to start, or write your own."
				>
					{props.presets && props.presets.length > 0 && (
						<div className="widget-presets nodrag nopan">
							{props.presets.map((preset) => (
								<button
									key={preset.label}
									type="button"
									className="widget-preset"
									disabled={props.readOnly}
									onClick={() => props.onPreset?.(preset)}
								>
									{preset.label}
								</button>
							))}
						</div>
					)}
					{!props.readOnly && props.onConfigure && (
						<button type="button" className="widget-action" onClick={props.onConfigure}>
							Write a search
						</button>
					)}
				</WidgetEmpty>
			);
		case "loading":
			return <SkeletonRows />;
		case "error":
			return (
				<QueryErrorEmpty
					error={status.error}
					noun="this list"
					what="this search"
					editLabel="Edit the search"
					readOnly={props.readOnly}
					now={props.now}
					onConfigure={props.onConfigure}
					onRefresh={props.onRefresh}
				/>
			);
		case "ready":
			if (status.result.items.length === 0 && mightMiss(props.q)) {
				// Words, or everywhere: more likely a search that says something
				// other than was meant than one whose matches haven't happened yet.
				return (
					<WidgetEmpty
						icon={<SearchIcon size={20} />}
						title="Nothing matches this search"
						detail={
							searchesWords(props.q)
								? "It looks for those words in titles and descriptions. Check it says what you mean."
								: "It searches everywhere you can see. Check it says what you mean."
						}
					>
						{!props.readOnly && props.onConfigure && (
							<button type="button" className="widget-action" onClick={props.onConfigure}>
								Check the search
							</button>
						)}
					</WidgetEmpty>
				);
			}
			if (status.result.items.length === 0) {
				return (
					<WidgetEmpty
						icon={<span className="widget-empty-mark" aria-hidden="true" />}
						title="Nothing matches, yet"
						detail={
							props.readOnly
								? "New matches show up here as they happen."
								: "New matches show up here as they happen. Drop a card here to make it match."
						}
					/>
				);
			}
			return <Rows {...props} rows={status.result.items} stale={status.stale} />;
	}
}

function Rows(props: ListViewProps & { rows: Card[]; stale: boolean }) {
	const shown = useRowMotion(props.rows);
	let entering = 0;
	return (
		<ul className="widget-rows" aria-label="Matches">
			{shown.map(({ card, motion }) => (
				<Row
					key={motion === "leave" ? `leave:${card.key}` : card.key}
					card={card}
					motion={motion}
					order={motion === "enter" ? entering++ : 0}
					onBoard={props.onBoard?.(card.key) ?? false}
					linked={props.linked === card.key}
					lifted={props.lifted === card.key}
					readOnly={props.readOnly}
					onHover={props.onRowHover}
					onPointerDown={props.onRowPointerDown}
					onReveal={props.onReveal}
					onActivate={props.onRowActivate}
				/>
			))}
		</ul>
	);
}

function Row({
	card,
	motion,
	order,
	onBoard,
	linked,
	lifted,
	readOnly,
	onHover,
	onPointerDown,
	onReveal,
	onActivate,
}: {
	card: Card;
	motion?: Motion;
	order: number;
	onBoard: boolean;
	linked: boolean;
	lifted: boolean;
	readOnly?: boolean;
	onHover?: (key: string | null) => void;
	onPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onReveal?: (key: string) => void;
	onActivate?: (card: Card) => void;
}) {
	const repo = card.repo.split("/").at(-1);
	const activation = rowActivation(card, onBoard, { readOnly, onRowActivate: onActivate });
	return (
		<li
			className="widget-row nodrag nopan"
			data-state={card.state}
			data-motion={motion}
			data-linked={linked || undefined}
			data-on-board={onBoard || undefined}
			data-lifted={lifted || undefined}
			data-draggable={!readOnly || undefined}
			style={{ "--i": Math.min(order, 10) } as React.CSSProperties}
			onPointerEnter={() => onHover?.(card.key)}
			onPointerLeave={() => onHover?.(null)}
			onPointerDown={(event) => onPointerDown?.(event, card)}
			{...activation.row}
		>
			<span className="state-icon" aria-hidden="true">
				<StateIcon card={card} size={14} />
			</span>
			<span className="widget-row-main" {...activation.handle}>
				<span className="widget-row-title">{card.title}</span>
				<span className="widget-row-meta">
					<span className="mono">
						{repo} {card.item}
					</span>
					{card.labels.slice(0, 3).map((label) => (
						<span
							key={label.name}
							className="chip label widget-row-label"
							style={{ "--label": `#${label.color}` } as React.CSSProperties}
						>
							{label.name}
						</span>
					))}
					{card.labels.length > 3 && (
						<span className="widget-row-more">+{card.labels.length - 3}</span>
					)}
				</span>
			</span>
			<span className="widget-row-side">
				{card.assignees.length > 0 && (
					<span className="avatars widget-row-avatars">
						{card.assignees.slice(0, 2).map((a) => (
							<img
								key={a.login}
								src={a.avatarUrl}
								alt={a.login}
								title={a.login}
								draggable={false}
							/>
						))}
					</span>
				)}
				{onBoard ? (
					<button
						type="button"
						className="widget-row-marker"
						aria-label={`${card.item} is on the board: show it`}
						data-tooltip="On the board"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => onReveal?.(card.key)}
					>
						<PinIcon />
					</button>
				) : (
					<a
						className="widget-row-open"
						href={card.url}
						target="_blank"
						rel="noreferrer"
						draggable={false}
						aria-label={`Open ${card.item}`}
						onPointerDown={(event) => event.stopPropagation()}
					>
						<ExternalIcon />
					</a>
				)}
			</span>
		</li>
	);
}

function DropOverlay({ drop }: { drop: DropPreview }) {
	const many = drop.status !== "impossible" && drop.cards > 1;
	return (
		<div className="widget-drop" data-status={drop.status} aria-live="polite">
			<span className="widget-drop-icon">
				{drop.status === "impossible" ? <WarnIcon size={20} /> : <DropIcon size={20} />}
			</span>
			{drop.status === "changes" && (
				<>
					<p className="widget-drop-title">
						Drop to make {many ? `${drop.cards} cards` : "it"} match
					</p>
					<ul className="widget-steps" aria-label="Changes it would stage">
						{drop.steps.map((step, i) => (
							<li
								key={`${step.kind}:${step.label}`}
								className="widget-step"
								data-kind={step.kind}
								style={{ "--i": i } as React.CSSProperties}
							>
								<StepIcon kind={step.kind} />
								{stepText(step)}
							</li>
						))}
					</ul>
				</>
			)}
			{drop.status === "matches" && (
				<p className="widget-drop-title">{many ? "They already match" : "Already matches"}</p>
			)}
			{drop.status === "impossible" && (
				<>
					<p className="widget-drop-title">Can't make it match</p>
					<p className="widget-drop-detail">{drop.reason}</p>
				</>
			)}
		</div>
	);
}

function searchesWords(q: string): boolean {
	return parseSearch(q).terms.some((term) => term.key === null && !term.negated);
}

/** A step as a short phrase: “Add bug”, “Assign @kai”. */
export function stepText(step: Pick<MatchStep, "kind" | "label">): string {
	switch (step.kind) {
		case "add-label":
			return `Add ${step.label}`;
		case "remove-label":
			return `Remove ${step.label}`;
		case "assign":
			return `Assign ${step.label}`;
		case "unassign":
			return `Unassign ${step.label}`;
		case "milestone":
			return step.label === "No milestone" ? "Clear the milestone" : `Milestone ${step.label}`;
		default:
			return step.label;
	}
}

function Footer({
	status,
	refreshing,
	now: fixedNow,
	onRefresh,
}: {
	status: ListStatus;
	refreshing?: boolean;
	now?: number;
	onRefresh?: () => void;
}) {
	// Keep "2 min ago" current.
	const now = useNow(fixedNow);
	if (status.kind !== "ready") return null;
	const { result, at, stale } = status;
	const shown = result.items.length;
	return (
		<WidgetFoot at={at} stale={stale} refreshing={refreshing} now={now} onRefresh={onRefresh}>
			{result.incomplete ? "Some results missing · " : ""}
			{result.total > shown
				? `${shown} of ${result.total}`
				: `${shown} ${shown === 1 ? "match" : "matches"}`}
		</WidgetFoot>
	);
}

/**
 * The whole search, for when the header's chips are cut off: on hover or
 * focus, with Copy and, on GitHub, a way to run it there. Useful to viewers,
 * who can't open the settings.
 */
function QueryPeek({ id, q, host }: { id: string; q: string; host?: string }) {
	const [copied, setCopied] = useState(false);
	const url =
		host === undefined || host === "github.com"
			? `https://github.com/issues?q=${encodeURIComponent(q)}`
			: null;
	return (
		<div className="widget-query-peek nodrag nopan" id={id} role="tooltip">
			<p className="mono">{q}</p>
			<span className="widget-query-peek-actions">
				<button
					type="button"
					onClick={async () => {
						setCopied(await copyText(q));
						setTimeout(() => setCopied(false), 1400);
					}}
				>
					{copied ? "Copied" : "Copy"}
				</button>
				{url && (
					<a href={url} target="_blank" rel="noreferrer">
						Open on GitHub
					</a>
				)}
			</span>
		</div>
	);
}
