import {
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Card } from "../../shared/cards.ts";
import type { MatchStep } from "../../shared/search.ts";
import { parseSearch } from "../../shared/search.ts";
import type { QueryError, SearchResult } from "../../shared/widgets.ts";
import { StateIcon } from "../CardView.tsx";
import { scaledDuration } from "../motion.ts";
import { ago, clock, queryChips } from "./describe.ts";
import {
	ClockIcon,
	DropIcon,
	ExternalIcon,
	ListIcon,
	LockIcon,
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
	/** Extra UI in the header, e.g. the config panel. */
	children?: ReactNode;
}

export function ListView(props: ListViewProps) {
	const { status, title, q, selected, enter, refreshing, readOnly, drop } = props;
	const chips = useMemo(() => queryChips(parseSearch(q)), [q]);
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
						<p className="widget-query" title={q}>
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

/** The total, which ticks when it changes. */
function Count({ value }: { value: number }) {
	const previous = useRef(value);
	const [bump, setBump] = useState(0);
	useEffect(() => {
		if (previous.current !== value) setBump((n) => n + 1);
		previous.current = value;
	}, [value]);
	return (
		<span
			key={bump}
			className="widget-count"
			data-pop={bump > 0 || undefined}
			title={`${value} ${value === 1 ? "match" : "matches"}`}
		>
			{value > 999 ? `${Math.round(value / 100) / 10}k` : value}
		</span>
	);
}

function Body(props: ListViewProps) {
	const { status } = props;
	switch (status.kind) {
		case "unconfigured":
			return (
				<Empty
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
				</Empty>
			);
		case "loading":
			return (
				<ul className="widget-rows" aria-busy="true" aria-label="Loading">
					{[0.82, 0.64, 0.9, 0.55, 0.74, 0.6].map((width, i) => (
						<li
							key={i}
							className="widget-row widget-row-skeleton"
							style={{ "--i": i } as React.CSSProperties}
						>
							<span className="skeleton widget-skeleton-dot" />
							<span className="widget-row-main">
								<span className="skeleton" style={{ width: `${width * 100}%` }} />
								<span className="skeleton short" />
							</span>
						</li>
					))}
				</ul>
			);
		case "error":
			return <ErrorBody error={status.error} {...props} />;
		case "ready":
			if (status.result.items.length === 0) {
				return (
					<Empty
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

function ErrorBody({ error, ...props }: ListViewProps & { error: QueryError }) {
	const now = props.now ?? Date.now();
	switch (error.reason) {
		case "signed_out":
			return (
				<Empty
					icon={<LockIcon size={20} />}
					title="Sign in to see this list"
					detail={error.message}
				>
					<a
						className="widget-action"
						href={`/auth/signin?return_to=${encodeURIComponent(location.pathname)}`}
					>
						Sign in with GitHub
					</a>
				</Empty>
			);
		case "rate_limited":
			return (
				<Empty
					icon={<ClockIcon size={20} />}
					title="GitHub needs a breather"
					detail={
						error.retryAt && error.retryAt > now
							? `Too many searches for now. Trying again at ${clock(error.retryAt)}.`
							: "Too many searches for now. Trying again shortly."
					}
					tone="wait"
				/>
			);
		case "invalid":
			return (
				<Empty
					icon={<SearchIcon size={20} />}
					title="GitHub couldn't read this search"
					detail={error.message}
					tone="warn"
				>
					{!props.readOnly && props.onConfigure && (
						<button type="button" className="widget-action" onClick={props.onConfigure}>
							Edit the search
						</button>
					)}
				</Empty>
			);
		case "no_access":
			return (
				<Empty
					icon={<LockIcon size={20} />}
					title="Tack can't search this for you"
					detail={error.message}
					tone="warn"
				/>
			);
		case "unsupported":
			return (
				<Empty
					icon={<WarnIcon size={20} />}
					title="This forge can't be searched"
					detail={error.message}
					tone="warn"
				/>
			);
		default:
			return (
				<Empty
					icon={<WarnIcon size={20} />}
					title="Couldn't load this list"
					detail={error.message}
					tone="warn"
				>
					{props.onRefresh && (
						<button type="button" className="widget-action" onClick={props.onRefresh}>
							Try again
						</button>
					)}
				</Empty>
			);
	}
}

function Empty({
	icon,
	title,
	detail,
	tone,
	children,
}: {
	icon: ReactNode;
	title: string;
	detail?: string;
	tone?: "warn" | "wait";
	children?: ReactNode;
}) {
	return (
		<div className="widget-empty" data-tone={tone}>
			<span className="widget-empty-icon">{icon}</span>
			<p className="widget-empty-title">{title}</p>
			{detail && <p className="widget-empty-detail">{detail}</p>}
			{children}
		</div>
	);
}

type Motion = "enter" | "leave" | "changed";

/** What a row shows, to tell when it changed. */
function signature(card: Card): string {
	return JSON.stringify([
		card.title,
		card.state,
		card.labels.map((l) => l.name),
		card.assignees.map((a) => a.login),
		card.pull?.checks?.state,
	]);
}

/**
 * Rows as they come and go: new ones slide in (a cascade, on first load),
 * ones that stopped matching fold away where they were, and changed ones
 * flash.
 */
function useRowMotion(rows: Card[]): { card: Card; motion?: Motion }[] {
	const [shown, setShown] = useState<{ card: Card; motion?: Motion }[]>(() =>
		rows.map((card) => ({ card })),
	);
	const previous = useRef(rows);
	useEffect(() => {
		const before = previous.current;
		previous.current = rows;
		if (before === rows) return;
		const old = new Map(before.map((card) => [card.key, card]));
		const keys = new Set(rows.map((card) => card.key));
		const next: { card: Card; motion?: Motion }[] = rows.map((card) => {
			const was = old.get(card.key);
			return {
				card,
				motion: !was ? "enter" : signature(was) !== signature(card) ? "changed" : undefined,
			};
		});
		before.forEach((card, i) => {
			if (!keys.has(card.key)) next.splice(Math.min(i, next.length), 0, { card, motion: "leave" });
		});
		setShown(next);
		const settle = setTimeout(
			() =>
				setShown((current) =>
					current.filter((row) => row.motion !== "leave").map(({ card }) => ({ card })),
				),
			scaledDuration(900),
		);
		return () => clearTimeout(settle);
	}, [rows]);
	return shown;
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
}) {
	const repo = card.repo.split("/").at(-1);
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
			title={readOnly ? undefined : "Drag onto the board to add a card"}
		>
			<span className="state-icon" aria-hidden="true">
				<StateIcon card={card} size={14} />
			</span>
			<span className="widget-row-main">
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
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (fixedNow !== undefined) return;
		const timer = setInterval(() => setTick((n) => n + 1), 30_000);
		return () => clearInterval(timer);
	}, [fixedNow]);
	void tick;
	if (status.kind !== "ready") return null;
	const now = fixedNow ?? Date.now();
	const { result, at, stale } = status;
	const shown = result.items.length;
	return (
		<footer className="widget-foot" data-stale={stale || undefined}>
			<span className="widget-live" data-live={(!stale && !refreshing) || undefined}>
				<span className="widget-live-dot" aria-hidden="true" />
				{refreshing
					? "Refreshing…"
					: stale
						? `Updated ${ago(at, now)} · couldn't refresh`
						: `Updated ${ago(at, now)}`}
			</span>
			{stale && onRefresh && !refreshing && (
				<button type="button" className="widget-foot-retry nodrag nopan" onClick={onRefresh}>
					Retry
				</button>
			)}
			<span className="widget-foot-count">
				{result.incomplete ? "Some results missing · " : ""}
				{result.total > shown
					? `${shown} of ${result.total}`
					: `${shown} ${shown === 1 ? "match" : "matches"}`}
			</span>
		</footer>
	);
}
