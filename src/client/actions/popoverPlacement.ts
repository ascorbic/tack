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
