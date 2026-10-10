// Side panels that open over the canvas's edges: "since you were here" on
// the left, comments, rules, history and vote results on the right. A jump
// to something should land it in the part of the board you can see, not
// behind one of them.

const SIDE_PANELS = ".since-panel, .comments-panel, .rules-panel, .history-panel, .tally-panel";

export interface ClearView {
	/** The canvas's size on screen. */
	width: number;
	height: number;
	/** How much of each side panels cover, in screen pixels. */
	left: number;
	right: number;
}

/** What of the canvas isn't under a side panel. */
export function clearView(canvas: Element | null = document.querySelector(".canvas")): ClearView {
	const bounds = canvas?.getBoundingClientRect();
	const width = bounds?.width ?? innerWidth;
	const height = bounds?.height ?? innerHeight;
	const origin = bounds?.left ?? 0;
	let left = 0;
	let right = 0;
	for (const panel of document.querySelectorAll(SIDE_PANELS)) {
		const rect = panel.getBoundingClientRect();
		if (rect.width === 0 || rect.width > width * 0.7) continue;
		const from = rect.left - origin;
		const to = rect.right - origin;
		// A panel against the left edge, or the right.
		if (from < width / 2 && to < width / 2) left = Math.max(left, to);
		else if (from > width / 2) right = Math.max(right, width - from);
	}
	return { width, height, left, right };
}

/**
 * Where to centre the view so `point` (in board coordinates) lands in the
 * middle of what panels leave clear, at `zoom`.
 */
export function centreClearOf(
	point: { x: number; y: number },
	zoom: number,
	view: ClearView,
): { x: number; y: number } {
	return { x: point.x - (view.left - view.right) / 2 / zoom, y: point.y };
}
