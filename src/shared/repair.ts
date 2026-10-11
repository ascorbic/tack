import * as Y from "yjs";
import { isDate, isOwner } from "./actionItems.ts";
import { isAnchor, isEnd } from "./connectors.ts";
import { readVotes } from "./decisions.ts";
import { memberAt, pileMembers, pileOf } from "./piles.ts";
import { readStructure } from "./sections.ts";
import { shapesMap } from "./shapes.ts";
import { readShapes, settlePiles } from "./structure.ts";
import { widgetDefinition, widgetSize } from "./widgetRegistry.ts";

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
	/**
	 * Decisions fixed up: a `supersededBy` pointing at a decision that's gone
	 * cleared, or votes that aren't a Y.Map (so wouldn't merge) rebuilt.
	 */
	decisions: number;
	/**
	 * Widgets fixed up: a size that isn't a usable number given their kind's
	 * default, or a config that isn't an object replaced with the defaults.
	 */
	widgets: number;
	/**
	 * Action items fixed up: an owner, due date, tick or link that isn't one
	 * this code would have written, dropped.
	 */
	actions: number;
	/**
	 * Piles fixed up (piles.ts): a sticky's `pile` pointing at nothing
	 * cleared, a pile left with one sticky dissolved or with none removed,
	 * or stickies put back where (and in the section) their pile is.
	 */
	piles: number;
}

/** How many things a repair fixed, in total. */
export function repairCount(result: RepairResult): number {
	return (
		result.parents +
		result.ends +
		result.removed +
		result.decisions +
		result.widgets +
		result.actions +
		result.piles
	);
}

export function repairBoard(doc: Y.Doc): RepairResult {
	const result: RepairResult = {
		parents: 0,
		ends: 0,
		removed: 0,
		decisions: 0,
		widgets: 0,
		actions: 0,
		piles: 0,
	};
	doc.transact(() => {
		result.piles = repairPiles(doc);
		const shapes = readShapes(doc);
		const map = shapesMap(doc);

		for (const [id, shape] of shapes) {
			if (shape.type !== "widget") continue;
			const widget = map.get(id);
			if (!widget) continue;
			let fixed = false;
			const size = widgetSize(shape);
			for (const key of ["w", "h"] as const) {
				const value = shape[key];
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
					widget.set(key, size[key]);
					fixed = true;
				}
			}
			const definition = widgetDefinition(shape.widget);
			const config = shape.config;
			if (definition && (!config || typeof config !== "object" || Array.isArray(config))) {
				widget.set("config", definition.defaults);
				fixed = true;
			}
			if (fixed) result.widgets++;
		}

		for (const id of readStructure(shapes).broken) {
			map.get(id)?.set("parent", null);
			result.parents++;
		}

		for (const [id, shape] of shapes) {
			if (shape.type !== "decision") continue;
			const decision = map.get(id);
			if (!decision) continue;
			let fixed = false;
			const by = shape.supersededBy;
			if (by !== undefined && (by === id || shapes.get(by)?.type !== "decision")) {
				decision.delete("supersededBy");
				fixed = true;
			}
			if (!(decision.get("votes") instanceof Y.Map)) {
				const votes = new Y.Map<unknown>();
				for (const [key, vote] of Object.entries(readVotes(decision.get("votes")))) {
					votes.set(key, vote);
				}
				decision.set("votes", votes);
				fixed = true;
			}
			if (fixed) result.decisions++;
		}

		for (const [id, shape] of shapes) {
			if (shape.type !== "action") continue;
			const item = map.get(id);
			if (!item) continue;
			const bad = [
				item.has("owner") && !isOwner(shape.owner) ? "owner" : null,
				item.has("due") && !isDate(shape.due) ? "due" : null,
				item.has("done") && typeof shape.done !== "string" ? "done" : null,
				item.has("ref") && typeof shape.ref !== "string" ? "ref" : null,
				item.has("issue") && typeof shape.issue !== "string" ? "issue" : null,
			].filter((key) => key !== null);
			for (const key of bad) item.delete(key);
			if (bad.length > 0) result.actions++;
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

/**
 * Piles after concurrent edits: two people piling the same sticky at once
 * leave one pile without it, someone deletes a pile as someone else drops
 * a sticky on it, or moves it while someone drags a sticky out (piles.ts).
 */
function repairPiles(doc: Y.Doc): number {
	let fixed = 0;
	const map = shapesMap(doc);
	let shapes = readShapes(doc);
	// A `pile` on anything but a sticky, or pointing at something that isn't a
	// pile. (Null is a sticky that's left its pile: set, never deleted, so it
	// resolves against a concurrent move of the pile as x, y and parent do.)
	for (const [id, shape] of shapes) {
		const value = map.get(id)?.get("pile");
		if (value === undefined || value === null) continue;
		if (shape.type === "sticky" && pileOf(shapes, id) !== null) continue;
		map.get(id)?.set("pile", null);
		fixed++;
	}
	shapes = readShapes(doc);
	const thin = [...shapes].filter(
		([id, shape]) => shape.type === "pile" && (pileMembers(shapes).get(id)?.length ?? 0) < 2,
	);
	if (thin.length > 0) {
		fixed += settlePiles(
			doc,
			thin.map(([id]) => id),
		);
		shapes = readShapes(doc);
	}
	// Stickies where their pile is, in its section.
	for (const [pile, members] of pileMembers(shapes)) {
		const shape = shapes.get(pile);
		if (!shape) continue;
		const at = memberAt(shape);
		const parent = typeof shape.parent === "string" ? shape.parent : null;
		for (const id of members) {
			const member = shapes.get(id);
			const target = map.get(id);
			if (!member || !target) continue;
			let moved = false;
			if (member.x !== at.x || member.y !== at.y) {
				target.set("x", at.x);
				target.set("y", at.y);
				moved = true;
			}
			if ((member.parent ?? null) !== parent) {
				target.set("parent", parent);
				moved = true;
			}
			if (moved) fixed++;
		}
	}
	return fixed;
}

/** The transaction origin for repairs, so observers can ignore their own writes. */
export const REPAIR_ORIGIN = "repair";
