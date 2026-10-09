import type { CSSProperties } from "react";

// Shapes arriving together, choreographed: Expand related's cards fly out
// from the card they're related to, one after another, and their connectors
// draw in once they've landed. Whoever adds the shapes says how each should
// arrive, just before adding them; each shape reads its entrance once, as it
// mounts. Durations come from CSS, so slow and reduced motion apply.

export interface Entrance {
	/** Where it flies in from, relative to where it lands (board pixels). */
	dx: number;
	dy: number;
	/** How long after the first it starts, before motion scaling (ms). */
	delay: number;
}

/** Entrances are only claimed by shapes mounting within this long. */
const FRESH_MS = 4000;

const entrances = new Map<string, Entrance & { at: number }>();

export function stageEntrances(entries: Iterable<[id: string, entrance: Entrance]>): void {
	const now = performance.now();
	for (const [id, entrance] of entries) entrances.set(id, { ...entrance, at: now });
	// Forget stale ones, so the map never grows.
	for (const [id, { at }] of entrances) if (now - at > FRESH_MS) entrances.delete(id);
}

/** How a shape that's just mounted should arrive, if it was given an entrance. */
export function entranceOf(id: string): Entrance | null {
	const entrance = entrances.get(id);
	if (!entrance || performance.now() - entrance.at > FRESH_MS) return null;
	return entrance;
}

/** The entrance as CSS custom properties, for `[data-enter="expand"]`. */
export function entranceStyle(entrance: Entrance): CSSProperties {
	return {
		"--enter-x": `${Math.round(entrance.dx)}px`,
		"--enter-y": `${Math.round(entrance.dy)}px`,
		"--enter-delay": `${Math.round(entrance.delay)}`,
	} as CSSProperties;
}
