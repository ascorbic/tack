import { type CSSProperties, useMemo } from "react";
import type { Card } from "../../shared/cards.ts";
import { mentionsMe, parseSearch } from "../../shared/search.ts";
import {
	type StaleConfig,
	type StaleGroup,
	quietText,
	spanText,
	staleGroups,
} from "../../shared/stale.ts";
import {
	Count,
	PersonalChip,
	QueryErrorEmpty,
	SkeletonRows,
	WidgetEmpty,
	WidgetFoot,
	useNow,
} from "./chrome.tsx";
import { queryChips } from "./describe.ts";
import type { RowProps, SearchStatus } from "./host.tsx";
import {
	CheckIcon,
	NotPlannedIcon,
	PingIcon,
	RefreshIcon,
	SettingsIcon,
	StaleIcon,
	TagIcon,
	UndoIcon,
} from "./icons.tsx";
import "./kinds.css";
import { ItemRow, RowLabels, useRowMotion } from "./rows.tsx";

// The stale finder (#43), drawn without the board around it: items with no
// activity for a while, grouped by how long they've been quiet, each with
// quick actions on hover that stage what to do (close as not planned, add a
// label, ping in a comment). What's staged shows on the row, with undo.
// Zoomed out: how many have gone quiet, and for how long, as bars.

export type StaleAction = "close" | "label" | "ping";

/** Something staged on an item, as its row shows it. */
export interface StagedMark {
	id: string;
	action: StaleAction;
	/** What it'll say: a ping's comment, shown before anything's pushed. */
	detail?: string;
}

export interface StaleViewProps extends RowProps {
	title: string;
	config: StaleConfig;
	status: SearchStatus;
	selected?: boolean;
	enter?: boolean;
	refreshing?: boolean;
	compact?: boolean;
	now?: number;
	/** What's staged for each item, by key. */
	staged?: ReadonlyMap<string, readonly StagedMark[]>;
	/** Whether an action can be staged on an item (the forge supports it, and you can edit). */
	canAct?: (card: Card, action: StaleAction) => boolean;
	onAction?: (action: StaleAction, cards: Card[]) => void;
	onUnstage?: (id: string) => void;
	/** Ready-made searches to offer while it isn't set up. */
	presets?: { label: string; q: string }[];
	onPreset?: (q: string) => void;
	onRefresh?: () => void;
	onConfigure?: () => void;
}

const STAGED_TEXT: Record<StaleAction, string> = {
	close: "Closing",
	label: "Labelling",
	ping: "Pinging",
};

export function StaleView(props: StaleViewProps) {
	const { status, title, config, selected, enter, refreshing, compact, readOnly } = props;
	const now = useNow(props.now);
	const result = status.kind === "ready" ? status.results.items : undefined;
	const groups = useMemo(
		() => (result ? staleGroups(result.items, now, config.days) : null),
		[result, now, config.days],
	);
	const count = groups?.reduce((n, group) => n + group.items.length, 0) ?? 0;
	const chips = useMemo(() => queryChips(parseSearch(config.q)), [config.q]);
	const stale = status.kind === "ready" && status.stale;
	return (
		<section
			className="widget widget-stale"
			data-kind="stale"
			data-selected={selected || undefined}
			data-enter={enter || undefined}
			data-status={status.kind}
			data-stale={stale || undefined}
			data-compact={compact || undefined}
			aria-label={title}
		>
			<header className="widget-head widget-handle">
				<span className="widget-kind" aria-hidden="true">
					<StaleIcon />
				</span>
				<div className="widget-heading">
					<h3 className="widget-title" title={title}>
						{title}
					</h3>
					{chips.length > 0 && (
						<p className="widget-query" title={config.q}>
							{mentionsMe(config.q) && <PersonalChip />}
							{config.title.trim() && (
								<span className="widget-chip mono stale-threshold">{spanText(config.days)}+</span>
							)}
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
				{result && <Count value={result.total} one="item" many="items" />}
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
							aria-label="Edit stale finder"
							data-tooltip="Edit finder"
							data-config-toggle
							onClick={props.onConfigure}
						>
							<SettingsIcon />
						</button>
					)}
				</div>
			</header>
			<div className="widget-main">
				{compact && groups ? (
					<FarGroups groups={groups} count={count} />
				) : (
					<div className="widget-body nowheel">
						<Body {...props} now={now} groups={groups} count={count} />
					</div>
				)}
			</div>
			{status.kind === "ready" && result && !compact && (
				<WidgetFoot
					at={status.at}
					stale={status.stale}
					refreshing={refreshing}
					now={now}
					onRefresh={props.onRefresh}
				>
					{result.total > result.items.length
						? `quietest ${result.items.length} of ${result.total}`
						: `${count} quiet`}
				</WidgetFoot>
			)}
		</section>
	);
}

function Body(props: StaleViewProps & { now: number; groups: StaleGroup[] | null; count: number }) {
	const { status, groups, config } = props;
	switch (status.kind) {
		case "unconfigured":
			return (
				<WidgetEmpty
					icon={<StaleIcon size={20} />}
					title="What should it look through?"
					detail={`Anything that's had no activity for ${spanText(config.days)} shows up here, quietest first.`}
				>
					{props.presets && props.presets.length > 0 && !props.readOnly && (
						<div className="widget-presets nodrag nopan">
							{props.presets.map((preset) => (
								<button
									key={preset.label}
									type="button"
									className="widget-preset"
									onClick={() => props.onPreset?.(preset.q)}
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
			return <SkeletonRows widths={[0.7, 0.85, 0.6, 0.76, 0.54]} />;
		case "error":
			return (
				<QueryErrorEmpty
					what="this search"
					error={status.error}
					noun="this finder"
					editLabel="Edit the search"
					readOnly={props.readOnly}
					now={props.now}
					onConfigure={props.onConfigure}
					onRefresh={props.onRefresh}
				/>
			);
		case "ready":
			if (!groups || props.count === 0) {
				return (
					<div className="stale-clear">
						<WidgetEmpty
							icon={<CheckIcon size={22} />}
							title="Nothing's gone quiet"
							detail={`Everything here has had activity in the last ${spanText(config.days)}.`}
						/>
					</div>
				);
			}
			return (
				<div className="stale-groups">
					{groups.map((group, i) => (
						<Group key={group.id} {...props} group={group} order={i} />
					))}
				</div>
			);
	}
}

function Group(props: StaleViewProps & { group: StaleGroup; count: number; order: number }) {
	const { group, count } = props;
	const cards = useMemo(() => group.items.map((item) => item.card), [group.items]);
	const idle = new Map(group.items.map((item) => [item.card.key, item.idle]));
	const shown = useRowMotion(cards);
	const closable = cards.filter(
		(card) =>
			(props.canAct?.(card, "close") ?? false) &&
			!props.staged?.get(card.key)?.some((mark) => mark.action === "close"),
	);
	let entering = 0;
	return (
		<div
			role="group"
			className="stale-group"
			data-group={group.id}
			data-empty={group.items.length === 0 || undefined}
			aria-label={group.label}
			style={
				{ "--share": count ? group.items.length / count : 0, "--g": props.order } as CSSProperties
			}
		>
			<header className="stale-group-head">
				<span className="stale-group-bar" aria-hidden="true">
					<span />
				</span>
				<h4 className="stale-group-title">{group.label}</h4>
				<span className="stale-group-count">{group.items.length || "none"}</span>
				{closable.length > 1 && props.onAction && !props.readOnly && (
					<button
						type="button"
						className="stale-group-action nodrag nopan"
						onClick={() => props.onAction?.("close", closable)}
					>
						<NotPlannedIcon size={12} />
						Close all {closable.length}
					</button>
				)}
			</header>
			{group.items.length > 0 && (
				<ul className="widget-rows" aria-label={group.label}>
					{shown.map(({ card, motion }) => (
						<StaleRow
							key={motion === "leave" ? `leave:${card.key}` : card.key}
							{...props}
							card={card}
							idle={idle.get(card.key) ?? 0}
							motion={motion}
							order={motion === "enter" ? entering++ : 0}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function StaleRow(
	props: StaleViewProps & {
		card: Card;
		idle: number;
		motion?: ReturnType<typeof useRowMotion>[number]["motion"];
		order: number;
	},
) {
	const { card, staged, config } = props;
	const marks = staged?.get(card.key) ?? [];
	const has = (action: StaleAction) => marks.some((mark) => mark.action === action);
	const can = (action: StaleAction) =>
		!props.readOnly && !has(action) && (props.canAct?.(card, action) ?? false);
	const hasLabel = card.labels.some((l) => l.name.toLowerCase() === config.label.toLowerCase());
	const actions = [
		can("close") && (
			<button
				key="close"
				type="button"
				className="stale-act"
				data-action="close"
				aria-label={`Close ${card.item} as not planned`}
				data-tooltip="Close as not planned"
				onClick={() => props.onAction?.("close", [card])}
			>
				<NotPlannedIcon />
			</button>
		),
		can("label") && config.label.trim() && !hasLabel && (
			<button
				key="label"
				type="button"
				className="stale-act"
				data-action="label"
				aria-label={`Label ${card.item} ${config.label}`}
				data-tooltip={`Label “${config.label}”`}
				onClick={() => props.onAction?.("label", [card])}
			>
				<TagIcon />
			</button>
		),
		can("ping") && (
			<button
				key="ping"
				type="button"
				className="stale-act"
				data-action="ping"
				aria-label={`Ask on ${card.item} if it's still wanted`}
				data-tooltip="Ask if it's still wanted"
				onClick={() => props.onAction?.("ping", [card])}
			>
				<PingIcon />
			</button>
		),
	].filter(Boolean);
	return (
		<ItemRow
			card={card}
			motion={props.motion}
			order={props.order}
			rows={props}
			className="stale-row"
			data={{ staged: marks.length > 0, closing: has("close") }}
			meta={
				<>
					{marks.map((mark) => (
						<span
							key={mark.id}
							className="stale-staged"
							data-action={mark.action}
							title={mark.detail ? `Will comment, as you: “${mark.detail}”` : undefined}
						>
							{STAGED_TEXT[mark.action]}
							{props.onUnstage && !props.readOnly && (
								<button
									type="button"
									className="stale-unstage"
									aria-label={`Unstage: ${STAGED_TEXT[mark.action].toLowerCase()} ${card.item}`}
									onPointerDown={(event) => event.stopPropagation()}
									onClick={() => props.onUnstage?.(mark.id)}
								>
									<UndoIcon />
								</button>
							)}
						</span>
					))}
					<span className="stale-idle">quiet {quietText(props.idle)}</span>
					{marks.length === 0 && <RowLabels card={card} />}
				</>
			}
			actions={actions.length > 0 ? actions : undefined}
		/>
	);
}

/** Zoomed out: how much has gone quiet, and how quiet, as bars. */
function FarGroups({ groups, count }: { groups: StaleGroup[]; count: number }) {
	const most = Math.max(1, ...groups.map((g) => g.items.length));
	return (
		<div className="kind-far stale-far" data-tone={count === 0 ? "clear" : undefined}>
			<span className="kind-far-number">{count}</span>
			<span className="kind-far-label">gone quiet</span>
			<div className="stale-far-bars">
				{groups.map((group) => (
					<span
						key={group.id}
						className="stale-far-bar"
						data-group={group.id}
						style={{ "--share": group.items.length / most } as CSSProperties}
					>
						<span className="stale-far-fill" />
						<span className="stale-far-text">
							{group.items.length} · {group.label}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}
