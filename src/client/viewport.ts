// Viewports for following someone: each person publishes the part of the
// board they can see (a rectangle in flow coordinates), and a follower fits
// that rectangle into their own window, whatever its size.

/** The visible part of the board, in flow coordinates. */
export interface View {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A React Flow viewport: translation in screen pixels, and zoom. */
export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

/** What a window of `width` × `height` shows at a React Flow transform. */
export function viewOf(
	[tx, ty, zoom]: readonly [number, number, number],
	width: number,
	height: number,
): View {
	return {
		x: round(-tx / zoom),
		y: round(-ty / zoom),
		width: round(width / zoom),
		height: round(height / zoom),
	};
}

/**
 * The viewport that shows all of `view`, centred, in a window of `width` ×
 * `height`. A bigger window sees a little more around the edges; a smaller
 * one zooms out to keep everything they can see in view.
 */
export function viewportFor(
	view: View,
	width: number,
	height: number,
	{ minZoom = 0.1, maxZoom = 2 }: { minZoom?: number; maxZoom?: number } = {},
): Viewport {
	const fit = Math.min(width / Math.max(view.width, 1), height / Math.max(view.height, 1));
	const zoom = Math.min(maxZoom, Math.max(minZoom, fit));
	const cx = view.x + view.width / 2;
	const cy = view.y + view.height / 2;
	return { x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom };
}

/** Whether two views differ by less than a pixel or so: not worth sending. */
export function sameView(a: View | null | undefined, b: View | null | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		Math.abs(a.x - b.x) < 1 &&
		Math.abs(a.y - b.y) < 1 &&
		Math.abs(a.width - b.width) < 1 &&
		Math.abs(a.height - b.height) < 1
	);
}

// Views travel through awareness many times a second; tenths of a pixel are
// plenty and keep updates small.
function round(value: number): number {
	return Math.round(value * 10) / 10;
}
