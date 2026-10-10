// Where a popover opens from its bar (#71): below or above it, room
// allowing, and clear of the board's fixed chrome (the minimap, the zoom
// controls, the tool dock), shifting sideways or flipping to get clear, so
// nothing a popover offers ends up under something else. Pure, so it's
// unit-tested; Popover.tsx measures and applies it.

/** A box on screen, in CSS pixels. */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export type Side = "below" | "above";

export interface PlacementInput {
	/** The bar the popover opens from. */
	anchor: Box;
	/** The popover's natural size. */
	size: { width: number; height: number };
	/** The visible canvas it must stay within. */
	bounds: Box;
	/** Chrome it mustn't cover or be covered by. */
	obstacles: readonly Box[];
	prefer: Side;
	/** Stay on the preferred side (once open, so it never jumps across its bar). */
	stay?: boolean;
	/** Between the bar and the popover. */
	gap?: number;
	/** Kept clear around the popover. */
	margin?: number;
	/** The least height worth scrolling in, rather than going somewhere else. */
	minRoom?: number;
}

export interface Placement {
	side: Side;
	/** Sideways shift from centred on the bar. */
	nudge: number;
	/** The height it has before it must scroll. */
	room: number;
}

interface Candidate extends Placement {
	clear: boolean;
	fits: boolean;
	/** The room on this side, chrome or no chrome. */
	space: number;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

export function placePopover({
	anchor,
	size,
	bounds,
	obstacles,
	prefer,
	stay = false,
	gap = 8,
	margin = 12,
	minRoom = 180,
}: PlacementInput): Placement {
	const centre = (anchor.left + anchor.right) / 2 - size.width / 2;
	const lo = bounds.left + margin;
	const hi = Math.max(lo, bounds.right - margin - size.width);
	const clamp = (x: number) => Math.min(Math.max(x, lo), hi);

	const candidate = (side: Side): Candidate => {
		const start = side === "below" ? anchor.bottom + gap : anchor.top - gap;
		const room = side === "below" ? bounds.bottom - margin - start : start - (bounds.top + margin);
		const height = Math.min(size.height, Math.max(0, room));
		const top = side === "below" ? start : start - height;
		const bottom = top + height;
		// Chrome level with where it would be.
		const level = obstacles.filter((o) => overlaps(top - margin, bottom + margin, o.top, o.bottom));
		const clearAt = (x: number) =>
			level.every((o) => !overlaps(x - margin, x + size.width + margin, o.left, o.right));
		// Centred if it can be, else the smallest shift sideways that's clear.
		const xs = [
			clamp(centre),
			...level.flatMap((o) => [o.left - margin - size.width, o.right + margin]).map(clamp),
		].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
		const x = xs.find(clearAt);
		if (x !== undefined) {
			const fits = size.height <= room;
			return { side, nudge: x - centre, room, clear: true, fits, space: room };
		}
		// Nowhere clear at full height: stop short of the chrome, and scroll.
		const left = clamp(centre);
		const inColumn = level.filter((o) => overlaps(left, left + size.width, o.left, o.right));
		const short =
			side === "below"
				? Math.min(...inColumn.map((o) => o.top - margin)) - start
				: start - Math.max(...inColumn.map((o) => o.bottom + margin));
		return {
			side,
			nudge: left - centre,
			room: Math.min(room, short),
			clear: short >= minRoom,
			fits: false,
			space: room,
		};
	};

	const first = candidate(prefer);
	const second = stay ? first : candidate(prefer === "below" ? "above" : "below");
	const clear =
		[first, second].find((o) => o.clear && o.fits) ??
		[first, second].find((o) => o.clear && o.room >= minRoom);
	// Nothing's clear: the side it'd fit, or with the most room, as before.
	const best = clear ?? {
		...(size.height <= first.space || first.space >= second.space ? first : second),
		nudge: clamp(centre) - centre,
	};
	return {
		side: best.side,
		nudge: Math.round(best.nudge),
		room: Math.max(minRoom, Math.floor(clear ? best.room : best.space)),
	};
}

// --- Beside a shape ------------------------------------------------------------
//
// Panels that open beside a shape (a widget's settings, drop to match's
// confirmation) go to its right, or its left when there's no room, centred on
// it and slid up or down to stay on the visible canvas and clear of the
// chrome over it. Too tall for the room, they're pinned to the top of it and
// scroll. Nothing a panel offers ever ends up off screen.

export type Beside = "right" | "left";

export interface BesideInput {
	/** The shape the panel belongs to, on screen. */
	anchor: Box;
	/** The panel's natural size. */
	size: { width: number; height: number };
	bounds: Box;
	obstacles: readonly Box[];
	prefer?: Beside;
	gap?: number;
	margin?: number;
}

export interface BesidePlacement {
	side: Beside;
	/** The panel's top-left corner, in the same coordinates as the input. */
	left: number;
	top: number;
	/** The height it has before it must scroll. */
	room: number;
}

/** Stretches of `[from, to]` not covered by any of `blocks`. */
function gaps(from: number, to: number, blocks: { from: number; to: number }[]) {
	const out: { from: number; to: number }[] = [];
	let at = from;
	for (const block of [...blocks].sort((a, b) => a.from - b.from)) {
		if (block.to <= at) continue;
		if (block.from > at) out.push({ from: at, to: Math.min(block.from, to) });
		at = Math.max(at, block.to);
		if (at >= to) break;
	}
	if (at < to) out.push({ from: at, to });
	return out.filter((gap) => gap.to > gap.from);
}

export function placeBeside({
	anchor,
	size,
	bounds,
	obstacles,
	prefer = "right",
	gap = 14,
	margin = 12,
}: BesideInput): BesidePlacement {
	const lo = bounds.left + margin;
	const hi = Math.max(lo, bounds.right - margin - size.width);
	const middle = (anchor.top + anchor.bottom) / 2;

	const candidate = (side: Beside) => {
		const left = side === "right" ? anchor.right + gap : anchor.left - gap - size.width;
		const inside = left >= lo && left <= hi;
		const x = Math.min(Math.max(left, lo), hi);
		// The free stretches of the column it would be in, top to bottom.
		const column = obstacles
			.filter((o) => overlaps(x - margin, x + size.width + margin, o.left, o.right))
			.map((o) => ({ from: o.top - margin, to: o.bottom + margin }));
		const free = gaps(bounds.top + margin, bounds.bottom - margin, column);
		const ideal = middle - size.height / 2;
		const options = free.map((stretch) => {
			const room = stretch.to - stretch.from;
			const height = Math.min(size.height, room);
			const top = Math.min(Math.max(ideal, stretch.from), stretch.to - height);
			return { top, room, height };
		});
		// The tallest it can be, then the nearest to centred on its shape.
		options.sort(
			(a, b) => b.height - a.height || Math.abs(a.top - ideal) - Math.abs(b.top - ideal),
		);
		const best = options[0] ?? { top: bounds.top + margin, room: 0, height: 0 };
		return {
			side,
			left: x,
			top: best.top,
			room: best.room,
			inside,
			fits: inside && best.height >= size.height,
			height: best.height,
		};
	};

	const first = candidate(prefer);
	const second = candidate(prefer === "right" ? "left" : "right");
	const best =
		[first, second].find((c) => c.fits) ??
		[first, second].filter((c) => c.inside).sort((a, b) => b.height - a.height)[0] ??
		// Wider than the room on either side: over the shape, on the side with more room.
		(anchor.left - bounds.left > bounds.right - anchor.right ? second : first);
	return {
		side: best.side,
		left: Math.round(best.left),
		top: Math.round(best.top),
		room: Math.max(0, Math.floor(best.room)),
	};
}

// --- Into view -----------------------------------------------------------------
//
// How far to pan the board so something drawn on it (an inbox's editor, say)
// is wholly on the visible canvas and out from under its chrome. Zero when
// it already is; the top wins when it's taller than the room.

export function panIntoView({
	rect,
	bounds,
	obstacles,
	margin = 16,
}: {
	rect: Box;
	bounds: Box;
	obstacles: readonly Box[];
	margin?: number;
}): { dx: number; dy: number } {
	const width = rect.right - rect.left;
	const height = rect.bottom - rect.top;
	const fit = (start: number, length: number, from: number, to: number) => {
		if (length > to - from || start < from) return from - start;
		if (start + length > to) return to - (start + length);
		return 0;
	};
	const dx = fit(rect.left, width, bounds.left + margin, bounds.right - margin);
	const left = rect.left + dx;
	// Chrome level with where it'll be: what's in the lower half of the canvas
	// limits it from below, what's in the upper half from above.
	const middle = (bounds.top + bounds.bottom) / 2;
	let top = bounds.top + margin;
	let bottom = bounds.bottom - margin;
	for (const o of obstacles) {
		if (!overlaps(left, left + width, o.left, o.right)) continue;
		if ((o.top + o.bottom) / 2 > middle) bottom = Math.min(bottom, o.top - margin);
		else top = Math.max(top, o.bottom + margin);
	}
	const dy = fit(rect.top, height, top, Math.max(top, bottom));
	return { dx: Math.round(dx), dy: Math.round(dy) };
}
