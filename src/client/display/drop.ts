import type { NodeChange } from "@xyflow/react";
import type * as Y from "yjs";
import { placeInDisplay } from "../../shared/display.ts";
import { NOMINAL_SIZE, type SizeOf } from "../../shared/sections.ts";
import type { Position, ShapeNode } from "../board.ts";
import type { DisplayState } from "./useDisplay.ts";

// Dropping shapes on, in and out of lists (#72). Moving a row within its list
// only reorders it: its free-form position stays as it was. Anything dropped
// on a list joins it where the gap was. A row dropped anywhere else becomes
// itself again, centred where the row was let go.

export interface DisplayDrop {
	/** The changes to commit as usual (rows that only reordered left out). */
	changes: NodeChange<ShapeNode>[];
	/** Then, in the same transaction, the lists' order; null if no list is involved. */
	after: (() => void) | null;
}

export function planDisplayDrop(
	doc: Y.Doc,
	display: DisplayState,
	changes: NodeChange<ShapeNode>[],
	lastDragPosition: (id: string) => Position | undefined,
	sizeOf: SizeOf,
): DisplayDrop {
	if (!display.active) return { changes, after: null };
	const drops = new Map<string, Position>();
	for (const change of changes) {
		if (change.type !== "position" || change.dragging) continue;
		const position = change.position ?? lastDragPosition(change.id);
		if (position) drops.set(change.id, position);
	}
	if (drops.size === 0) return { changes, after: null };

	// Worked out from where things were let go, not the last frame drawn,
	// which can be a move behind a quick drop.
	const hover = display.hoverAt(drops);
	const into = new Set(hover?.ids.filter((id) => drops.has(id)) ?? []);
	const adjusted = new Map<string, Position>();
	const skip = new Set<string>();
	for (const [id, at] of drops) {
		const parent = display.structure.parentOf.get(id);
		if (into.has(id)) {
			// Already in the list it's dropped on: just a new place in its order.
			if (parent === hover?.section) skip.add(id);
			continue;
		}
		const slot = display.base.slots.get(id);
		const shape = display.shapes.get(id);
		if (!slot || !shape || slot.kind === "group") continue;
		// Out of its list: itself again, centred where the row was let go.
		const size = sizeOf(id) ?? NOMINAL_SIZE[shape.type] ?? { w: 0, h: 0 };
		adjusted.set(id, {
			x: Math.round(at.x + slot.rect.w / 2 - size.w / 2),
			y: Math.round(at.y + slot.rect.h / 2 - size.h / 2),
		});
	}

	const out = changes.flatMap((change): NodeChange<ShapeNode>[] => {
		if (change.type !== "position" || change.dragging) return [change];
		if (skip.has(change.id)) return [];
		const position = adjusted.get(change.id);
		return position ? [{ ...change, position }] : [change];
	});
	return {
		changes: out,
		after:
			hover && into.size > 0
				? () =>
						placeInDisplay(doc, [...into], hover.section, hover.index, {
							sizeOf,
							cardOf: display.cardOf,
						})
				: adjusted.size > 0
					? () => {}
					: null,
	};
}
