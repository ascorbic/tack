import { TRAY_GAP, TRAY_WIDTH } from "./inbox/layout.ts";
import type { Rect } from "../shared/geometry.ts";
import { type SizeOf, boxOf } from "../shared/sections.ts";
import type { ShapeNode } from "./board.ts";
import type { Viewport } from "./viewport.ts";

// Fitting the board into view around the chrome that floats over it (the
// tool dock along the bottom, the minimap in the corner, a vote's bar along
// the top), and remembering
// where each person last looked at each board, so coming back is where
// they left off and opening a board for the first time shows all of it.
// Bounds come from the document rather than React Flow, which only knows
// the sizes of shapes it has drawn (it skips those off screen).

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Space kept between fitted content and the canvas's edge or its chrome. */
const GAP = 32;
/** A phone's screen is too narrow to spare as much. */
const PHONE_GAP = 16;

/**
 * Marks chrome that fitting keeps content clear of, beyond the dock and the
 * minimap: `"top"` for what hangs from the top (a vote's bar, the timer), on
 * every screen; `"bottom"` for what sits along the bottom (the demo's guide
 * card), on a phone only, as elsewhere the card moves about with its step.
 */
export const FIT_CLEAR = "data-fit-clear";

/**
 * How far in from each side of `canvas` fitted content must stay: clear of
 * the dock at the bottom and the minimap at the bottom right (beside it,
 * which costs less of the screen than going above it), below everything in
 * `top` and above everything in `bottom`.
 */
export function chromeInsets(
	canvas: Box,
	{
		dock,
		minimap,
		top = [],
		bottom = [],
	}: { dock?: Box | null; minimap?: Box | null; top?: Box[]; bottom?: Box[] },
	gap = GAP,
): Insets {
	const under = (box: Box) => box.bottom - canvas.top + gap / 2;
	const over = (box: Box) => canvas.bottom - box.top + gap / 2;
	const fromTop = Math.max(gap, ...top.map(under));
	const fromBottom = Math.max(gap, ...(dock ? [dock] : []).concat(bottom).map(over));
	const right = minimap ? Math.max(gap, canvas.right - minimap.left + gap / 2) : gap;
	return {
		top: Math.round(fromTop),
		right: Math.round(right),
		bottom: Math.round(fromBottom),
		left: gap,
	};
}

/**
 * The viewport that shows all of `bounds` (in flow coordinates) on a canvas
 * of `size`, inside `insets`, centred, at no more than `maxZoom`.
 */
export function viewportToFit(
	bounds: Rect,
	size: { width: number; height: number },
	insets: Insets,
	{ minZoom = 0.1, maxZoom = 1 }: { minZoom?: number; maxZoom?: number } = {},
): Viewport {
	const width = Math.max(1, size.width - insets.left - insets.right);
	const height = Math.max(1, size.height - insets.top - insets.bottom);
	const fit = Math.min(width / Math.max(1, bounds.w), height / Math.max(1, bounds.h));
	const zoom = Math.min(maxZoom, Math.max(minZoom, fit));
	return {
		x: insets.left + (width - bounds.w * zoom) / 2 - bounds.x * zoom,
		y: insets.top + (height - bounds.h * zoom) / 2 - bounds.y * zoom,
		zoom,
	};
}

/** Everything on the board, as one box: shapes where they're drawn, at the size they're drawn. */
export function contentBounds(boxes: Iterable<Rect>): Rect | null {
	let out: { x0: number; y0: number; x1: number; y1: number } | null = null;
	for (const box of boxes) {
		if (!out) out = { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h };
		else {
			out.x0 = Math.min(out.x0, box.x);
			out.y0 = Math.min(out.y0, box.y);
			out.x1 = Math.max(out.x1, box.x + box.w);
			out.y1 = Math.max(out.y1, box.y + box.h);
		}
	}
	return out ? { x: out.x0, y: out.y0, w: out.x1 - out.x0, h: out.y1 - out.y0 } : null;
}

/** Each shape's box where it's drawn: at its drawn size if it's been drawn, else its document size. */
export function shapeBoxes(
	nodes: readonly ShapeNode[],
	drawnSize: (id: string) => { width: number; height: number } | undefined,
	boxSize?: SizeOf,
): Rect[] {
	return nodes.map((node) => {
		const size = drawnSize(node.id);
		const box = size
			? { x: node.position.x, y: node.position.y, w: size.width, h: size.height }
			: boxOf(node.id, node.data.shape, boxSize);
		// An inbox's tray of new matches sits beside its section, on whichever
		// side has room: fit in either.
		const tray = TRAY_GAP + TRAY_WIDTH;
		return node.data.shape.type === "section" && node.data.shape.inbox
			? { ...box, x: box.x - tray, w: box.w + 2 * tray }
			: box;
	});
}

/**
 * What the chrome floating over `canvas` (the dock, the minimap, and
 * whatever's marked with `FIT_CLEAR`) leaves to fit content into.
 */
export function insetsOf(canvas: HTMLElement, gap?: number): Insets {
	const shown = (el: Element | null) => {
		if (!el) return null;
		// Hidden while history plays back, say, it covers nothing.
		if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 ? rect : null;
	};
	const box = (selector: string) => shown(canvas.querySelector(selector));
	const bounds = canvas.getBoundingClientRect();
	const phone = canvas.closest("[data-phone]") !== null;
	const marked = (edge: "top" | "bottom") =>
		phone || edge === "top"
			? [...document.querySelectorAll(`[${FIT_CLEAR}="${edge}"]`)]
					.map(shown)
					.filter(
						(rect): rect is DOMRect =>
							rect !== null && rect.bottom > bounds.top && rect.top < bounds.bottom,
					)
			: [];
	return chromeInsets(
		bounds,
		{
			dock: box(".toolbar-dock .toolbar, .history-dock"),
			minimap: box(".react-flow__minimap"),
			top: marked("top"),
			bottom: marked("bottom"),
		},
		gap ?? (phone ? PHONE_GAP : GAP),
	);
}

/**
 * Fit `boxes` into view on `canvas`, clear of its chrome: the viewport to
 * pass to `setViewport`, or null if there's nothing to fit.
 */
export function fitBoxes(
	canvas: HTMLElement | null | undefined,
	boxes: Iterable<Rect>,
	{ gap, ...zoom }: { maxZoom?: number; minZoom?: number; gap?: number } = {},
): Viewport | null {
	const bounds = contentBounds(boxes);
	if (!canvas || !bounds) return null;
	const { width, height } = canvas.getBoundingClientRect();
	return viewportToFit(bounds, { width, height }, insetsOf(canvas, gap), zoom);
}

const KEY = (board: string) => `tack:view:${board}`;

/** Where you last left this board in this browser, if anywhere. */
export function savedViewport(board: string): Viewport | null {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY(board)) ?? "null") as Partial<Viewport> | null;
		if (
			raw &&
			Number.isFinite(raw.x) &&
			Number.isFinite(raw.y) &&
			Number.isFinite(raw.zoom) &&
			(raw.zoom ?? 0) > 0
		) {
			return { x: raw.x as number, y: raw.y as number, zoom: raw.zoom as number };
		}
	} catch {
		// Storage is off or full, or what's there isn't ours.
	}
	return null;
}

export function saveViewport(board: string, viewport: Viewport): void {
	try {
		const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
		localStorage.setItem(
			KEY(board),
			JSON.stringify({
				x: round(viewport.x, 1),
				y: round(viewport.y, 1),
				zoom: round(viewport.zoom, 4),
			}),
		);
	} catch {
		// Not remembered, then.
	}
}
