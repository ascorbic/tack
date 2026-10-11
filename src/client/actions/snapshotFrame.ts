import type { Rect } from "../snapping.ts";

// Where a backlink's snapshot is framed (#33, review finding 12.3): the
// selection and what's around it, with even padding, never cutting through
// a shape. Pure, so it's unit-tested in Node.

/** How far around the selection to look for neighbours, in board units. */
export const SNAPSHOT_PADDING = 160;
/** Space around what's framed, in board units. */
export const SNAPSHOT_FRAME = 40;

function intersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

function union(a: Rect, b: Rect): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

function pad(rect: Rect, by: number): Rect {
	return {
		x: rect.x - by,
		y: rect.y - by,
		width: rect.width + by * 2,
		height: rect.height + by * 2,
	};
}

/**
 * The region to draw: the selection with the shapes near it (within
 * `SNAPSHOT_PADDING`) whole, framed by `SNAPSHOT_FRAME` all round, so it's
 * not mostly empty board and nothing near it is cut in half. Where the
 * frame's padding would clip a shape that isn't framed, the edge is pulled
 * back to just clear of it instead. Shapes off screen aren't drawn (React
 * Flow culls them), so neighbours are only taken in while they're fully on
 * screen; the selection always is. `shapes` are the boxes of what's on the
 * board; for a section, just its title (it's a backdrop, and framing it
 * whole would mean framing everything in it).
 */
export function snapshotRegion(selection: Rect, visible: Rect, shapes: readonly Rect[] = []): Rect {
	const near = pad(selection, SNAPSHOT_PADDING);
	let content = selection;
	const framed: Rect[] = [];
	const take = (shape: Rect) => {
		content = union(content, shape);
		framed.push(shape);
	};
	for (const shape of shapes) {
		if (intersects(near, shape) && contains(visible, shape)) take(shape);
	}
	// What's framed is a rectangle: anything poking into it (or its padding)
	// is in the picture anyway, so take it in whole too (a few rounds at most,
	// so a crowded board doesn't run on).
	for (let round = 0; round < 3; round++) {
		const frame = pad(content, SNAPSHOT_FRAME);
		const more = shapes.filter(
			(shape) => !framed.includes(shape) && contains(visible, shape) && intersects(frame, shape),
		);
		if (more.length === 0) break;
		for (const shape of more) take(shape);
	}
	let left = content.x - SNAPSHOT_FRAME;
	let top = content.y - SNAPSHOT_FRAME;
	let right = content.x + content.width + SNAPSHOT_FRAME;
	let bottom = content.y + content.height + SNAPSHOT_FRAME;
	const GAP = 6;
	for (const shape of shapes) {
		if (framed.includes(shape)) continue;
		const region = { x: left, y: top, width: right - left, height: bottom - top };
		if (!intersects(region, shape) || contains(region, shape)) continue;
		const sx1 = shape.x + shape.width;
		const sy1 = shape.y + shape.height;
		const cx1 = content.x + content.width;
		const cy1 = content.y + content.height;
		// Pull back whichever edge it pokes in at, never into what's framed.
		if (shape.x >= cx1) right = Math.max(cx1, Math.min(right, shape.x - GAP));
		else if (sx1 <= content.x) left = Math.min(content.x, Math.max(left, sx1 + GAP));
		else if (shape.y >= cy1) bottom = Math.max(cy1, Math.min(bottom, shape.y - GAP));
		else if (sy1 <= content.y) top = Math.min(content.y, Math.max(top, sy1 + GAP));
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}
