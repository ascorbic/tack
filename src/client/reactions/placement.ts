// Where a who-reacted tooltip goes: anchored to its pill, centred on it,
// on the side it prefers (above, or below for a card's count, which sits in
// the card's foot) unless there's no room there within the board. Near the
// board's edge it lines up with the pill's own edge rather than sliding off
// along the edge, so it still reads as the pill's. Pure, for unit tests.

export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Space kept between the tip and its pill, and the edges of where it may go. */
export const GAP = 8;

export function placeTip(
	pill: Box,
	size: { width: number; height: number },
	bounds: Box,
	prefer: "above" | "below" = "above",
): { left: number; top: number; side: "above" | "below" } {
	const roomAbove = pill.top - GAP - size.height >= bounds.top + GAP;
	const roomBelow = pill.bottom + GAP + size.height <= bounds.bottom - GAP;
	const side =
		prefer === "below"
			? roomBelow || !roomAbove
				? "below"
				: "above"
			: roomAbove || !roomBelow
				? "above"
				: "below";
	const top = side === "above" ? pill.top - GAP - size.height : pill.bottom + GAP;
	const centre = (pill.left + pill.right) / 2 - size.width / 2;
	let left = centre;
	// Too near an edge to centre: start at the pill's edge instead.
	if (left < bounds.left + GAP) left = pill.left - GAP;
	else if (left + size.width > bounds.right - GAP) left = pill.right + GAP - size.width;
	left = Math.max(bounds.left + GAP, Math.min(bounds.right - GAP - size.width, left));
	return { left: Math.round(left), top: Math.round(top), side };
}
