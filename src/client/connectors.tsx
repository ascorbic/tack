import { ViewportPortal, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useContext,
	useSyncExternalStore,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import {
	CONNECTOR_COLORS,
	type Connector,
	type ConnectorColor,
	type Target,
	arrowHead,
	arrowTrim,
	endAt,
	readConnector,
	resolveEnds,
	routeConnector,
	withFallbacks,
} from "../shared/connectors.ts";
import {
	type Point,
	type Rect,
	contains,
	distance,
	polylineIntersectsRect,
} from "../shared/geometry.ts";
import type { SizeOf } from "../shared/sections.ts";
import {
	type ConnectorArrow,
	type ConnectorEnd,
	type ConnectorRoute,
	readShape,
	shapesMap,
	transactLocal,
	updateShapes,
} from "../shared/shapes.ts";
import { addConnector } from "../shared/structure.ts";
import { type ShapeNode, deleteShapes } from "./board.ts";
import { useInsideCanvas } from "./useInsideCanvas.ts";
import { type SectionDrag, nodeBox } from "./canvasStructure.ts";
import { ReadOnlyContext } from "./DocContext.ts";
import { entranceOf } from "./entering.ts";
import { useAwarenessField } from "./ephemeral.ts";
import { isOffBoardTarget } from "./keys.ts";
import "./connectors.css";

// Connectors live on our own SVG layer inside the React Flow viewport rather
// than as React Flow edges: edges need a node at both ends and attach to
// fixed handles, while connectors here can end anywhere, attach anywhere on
// a shape's outline, and be picked up and re-attached. See
// docs/react-flow-probe.md.

const STROKE = 2;
/** Screen pixels within which an end pins to a shape's outline. */
const SNAP = 12;
/** Screen pixels a press must move before it draws a connector. */
const DRAG_SLOP = 5;

/** The style the next connector is drawn in: whatever was last picked. */
let lastStyle: { route?: ConnectorRoute; arrow?: ConnectorArrow; dash?: boolean; color?: string } =
	{};

interface Entry {
	id: string;
	z: string;
	connector: Connector;
}

/** Connectors from the document, in stacking order, reusing unchanged entries. */
function createConnectorStore(doc: Y.Doc) {
	const shapes = shapesMap(doc);
	const cache = new Map<string, Entry | null>();
	let snapshot: Entry[] = [];
	const rebuild = (changed?: Set<string>) => {
		const out: Entry[] = [];
		for (const [id, shape] of shapes) {
			if (shape.get("type") !== "connector") continue;
			let entry = cache.get(id);
			if (entry === undefined || !changed || changed.has(id)) {
				const props = readShape(shape);
				const connector = readConnector(props);
				entry = connector ? { id, z: props.z, connector } : null;
				cache.set(id, entry);
			}
			if (entry) out.push(entry);
		}
		for (const id of cache.keys()) if (!shapes.has(id)) cache.delete(id);
		out.sort((a, b) => (a.z < b.z ? -1 : 1));
		snapshot = out;
	};
	rebuild();
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			rebuild();
			const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
				const changed = new Set<string>();
				for (const event of events) {
					if (event.target === shapes) for (const key of event.keys.keys()) changed.add(key);
					else if (typeof event.path[0] === "string") changed.add(event.path[0]);
				}
				const before = snapshot;
				rebuild(changed);
				// Only tell React when a connector actually changed.
				if (before.length !== snapshot.length || before.some((entry, i) => entry !== snapshot[i])) {
					listener();
				}
			};
			shapes.observeDeep(observer);
			return () => shapes.unobserveDeep(observer);
		},
	};
}

function useConnectors(doc: Y.Doc): Entry[] {
	const store = useMemo(() => createConnectorStore(doc), [doc]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** A connector being drawn or re-attached, shared through awareness. */
interface Connecting {
	/** The connector being re-attached; absent while drawing a new one. */
	id?: string;
	from: ConnectorEnd;
	to: ConnectorEnd;
}

type Gesture = Connecting & {
	/** The end following the pointer. */
	moving: "from" | "to";
	/** Whether the pointer has moved far enough to count. */
	live: boolean;
};

interface Geometry {
	d: string;
	/** The route as a polyline, for marquee selection. */
	points: Point[];
	heads: string;
	middle: Point;
	start: Point;
	end: Point;
}

function geometryOf(
	connector: Pick<Connector, "from" | "to" | "route" | "arrow">,
	boxOf: (id: string) => Rect | undefined,
): Geometry {
	const { start, end } = resolveEnds(connector.from, connector.to, boxOf);
	const trim = arrowTrim(STROKE);
	const route = routeConnector(start, end, connector.route, {
		start: connector.arrow === "both" ? trim : 0,
		end: connector.arrow === "none" ? 0 : trim,
	});
	const heads: string[] = [];
	if (connector.arrow !== "none") heads.push(arrowHead(end.point, route.endAngle, STROKE));
	if (connector.arrow === "both") heads.push(arrowHead(start.point, route.startAngle, STROKE));
	return {
		d: route.d,
		points: route.points,
		heads: heads.join(" "),
		middle: route.middle,
		start: start.point,
		end: end.point,
	};
}

export interface ConnectorLayerProps {
	doc: Y.Doc;
	awareness: Awareness;
	/** Nodes as drawn, with drags and resizes applied. */
	nodes: ShapeNode[];
	sectionDrags: SectionDrag[];
	/** Whether the connector tool is active. */
	drawing: boolean;
	/** Whether shapes can be interacted with at all (not with the hand tool). */
	interactive: boolean;
	onDrawn: () => void;
	selected: ReadonlySet<string>;
	setSelected: (update: (current: Set<string>) => Set<string>) => void;
	sizeOf: SizeOf;
	/** Extra controls at the end of a selected connector's toolbar, e.g. blocked-by. */
	connectorActions?: (id: string) => ReactNode;
}

export function ConnectorLayer({
	doc,
	awareness,
	nodes,
	sectionDrags,
	drawing,
	interactive,
	onDrawn,
	selected,
	setSelected,
	sizeOf,
	connectorActions,
}: ConnectorLayerProps) {
	const entries = useConnectors(doc);
	const store = useStoreApi();
	const flow = useReactFlow();
	const zoom = useStore((state) => state.transform[2]);

	const boxes = useMemo(() => new Map(nodes.map((node) => [node.id, nodeBox(node)])), [nodes]);
	// Topmost first: shapes above sections, inner sections above outer ones.
	const targets = useMemo<Target[]>(
		() =>
			nodes
				.map((node) => ({
					id: node.id,
					type: node.data.shape.type,
					box: boxes.get(node.id) as Rect,
				}))
				.reverse(),
		[nodes, boxes],
	);
	const boxOf = useCallback((id: string) => boxes.get(id), [boxes]);

	// Latest values for the pointer handlers, which outlive renders.
	const live = useRef({ targets, boxOf, zoom, entries, sizeOf });
	live.current = { targets, boxOf, zoom, entries, sizeOf };

	const [gesture, setGestureState] = useState<Gesture | null>(null);
	const [remote, publish] = useAwarenessField<Connecting>(awareness, "connecting");
	const setGesture = useCallback(
		(next: Gesture | null) => {
			setGestureState(next);
			publish(next?.live ? { id: next.id, from: next.from, to: next.to } : null);
		},
		[publish],
	);

	// View-only boards show connectors, but don't label, restyle or re-attach them.
	const readOnly = useContext(ReadOnlyContext);
	const [editingState, setEditing] = useState<string | null>(null);
	const editing = readOnly ? null : editingState;
	const connectorIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);
	const selectedConnectors = useMemo(
		() => [...selected].filter((id) => connectorIds.has(id)),
		[selected, connectorIds],
	);
	// Stop editing a label whose connector has gone (deleted by someone else).
	useEffect(() => {
		if (editing && !connectorIds.has(editing)) setEditing(null);
	}, [editing, connectorIds]);

	// A gesture in progress, so it can be abandoned if the layer goes away.
	const cancelGesture = useRef<(() => void) | null>(null);
	useEffect(() => () => cancelGesture.current?.(), []);

	/** Follow the pointer with one end until it's released, then commit. */
	const track = useCallback(
		(initial: Gesture, event: { clientX: number; clientY: number }) => {
			cancelGesture.current?.();
			const startScreen = { x: event.clientX, y: event.clientY };
			let current = initial;
			setGesture(current);
			const fixed = initial.moving === "from" ? initial.to : initial.from;
			const exclude = fixed.shape ? new Set([fixed.shape]) : undefined;
			const onMove = (move: PointerEvent) => {
				const screen = { x: move.clientX, y: move.clientY };
				const isLive = current.live || distance(screen, startScreen) > DRAG_SLOP;
				const point = flow.screenToFlowPosition(screen);
				const { targets, zoom } = live.current;
				const end = endAt(point, targets, SNAP / zoom, exclude);
				current =
					current.moving === "from"
						? { ...current, from: end, live: isLive }
						: { ...current, to: end, live: isLive };
				setGesture(current);
			};
			const finish = (commit: boolean) => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onCancel);
				window.removeEventListener("keydown", onKey, true);
				cancelGesture.current = null;
				setGesture(null);
				if (!commit || !current.live) return;
				const ends = withFallbacks(current.from, current.to, live.current.boxOf);
				if (current.id) {
					const which = current.moving;
					updateShapes(doc, [current.id as string], { [which]: ends[which] });
					return;
				}
				const id = transactLocal(doc, () => addConnector(doc, { ...lastStyle, ...ends }));
				setSelected(() => new Set([id]));
				onDrawn();
			};
			const onUp = () => finish(true);
			const onCancel = () => finish(false);
			const onKey = (key: KeyboardEvent) => {
				if (key.key !== "Escape") return;
				key.stopPropagation();
				finish(false);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onCancel);
			window.addEventListener("keydown", onKey, true);
			cancelGesture.current = onCancel;
		},
		[doc, flow, onDrawn, setGesture, setSelected],
	);

	const beginDraw = useCallback(
		(from: ConnectorEnd, event: { clientX: number; clientY: number }) =>
			track({ from, to: { x: from.x, y: from.y }, moving: "to", live: false }, event),
		[track],
	);

	// The connector tool: press anywhere (on a shape or not) and drag.
	useEffect(() => {
		if (!drawing) return;
		const dom = store.getState().domNode;
		if (!dom) return;
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0 || !event.isPrimary) return;
			if ((event.target as Element | null)?.closest(".react-flow__panel, .connector-ui")) return;
			event.preventDefault();
			event.stopPropagation();
			const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
			const { targets, zoom } = live.current;
			beginDraw(endAt(point, targets, SNAP / zoom), event);
		};
		dom.addEventListener("pointerdown", onDown, true);
		return () => dom.removeEventListener("pointerdown", onDown, true);
	}, [drawing, store, flow, beginDraw]);

	// Pressing a shape or the empty canvas (without shift) moves selection
	// away from connectors, as React Flow only knows about its nodes.
	useEffect(() => {
		const dom = store.getState().domNode;
		if (!dom) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target || target.closest(".connector-ui, .connector-hit")) return;
			if (event.shiftKey && target.closest(".react-flow__node")) return;
			setSelected((current) => {
				const kept = new Set([...current].filter((id) => !connectorIds.has(id)));
				return kept.size === current.size ? current : kept;
			});
		};
		dom.addEventListener("pointerdown", onDown);
		return () => dom.removeEventListener("pointerdown", onDown);
	}, [store, connectorIds, setSelected]);

	const remove = useCallback(
		(ids: string[]) => {
			deleteShapes(doc, ids, sizeOf);
			setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
		},
		[doc, sizeOf, setSelected],
	);

	// Enter labels a connector selected on its own. Typing doesn't: single
	// keys are shortcuts (tools, Space to pan, Shift+1 to fit) and must never
	// land in a label. (Deleting and deselecting are board commands, in commands.ts.)
	const alone = selected.size === 1 && selectedConnectors.length === 1;
	useEffect(() => {
		if (!alone || editing || readOnly) return;
		const onKey = (event: KeyboardEvent) => {
			if (isOffBoardTarget(event.target)) return;
			if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
			event.preventDefault();
			event.stopPropagation();
			setEditing(selectedConnectors[0] as string);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [alone, selectedConnectors, editing, readOnly]);

	// Ends being moved right now, by us or anyone else.
	const moving = useMemo(() => {
		const out = new Map<string, Connecting>();
		for (const { value } of remote) if (value.id) out.set(value.id, value);
		if (gesture?.id && gesture.live) out.set(gesture.id, gesture);
		return out;
	}, [remote, gesture]);

	/** An end as drawn: loose ends inside a dragged section move with it. */
	const shift = useCallback(
		(end: ConnectorEnd): ConnectorEnd => {
			if (end.shape && boxes.has(end.shape)) return end;
			const drag = sectionDrags.find((candidate) => contains(candidate.box, end));
			return drag ? { ...end, x: end.x + drag.delta.x, y: end.y + drag.delta.y } : end;
		},
		[sectionDrags, boxes],
	);

	const drawn = entries.map((entry) => {
		const override = moving.get(entry.id);
		const connector = {
			...entry.connector,
			from: shift(override?.from ?? entry.connector.from),
			to: shift(override?.to ?? entry.connector.to),
		};
		return { entry, connector, geometry: geometryOf(connector, boxOf) };
	});

	// Marquee selection takes connectors the box touches, as well as shapes.
	const marquee = useStore((state) => (state.userSelectionActive ? state.userSelectionRect : null));
	const marqueed = useRef(new Set<string>());
	const drawnRef = useRef(drawn);
	drawnRef.current = drawn;
	useEffect(() => {
		if (!marquee) {
			marqueed.current = new Set();
			return;
		}
		const [tx, ty, zoom] = store.getState().transform;
		const box = {
			x: (marquee.x - tx) / zoom,
			y: (marquee.y - ty) / zoom,
			w: marquee.width / zoom,
			h: marquee.height / zoom,
		};
		const hits = new Set(
			drawnRef.current
				.filter(({ geometry }) => polylineIntersectsRect(geometry.points, box))
				.map(({ entry }) => entry.id),
		);
		const before = marqueed.current;
		if (hits.size === before.size && [...hits].every((id) => before.has(id))) return;
		marqueed.current = hits;
		setSelected((current) => {
			const next = new Set(current);
			for (const id of before) if (!hits.has(id)) next.delete(id);
			for (const id of hits) next.add(id);
			return next;
		});
	}, [marquee, store, setSelected]);

	const drafts: { key: string; color?: string; geometry: Geometry }[] = [];
	if (gesture && gesture.live && !gesture.id) {
		drafts.push({
			key: "local",
			geometry: geometryOf(
				{ ...gesture, route: lastStyle.route ?? "curved", arrow: lastStyle.arrow ?? "end" },
				boxOf,
			),
		});
	}
	for (const { clientId, user, value } of remote) {
		if (value.id) continue;
		drafts.push({
			key: String(clientId),
			color: user?.color,
			geometry: geometryOf({ ...value, route: "curved", arrow: "end" }, boxOf),
		});
	}

	// What the moving end would attach to, highlighted.
	const movingEnd = gesture?.live ? gesture[gesture.moving] : null;
	const highlight = movingEnd?.shape ? boxes.get(movingEnd.shape) : undefined;

	const onPress = useCallback(
		(id: string, event: ReactPointerEvent) => {
			if (event.button !== 0) return;
			event.stopPropagation();
			setSelected((current) => {
				if (!event.shiftKey) return new Set([id]);
				const next = new Set(current);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				return next;
			});
		},
		[setSelected],
	);

	const single = alone && !gesture ? selectedConnectors[0] : undefined;
	const singleDrawn = single ? drawn.find((item) => item.entry.id === single) : undefined;

	return (
		<ViewportPortal>
			<div className="connector-layer" data-interactive={interactive && !drawing}>
				<svg className="connectors" aria-hidden="true">
					{highlight && (
						<rect
							className="connector-target"
							x={highlight.x - 4 / zoom}
							y={highlight.y - 4 / zoom}
							width={highlight.w + 8 / zoom}
							height={highlight.h + 8 / zoom}
							rx={10}
						/>
					)}
					{drawn.map(({ entry, connector, geometry }) => (
						<ConnectorPath
							key={entry.id}
							id={entry.id}
							d={geometry.d}
							heads={geometry.heads}
							color={connector.color}
							dash={connector.dash}
							selected={selected.has(entry.id)}
							moving={moving.has(entry.id)}
							onPress={onPress}
							onEdit={setEditing}
						/>
					))}
					{drafts.map(({ key, color, geometry }) => (
						<g
							key={key}
							className="connector connector-draft"
							data-remote={color !== undefined}
							style={color ? ({ "--who": color } as React.CSSProperties) : undefined}
						>
							<path className="connector-line" d={geometry.d} />
							<path className="connector-head" d={geometry.heads} />
						</g>
					))}
					{movingEnd?.shape && movingEnd.anchor && (
						<circle className="connector-snap" cx={movingEnd.x} cy={movingEnd.y} r={5 / zoom} />
					)}
				</svg>

				{drawn.map(({ entry, connector, geometry }) =>
					connector.label || editing === entry.id ? (
						<ConnectorLabel
							key={entry.id}
							id={entry.id}
							at={geometry.middle}
							label={connector.label}
							color={connector.color}
							editing={editing === entry.id}
							selected={selected.has(entry.id)}
							onPress={(event) => onPress(entry.id, event)}
							onEdit={() => setEditing(entry.id)}
							onChange={(label) => updateShapes(doc, [entry.id], { label })}
							onDone={() => setEditing(null)}
						/>
					) : null,
				)}

				{singleDrawn && !readOnly && (
					<>
						<EndHandle
							at={singleDrawn.geometry.start}
							bound={!!singleDrawn.connector.from.shape}
							onPointerDown={(event) =>
								track(
									{
										id: singleDrawn.entry.id,
										from: singleDrawn.entry.connector.from,
										to: singleDrawn.entry.connector.to,
										moving: "from",
										live: false,
									},
									event,
								)
							}
						/>
						<EndHandle
							at={singleDrawn.geometry.end}
							bound={!!singleDrawn.connector.to.shape}
							onPointerDown={(event) =>
								track(
									{
										id: singleDrawn.entry.id,
										from: singleDrawn.entry.connector.from,
										to: singleDrawn.entry.connector.to,
										moving: "to",
										live: false,
									},
									event,
								)
							}
						/>
						{editing !== singleDrawn.entry.id && (
							<ConnectorToolbar
								at={singleDrawn.geometry.middle}
								connector={singleDrawn.entry.connector}
								onStyle={(style) => {
									lastStyle = { ...lastStyle, ...style };
									updateShapes(doc, [singleDrawn.entry.id], style);
								}}
								onLabel={() => setEditing(singleDrawn.entry.id)}
								onDelete={() => remove([singleDrawn.entry.id])}
								extra={connectorActions?.(singleDrawn.entry.id)}
							/>
						)}
					</>
				)}

				{interactive && !drawing && !gesture && <HoverHandles boxes={boxes} onBegin={beginDraw} />}
			</div>
		</ViewportPortal>
	);
}

const ConnectorPath = memo(function ConnectorPath({
	id,
	d,
	heads,
	color,
	dash,
	selected,
	moving,
	onPress,
	onEdit,
}: {
	id: string;
	d: string;
	heads: string;
	color: ConnectorColor;
	dash: boolean;
	selected: boolean;
	moving: boolean;
	onPress: (id: string, event: ReactPointerEvent) => void;
	onEdit: (id: string) => void;
}) {
	// Laid out with others (Expand related): drawn in once its cards land.
	const [entrance] = useState(() => entranceOf(id));
	return (
		<g
			className="connector"
			data-color={color}
			data-selected={selected}
			data-moving={moving}
			data-enter={entrance ? "draw" : undefined}
			style={
				entrance
					? ({ "--enter-delay": `${Math.round(entrance.delay)}` } as React.CSSProperties)
					: undefined
			}
		>
			<path className="connector-halo" d={d} />
			<path
				className="connector-line"
				d={d}
				data-dash={dash}
				{...(entrance && !dash ? { pathLength: 1, "data-draw": true } : {})}
			/>
			{heads && <path className="connector-head" d={heads} />}
			<path
				className="connector-hit"
				d={d}
				onPointerDown={(event) => onPress(id, event)}
				onClick={(event) => event.stopPropagation()}
				onDoubleClick={(event) => {
					event.stopPropagation();
					onEdit(id);
				}}
			/>
		</g>
	);
});

function ConnectorLabel({
	id,
	at,
	label,
	color,
	editing,
	selected,
	onPress,
	onEdit,
	onChange,
	onDone,
}: {
	/** The connector's id, for its entrance when laid out with others. */
	id?: string;
	at: Point;
	label: string;
	color: ConnectorColor;
	editing: boolean;
	selected: boolean;
	onPress: (event: ReactPointerEvent) => void;
	onEdit: () => void;
	onChange: (label: string) => void;
	onDone: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!editing) return;
		const el = input.current;
		el?.focus();
		el?.setSelectionRange(el.value.length, el.value.length);
	}, [editing]);
	const [entrance] = useState(() => (id ? entranceOf(id) : null));
	return (
		<div
			data-enter={entrance ? "draw" : undefined}
			className="connector-label connector-ui nodrag nopan"
			data-color={color}
			data-selected={selected}
			data-editing={editing}
			style={
				{
					transform: `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`,
					...(entrance ? { "--enter-delay": `${Math.round(entrance.delay)}` } : {}),
				} as React.CSSProperties
			}
			onPointerDown={(event) => {
				event.stopPropagation();
				if (!editing) onPress(event);
			}}
			onDoubleClick={(event) => {
				event.stopPropagation();
				onEdit();
			}}
		>
			{editing ? (
				<span className="connector-label-edit" data-value={label || "Label"}>
					<input
						ref={input}
						aria-label="Connector label"
						placeholder="Label"
						value={label}
						onChange={(event) => onChange(event.target.value)}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter" || event.key === "Escape") onDone();
						}}
						onBlur={onDone}
					/>
				</span>
			) : (
				label
			)}
		</div>
	);
}

/** A handle on the end of the selected connector, to pick it up and re-attach it. */
function EndHandle({
	at,
	bound,
	onPointerDown,
}: {
	at: Point;
	bound: boolean;
	onPointerDown: (event: ReactPointerEvent) => void;
}) {
	return (
		<div
			className="connector-end connector-ui nodrag nopan"
			data-bound={bound}
			style={{ transform: `translate(${at.x}px, ${at.y}px) scale(var(--inv-zoom, 1))` }}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.stopPropagation();
				event.preventDefault();
				onPointerDown(event);
			}}
		/>
	);
}

/** How far outside a shape its connector handles sit, in screen pixels. */
const HANDLE_OFFSET = 16;

const SIDES = [
	{ anchor: { x: 0.5, y: 0 }, offset: { x: 0, y: -1 } },
	{ anchor: { x: 1, y: 0.5 }, offset: { x: 1, y: 0 } },
	{ anchor: { x: 0.5, y: 1 }, offset: { x: 0, y: 1 } },
	{ anchor: { x: 0, y: 0.5 }, offset: { x: -1, y: 0 } },
];

/**
 * FigJam-style handles around the shape under the pointer: drag one out to
 * draw a connector from that side.
 */
function HoverHandles({
	boxes,
	onBegin,
}: {
	boxes: Map<string, Rect>;
	onBegin: (from: ConnectorEnd, event: ReactPointerEvent) => void;
}) {
	const store = useStoreApi();
	const [hovered, setHovered] = useState<string | null>(null);

	useEffect(() => {
		const dom = store.getState().domNode;
		if (!dom) return;
		let timer = 0;
		const onOver = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (target?.closest(".connector-handle")) {
				clearTimeout(timer);
				return;
			}
			const node = target?.closest(".react-flow__node:not(.react-flow__node-section)");
			const id = node?.getAttribute("data-id");
			clearTimeout(timer);
			if (id && event.buttons === 0) setHovered(id);
			else timer = window.setTimeout(() => setHovered(null), 180);
		};
		const onDown = (event: PointerEvent) => {
			if (!(event.target as Element | null)?.closest(".connector-handle")) setHovered(null);
		};
		dom.addEventListener("pointerover", onOver);
		dom.addEventListener("pointerdown", onDown);
		return () => {
			clearTimeout(timer);
			dom.removeEventListener("pointerover", onOver);
			dom.removeEventListener("pointerdown", onDown);
		};
	}, [store]);

	const box = hovered ? boxes.get(hovered) : undefined;
	if (!hovered || !box) return null;
	return (
		<>
			{SIDES.map(({ anchor, offset }) => {
				const x = box.x + box.w * anchor.x;
				const y = box.y + box.h * anchor.y;
				return (
					<div
						key={`${anchor.x},${anchor.y}`}
						className="connector-handle connector-ui nodrag nopan"
						style={{
							transform: `translate(${x}px, ${y}px) scale(var(--inv-zoom, 1)) translate(${offset.x * HANDLE_OFFSET}px, ${offset.y * HANDLE_OFFSET}px)`,
						}}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							event.stopPropagation();
							event.preventDefault();
							setHovered(null);
							onBegin({ x, y, shape: hovered, anchor }, event);
						}}
					/>
				);
			})}
		</>
	);
}

const ROUTES: { route: ConnectorRoute; label: string; icon: string }[] = [
	{ route: "curved", label: "Curved", icon: "M4 16C4 8 16 12 16 4" },
	{ route: "elbow", label: "Elbow", icon: "M4 16V10H16V4" },
	{ route: "straight", label: "Straight", icon: "M4 16L16 4" },
];

const NEXT_ARROW: Record<ConnectorArrow, ConnectorArrow> = {
	end: "both",
	both: "none",
	none: "end",
};
const ARROW_ICON: Record<ConnectorArrow, string> = {
	end: "M3 10H16M12 6l4 4-4 4",
	both: "M4 10H16M12 6l4 4-4 4M8 6l-4 4 4 4",
	none: "M3 10H17",
};

/** Style controls for the selected connector, floating above its middle. */
function ConnectorToolbar({
	at,
	connector,
	onStyle,
	onLabel,
	onDelete,
	extra,
}: {
	at: Point;
	connector: Connector;
	onStyle: (style: Partial<Pick<Connector, "route" | "arrow" | "dash" | "color">>) => void;
	onLabel: () => void;
	onDelete: () => void;
	extra?: ReactNode;
}) {
	const inner = useRef<HTMLDivElement>(null);
	useInsideCanvas(inner);
	return (
		<div
			className="connector-toolbar connector-ui nodrag nopan"
			data-labelled={connector.label !== ""}
			role="toolbar"
			aria-label="Connector"
			style={{ transform: `translate(${at.x}px, ${at.y}px) scale(var(--inv-zoom, 1))` }}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			<div ref={inner} className="connector-toolbar-inner">
				{ROUTES.map(({ route, label, icon }) => (
					<button
						key={route}
						type="button"
						aria-label={label}
						title={label}
						aria-pressed={connector.route === route}
						onClick={() => onStyle({ route })}
					>
						<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
							<path d={icon} />
						</svg>
					</button>
				))}
				<span className="connector-toolbar-divider" />
				<button
					type="button"
					aria-label={`Arrowheads: ${connector.arrow}`}
					title="Arrowheads"
					onClick={() => onStyle({ arrow: NEXT_ARROW[connector.arrow] })}
				>
					<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
						<path d={ARROW_ICON[connector.arrow]} />
					</svg>
				</button>
				<button
					type="button"
					aria-label="Dashed"
					title="Dashed"
					aria-pressed={connector.dash}
					onClick={() => onStyle({ dash: !connector.dash })}
				>
					<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
						<path d="M3 10H17" strokeDasharray="3 3" />
					</svg>
				</button>
				<span className="connector-toolbar-divider" />
				{CONNECTOR_COLORS.map((color) => (
					<button
						key={color}
						type="button"
						className="connector-swatch"
						data-color={color}
						aria-label={color}
						aria-pressed={connector.color === color}
						onClick={() => onStyle({ color })}
					/>
				))}
				<span className="connector-toolbar-divider" />
				<button type="button" aria-label="Label" title="Label (Enter)" onClick={onLabel}>
					<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
						<path d="M5 15L10 4l5 11M7 11h6" />
					</svg>
				</button>
				<button type="button" aria-label="Delete" title="Delete (⌫)" onClick={onDelete}>
					<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
						<path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
					</svg>
				</button>
				{extra}
			</div>
		</div>
	);
}

/**
 * A connector drawn on its own, outside the canvas: for the gallery. Shapes
 * are drawn as plain boxes so bound ends have something to attach to.
 */
export function ConnectorSample({
	connector,
	boxes,
	width,
	height,
	selected = false,
}: {
	connector: Connector;
	boxes: Map<string, Rect>;
	width: number;
	height: number;
	selected?: boolean;
}) {
	const geometry = geometryOf(connector, (id) => boxes.get(id));
	return (
		<div className="connector-sample" style={{ width, height }}>
			<svg className="connectors" width={width} height={height} aria-hidden="true">
				{[...boxes].map(([id, box]) => (
					<rect
						key={id}
						className="connector-sample-shape"
						x={box.x}
						y={box.y}
						width={box.w}
						height={box.h}
						rx={8}
					/>
				))}
				<g className="connector" data-color={connector.color} data-selected={selected}>
					<path className="connector-halo" d={geometry.d} />
					<path className="connector-line" d={geometry.d} data-dash={connector.dash} />
					{geometry.heads && <path className="connector-head" d={geometry.heads} />}
				</g>
			</svg>
			{connector.label && (
				<div
					className="connector-label"
					data-color={connector.color}
					style={{
						transform: `translate(${geometry.middle.x}px, ${geometry.middle.y}px) translate(-50%, -50%)`,
					}}
				>
					{connector.label}
				</div>
			)}
		</div>
	);
}
