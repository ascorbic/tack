import type * as Y from "yjs";
import { isAnchor, isEnd } from "./connectors.ts";
import { readStructure } from "./sections.ts";
import { shapesMap } from "./shapes.ts";
import { readShapes } from "./structure.ts";

// The repair pass. Concurrent edits can leave references between shapes
// dangling: someone deletes a section while someone else drops a sticky into
// it, or deletes a card just as someone else attaches a connector to it.
// Clients draw those states sensibly (see `readStructure` and `resolveEnds`)
// and this pass, run by the board's Durable Object, writes the fix into the
// document so every client converges on it. It's idempotent, and it only
// writes when something is actually broken.

export interface RepairResult {
	/** Shapes whose parent was cleared. */
	parents: number;
	/** Connector ends that were detached from shapes that are gone. */
	ends: number;
	/** Connectors removed because they had no usable ends. */
	removed: number;
}

export function repairBoard(doc: Y.Doc): RepairResult {
	const result: RepairResult = { parents: 0, ends: 0, removed: 0 };
	doc.transact(() => {
		const shapes = readShapes(doc);
		const map = shapesMap(doc);

		for (const id of readStructure(shapes).broken) {
			map.get(id)?.set("parent", null);
			result.parents++;
		}

		for (const [id, shape] of shapes) {
			if (shape.type !== "connector") continue;
			if (!isEnd(shape.from) || !isEnd(shape.to)) {
				map.delete(id);
				result.removed++;
				continue;
			}
			for (const which of ["from", "to"] as const) {
				const end = shape[which];
				if (!isEnd(end) || end.shape === undefined) continue;
				const target = typeof end.shape === "string" ? shapes.get(end.shape) : undefined;
				if (!target || target.type === "connector") {
					map.get(id)?.set(which, { x: end.x, y: end.y });
					result.ends++;
				} else if (end.anchor !== undefined && !isAnchor(end.anchor)) {
					map.get(id)?.set(which, { x: end.x, y: end.y, shape: end.shape });
					result.ends++;
				}
			}
		}
	}, REPAIR_ORIGIN);
	return result;
}

/** The transaction origin for repairs, so observers can ignore their own writes. */
export const REPAIR_ORIGIN = "repair";
