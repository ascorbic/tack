// Snapping a dragged shape (or selection) to other shapes' edges and centres,
// and the guides that show what it snapped to. Pure geometry in flow
// coordinates, so it works for any shape with a bounding box.

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A guide line. `axis: "x"` is a vertical line at x = `at`, running from y =
 * `from` to y = `to`; `axis: "y"` is a horizontal line at y = `at`.
 */
export interface Guide {
	axis: "x" | "y";
	at: number;
	from: number;
	to: number;
}

export interface Snap {
	/** How far to move the dragged box to snap it. */
	dx: number;
	dy: number;
	guides: Guide[];
}

/** Snap distance in screen pixels; divide by zoom for flow units. */
export const SNAP_PX = 6;

/** Alignment within this distance counts as exact, for drawing guides. */
const EPSILON = 0.5;

type Axis = "x" | "y";

/** Left/top, centre and right/bottom lines of a rect along an axis. */
function lines(rect: Rect, axis: Axis): [number, number, number] {
	const start = axis === "x" ? rect.x : rect.y;
	const size = axis === "x" ? rect.width : rect.height;
	return [start, start + size / 2, start + size];
}

/** The rect's extent across the axis: where a guide along it should span. */
function span(rect: Rect, axis: Axis): [number, number] {
	return axis === "x" ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width];
}

function snapAxis(moving: Rect, targets: Rect[], axis: Axis, threshold: number): number {
	const own = lines(moving, axis);
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const target of targets) {
		for (const line of lines(target, axis)) {
			for (const mine of own) {
				const delta = line - mine;
				const distance = Math.abs(delta);
				// Strictly closer wins, so ties keep the first match found.
				if (distance <= threshold && distance < bestDistance) {
					best = delta;
					bestDistance = distance;
				}
			}
		}
	}
	return best;
}

function guidesFor(moving: Rect, targets: Rect[], axis: Axis): Guide[] {
	const byLine = new Map<number, Guide>();
	const own = lines(moving, axis);
	const [ownFrom, ownTo] = span(moving, axis);
	for (const target of targets) {
		const [from, to] = span(target, axis);
		for (const line of lines(target, axis)) {
			if (!own.some((mine) => Math.abs(mine - line) < EPSILON)) continue;
			const key = Math.round(line * 2) / 2;
			const existing = byLine.get(key);
			byLine.set(key, {
				axis,
				at: line,
				from: Math.min(existing?.from ?? ownFrom, from, ownFrom),
				to: Math.max(existing?.to ?? ownTo, to, ownTo),
			});
		}
	}
	return [...byLine.values()];
}

/**
 * Snap `moving` to the nearest edge or centre of any target within
 * `threshold` (in flow units), independently on each axis, and return the
 * guides for every alignment the snapped box makes.
 */
export function snapRect(moving: Rect, targets: Rect[], threshold: number): Snap {
	const dx = snapAxis(moving, targets, "x", threshold);
	const dy = snapAxis(moving, targets, "y", threshold);
	const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
	return {
		dx,
		dy,
		guides: [...guidesFor(snapped, targets, "x"), ...guidesFor(snapped, targets, "y")],
	};
}

/** The smallest rect containing all of `rects`, or null if there are none. */
export function unionRect(rects: Iterable<Rect>): Rect | null {
	let x1 = Number.POSITIVE_INFINITY;
	let y1 = Number.POSITIVE_INFINITY;
	let x2 = Number.NEGATIVE_INFINITY;
	let y2 = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		x1 = Math.min(x1, rect.x);
		y1 = Math.min(y1, rect.y);
		x2 = Math.max(x2, rect.x + rect.width);
		y2 = Math.max(y2, rect.y + rect.height);
	}
	return x1 === Number.POSITIVE_INFINITY ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function intersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
