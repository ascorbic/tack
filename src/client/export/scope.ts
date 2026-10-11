import type { ShapeProps } from "../../shared/shapes.ts";
import type { Rect } from "../snapping.ts";

// What an image export draws (#59), pure so it's unit-tested in Node: which
// shapes (a selection, with what's inside its sections and the connectors
// between what's drawn), the region around them, and how big the image can
// be at a scale before a browser refuses to draw it.

/** Space around what's drawn, in board units. */
export const EXPORT_PADDING = 40;
/** Longest side, and most pixels, a canvas reliably takes across browsers. */
export const MAX_SIDE = 16_384;
export const MAX_PIXELS = 100_000_000;
export const SCALES = [1, 2, 3, 4] as const;

/**
 * The shapes a selection exports: what's selected, everything inside a
 * selected section (however deep), and the connectors whose ends are both
 * on what's drawn (or that are selected themselves, ends and all).
 */
export function selectionScope(
	shapes: ReadonlyMap<string, ShapeProps>,
	selected: Iterable<string>,
): Set<string> {
	const scope = new Set<string>();
	for (const id of selected) if (shapes.has(id)) scope.add(id);
	// Sections hold what's inside them: take it all, at any depth.
	let grew = true;
	while (grew) {
		grew = false;
		for (const [id, shape] of shapes) {
			if (scope.has(id) || typeof shape.parent !== "string" || !scope.has(shape.parent)) continue;
			scope.add(id);
			grew = true;
		}
	}
	for (const [id, shape] of shapes) {
		if (shape.type !== "connector" || scope.has(id)) continue;
		const ends = [shape.from?.shape, shape.to?.shape];
		if (ends.every((end) => end === undefined || scope.has(end)) && ends.some(Boolean)) {
			scope.add(id);
		}
	}
	return scope;
}

/** The region around some boxes, padded; null if there are none. */
export function exportRegion(boxes: Iterable<Rect>, padding = EXPORT_PADDING): Rect | null {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const box of boxes) {
		if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
		left = Math.min(left, box.x);
		top = Math.min(top, box.y);
		right = Math.max(right, box.x + box.width);
		bottom = Math.max(bottom, box.y + box.height);
	}
	if (left === Infinity) return null;
	return {
		x: Math.floor(left - padding),
		y: Math.floor(top - padding),
		width: Math.ceil(right - left + padding * 2),
		height: Math.ceil(bottom - top + padding * 2),
	};
}

/**
 * The image's size at a scale, and the scale it can actually have: brought
 * down, if need be, to stay within what browsers will draw.
 */
export function imageSize(
	region: Pick<Rect, "width" | "height">,
	scale: number,
): { width: number; height: number; scale: number; capped: boolean } {
	const side = Math.max(region.width, region.height, 1);
	const area = Math.max(region.width * region.height, 1);
	const most = Math.min(MAX_SIDE / side, Math.sqrt(MAX_PIXELS / area));
	const actual = Math.min(scale, most);
	return {
		width: Math.max(1, Math.round(region.width * actual)),
		height: Math.max(1, Math.round(region.height * actual)),
		scale: actual,
		capped: actual < scale,
	};
}
