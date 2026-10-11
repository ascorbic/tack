// The pure parts of touch on the board (#67), unit-tested in Node
// (test/touch.test.ts): when a sheet dragged down goes away, when a press
// becomes a long-press, and where a sticky added from a phone goes.

/** How far a finger may wander and still be pressing, not dragging (px). */
export const PRESS_SLOP = 10;
/** How long a press lasts before it's a long-press (ms, unscaled by motion: it's a feel, not an animation). */
export const LONG_PRESS_MS = 450;

/** Whether a pointer that went down at `from` and is now at `to` has moved too far to be a press. */
export function movedTooFar(
	from: { x: number; y: number },
	to: { x: number; y: number },
	slop = PRESS_SLOP,
): boolean {
	return Math.hypot(to.x - from.x, to.y - from.y) > slop;
}

/** How fast a flick down closes a sheet whatever the distance (px per ms). */
export const FLICK_SPEED = 0.6;

/**
 * Whether a sheet let go of after being dragged down `dy` pixels (of its
 * `height`), moving at `velocity` px/ms (down is positive), closes, or
 * springs back.
 */
export function sheetCloses(dy: number, velocity: number, height: number): boolean {
	if (dy <= 0) return false;
	if (velocity >= FLICK_SPEED) return true;
	// A flick back up keeps it, however far down it was.
	if (velocity < -0.2) return false;
	return dy > Math.min(160, height * 0.35);
}

/**
 * How far the sheet follows a drag: one to one downwards, and only a
 * little upwards (it's already as tall as it'll go), like a rubber band.
 */
export function sheetOffset(dy: number): number {
	return dy >= 0 ? dy : -Math.sqrt(-dy) * 2;
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * The part of the canvas a sheet leaves to see the board through: above it,
 * in screen pixels. `sheetTop` is where the sheet starts (from the canvas's
 * top), or null with no sheet.
 */
export function clearOfSheet(canvas: { width: number; height: number }, sheetTop: number | null) {
	const bottom =
		sheetTop === null ? canvas.height : Math.max(120, Math.min(canvas.height, sheetTop));
	return { x: 0, y: 0, w: canvas.width, h: bottom };
}

/**
 * Where to move the view so a shape (in screen pixels, relative to the
 * canvas) shows in the part of the canvas a sheet leaves clear: by how much
 * to pan, or null when it's already in view there.
 */
export function panToShow(shape: Box, clear: Box, margin = 16): { dx: number; dy: number } | null {
	const room = {
		x: clear.x + margin,
		y: clear.y + margin,
		w: clear.w - margin * 2,
		h: clear.h - margin * 2,
	};
	const inside =
		shape.x >= room.x &&
		shape.y >= room.y &&
		shape.x + shape.w <= room.x + room.w &&
		shape.y + shape.h <= room.y + room.h;
	if (inside) return null;
	// Centre it in the clear space; if it's bigger than that, show its top.
	const targetX = room.x + Math.max(0, (room.w - shape.w) / 2);
	const targetY = room.y + Math.max(0, (room.h - shape.h) / 2);
	return { dx: targetX - shape.x, dy: targetY - shape.y };
}
