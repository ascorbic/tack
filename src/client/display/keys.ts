import { centre } from "../../shared/geometry.ts";
import type { DisplayState } from "./useDisplay.ts";

// The keyboard in a list or grid (#72). Arrow keys don't nudge rows (their
// free-form positions are hidden): they move the selection through the list,
// and with Shift they move what's selected up and down it.

export type ListKey =
	| { kind: "select"; id: string }
	| { kind: "move"; section: string; ids: string[]; index: number }
	/** Rows are selected, but there's nowhere to go: swallow the key. */
	| { kind: "none" };

type Direction = "left" | "right" | "up" | "down";

const DIRECTIONS: Record<string, { direction: Direction; far: boolean }> = {
	nudgeLeft: { direction: "left", far: false },
	nudgeRight: { direction: "right", far: false },
	nudgeUp: { direction: "up", far: false },
	nudgeDown: { direction: "down", far: false },
	nudgeLeftFar: { direction: "left", far: true },
	nudgeRightFar: { direction: "right", far: true },
	nudgeUpFar: { direction: "up", far: true },
	nudgeDownFar: { direction: "down", far: true },
};

/**
 * What an arrow key does to the selection, if any of it is in a list:
 * null means it's all free-form, so the key nudges as usual.
 */
export function listKey(
	display: DisplayState,
	selected: ReadonlySet<string>,
	command: string,
): ListKey | null {
	const key = DIRECTIONS[command];
	if (!key || !display.active) return null;
	const listed = [...selected].filter((id) => display.slots.has(id));
	if (listed.length === 0) return null;
	// Rows and free shapes together: rows can't nudge, so nothing does.
	if (listed.length !== selected.size) return { kind: "none" };
	const slots = listed.map((id) => display.slots.get(id)).filter((slot) => slot !== undefined);
	const first = slots.reduce((a, b) => (b.index < a.index ? b : a));

	if (key.far) {
		// Move within its own list or group: one place, or a line in a grid.
		if (slots.some((slot) => slot.section !== first.section)) return { kind: "none" };
		const order = display.sections.get(first.section)?.order ?? [];
		const columns = order.filter(
			(id) =>
				display.slots.get(id)?.rect.y === first.rect.y && display.slots.get(id)?.kind === "mini",
		).length;
		const step =
			first.kind === "mini" && (key.direction === "up" || key.direction === "down")
				? Math.max(1, columns)
				: 1;
		const earlier = key.direction === "up" || key.direction === "left";
		if (first.kind !== "mini" && (key.direction === "left" || key.direction === "right")) {
			return { kind: "none" };
		}
		const index = earlier ? first.index - step : first.index + step;
		const rest = order.length - listed.length;
		if (index < 0 || index > rest) return { kind: "none" };
		return { kind: "move", section: first.section, ids: listed, index };
	}

	// Move the selection to the nearest row or card that way, anywhere in
	// the same outermost list.
	const from = display.slots.get(listed.at(-1) as string) ?? first;
	const root = display.rootOf(from.id);
	const here = centre(from.rect);
	let best: { id: string; score: number } | null = null;
	for (const [id, slot] of display.slots) {
		if (id === from.id || slot.dragging || display.rootOf(id) !== root) continue;
		const there = centre(slot.rect);
		const dx = there.x - here.x;
		const dy = there.y - here.y;
		const along = { left: -dx, right: dx, up: -dy, down: dy }[key.direction];
		const across = key.direction === "left" || key.direction === "right" ? dy : dx;
		if (along <= 1) continue;
		// A group's row is as wide as its list: what's across from it is its header.
		const spread = slot.kind === "group" ? 0 : Math.abs(across);
		if ((key.direction === "left" || key.direction === "right") && Math.abs(dy) > from.rect.h / 2) {
			continue;
		}
		const score = along + spread * 3;
		if (!best || score < best.score) best = { id, score };
	}
	return best ? { kind: "select", id: best.id } : { kind: "none" };
}
