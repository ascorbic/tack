import {
	type PointerEvent as ReactPointerEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { Card } from "../../shared/cards.ts";
import { mentionsMe } from "../../shared/search.ts";
import {
	type TimelineConfig,
	type TimelineMark,
	eventTime,
	eventWord,
	layoutTimeline,
	timelineDensity,
	rangeText,
	timelineRange,
} from "../../shared/timeline.ts";
import type { SearchResult } from "../../shared/widgets.ts";
import { StateIcon } from "../CardView.tsx";
import {
	QueryErrorEmpty,
	WidgetEmpty,
	WidgetFoot,
	WidgetShell,
	type WidgetState,
	useNow,
	useSize,
} from "./chrome.tsx";
import { safeUrl } from "../changes/inline.ts";
import { ago } from "./describe.ts";
import { TimelineIcon, ZoomOutIcon } from "./kindIcons.tsx";
import "./timeline.css";

// The timeline widget (#43), drawn without the board around it so the
// gallery can show every state. Items sit on a horizontal time axis as
// dots coloured by state, stacked where they're close and gathered into a
// counted cluster where they're crowded; clicking a cluster zooms into its
// span. A legend says what the shapes and colours mean. Hovering an item
// shows what it is; clicking it puts its card beside the widget (or shows
// the one on the board), ⌘-click opens it, and dragging it out makes a card.

/** Room kept on each side of the axis, so markers at the ends aren't cut off. */
const INSET = 22;
/** How tall each stacked lane is, and the axis below them. */
const LANE = 21;
const AXIS = 34;
/** Room above the lanes for the today label. */
const TOP = 30;

export interface TimelineViewProps {
	title: string;
	config: TimelineConfig;
	state: WidgetState<SearchResult>;
	/** For the gallery: a fixed “now”. */
	now?: number;
	selected?: boolean;
	readOnly?: boolean;
	enter?: boolean;
	refreshing?: boolean;
	/** The item someone's pointing at on the board. */
	linked?: string | null;
	/** An item being dragged out. */
	lifted?: string | null;
	onBoard?: (key: string) => boolean;
	onRefresh?: () => void;
	onConfigure?: () => void;
	onItemPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onItemHover?: (key: string | null) => void;
	onReveal?: (key: string) => void;
	/** An item clicked: its card shown, or added beside the widget. */
	onItemActivate?: (card: Card) => void;
	/** Ready-made scopes while it's not set up. */
	suggestions?: { label: string; q: string }[];
	onSuggest?: (q: string) => void;
}

export function TimelineView(props: TimelineViewProps) {
	const { config, state } = props;
	const now = useNow(props.now, 60_000);
	const range = timelineRange(config, now);
	const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null);
	const domain = zoom ?? range;
	const items = state.kind === "ready" ? state.value.items : [];
	const dated = useMemo(
		() =>
			items.flatMap((card) => {
				const t = eventTime(card, config.event);
				return t === null ? [] : [{ card, t }];
			}),
		[items, config.event],
	);
	const shown = dated.filter(({ t }) => t >= range.from && t < range.to).length;
	const word = eventWord(config.event).toLowerCase();
	const subtitle = (
		<>
			<span className="timeline-range">{rangeText(range.from, range.to)}</span>
			{zoom && (
				<button
					type="button"
					className="timeline-unzoom nodrag nopan"
					onClick={() => setZoom(null)}
					title="Show the whole range"
				>
					<ZoomOutIcon size={12} />
					{rangeText(zoom.from, zoom.to)}
				</button>
			)}
		</>
	);
	return (
		<WidgetShell
			kind="timeline"
			icon={<TimelineIcon />}
			title={props.title}
			subtitle={config.q.trim() ? subtitle : undefined}
			personal={mentionsMe(config.q)}
			count={state.kind === "ready" ? shown : null}
			status={state.kind}
			stale={state.kind === "ready" && state.stale}
			selected={props.selected}
			enter={props.enter}
			readOnly={props.readOnly}
			refreshing={props.refreshing}
			onRefresh={props.onRefresh}
			onConfigure={props.onConfigure}
			configureLabel="Edit timeline"
			far={
				state.kind === "ready"
					? { value: String(shown), label: `${word} · ${rangeText(range.from, range.to)}` }
					: undefined
			}
			footer={
				state.kind === "ready" ? (
					<WidgetFoot
						at={state.at}
						stale={state.stale}
						refreshing={props.refreshing}
						now={props.now}
						onRefresh={props.onRefresh}
					>
						{state.value.total > state.value.items.length
							? `Latest ${state.value.items.length} of ${state.value.total}`
							: `${shown} ${word}`}
					</WidgetFoot>
				) : undefined
			}
		>
			<Body {...props} now={now} domain={domain} dated={dated} onZoom={setZoom} />
		</WidgetShell>
	);
}

function Body(
	props: TimelineViewProps & {
		now: number;
		domain: { from: number; to: number };
		dated: { card: Card; t: number }[];
		onZoom: (zoom: { from: number; to: number }) => void;
	},
) {
	const { state } = props;
	switch (state.kind) {
		case "unconfigured":
			return (
				<WidgetEmpty
					icon={<TimelineIcon size={20} />}
					title="What should this timeline follow?"
					detail="Pick a repository, then what to plot: opened, closed, merged or updated."
				>
					{props.suggestions && props.suggestions.length > 0 && (
						<div className="widget-presets nodrag nopan">
							{props.suggestions.map((suggestion) => (
								<button
									key={suggestion.q}
									type="button"
									className="widget-preset"
									disabled={props.readOnly}
									onClick={() => props.onSuggest?.(suggestion.q)}
								>
									{suggestion.label}
								</button>
							))}
						</div>
					)}
					{!props.readOnly && props.onConfigure && (
						<button type="button" className="widget-action" onClick={props.onConfigure}>
							Set it up
						</button>
					)}
				</WidgetEmpty>
			);
		case "error":
			return (
				<QueryErrorEmpty
					error={state.error}
					noun="this timeline"
					now={props.now}
					readOnly={props.readOnly}
					onRefresh={props.onRefresh}
					onConfigure={props.onConfigure}
				/>
			);
		default:
			return <Plot {...props} />;
	}
}

function Plot(
	props: TimelineViewProps & {
		now: number;
		domain: { from: number; to: number };
		dated: { card: Card; t: number }[];
		onZoom: (zoom: { from: number; to: number }) => void;
	},
) {
	const ref = useRef<HTMLDivElement>(null);
	const size = useSize(ref);
	const { domain, dated, state, config } = props;
	const width = Math.max(0, size.w - INSET * 2);
	const lanes = Math.max(1, Math.min(7, Math.floor((size.h - AXIS - TOP - 8) / LANE)));
	const cards = useMemo(() => new Map(dated.map(({ card }) => [card.key, card])), [dated]);
	const layout = useMemo(
		() =>
			layoutTimeline(
				dated.map(({ card, t }) => ({ key: card.key, t })),
				{ from: domain.from, to: domain.to, width, now: props.now, lanes, gap: 17 },
			),
		[dated, domain.from, domain.to, width, props.now, lanes],
	);
	const density = useMemo(
		() =>
			timelineDensity(
				dated.map(({ card, t }) => ({ key: card.key, t })),
				{ from: domain.from, to: domain.to, width },
			),
		[dated, domain.from, domain.to, width],
	);
	const [hover, setHover] = useState<TimelineMark | null>(null);
	const loading = state.kind === "loading";
	const empty = state.kind === "ready" && layout.marks.length === 0;
	// Markers come in from left to right, the first time.
	const order = useMemo(() => {
		const xs = layout.marks.map((mark) => mark.x).sort((a, b) => a - b);
		return (x: number) => Math.min(40, xs.indexOf(x));
	}, [layout.marks]);

	const peekCard = hover?.kind === "item" ? cards.get(hover.key) : undefined;
	return (
		<div
			ref={ref}
			className="timeline"
			data-loading={loading || undefined}
			style={
				{
					"--inset": `${INSET}px`,
					"--lane-step": `${LANE}px`,
					"--axis": `${AXIS}px`,
				} as React.CSSProperties
			}
			onPointerLeave={() => {
				setHover(null);
				props.onItemHover?.(null);
			}}
		>
			<div className="timeline-plot">
				{!loading &&
					density.map((bar) => (
						<span
							key={bar.t}
							className="timeline-bar"
							style={
								{
									translate: `${bar.x}px 0`,
									width: Math.max(2, bar.w - 2),
									"--share": bar.share,
								} as React.CSSProperties
							}
						/>
					))}
				{layout.ticks.map((tick) => (
					<span
						key={tick.t}
						className="timeline-grid"
						data-major={tick.major || undefined}
						style={{ translate: `${tick.x}px 0` }}
					/>
				))}
				{layout.today !== null && (
					<span className="timeline-today" style={{ translate: `${layout.today}px 0` }}>
						<span className="timeline-today-label">Today</span>
					</span>
				)}
				{!loading &&
					layout.marks.map((mark) =>
						mark.kind === "item" ? (
							<Dot
								key={mark.key}
								mark={mark}
								card={cards.get(mark.key)}
								order={order(mark.x)}
								hovered={hover?.kind === "item" && hover.key === mark.key}
								linked={props.linked === mark.key}
								lifted={props.lifted === mark.key}
								onBoard={props.onBoard?.(mark.key) ?? false}
								readOnly={props.readOnly}
								onHover={(on) => {
									setHover(on ? mark : null);
									props.onItemHover?.(on ? mark.key : null);
								}}
								onPointerDown={props.onItemPointerDown}
								onReveal={props.onReveal}
								onActivate={props.onItemActivate}
							/>
						) : (
							<button
								key={`cluster:${mark.keys[0]}`}
								type="button"
								className="timeline-cluster nodrag nopan"
								style={
									{
										translate: `${mark.x}px 0`,
										"--i": order(mark.x),
									} as React.CSSProperties
								}
								data-hovered={hover === mark || undefined}
								aria-label={`${mark.keys.length} items: zoom in`}
								onPointerEnter={() => setHover(mark)}
								onPointerLeave={() => setHover(null)}
								onClick={() => {
									// Zoom to the cluster's span, with room either side.
									const span = Math.max(mark.to - mark.from, 3_600_000);
									props.onZoom({
										from: Math.max(props.domain.from, mark.from - span),
										to: Math.min(props.domain.to, mark.to + span),
									});
									setHover(null);
								}}
							>
								{mark.keys.length}
							</button>
						),
					)}
				{loading && <Skeleton />}
			</div>
			{!loading && size.w >= 300 && <Legend cards={dated.map(({ card }) => card)} />}
			<div className="timeline-axis" aria-hidden="true">
				{layout.ticks.map((tick) => (
					<span
						key={tick.t}
						className="timeline-tick"
						data-major={tick.major || undefined}
						style={{ translate: `${tick.x}px 0` }}
					>
						{tick.label}
					</span>
				))}
			</div>
			{empty && (
				<p className="timeline-empty">
					Nothing {eventWord(config.event).toLowerCase()} in this range, yet
				</p>
			)}
			{hover && (
				<Peek
					mark={hover}
					card={peekCard}
					cards={cards}
					event={config.event}
					now={props.now}
					container={ref}
					onBoard={peekCard ? (props.onBoard?.(peekCard.key) ?? false) : false}
					canAdd={Boolean(props.onItemActivate)}
				/>
			)}
		</div>
	);
}

function Dot({
	mark,
	card,
	order,
	hovered,
	linked,
	lifted,
	onBoard,
	readOnly,
	onHover,
	onPointerDown,
	onReveal,
	onActivate,
}: {
	mark: Extract<TimelineMark, { kind: "item" }>;
	card: Card | undefined;
	order: number;
	hovered: boolean;
	linked: boolean;
	lifted: boolean;
	onBoard: boolean;
	readOnly?: boolean;
	onHover: (on: boolean) => void;
	onPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onReveal?: (key: string) => void;
	onActivate?: (card: Card) => void;
}) {
	if (!card) return null;
	return (
		<button
			type="button"
			className="timeline-dot nodrag nopan"
			data-state={card.state}
			data-kind={card.kind}
			data-hovered={hovered || undefined}
			data-linked={linked || undefined}
			data-lifted={lifted || undefined}
			data-on-board={onBoard || undefined}
			data-base={mark.lane === 0 || undefined}
			data-draggable={!readOnly || undefined}
			style={
				{ translate: `${mark.x}px 0`, "--lane": mark.lane, "--i": order } as React.CSSProperties
			}
			aria-label={`${card.item} ${card.title}`}
			onPointerEnter={() => onHover(true)}
			onPointerLeave={() => onHover(false)}
			onFocus={() => onHover(true)}
			onBlur={() => onHover(false)}
			onPointerDown={(event) => onPointerDown?.(event, card)}
			onClick={(event) => {
				const url = safeUrl(card.url);
				if (event.metaKey || event.ctrlKey) {
					if (url) window.open(url, "_blank", "noopener");
				} else if (onActivate) onActivate(card);
				else if (onBoard) onReveal?.(card.key);
				else if (url) window.open(url, "_blank", "noopener");
			}}
		>
			<span className="timeline-dot-core" />
		</button>
	);
}

/** What's under the pointer: an item, or the items in a cluster. */
function Peek({
	mark,
	card,
	cards,
	event,
	now,
	container,
	onBoard = false,
	canAdd = false,
}: {
	mark: TimelineMark;
	card: Card | undefined;
	cards: Map<string, Card>;
	event: TimelineConfig["event"];
	now: number;
	/** The timeline, for where on the screen the item is. */
	container: React.RefObject<HTMLDivElement | null>;
	onBoard?: boolean;
	canAdd?: boolean;
}) {
	const w = 248;
	const ref = useRef<HTMLDivElement>(null);
	// Drawn over the page at screen size, so the widget's header and edges
	// never clip it: above the item, or below it when there's no room.
	const [at, setAt] = useState<{ left: number; top: number; arrow: number; below: boolean } | null>(
		null,
	);
	const lane = mark.kind === "item" ? mark.lane : 1;
	useLayoutEffect(() => {
		const box = container.current;
		const own = ref.current;
		if (!box || !own) return;
		const rect = box.getBoundingClientRect();
		const scale = box.offsetWidth > 0 ? rect.width / box.offsetWidth : 1;
		const x = rect.left + (mark.x + INSET) * scale;
		const dotBottom = rect.bottom - (AXIS + 9 + lane * LANE) * scale;
		const dotTop = dotBottom - 15 * scale;
		const h = own.offsetHeight;
		const below = dotTop - 12 - h < 8;
		const left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2));
		setAt({
			left,
			top: below ? dotBottom + 12 : dotTop - 12 - h,
			arrow: Math.max(14, Math.min(w - 14, x - left)),
			below,
		});
	}, [container, mark, lane]);
	const style = {
		left: at?.left ?? 0,
		top: at?.top ?? 0,
		visibility: at ? undefined : "hidden",
		"--arrow": `${at?.arrow ?? w / 2}px`,
	} as React.CSSProperties;
	const below = at?.below ?? false;
	if (mark.kind === "cluster") {
		const list = mark.keys.map((key) => cards.get(key)).filter((c): c is Card => Boolean(c));
		return createPortal(
			<div
				ref={ref}
				className="timeline-peek"
				data-kind="cluster"
				data-below={below || undefined}
				style={style}
				role="tooltip"
			>
				<p className="timeline-peek-head">
					{mark.keys.length} {eventWord(event).toLowerCase()} · {rangeText(mark.from, mark.to + 1)}
				</p>
				<ul className="timeline-peek-list">
					{list.slice(0, 5).map((item) => (
						<li key={item.key} data-state={item.state}>
							<span className="state-icon">
								<StateIcon card={item} size={12} />
							</span>
							<span className="mono">{item.item}</span>
							<span className="timeline-peek-title">{item.title}</span>
						</li>
					))}
				</ul>
				<p className="timeline-peek-hint">
					{list.length > 5 ? `and ${list.length - 5} more · ` : ""}Click to zoom in
				</p>
			</div>,
			document.body,
		);
	}
	if (!card) return null;
	return createPortal(
		<div
			ref={ref}
			className="timeline-peek"
			data-state={card.state}
			data-below={below || undefined}
			style={style}
			role="tooltip"
		>
			<p className="timeline-peek-head">
				<span className="state-icon">
					<StateIcon card={card} size={13} />
				</span>
				<span className="mono">
					{card.repo.split("/").at(-1)} {card.item}
				</span>
				<span className="timeline-peek-when">
					{eventWord(event)} {ago(mark.t, now)}
				</span>
			</p>
			<p className="timeline-peek-name">{card.title}</p>
			{(card.labels.length > 0 || card.assignees.length > 0) && (
				<p className="timeline-peek-meta">
					{card.labels.slice(0, 3).map((label) => (
						<span
							key={label.name}
							className="chip label widget-row-label"
							style={{ "--label": `#${label.color}` } as React.CSSProperties}
						>
							{label.name}
						</span>
					))}
					{card.assignees.length > 0 && (
						<span className="avatars widget-row-avatars">
							{card.assignees.slice(0, 3).map((a) => (
								<img key={a.login} src={a.avatarUrl} alt={a.login} draggable={false} />
							))}
						</span>
					)}
				</p>
			)}
			<p className="timeline-peek-hint">
				{onBoard
					? "On the board: click to show it · ⌘-click opens it"
					: canAdd
						? "Click to add it beside the timeline, or drag it out"
						: "Click to open it"}
			</p>
		</div>,
		document.body,
	);
}

/** What the shapes and colours mean: only the kinds and states that are here. */
export function legendEntries(
	cards: Card[],
): { kind: Card["kind"]; state: string; label: string }[] {
	const ENTRIES: { kind: Card["kind"]; state: string; label: string }[] = [
		{ kind: "issue", state: "open", label: "Open issue" },
		{ kind: "issue", state: "closed", label: "Closed issue" },
		{ kind: "pull", state: "open", label: "Open PR" },
		{ kind: "pull", state: "draft", label: "Draft PR" },
		{ kind: "pull", state: "merged", label: "Merged PR" },
		{ kind: "pull", state: "closed", label: "Closed PR" },
	];
	const seen = new Set(cards.map((card) => `${card.kind}:${card.state}`));
	return ENTRIES.filter((entry) => seen.has(`${entry.kind}:${entry.state}`));
}

function Legend({ cards }: { cards: Card[] }) {
	const entries = useMemo(() => legendEntries(cards), [cards]);
	if (entries.length === 0) return null;
	return (
		<ul className="timeline-legend" aria-label="Key">
			{entries.map((entry) => (
				<li key={`${entry.kind}:${entry.state}`}>
					<span
						className="timeline-legend-mark"
						data-kind={entry.kind}
						data-state={entry.state}
						aria-hidden="true"
					/>
					{entry.label}
				</li>
			))}
		</ul>
	);
}

/** Loading: markers shimmering where items might be. */
function Skeleton() {
	return (
		<>
			{[0.08, 0.17, 0.21, 0.34, 0.41, 0.46, 0.58, 0.66, 0.72, 0.85, 0.91].map((at, i) => (
				<span
					key={at}
					className="timeline-dot timeline-dot-skeleton"
					style={
						{
							translate: `calc(${at} * (100cqw - var(--inset) * 2)) 0`,
							"--lane": i % 3 === 1 ? 1 : 0,
							"--i": i,
						} as React.CSSProperties
					}
				/>
			))}
		</>
	);
}
