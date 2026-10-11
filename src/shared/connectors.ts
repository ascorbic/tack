import {
	type Anchor,
	type Point,
	type Rect,
	type Side,
	anchorPoint,
	anchorSide,
	centre,
	clipToOutline,
	contains,
	distance,
	nearestOutlineAnchor,
	pointAlong,
	sideNormal,
} from "./geometry.ts";
import type { ConnectorArrow, ConnectorEnd, ConnectorRoute, ShapeProps } from "./shapes.ts";

// Connector geometry: where each end sits, how the line between them is
// routed, and what a pointer is over when drawing one. Pure functions over
// boxes, so the client can render from measured sizes and the server can
// reason about bindings with none.

export const CONNECTOR_COLORS = ["ink", "red", "orange", "green", "blue", "purple"] as const;
export type ConnectorColor = (typeof CONNECTOR_COLORS)[number];

export const DEFAULT_ROUTE: ConnectorRoute = "curved";
export const DEFAULT_ARROW: ConnectorArrow = "end";

/** Space left between a bound end and its shape's outline. */
export const END_GAP = 5;

export interface Connector {
	from: ConnectorEnd;
	to: ConnectorEnd;
	route: ConnectorRoute;
	arrow: ConnectorArrow;
	dash: boolean;
	color: ConnectorColor;
	label: string;
}

/** Read a connector shape tolerantly, or null if it has no usable ends. */
export function readConnector(shape: Partial<ShapeProps>): Connector | null {
	if (!isEnd(shape.from) || !isEnd(shape.to)) return null;
	return {
		from: shape.from,
		to: shape.to,
		route: shape.route === "straight" || shape.route === "elbow" ? shape.route : DEFAULT_ROUTE,
		arrow: shape.arrow === "both" || shape.arrow === "none" ? shape.arrow : DEFAULT_ARROW,
		dash: shape.dash === true,
		color: (CONNECTOR_COLORS as readonly string[]).includes(shape.color ?? "")
			? (shape.color as ConnectorColor)
			: "ink",
		label: typeof shape.label === "string" ? shape.label : "",
	};
}

export function isEnd(value: unknown): value is ConnectorEnd {
	if (typeof value !== "object" || value === null) return false;
	const end = value as Partial<ConnectorEnd>;
	return Number.isFinite(end.x) && Number.isFinite(end.y);
}

export function isAnchor(value: unknown): value is Anchor {
	if (typeof value !== "object" || value === null) return false;
	const anchor = value as Partial<Anchor>;
	return (
		typeof anchor.x === "number" &&
		typeof anchor.y === "number" &&
		anchor.x >= 0 &&
		anchor.x <= 1 &&
		anchor.y >= 0 &&
		anchor.y <= 1
	);
}

/** Where an end actually is, once its shape (if any) has been looked up. */
export interface ResolvedEnd {
	point: Point;
	/** The direction the line leaves in, for bound ends. */
	normal: Point | null;
	/** The shape it's attached to, if that shape exists. */
	shape: string | null;
}

/**
 * Resolve both ends of a connector against the shapes' boxes. A bound end
 * whose shape has gone is drawn as a loose end where it was attached, so
 * dangling bindings render sensibly until they're repaired.
 */
export function resolveEnds(
	from: ConnectorEnd,
	to: ConnectorEnd,
	boxOf: (id: string) => Rect | undefined,
	gap = END_GAP,
): { start: ResolvedEnd; end: ResolvedEnd } {
	const fromBox = from.shape ? boxOf(from.shape) : undefined;
	const toBox = to.shape ? boxOf(to.shape) : undefined;
	// What each end aims at when it floats around its shape's outline.
	const aim = (end: ConnectorEnd, box: Rect | undefined): Point => {
		if (!box) return { x: end.x, y: end.y };
		if (isAnchor(end.anchor)) return anchorPoint(box, end.anchor);
		return centre(box);
	};
	const resolve = (end: ConnectorEnd, box: Rect | undefined, other: Point): ResolvedEnd => {
		if (!box || !end.shape) return { point: { x: end.x, y: end.y }, normal: null, shape: null };
		let point: Point;
		let side: Side;
		if (isAnchor(end.anchor)) {
			point = anchorPoint(box, end.anchor);
			side = anchorSide(end.anchor);
		} else {
			({ point, side } = clipToOutline(box, other));
		}
		const normal = sideNormal(side);
		return {
			point: { x: point.x + normal.x * gap, y: point.y + normal.y * gap },
			normal,
			shape: end.shape,
		};
	};
	return {
		start: resolve(from, fromBox, aim(to, toBox)),
		end: resolve(to, toBox, aim(from, fromBox)),
	};
}

export interface Route {
	/** SVG path data. */
	d: string;
	/** The route as a polyline, for hit testing and placing the label. */
	points: Point[];
	/** The middle of the route, where the label goes. */
	middle: Point;
	/** Direction of travel arriving at each end, in radians. */
	startAngle: number;
	endAngle: number;
}

/** Arrowhead size, in multiples of the stroke width. */
const ARROW_LENGTH = 5.5;
const ARROW_WIDTH = 5;

/**
 * Route a line between two resolved ends. `trim` shortens each end (for the
 * arrowheads), measured along the direction of travel.
 */
export function routeConnector(
	start: ResolvedEnd,
	end: ResolvedEnd,
	kind: ConnectorRoute,
	trim: { start: number; end: number } = { start: 0, end: 0 },
): Route {
	const points =
		kind === "straight"
			? [start.point, end.point]
			: kind === "elbow"
				? elbowPoints(start, end)
				: curvePoints(start, end);
	const startAngle = angleOf(points[1] ?? end.point, points[0] ?? start.point);
	const endAngle = angleOf(
		points[points.length - 2] ?? start.point,
		points[points.length - 1] ?? end.point,
	);
	const middle = pointAlong(points, 0.5);

	// Trim the drawn line so it stops inside the arrowheads.
	const s = towards(start.point, startAngle + Math.PI, trim.start);
	const e = towards(end.point, endAngle, -trim.end);
	let d: string;
	if (kind === "curved") {
		const [c1, c2] = curveControls(start, end);
		d = `M${fmt(s)} C${fmt(c1)} ${fmt(c2)} ${fmt(e)}`;
	} else if (kind === "elbow") {
		const trimmed = [...points];
		trimmed[0] = s;
		trimmed[trimmed.length - 1] = e;
		d = roundedPolyline(trimmed, 12);
	} else {
		d = `M${fmt(s)} L${fmt(e)}`;
	}
	return { d, points, middle, startAngle, endAngle };
}

/** An arrowhead with its tip at `tip`, pointing along `angle`. */
export function arrowHead(tip: Point, angle: number, strokeWidth: number): string {
	const length = ARROW_LENGTH * strokeWidth + 3;
	const half = (ARROW_WIDTH * strokeWidth + 2) / 2;
	const back = towards(tip, angle, -length);
	const nx = -Math.sin(angle);
	const ny = Math.cos(angle);
	const left = { x: back.x + nx * half, y: back.y + ny * half };
	const right = { x: back.x - nx * half, y: back.y - ny * half };
	return `M${fmt(left)} L${fmt(tip)} L${fmt(right)} Z`;
}

/** How far to pull a line back from an end that has an arrowhead. */
export function arrowTrim(strokeWidth: number): number {
	return ARROW_LENGTH * strokeWidth;
}

function curveControls(start: ResolvedEnd, end: ResolvedEnd): [Point, Point] {
	const length = distance(start.point, end.point);
	const reach = Math.min(Math.max(length * 0.45, 28), 220);
	const control = (from: ResolvedEnd): Point =>
		from.normal
			? { x: from.point.x + from.normal.x * reach, y: from.point.y + from.normal.y * reach }
			: from.point;
	return [control(start), control(end)];
}

function curvePoints(start: ResolvedEnd, end: ResolvedEnd): Point[] {
	const [c1, c2] = curveControls(start, end);
	const p0 = start.point;
	const p3 = end.point;
	const points: Point[] = [];
	const steps = 24;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		points.push({
			x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
		});
	}
	return points;
}

const STUB = 20;

/**
 * An orthogonal route. Each end leaves along its side's normal (loose ends
 * pick the axis facing the other end), then the route turns at most twice.
 */
function elbowPoints(start: ResolvedEnd, end: ResolvedEnd): Point[] {
	const s = start.point;
	const e = end.point;
	const n1 = start.normal ?? axisToward(s, e);
	const n2 = end.normal ?? axisToward(e, s);
	const a = start.normal ? { x: s.x + n1.x * STUB, y: s.y + n1.y * STUB } : s;
	const b = end.normal ? { x: e.x + n2.x * STUB, y: e.y + n2.y * STUB } : e;
	const horizontal1 = n1.x !== 0;
	const horizontal2 = n2.x !== 0;
	const middle: Point[] = [];
	if (horizontal1 && horizontal2) {
		const ahead = (b.x - a.x) * n1.x >= 0 && (a.x - b.x) * n2.x >= 0;
		if (ahead) {
			const mx = (a.x + b.x) / 2;
			middle.push({ x: mx, y: a.y }, { x: mx, y: b.y });
		} else {
			const my = (a.y + b.y) / 2;
			middle.push({ x: a.x, y: my }, { x: b.x, y: my });
		}
	} else if (!horizontal1 && !horizontal2) {
		const ahead = (b.y - a.y) * n1.y >= 0 && (a.y - b.y) * n2.y >= 0;
		if (ahead) {
			const my = (a.y + b.y) / 2;
			middle.push({ x: a.x, y: my }, { x: b.x, y: my });
		} else {
			const mx = (a.x + b.x) / 2;
			middle.push({ x: mx, y: a.y }, { x: mx, y: b.y });
		}
	} else if (horizontal1) {
		const corner = { x: b.x, y: a.y };
		if ((corner.x - a.x) * n1.x >= 0 && (corner.y - b.y) * n2.y >= 0) middle.push(corner);
		else middle.push({ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 });
	} else {
		const corner = { x: a.x, y: b.y };
		if ((corner.y - a.y) * n1.y >= 0 && (corner.x - b.x) * n2.x >= 0) middle.push(corner);
		else middle.push({ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y });
	}
	return simplify([s, a, ...middle, b, e]);
}

function axisToward(from: Point, to: Point): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
	return { x: 0, y: dy >= 0 ? 1 : -1 };
}

/** Drop repeated and collinear points. */
function simplify(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const point of points) {
		const last = out[out.length - 1];
		if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) continue;
		const before = out[out.length - 2];
		if (last && before) {
			const cross =
				(last.x - before.x) * (point.y - last.y) - (last.y - before.y) * (point.x - last.x);
			if (Math.abs(cross) < 0.5) out.pop();
		}
		out.push(point);
	}
	return out;
}

/** A polyline with its corners rounded off. */
function roundedPolyline(points: Point[], radius: number): string {
	const first = points[0];
	if (!first) return "";
	let d = `M${fmt(first)}`;
	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1] as Point;
		const corner = points[i] as Point;
		const next = points[i + 1] as Point;
		const r = Math.min(radius, distance(prev, corner) / 2, distance(corner, next) / 2);
		const enter = towards(corner, angleOf(corner, prev), r);
		const leave = towards(corner, angleOf(corner, next), r);
		d += ` L${fmt(enter)} Q${fmt(corner)} ${fmt(leave)}`;
	}
	const last = points[points.length - 1] as Point;
	return `${d} L${fmt(last)}`;
}

function angleOf(from: Point, to: Point): number {
	return Math.atan2(to.y - from.y, to.x - from.x);
}

function towards(point: Point, angle: number, by: number): Point {
	return { x: point.x + Math.cos(angle) * by, y: point.y + Math.sin(angle) * by };
}

function fmt(point: Point): string {
	return `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`;
}

export interface Target {
	id: string;
	type: ShapeProps["type"];
	box: Rect;
}

/**
 * What an end dropped at `point` attaches to. `targets` run topmost first.
 * Near a shape's outline (within `snap`) the end pins to that spot, and near
 * the middle of a side it snaps to the middle exactly. Further inside, it
 * floats around the outline. Sections only take ends near their outline, so
 * an end can still be left loose inside one.
 */
export function endAt(
	point: Point,
	targets: Iterable<Target>,
	snap: number,
	exclude?: ReadonlySet<string>,
): ConnectorEnd {
	for (const target of targets) {
		if (exclude?.has(target.id) || target.type === "connector") continue;
		if (!contains(target.box, point, snap)) continue;
		const nearest = nearestOutlineAnchor(target.box, point);
		if (nearest.distance <= snap) {
			const anchor = roundAnchor(snapToMiddle(target.box, nearest.anchor, snap * 1.5));
			const at = anchorPoint(target.box, anchor);
			return { x: at.x, y: at.y, shape: target.id, anchor };
		}
		if (target.type === "section") continue;
		const at = centre(target.box);
		return { x: at.x, y: at.y, shape: target.id };
	}
	return { x: point.x, y: point.y };
}

function roundAnchor(anchor: Anchor): Anchor {
	return { x: Math.round(anchor.x * 1000) / 1000, y: Math.round(anchor.y * 1000) / 1000 };
}

function snapToMiddle(box: Rect, anchor: Anchor, within: number): Anchor {
	const onVertical = anchor.x === 0 || anchor.x === 1;
	if (onVertical && Math.abs(anchor.y - 0.5) * box.h <= within) return { x: anchor.x, y: 0.5 };
	if (!onVertical && Math.abs(anchor.x - 0.5) * box.w <= within) return { x: 0.5, y: anchor.y };
	return anchor;
}

/**
 * The ends as they should be stored: bound ends carry their current resolved
 * point (without the gap) as the fallback for if their shape disappears.
 */
export function withFallbacks(
	from: ConnectorEnd,
	to: ConnectorEnd,
	boxOf: (id: string) => Rect | undefined,
): { from: ConnectorEnd; to: ConnectorEnd } {
	const { start, end } = resolveEnds(from, to, boxOf, 0);
	const round = (point: Point) => ({ x: Math.round(point.x), y: Math.round(point.y) });
	return {
		from: { ...from, ...round(start.point) },
		to: { ...to, ...round(end.point) },
	};
}

/** Strip a binding, leaving a loose end at `at`. */
export function looseEnd(at: Point): ConnectorEnd {
	return { x: Math.round(at.x), y: Math.round(at.y) };
}

/** Roughly how wide a label is, in board units: 13px type, and its padding. */
export function labelWidth(label: string): number {
	return 16 + 7.2 * Math.max(label.length, 5);
}

/**
 * Where a connector's label goes: on the middle of its route, or, when the
 * route is too short to show it there (two shapes close together), just
 * beside the middle, off the line: above it, or left of an upright one.
 */
export function labelPoint(route: Pick<Route, "points" | "middle">, label: string): Point {
	const first = route.points[0];
	const last = route.points.at(-1);
	if (!first || !last) return route.middle;
	let length = 0;
	for (let i = 1; i < route.points.length; i++) {
		const a = route.points[i - 1]!;
		const b = route.points[i]!;
		length += Math.hypot(b.x - a.x, b.y - a.y);
	}
	const width = labelWidth(label);
	if (length >= width + 24) return route.middle;
	const dx = last.x - first.x;
	const dy = last.y - first.y;
	const span = Math.hypot(dx, dy);
	if (span === 0) return { x: route.middle.x, y: route.middle.y - 22 };
	// The side of the line that's up, or left for an upright line.
	let nx = -dy / span;
	let ny = dx / span;
	if (ny > 0 || (ny === 0 && nx > 0)) {
		nx = -nx;
		ny = -ny;
	}
	// Clear of the line: half the label's height, and its half-width sideways.
	const by = 22 + (Math.abs(nx) * width) / 2;
	return { x: route.middle.x + nx * by, y: route.middle.y + ny * by };
}
