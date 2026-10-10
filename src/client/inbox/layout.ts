import { type Rect, intersects } from "../../shared/geometry.ts";

// Where an inbox's tray goes (#40): beside its section, on the right if
// that's clear of everything else on the board, else on the left, else
// nowhere: it folds away to its "N new" pill, so it never covers the section
// next door (the review's Bugs / Docs / Later). The tray grows against the
// zoom like section titles, so zoomed out it needs more room on the board,
// and folds away sooner. Pure, so it's unit-tested; InboxTray.tsx applies it.

/** How wide a tray is on screen. */
export const TRAY_WIDTH = 280;
/** Between a section's edge and its tray, on the board at 100%. */
export const TRAY_GAP = 14;
/** Below this zoom every tray folds to its pill: the board's for reading as a whole. */
export const TRAY_MIN_ZOOM = 0.3;

export type TraySide = "right" | "left";

/** How tall a tray with this many new matches is, on screen, near enough. */
export function trayHeight(items: number, dismissed = false): number {
	// Header and query, then rows (scrolling after six), or the "all sorted" note.
	const body = items === 0 ? 76 : Math.min(items, 6) * 62;
	return 78 + body + (dismissed ? 30 : 0);
}

/**
 * Which side of `section` (on the board) a tray of `size` (on screen) fits
 * at `zoom` without covering any of `others` (other shapes' boxes, on the
 * board), or null if neither.
 */
export function traySide(
	section: Rect,
	size: { w: number; h: number },
	zoom: number,
	others: readonly Rect[],
): TraySide | null {
	if (zoom < TRAY_MIN_ZOOM) return null;
	// Grown against the zoom when zoomed out, as on screen (`--unzoom`).
	const unzoom = Math.min(10, Math.max(1, 1 / zoom));
	const w = size.w * unzoom;
	const h = size.h * unzoom;
	const gap = TRAY_GAP;
	const right: Rect = { x: section.x + section.w + gap, y: section.y, w, h };
	const left: Rect = { x: section.x - gap - w, y: section.y, w, h };
	const clear = (rect: Rect) => others.every((other) => !intersects(rect, other));
	if (clear(right)) return "right";
	if (clear(left)) return "left";
	return null;
}
