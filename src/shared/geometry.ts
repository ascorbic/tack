// Plain 2D geometry in board coordinates, shared by the client (rendering,
// hit testing) and the server (repair). Nothing here knows about React Flow.

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type Side = "top" | "right" | "bottom" | "left";

/**
 * A point on a shape's box as fractions of its width and height: `{x: 0,
 * y: 0}` is the top-left corner, `{x: 0.5, y: 1}` the middle of the bottom
 * edge. Anchors survive the shape moving and resizing.
 */
export type Anchor = Point;

export function centre(rect: Rect): Point {
	return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function area(rect: Rect): number {
	return rect.w * rect.h;
}

export function contains(rect: Rect, point: Point, pad = 0): boolean {
	return (
		point.x >= rect.x - pad &&
		point.x <= rect.x + rect.w + pad &&
		point.y >= rect.y - pad &&
		point.y <= rect.y + rect.h + pad
	);
}

export function intersects(a: Rect, b: Rect): boolean {
	return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** The rectangle spanning two corners, in any order. */
export function rectFromPoints(a: Point, b: Point): Rect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		w: Math.abs(a.x - b.x),
		h: Math.abs(a.y - b.y),
	};
}

export function translate(rect: Rect, by: Point): Rect {
	return { ...rect, x: rect.x + by.x, y: rect.y + by.y };
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function anchorPoint(rect: Rect, anchor: Anchor): Point {
	return { x: rect.x + rect.w * anchor.x, y: rect.y + rect.h * anchor.y };
}

/** The edge an anchor is on, or nearest to. */
export function anchorSide(anchor: Anchor): Side {
	const distances: [Side, number][] = [
		["left", anchor.x],
		["right", 1 - anchor.x],
		["top", anchor.y],
		["bottom", 1 - anchor.y],
	];
	distances.sort((a, b) => a[1] - b[1]);
	return distances[0]?.[0] ?? "right";
}

export function sideNormal(side: Side): Point {
	switch (side) {
		case "top":
			return { x: 0, y: -1 };
		case "bottom":
			return { x: 0, y: 1 };
		case "left":
			return { x: -1, y: 0 };
		case "right":
			return { x: 1, y: 0 };
	}
}

/**
 * The nearest point on a rectangle's outline to `point`, as an anchor, and
 * how far away it is. Works from inside and outside the rectangle.
 */
export function nearestOutlineAnchor(
	rect: Rect,
	point: Point,
): { anchor: Anchor; distance: number } {
	const w = Math.max(rect.w, 1);
	const h = Math.max(rect.h, 1);
	const fx = clamp((point.x - rect.x) / w, 0, 1);
	const fy = clamp((point.y - rect.y) / h, 0, 1);
	const inside = contains(rect, point);
	let anchor: Anchor;
	if (inside) {
		// Push out to the closest edge.
		const toEdge: [number, Anchor][] = [
			[point.x - rect.x, { x: 0, y: fy }],
			[rect.x + rect.w - point.x, { x: 1, y: fy }],
			[point.y - rect.y, { x: fx, y: 0 }],
			[rect.y + rect.h - point.y, { x: fx, y: 1 }],
		];
		toEdge.sort((a, b) => a[0] - b[0]);
		anchor = toEdge[0]?.[1] ?? { x: fx, y: fy };
	} else {
		anchor = { x: fx, y: fy };
	}
	return { anchor, distance: distance(anchorPoint(rect, anchor), point) };
}

/**
 * Where a ray from the rectangle's centre towards `toward` crosses its
 * outline, and which side it leaves by.
 */
export function clipToOutline(rect: Rect, toward: Point): { point: Point; side: Side } {
	const c = centre(rect);
	const dx = toward.x - c.x;
	const dy = toward.y - c.y;
	if (dx === 0 && dy === 0) return { point: { x: c.x + rect.w / 2, y: c.y }, side: "right" };
	const halfW = rect.w / 2;
	const halfH = rect.h / 2;
	// Scale the direction so it just reaches the nearer pair of edges.
	const sx = dx === 0 ? Infinity : halfW / Math.abs(dx);
	const sy = dy === 0 ? Infinity : halfH / Math.abs(dy);
	if (sx < sy) {
		return { point: { x: c.x + dx * sx, y: c.y + dy * sx }, side: dx > 0 ? "right" : "left" };
	}
	return { point: { x: c.x + dx * sy, y: c.y + dy * sy }, side: dy > 0 ? "bottom" : "top" };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return distance(p, a);
	const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function distanceToPolyline(p: Point, points: readonly Point[]): number {
	if (points.length === 0) return Infinity;
	if (points.length === 1) return distance(p, points[0] as Point);
	let best = Infinity;
	for (let i = 1; i < points.length; i++) {
		best = Math.min(best, distanceToSegment(p, points[i - 1] as Point, points[i] as Point));
	}
	return best;
}

export function boundsOf(points: readonly Point[]): Rect | null {
	if (points.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const { x, y } of points) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The point at `t` along a polyline's length (0 = start, 1 = end). */
export function pointAlong(points: readonly Point[], t: number): Point {
	if (points.length === 0) return { x: 0, y: 0 };
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += distance(points[i - 1] as Point, points[i] as Point);
	}
	let remaining = total * clamp(t, 0, 1);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Point;
		const b = points[i] as Point;
		const length = distance(a, b);
		if (remaining <= length && length > 0) {
			const f = remaining / length;
			return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
		}
		remaining -= length;
	}
	return points[points.length - 1] as Point;
}

/** Whether a polyline passes through (or lies inside) a rectangle. */
export function polylineIntersectsRect(points: readonly Point[], rect: Rect): boolean {
	if (points.some((point) => contains(rect, point))) return true;
	const corners: Point[] = [
		{ x: rect.x, y: rect.y },
		{ x: rect.x + rect.w, y: rect.y },
		{ x: rect.x + rect.w, y: rect.y + rect.h },
		{ x: rect.x, y: rect.y + rect.h },
	];
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Point;
		const b = points[i] as Point;
		for (let j = 0; j < 4; j++) {
			if (segmentsCross(a, b, corners[j] as Point, corners[(j + 1) % 4] as Point)) return true;
		}
	}
	return false;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
	const side = (p: Point, q: Point, r: Point) =>
		(q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	const d1 = side(c, d, a);
	const d2 = side(c, d, b);
	const d3 = side(a, b, c);
	const d4 = side(a, b, d);
	return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
