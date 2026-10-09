import { ViewportPortal, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
	type Point,
	type Rect,
	boundsOf,
	contains,
	distanceToPolyline,
} from "../../shared/geometry.ts";
import "./probe.css";

// The React Flow probe's pen prototype (see docs/react-flow-probe.md): pen
// strokes on our own SVG layer inside the viewport, with our own hit
// testing rather than the DOM's. Strokes live in their own map in the
// playground's document; this isn't part of the board schema yet.

export type PenMode = "off" | "pen" | "eraser";

interface Stroke {
	id: string;
	points: Point[];
	bounds: Rect;
	color: string;
}

/** Stroke colours, from the connector palette so both themes have them. */
const COLORS = ["ink", "red", "blue", "green"];
const strokeColor = (color: string) => `var(--connector-${color})`;

function strokesMap(doc: Y.Doc): Y.Map<{ points: number[]; color: string }> {
	return doc.getMap("probe:strokes");
}

function toStroke(id: string, value: { points: number[]; color: string }): Stroke {
	const points: Point[] = [];
	for (let i = 0; i + 1 < value.points.length; i += 2) {
		points.push({ x: value.points[i] as number, y: value.points[i + 1] as number });
	}
	return { id, points, bounds: boundsOf(points) ?? { x: 0, y: 0, w: 0, h: 0 }, color: value.color };
}

function useStrokes(doc: Y.Doc): Stroke[] {
	const store = useMemo(() => {
		const map = strokesMap(doc);
		let snapshot: Stroke[] = [];
		const cache = new Map<string, Stroke>();
		const rebuild = () => {
			const next: Stroke[] = [];
			for (const [id, value] of map) {
				let stroke = cache.get(id);
				if (!stroke) {
					stroke = toStroke(id, value);
					cache.set(id, stroke);
				}
				next.push(stroke);
			}
			for (const id of cache.keys()) if (!map.has(id)) cache.delete(id);
			snapshot = next;
		};
		rebuild();
		return {
			getSnapshot: () => snapshot,
			subscribe: (listener: () => void) => {
				const observer = () => {
					rebuild();
					listener();
				};
				map.observe(observer);
				return () => map.unobserve(observer);
			},
		};
	}, [doc]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Smooth a polyline through the midpoints of its segments. */
function strokePath(points: Point[]): string {
	const first = points[0];
	if (!first) return "";
	if (points.length < 3) {
		return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
	}
	let d = `M${first.x},${first.y}`;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i] as Point;
		const next = points[i + 1] as Point;
		d += ` Q${p.x},${p.y} ${(p.x + next.x) / 2},${(p.y + next.y) / 2}`;
	}
	const last = points[points.length - 1] as Point;
	return `${d} L${last.x},${last.y}`;
}

/**
 * Strokes within `tolerance` of a point, by geometry alone: a bounding box
 * check, then the distance to each stroke's polyline.
 */
export function strokesAt(strokes: Stroke[], point: Point, tolerance: number): string[] {
	const hits: string[] = [];
	for (const stroke of strokes) {
		if (!contains(stroke.bounds, point, tolerance)) continue;
		if (distanceToPolyline(point, stroke.points) <= tolerance) hits.push(stroke.id);
	}
	return hits;
}

export function PenProbe({
	doc,
	mode,
	onStats,
}: {
	doc: Y.Doc;
	mode: PenMode;
	onStats: (stats: string) => void;
}) {
	const strokes = useStrokes(doc);
	const store = useStoreApi();
	const flow = useReactFlow();
	const zoom = useStore((state) => state.transform[2]);
	const [draft, setDraft] = useState<Point[] | null>(null);
	const [hover, setHover] = useState<string[]>([]);
	const live = useRef({ strokes, zoom });
	live.current = { strokes, zoom };
	const color = useRef(COLORS[0] as string);

	useEffect(() => {
		if (mode === "off") return;
		const dom = store.getState().domNode;
		if (!dom) return;
		const erase = (point: Point) => {
			const started = performance.now();
			const { strokes, zoom } = live.current;
			const hits = strokesAt(strokes, point, 8 / zoom);
			const ms = performance.now() - started;
			onStats(`Hit test: ${strokes.length} strokes in ${ms.toFixed(2)} ms`);
			if (hits.length > 0) doc.transact(() => hits.forEach((id) => strokesMap(doc).delete(id)));
		};
		const onHover = (event: PointerEvent) => {
			if (mode !== "eraser" || event.buttons) return;
			const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
			setHover(strokesAt(live.current.strokes, point, 8 / live.current.zoom));
		};
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0 || (event.target as Element | null)?.closest(".react-flow__panel")) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const at = (e: PointerEvent) => flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
			const points: Point[] = [at(event)];
			if (mode === "eraser") erase(points[0] as Point);
			else setDraft([...points]);
			const onMove = (move: PointerEvent) => {
				const point = at(move);
				if (mode === "eraser") return erase(point);
				const last = points[points.length - 1] as Point;
				// Skip points closer than a screen pixel or two.
				if (Math.hypot(point.x - last.x, point.y - last.y) * live.current.zoom < 2) return;
				points.push(point);
				setDraft([...points]);
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				setDraft(null);
				if (mode !== "pen" || points.length < 2) return;
				strokesMap(doc).set(crypto.randomUUID(), {
					points: points.flatMap((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
					color: color.current,
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		};
		dom.addEventListener("pointerdown", onDown, true);
		dom.addEventListener("pointermove", onHover);
		return () => {
			dom.removeEventListener("pointerdown", onDown, true);
			dom.removeEventListener("pointermove", onHover);
			setHover([]);
		};
	}, [mode, store, flow, doc, onStats]);

	const hovered = new Set(hover);
	return (
		<ViewportPortal>
			<svg className="pen-probe" data-mode={mode} aria-hidden="true">
				{strokes.map((stroke) => (
					<path
						key={stroke.id}
						d={strokePath(stroke.points)}
						stroke={strokeColor(stroke.color)}
						data-hover={hovered.has(stroke.id)}
					/>
				))}
				{draft && <path d={strokePath(draft)} stroke={strokeColor(color.current)} />}
			</svg>
		</ViewportPortal>
	);
}

/** Scribble lots of strokes, to measure rendering and hit testing at scale. */
export function scribble(doc: Y.Doc, count: number, around: Point): void {
	doc.transact(() => {
		for (let n = 0; n < count; n++) {
			const start = {
				x: around.x + (Math.random() - 0.5) * 2400,
				y: around.y + (Math.random() - 0.5) * 1600,
			};
			const points: number[] = [];
			let angle = Math.random() * Math.PI * 2;
			let { x, y } = start;
			for (let i = 0; i < 40; i++) {
				angle += (Math.random() - 0.5) * 0.6;
				x += Math.cos(angle) * 6;
				y += Math.sin(angle) * 6;
				points.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
			}
			strokesMap(doc).set(crypto.randomUUID(), {
				points,
				color: COLORS[n % COLORS.length] as string,
			});
		}
	});
}
