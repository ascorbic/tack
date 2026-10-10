import type * as Y from "yjs";
import type { Point } from "../../shared/geometry.ts";
import { PLACE_GAP } from "../../shared/placement.ts";
import { type SizeOf, boxOf } from "../../shared/sections.ts";
import { type ConnectorEnd, shapesMap, transactLocal } from "../../shared/shapes.ts";
import { copyClosure, readShapes, settlePasted } from "../../shared/structure.ts";
import { copyShapes, pasteShapes, payloadBounds } from "../clipboard.ts";

// Restoring from history: shapes as they were at some point, brought into
// the live board as a new edit of yours (one undo step), never by rewriting
// history. A shape that's gone comes back where it was; one that's still
// here comes back as a copy beside it, so nothing current is overwritten.
// Sections bring what was in them, and connectors come with the shapes
// they joined. Restored shapes get new ids, like a paste.

export interface Restored {
	/** The new shapes' ids. */
	ids: string[];
	/** Whether they came back where they were (rather than as a copy beside). */
	inPlace: boolean;
	/** How many of the shapes picked (not counting what came with them). */
	count: number;
	/** What kind of shape, if they're all one kind. */
	type: string | null;
}

/**
 * Bring `ids` (and what comes with them) from `past` into `live`. If any
 * of them is still on the board, they all come back as a copy, just right
 * of where they were.
 */
export function restoreShapes(
	past: Y.Doc,
	live: Y.Doc,
	ids: readonly string[],
	sizeOf?: SizeOf,
): Restored | null {
	const picked = ids.filter((id) => shapesMap(past).has(id));
	if (picked.length === 0) return null;
	const closure = copyClosure(past, picked);
	const payload = copyShapes(past, closure, {
		sizes: (id) => {
			const size = sizeOf?.(id);
			return size ? { width: size.w, height: size.h } : undefined;
		},
	});
	if (payload.shapes.length === 0) return null;
	const current = shapesMap(live);
	const inPlace = picked.every((id) => !current.has(id));
	const offset = inPlace ? { x: 0, y: 0 } : besideOriginals(live, payload, picked, sizeOf);
	const types = new Set(picked.map((id) => String(shapesMap(past).get(id)?.get("type"))));
	const added = transactLocal(live, () => {
		const added = pasteShapes(live, payload, offset);
		settlePasted(live, added, offset, sizeOf);
		if (inPlace) rebind(live, payload.shapes, added);
		return added;
	});
	return {
		ids: added,
		inPlace,
		count: picked.length,
		type: types.size === 1 ? ([...types][0] ?? null) : null,
	};
}

/**
 * Restored in place, connectors that joined a shape still on the board join
 * it again (pasting lets go of shapes that weren't copied).
 */
function rebind(
	live: Y.Doc,
	copied: readonly { id: string; props: Record<string, unknown> }[],
	added: readonly string[],
): void {
	const map = shapesMap(live);
	copied.forEach((original, i) => {
		if (original.props.type !== "connector") return;
		const shape = map.get(added[i] ?? "");
		if (!shape) return;
		for (const which of ["from", "to"] as const) {
			const was = original.props[which] as ConnectorEnd | undefined;
			const now = shape.get(which) as ConnectorEnd | undefined;
			if (!was?.shape || !now || now.shape || !map.has(was.shape)) continue;
			shape.set(which, { ...now, shape: was.shape, ...(was.anchor ? { anchor: was.anchor } : {}) });
		}
	});
}

/** An offset that puts the copies just right of their originals (as they were, and as they are). */
function besideOriginals(
	live: Y.Doc,
	payload: ReturnType<typeof copyShapes>,
	picked: readonly string[],
	sizeOf?: SizeOf,
): Point {
	const bounds = payloadBounds(payload);
	if (!bounds) return { x: 0, y: 0 };
	let right = bounds.x + bounds.width;
	const shapes = readShapes(live);
	for (const id of picked) {
		const shape = shapes.get(id);
		if (shape && shape.type !== "connector") {
			const box = boxOf(id, shape, sizeOf);
			right = Math.max(right, box.x + box.w);
		}
	}
	return { x: Math.round(right + PLACE_GAP * 3 - bounds.x), y: 0 };
}
