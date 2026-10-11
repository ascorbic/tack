import {
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type Card, type MissingCard, isMissing } from "../../shared/cards.ts";
import {
	type DependencyGraph,
	type DependencyLayout,
	MAP_SIZE,
	type PlacedNode,
	describeMap,
	edgePath,
} from "../../shared/dependencyMap.ts";
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
import { ExternalIcon, PinIcon, WarnIcon } from "./icons.tsx";
import { CycleIcon, DependencyIcon, SpreadIcon } from "./kindIcons.tsx";
import "./dependencies.css";

// The dependency map widget (#43), drawn without the board around it so the
// gallery can show every state. Items are laid out left to right in the
// order work can happen: blockers first. The critical path glows, cycles
// are drawn in red, and items nothing open blocks say they're ready.
// Pointing at an item lights up everything upstream and downstream of it;
// clicking one says what it's waiting on and puts it on the board; dragging
// one out makes its card.

export interface DependencyData {
	graph: DependencyGraph;
	layout: DependencyLayout;
}

export interface DependencyViewProps {
	title: string;
	/** What it maps, in a few words: “12 items from a search”, “Cards in Launch”. */
	source: ReactNode;
	state: WidgetState<DependencyData>;
	now?: number;
	selected?: boolean;
	readOnly?: boolean;
	enter?: boolean;
	refreshing?: boolean;
	linked?: string | null;
	lifted?: string | null;
	/** For the gallery: an item shown as clicked. */
	picked?: string | null;
	onBoard?: (key: string) => boolean;
	onRefresh?: () => void;
	onConfigure?: () => void;
	onItemPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onItemHover?: (key: string | null) => void;
	onReveal?: (key: string) => void;
	/** Put these items (or all of them) on the board as cards, with their connectors. */
	onExpand?: (keys: string[] | "all") => void;
	/** Ready-made sources while it's not set up. */
	suggestions?: { label: string; run: () => void }[];
}

const PAD = 18;
/** More room on the left, for cycles' bows. */
const LEFT = 48;

export function DependencyView(props: DependencyViewProps) {
	const { state } = props;
	const now = useNow(props.now);
	const data = state.kind === "ready" ? state.value : null;
	const summary = data ? describeMap(data.graph, data.layout) : null;
	const cycles = data?.layout.cycles.length ?? 0;
	return (
		<WidgetShell
			kind="dependencies"
			icon={<DependencyIcon />}
			title={props.title}
			subtitle={
				<>
					<span className="depmap-source">{props.source}</span>
					{cycles > 0 && (
						<span className="depmap-flag" data-tone="cycle">
							<CycleIcon size={11} />
							{cycles === 1 ? "A cycle" : `${cycles} cycles`}
						</span>
					)}
					{data && data.layout.critical.length > 0 && (
						<span className="depmap-flag" data-tone="critical">
							Critical path · {data.layout.critical.length}
						</span>
					)}
				</>
			}
			count={data ? data.layout.edges.length : null}
			status={state.kind}
			stale={state.kind === "ready" && state.stale}
			selected={props.selected}
			enter={props.enter}
			readOnly={props.readOnly}
			refreshing={props.refreshing}
			onRefresh={props.onRefresh}
			onConfigure={props.onConfigure}
			configureLabel="Edit dependency map"
			tools={
				data && data.layout.nodes.length > 0 && !props.readOnly && props.onExpand ? (
					<button
						type="button"
						className="widget-tool"
						aria-label="Put the map on the board"
						data-tooltip="Put it on the board"
						onClick={() => props.onExpand?.("all")}
					>
						<SpreadIcon />
					</button>
				) : undefined
			}
			far={
				data && summary
					? {
							value: String(data.layout.edges.length),
							label:
								cycles > 0
									? `dependencies · ${cycles === 1 ? "a cycle" : `${cycles} cycles`}`
									: data.layout.critical.length > 0
										? `dependencies · critical path ${data.layout.critical.length}`
										: "dependencies",
						}
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
						{state.value.graph.pending.length > 0
							? `Asking about ${state.value.graph.pending.length} more…`
							: summary}
					</WidgetFoot>
				) : undefined
			}
		>
			<Body {...props} now={now} />
		</WidgetShell>
	);
}

function Body(props: DependencyViewProps & { now: number }) {
	const { state } = props;
	switch (state.kind) {
		case "unconfigured":
			return (
				<WidgetEmpty
					icon={<DependencyIcon size={20} />}
					title="What should this map?"
					detail="A search's results, or the cards in a section: Tack asks each what blocks it."
				>
					{props.suggestions && props.suggestions.length > 0 && (
						<div className="widget-presets nodrag nopan">
							{props.suggestions.map((suggestion) => (
								<button
									key={suggestion.label}
									type="button"
									className="widget-preset"
									disabled={props.readOnly}
									onClick={suggestion.run}
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
		case "loading":
			return <Skeleton />;
		case "error":
			return (
				<QueryErrorEmpty
					error={state.error}
					noun="this map"
					now={props.now}
					readOnly={props.readOnly}
					onRefresh={props.onRefresh}
					onConfigure={props.onConfigure}
				/>
			);
		case "ready": {
			const { graph, layout } = state.value;
			if (graph.nodes.size === 0) {
				return (
					<WidgetEmpty
						icon={<span className="widget-empty-mark" aria-hidden="true" />}
						title="Nothing to map, yet"
						detail="Items show up here as they match, with what blocks them."
					/>
				);
			}
			if (layout.nodes.length === 0 && graph.pending.length === 0) {
				return (
					<>
						<WidgetEmpty
							icon={<DependencyIcon size={20} />}
							tone="good"
							title="Nothing here blocks anything"
							detail="When one item is blocked by another, the map draws it."
						/>
						<Loose {...props} graph={graph} />
					</>
				);
			}
			return <Graph {...props} graph={graph} layout={layout} />;
		}
	}
}

function Graph(
	props: DependencyViewProps & { graph: DependencyGraph; layout: DependencyLayout; now: number },
) {
	const { graph, layout } = props;
	const ref = useRef<HTMLDivElement>(null);
	const size = useSize(ref);
	const [hover, setHover] = useState<string | null>(null);
	const [picked, setPicked] = useState<string | null>(props.picked ?? null);
	const node = MAP_SIZE.node;
	const w = layout.width + PAD + (layout.cycles.length > 0 ? LEFT : PAD);
	const left = layout.cycles.length > 0 ? LEFT : PAD;
	const h = layout.height + PAD * 2 + 20;
	// Fit what fits; scroll the rest, never smaller than legible.
	const scale = size.w > 0 ? Math.max(0.62, Math.min(1, (size.w - 8) / w, (size.h - 8) / h)) : 1;
	const at = useMemo(() => new Map(layout.nodes.map((n) => [n.key, n])), [layout.nodes]);

	// Everything upstream and downstream of what's pointed at.
	const focus = hover ?? picked;
	const chain = useMemo(() => {
		if (!focus) return null;
		const keys = new Set([focus]);
		const walk = (start: string, forward: boolean) => {
			const stack = [start];
			while (stack.length > 0) {
				const key = stack.pop() as string;
				for (const edge of layout.edges) {
					const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
					if (from === key && !keys.has(to)) {
						keys.add(to);
						stack.push(to);
					}
				}
			}
		};
		walk(focus, true);
		walk(focus, false);
		return keys;
	}, [focus, layout.edges]);

	useEffect(() => {
		if (!picked) return;
		const close = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target?.closest(".depmap-node, .depmap-pop")) setPicked(null);
		};
		const key = (event: KeyboardEvent) => event.key === "Escape" && setPicked(null);
		window.addEventListener("pointerdown", close, true);
		window.addEventListener("keydown", key);
		return () => {
			window.removeEventListener("pointerdown", close, true);
			window.removeEventListener("keydown", key);
		};
	}, [picked]);

	const pickedNode = picked ? at.get(picked) : undefined;
	return (
		<div className="depmap" ref={ref}>
			<div
				className="depmap-canvas"
				data-focus={chain ? true : undefined}
				style={{ width: w * scale, height: h * scale }}
			>
				<div
					className="depmap-inner"
					style={{ width: w, height: h, transform: `scale(${scale})` }}
					onPointerLeave={() => {
						setHover(null);
						props.onItemHover?.(null);
					}}
				>
					<svg className="depmap-edges" width={w} height={h} aria-hidden="true">
						<defs>
							{(["base", "critical", "cycle"] as const).map((tone) => (
								<marker
									key={tone}
									id={`depmap-arrow-${tone}`}
									className={`depmap-arrow depmap-arrow-${tone}`}
									viewBox="0 0 8 8"
									refX="7"
									refY="4"
									markerWidth="7"
									markerHeight="7"
									orient="auto-start-reverse"
								>
									<path d="M1 1 7 4 1 7z" />
								</marker>
							))}
						</defs>
						<g transform={`translate(${left} ${PAD + 20})`}>
							{layout.edges.map((edge, i) => {
								const a = at.get(edge.from);
								const b = at.get(edge.to);
								if (!a || !b) return null;
								const d = edgePath(a, b, node);
								const tone = edge.cycle ? "cycle" : edge.critical ? "critical" : "base";
								const lit = chain ? chain.has(edge.from) && chain.has(edge.to) : undefined;
								return (
									<g
										key={`${edge.from}>${edge.to}`}
										className="depmap-edge"
										data-tone={tone}
										data-lit={lit || undefined}
										data-dim={lit === false || undefined}
										style={{ "--i": b.layer * 2 + i * 0.2 } as React.CSSProperties}
									>
										<path
											d={d}
											pathLength={tone === "cycle" ? undefined : 1}
											markerEnd={`url(#depmap-arrow-${tone})`}
										/>
										{tone === "critical" && <path className="depmap-flow" d={d} />}
									</g>
								);
							})}
						</g>
					</svg>
					{layout.nodes.map((placed) => (
						<Node
							key={placed.key}
							placed={placed}
							left={left}
							card={graph.nodes.get(placed.key)?.card ?? null}
							member={graph.nodes.get(placed.key)?.member ?? true}
							unknown={graph.nodes.get(placed.key)?.unknown ?? false}
							lit={chain ? chain.has(placed.key) : undefined}
							picked={picked === placed.key}
							linked={props.linked === placed.key}
							lifted={props.lifted === placed.key}
							onBoard={props.onBoard?.(placed.key) ?? false}
							readOnly={props.readOnly}
							onHover={(on) => {
								setHover(on ? placed.key : null);
								props.onItemHover?.(on ? placed.key : null);
							}}
							onPointerDown={props.onItemPointerDown}
							onPick={() => setPicked((current) => (current === placed.key ? null : placed.key))}
						/>
					))}
					{pickedNode && (
						<Pop
							{...props}
							placed={pickedNode}
							left={left}
							width={w}
							onDone={() => setPicked(null)}
						/>
					)}
				</div>
			</div>
			<Loose {...props} graph={graph} />
		</div>
	);
}

function Node({
	placed,
	left,
	card,
	member,
	unknown,
	lit,
	picked,
	linked,
	lifted,
	onBoard,
	readOnly,
	onHover,
	onPointerDown,
	onPick,
}: {
	placed: PlacedNode;
	left: number;
	card: Card | MissingCard | null;
	member: boolean;
	unknown: boolean;
	lit?: boolean;
	picked: boolean;
	linked: boolean;
	lifted: boolean;
	onBoard: boolean;
	readOnly?: boolean;
	onHover: (on: boolean) => void;
	onPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onPick: () => void;
}) {
	const real = card && !isMissing(card) ? card : null;
	const item = placed.key.slice(placed.key.search(/[#!]\d+$/));
	return (
		<button
			type="button"
			className="depmap-node nodrag nopan"
			data-state={real?.state ?? "unknown"}
			data-critical={placed.critical || undefined}
			data-cycle={placed.cycle || undefined}
			data-ready={placed.ready || undefined}
			data-outside={!member || undefined}
			data-lit={lit || undefined}
			data-dim={lit === false || undefined}
			data-picked={picked || undefined}
			data-linked={linked || undefined}
			data-lifted={lifted || undefined}
			data-on-board={onBoard || undefined}
			data-draggable={(!readOnly && real) || undefined}
			style={
				{
					translate: `${placed.x + left}px ${placed.y + PAD + 20}px`,
					"--i": placed.layer * 3 + placed.row,
				} as React.CSSProperties
			}
			aria-label={`${item} ${real?.title ?? ""}`}
			onPointerEnter={() => onHover(true)}
			onPointerLeave={() => onHover(false)}
			onFocus={() => onHover(true)}
			onBlur={() => onHover(false)}
			onPointerDown={(event) => real && onPointerDown?.(event, real)}
			onClick={onPick}
		>
			<span className="depmap-node-head">
				<span className="state-icon" aria-hidden="true">
					{real ? <StateIcon card={real} size={12} /> : <WarnIcon size={12} />}
				</span>
				<span className="mono">{item}</span>
				{placed.cycle ? (
					<span className="depmap-badge" data-tone="cycle">
						<CycleIcon size={10} />
					</span>
				) : placed.ready ? (
					<span className="depmap-badge" data-tone="ready">
						Ready
					</span>
				) : null}
				{onBoard && (
					<span className="depmap-pin" aria-label="On the board">
						<PinIcon size={10} />
					</span>
				)}
			</span>
			<span className="depmap-node-title">
				{real?.title ?? (unknown ? "Couldn't read this" : "Not visible to you")}
			</span>
		</button>
	);
}

/** Items a popover lists, by number and title, so they can be told apart. */
function Linked({
	keys,
	graph,
	refOf,
}: {
	keys: string[];
	graph: DependencyGraph;
	refOf: (key: string) => string;
}) {
	return (
		<ul className="depmap-pop-items">
			{keys.map((key) => {
				const card = graph.nodes.get(key)?.card;
				const title = card && !isMissing(card) ? card.title : null;
				return (
					<li key={key} title={title ?? undefined}>
						<span className="mono">{refOf(key)}</span>
						{title && <span className="depmap-pop-item-title">{title}</span>}
					</li>
				);
			})}
		</ul>
	);
}

/** A clicked item: what it waits on, what waits on it, and putting it on the board. */
function Pop(
	props: DependencyViewProps & {
		placed: PlacedNode;
		left: number;
		graph: DependencyGraph;
		layout: DependencyLayout;
		width: number;
		onDone: () => void;
	},
) {
	const { placed, graph, layout } = props;
	const card = graph.nodes.get(placed.key)?.card;
	const real = card && !isMissing(card) ? card : null;
	const ref = (key: string) => key.slice(key.search(/[#!]\d+$/));
	const blockers = layout.edges.filter((e) => e.to === placed.key).map((e) => e.from);
	const blocks = layout.edges.filter((e) => e.from === placed.key).map((e) => e.to);
	const openBlockers = blockers.filter((key) => graph.nodes.get(key)?.open);
	const on = props.onBoard?.(placed.key) ?? false;
	const popW = 236;
	const left = Math.min(placed.x + props.left, props.width - popW - 8);
	return (
		<div
			className="depmap-pop nodrag nopan"
			role="dialog"
			aria-label={`${ref(placed.key)}: dependencies`}
			style={{ left, top: placed.y + PAD + 20 + MAP_SIZE.node.h + 8, width: popW }}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<p className="depmap-pop-title">{real?.title ?? ref(placed.key)}</p>
			<p
				className="depmap-pop-status"
				data-tone={placed.cycle ? "cycle" : placed.ready ? "ready" : undefined}
			>
				{placed.cycle
					? "In a cycle: it can't start until the cycle's broken"
					: !graph.nodes.get(placed.key)?.open
						? "Done"
						: placed.ready
							? "Ready: nothing open blocks it"
							: `Waiting on ${openBlockers.map(ref).join(", ")}`}
			</p>
			<dl className="depmap-pop-links">
				{blockers.length > 0 && (
					<>
						<dt>Blocked by</dt>
						<dd>
							<Linked keys={blockers} graph={graph} refOf={ref} />
						</dd>
					</>
				)}
				{blocks.length > 0 && (
					<>
						<dt>Blocks</dt>
						<dd>
							<Linked keys={blocks} graph={graph} refOf={ref} />
						</dd>
					</>
				)}
			</dl>
			<div className="depmap-pop-actions">
				{on ? (
					<button
						type="button"
						className="widget-action"
						onClick={() => {
							props.onReveal?.(placed.key);
							props.onDone();
						}}
					>
						<PinIcon size={12} /> Show on the board
					</button>
				) : (
					!props.readOnly &&
					props.onExpand && (
						<button
							type="button"
							className="widget-action"
							onClick={() => {
								props.onExpand?.([placed.key]);
								props.onDone();
							}}
						>
							Add to the board
						</button>
					)
				)}
				{real && (
					<a className="depmap-pop-open" href={real.url} target="_blank" rel="noreferrer">
						Open <ExternalIcon />
					</a>
				)}
			</div>
		</div>
	);
}

/** Items with no dependencies either way, as chips under the map. */
function Loose(props: DependencyViewProps & { graph: DependencyGraph }) {
	const { graph } = props;
	if (graph.isolated.length === 0) return null;
	return (
		<div className="depmap-loose">
			<span className="depmap-loose-label">No dependencies</span>
			{graph.isolated.slice(0, 24).map((key) => {
				const card = graph.nodes.get(key)?.card;
				const real = card && !isMissing(card) ? card : null;
				return (
					<span
						key={key}
						className="depmap-chip nodrag nopan"
						data-state={real?.state}
						data-linked={props.linked === key || undefined}
						data-draggable={(!props.readOnly && real) || undefined}
						title={real?.title}
						onPointerEnter={() => props.onItemHover?.(key)}
						onPointerLeave={() => props.onItemHover?.(null)}
						onPointerDown={(event) => real && props.onItemPointerDown?.(event, real)}
					>
						{key.slice(key.search(/[#!]\d+$/))}
					</span>
				);
			})}
			{graph.isolated.length > 24 && (
				<span className="depmap-loose-label">+{graph.isolated.length - 24}</span>
			)}
		</div>
	);
}

/** Loading: a ghost of a small graph, shimmering. */
function Skeleton() {
	const nodes = [
		[0, 30],
		[0, 100],
		[1, 10],
		[1, 70],
		[2, 50],
	] as const;
	const node = MAP_SIZE.node;
	const col = node.w + MAP_SIZE.gap.x;
	return (
		<div className="depmap depmap-skeleton" role="status" aria-busy="true" aria-label="Loading">
			<svg width={3 * col} height={170} aria-hidden="true">
				{[
					[0, 2],
					[1, 3],
					[2, 4],
					[3, 4],
				].map(([a, b]) => {
					const [la, ya] = nodes[a as number] as readonly [number, number];
					const [lb, yb] = nodes[b as number] as readonly [number, number];
					return (
						<path
							key={`${a}-${b}`}
							d={edgePath(
								{ x: la * col + PAD, y: ya + PAD },
								{ x: lb * col + PAD, y: yb + PAD },
								node,
							)}
						/>
					);
				})}
			</svg>
			{nodes.map(([layer, y], i) => (
				<span
					key={i}
					className="depmap-node depmap-node-skeleton"
					style={
						{ translate: `${layer * col + PAD}px ${y + PAD}px`, "--i": i } as React.CSSProperties
					}
				>
					<span className="skeleton" style={{ width: "40%" }} />
					<span className="skeleton" style={{ width: "80%" }} />
				</span>
			))}
		</div>
	);
}
