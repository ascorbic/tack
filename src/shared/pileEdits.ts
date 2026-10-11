import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";
import { isEnd } from "./connectors.ts";
import { type Point, type Rect, intersects } from "./geometry.ts";
import {
	PILE_SIZE,
	cleanName,
	memberAt,
	membersOf,
	namingTexts,
	nameState,
	openLayout,
	pileAtSticky,
	pileHash,
	pileOf,
} from "./piles.ts";
import { readingOrder } from "./display.ts";
import { spotNear } from "./placement.ts";
import type { SizeOf } from "./sections.ts";
import { type ShapeProps, addShape, nextZ, readShape, shapesMap, topZ } from "./shapes.ts";
import { commitMoves, readShapes, settlePiles } from "./structure.ts";

// Edits to piles (piles.ts has what they are). Each is one transaction;
// call them inside `transactLocal` for one undo step.

/**
 * Drop `dropped` on `target`: on a pile, they join it; on a sticky, the two
 * become a pile where the sticky was (or, if it's a sticky in an open pile,
 * they join its pile). Stickies join on top; piles dropped along bring
 * their stickies and go, as do piles left with one sticky by stickies
 * leaving them. Returns the pile, or null if nothing could be piled.
 */
export function pileUp(
	doc: Y.Doc,
	target: string,
	dropped: readonly string[],
	sizeOf?: SizeOf,
	newId: () => string = () => crypto.randomUUID(),
): string | null {
	let result: string | null = null;
	doc.transact(() => {
		const shapes = readShapes(doc);
		const map = shapesMap(doc);
		const targetShape = shapes.get(target);
		if (!targetShape) return;
		let pile: string;
		let made = false;
		if (targetShape.type === "pile") {
			pile = target;
		} else if (targetShape.type === "sticky") {
			const existing = pileOf(shapes, target);
			if (existing) pile = existing;
			else {
				pile = newId();
				made = true;
			}
		} else {
			return;
		}

		const incoming: string[] = [];
		const merged: string[] = [];
		const thinned = new Set<string>();
		const seen = new Set<string>([pile]);
		if (made) seen.add(target);
		for (const id of dropped) {
			if (seen.has(id)) continue;
			seen.add(id);
			const shape = shapes.get(id);
			if (shape?.type === "sticky") {
				const from = pileOf(shapes, id);
				if (from === pile) continue;
				if (from) thinned.add(from);
				incoming.push(id);
			} else if (shape?.type === "pile") {
				merged.push(id);
				for (const member of membersOf(shapes, id).reverse()) {
					if (seen.has(member)) continue;
					seen.add(member);
					incoming.push(member);
				}
			}
		}
		if (incoming.length === 0) return;

		if (made) {
			const at = pileAtSticky(targetShape);
			addShape(doc, pile, {
				type: "pile",
				x: Math.round(at.x),
				y: Math.round(at.y),
				z: nextZ(doc),
				parent: typeof targetShape.parent === "string" ? targetShape.parent : null,
			});
			// Someone's name for a pile dropped on a lone sticky comes along.
			const named = merged
				.map((id) => shapes.get(id))
				.find((shape) => nameState(shape) === "person");
			if (named?.title) map.get(pile)?.set("title", named.title);
		}
		const pileShape = readShape(map.get(pile) as Y.Map<unknown>);
		const at = memberAt(pileShape);
		const parent = typeof pileShape.parent === "string" ? pileShape.parent : null;
		const joining = made ? [target, ...incoming] : incoming;
		// On top of the stack, in the order they came (the first dropped lowest).
		const top = topZ(doc);
		const keys = top ? [top, ...generateNKeysBetween(top, null, joining.length - 1)] : [];
		joining.forEach((id, i) => {
			const sticky = map.get(id);
			if (!sticky) return;
			sticky.set("pile", pile);
			sticky.set("x", at.x);
			sticky.set("y", at.y);
			sticky.set("parent", parent);
			if (keys[i]) sticky.set("z", keys[i] as string);
		});
		for (const id of merged) {
			// Connectors to a pile that's gone in go to the one it went into.
			for (const [connectorId, shape] of shapes) {
				if (shape.type !== "connector") continue;
				for (const which of ["from", "to"] as const) {
					const end = shape[which];
					if (isEnd(end) && end.shape === id) {
						map.get(connectorId)?.set(which, { ...end, shape: pile });
					}
				}
			}
			map.delete(id);
			thinned.delete(id);
		}
		settlePiles(doc, thinned, sizeOf);
		result = pile;
	});
	return result;
}

/** Pile up a selection of stickies (and piles) where the first of them, in reading order, is. */
export function pileSelection(doc: Y.Doc, ids: readonly string[], sizeOf?: SizeOf): string | null {
	const shapes = readShapes(doc);
	const candidates = ids.filter((id) => {
		const type = shapes.get(id)?.type;
		return type === "sticky" || type === "pile";
	});
	if (candidates.length < 2) return null;
	const order = readingOrder(
		candidates.map((id) => {
			const shape = shapes.get(id) as ShapeProps;
			return { id, x: shape.x, y: shape.y };
		}),
	);
	// Onto a pile if there's one, else the first sticky.
	const target = order.find((id) => shapes.get(id)?.type === "pile") ?? order[0];
	if (!target) return null;
	return pileUp(
		doc,
		target,
		order.filter((id) => id !== target),
		sizeOf,
	);
}

/**
 * Stickies dragged out of a pile, dropped at `moves`: themselves again, there
 * (in whichever section that is). A pile left with one sticky dissolves.
 */
export function leavePile(doc: Y.Doc, moves: ReadonlyMap<string, Point>, sizeOf?: SizeOf): void {
	doc.transact(() => {
		const shapes = readShapes(doc);
		const map = shapesMap(doc);
		const thinned = new Set<string>();
		for (const id of moves.keys()) {
			const pile = pileOf(shapes, id);
			if (!pile) continue;
			thinned.add(pile);
			map.get(id)?.set("pile", null);
		}
		commitMoves(doc, moves, sizeOf);
		settlePiles(doc, thinned, sizeOf);
	});
}

/**
 * Move a sticky to `index` in its pile's order (0 is the top of the stack),
 * restacking only that sticky.
 */
export function reorderInPile(doc: Y.Doc, id: string, index: number): void {
	doc.transact(() => {
		const shapes = readShapes(doc);
		const pile = pileOf(shapes, id);
		if (!pile) return;
		const others = membersOf(shapes, pile).filter((member) => member !== id);
		const at = Math.max(0, Math.min(index, others.length));
		// Top first: the one above it is at - 1, below it at.
		const above = at > 0 ? (shapes.get(others[at - 1] as string)?.z ?? null) : null;
		const below = at < others.length ? (shapes.get(others[at] as string)?.z ?? null) : null;
		if (above !== null && below !== null && below >= above) return;
		try {
			const [key] = generateNKeysBetween(below, above, 1);
			if (key) shapesMap(doc).get(id)?.set("z", key);
		} catch {
			// Keys fractional-indexing can't build between: leave it where it is.
		}
	});
}

/**
 * Spread a pile out for good: its stickies laid out in a grid where it is
 * (as it shows open), themselves again, and the pile gone. Connectors to it
 * go to its top sticky.
 */
export function spreadPile(doc: Y.Doc, pile: string, sizeOf?: SizeOf): string[] {
	let spread: string[] = [];
	doc.transact(() => {
		const shapes = readShapes(doc);
		const shape = shapes.get(pile);
		if (shape?.type !== "pile") return;
		const members = membersOf(shapes, pile);
		const layout = openLayout(shape, members);
		const map = shapesMap(doc);
		for (const id of members) map.get(id)?.set("pile", null);
		const [top] = members;
		for (const [id, other] of shapes) {
			if (other.type !== "connector" || !top) continue;
			for (const which of ["from", "to"] as const) {
				const end = other[which];
				if (isEnd(end) && end.shape === pile) map.get(id)?.set(which, { ...end, shape: top });
			}
		}
		map.delete(pile);
		// Below the tray's header, as the grid shows open.
		commitMoves(doc, layout.slots, sizeOf, { raise: false });
		spread = members;
	});
	return spread;
}

/** Name a pile. An empty name clears it, so suggestions show again. */
export function setPileName(doc: Y.Doc, pile: string, name: string): void {
	const shape = shapesMap(doc).get(pile);
	if (!shape || shape.get("type") !== "pile") return;
	const clean = cleanName(name);
	doc.transact(() => {
		if (clean) {
			if (shape.get("title") !== clean) shape.set("title", clean);
		} else if (shape.has("title")) {
			shape.delete("title");
		}
	});
}

// --- Grouping a selection ("Group these") ------------------------------------------------

/** Piles proposed for some stickies: a name, and which stickies, best first. */
export interface ProposedPile {
	name: string;
	ids: string[];
}

export interface PlannedPile extends ProposedPile {
	/** Where it goes: its top left. */
	at: Point;
}

/**
 * Where each proposed pile goes: where its first sticky (in reading order)
 * is, unless that's on a pile planned before it, then the nearest free
 * space. Only stickies with something to read count, each in one pile at
 * most; piles of fewer than two are left out (those stickies stay put).
 */
export function planGrouping(
	shapes: ReadonlyMap<string, ShapeProps>,
	proposal: readonly ProposedPile[],
	sizeOf?: SizeOf,
): PlannedPile[] {
	const used = new Set<string>();
	const grouped = new Set<string>();
	const groups: ProposedPile[] = [];
	for (const pile of proposal) {
		const ids = pile.ids.filter((id) => {
			const shape = shapes.get(id);
			if (used.has(id) || shape?.type !== "sticky" || shape.silent !== undefined) return false;
			used.add(id);
			return true;
		});
		if (ids.length < 2) {
			for (const id of ids) used.delete(id);
			continue;
		}
		const name = cleanName(pile.name);
		groups.push({ name, ids });
		for (const id of ids) grouped.add(id);
	}
	// What's left on the board: everything but the stickies being piled, and the piles so far.
	const others = new Map<string, ShapeProps>();
	for (const [id, shape] of shapes) if (!grouped.has(id)) others.set(id, shape);
	const placed: Rect[] = [];
	return groups.map((group, i) => {
		const first = readingOrder(
			group.ids.map((id) => {
				const shape = shapes.get(id) as ShapeProps;
				return { id, x: shape.x, y: shape.y };
			}),
		)[0] as string;
		const sticky = shapes.get(first) as ShapeProps;
		const ideal = pileAtSticky(sticky);
		const box = { ...ideal, ...PILE_SIZE };
		const at = placed.some((other) => intersects(box, other))
			? (spotNear(others, ideal, PILE_SIZE, sizeOf) ?? ideal)
			: ideal;
		const rounded = { x: Math.round(at.x), y: Math.round(at.y) };
		placed.push({ ...rounded, ...PILE_SIZE });
		others.set(`planned:${i}`, { type: "pile", ...rounded, z: "" });
		return { ...group, at: rounded };
	});
}

/**
 * Make the planned piles, each named with its proposed name as a
 * suggestion (✨), as one transaction. Returns the new piles' ids.
 */
export function applyGrouping(
	doc: Y.Doc,
	plan: readonly PlannedPile[],
	sizeOf?: SizeOf,
	newId: () => string = () => crypto.randomUUID(),
): string[] {
	const made: string[] = [];
	doc.transact(() => {
		const map = shapesMap(doc);
		const thinned = new Set<string>();
		for (const planned of plan) {
			const shapes = readShapes(doc);
			const ids = planned.ids.filter((id) => shapes.get(id)?.type === "sticky");
			if (ids.length < 2) continue;
			const pile = newId();
			const section = shapes.get(ids[0] as string)?.parent;
			addShape(doc, pile, {
				type: "pile",
				x: planned.at.x,
				y: planned.at.y,
				z: nextZ(doc),
				parent: typeof section === "string" ? section : null,
			});
			const at = memberAt(planned.at);
			const top = topZ(doc);
			// The first listed ends up on top.
			const keys = top ? [top, ...generateNKeysBetween(top, null, ids.length - 1)] : [];
			[...ids].reverse().forEach((id, i) => {
				const from = pileOf(shapes, id);
				if (from) thinned.add(from);
				const sticky = map.get(id);
				sticky?.set("pile", pile);
				sticky?.set("x", at.x);
				sticky?.set("y", at.y);
				if (keys[i]) sticky?.set("z", keys[i] as string);
			});
			// Which section it's in, from where it landed; its stickies follow.
			commitMoves(doc, new Map([[pile, planned.at]]), sizeOf, { raise: false });
			const texts = namingTexts(readShapes(doc), ids);
			if (planned.name && texts.length > 0) {
				map.get(pile)?.set("suggested", { title: planned.name, hash: pileHash(texts) });
			}
			made.push(pile);
		}
		settlePiles(doc, thinned, sizeOf);
	});
	return made;
}
