import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";
import { isEnd } from "./connectors.ts";
import { type Point, type Rect, intersects } from "./geometry.ts";
import {
	STACK_SIZE,
	cleanName,
	isStackable,
	memberAt,
	membersOf,
	namingTexts,
	nameState,
	openLayout,
	stackAtSticky,
	stackHash,
	stackOf,
} from "./stacks.ts";
import { readingOrder } from "./display.ts";
import { spotNear } from "./placement.ts";
import type { SizeOf } from "./sections.ts";
import { type ShapeProps, addShape, nextZ, readShape, shapesMap, topZ } from "./shapes.ts";
import { commitMoves, readShapes, settleStacks } from "./structure.ts";

// Edits to stacks (stacks.ts has what they are). Each is one transaction;
// call them inside `transactLocal` for one undo step.

/**
 * Drop `dropped` on `target`: on a stack, they join it; on a sticky or card,
 * the two become a stack where it was (or, if it's in an open stack, they
 * join its stack). Stickies and cards join on top; stacks dropped along
 * bring their members and go, as do stacks left with one member by members
 * leaving them. Returns the stack, or null if nothing could be stacked.
 */
export function stackUp(
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
		let stack: string;
		let made = false;
		if (targetShape.type === "stack") {
			stack = target;
		} else if (isStackable(targetShape.type)) {
			const existing = stackOf(shapes, target);
			if (existing) stack = existing;
			else {
				stack = newId();
				made = true;
			}
		} else {
			return;
		}

		const incoming: string[] = [];
		const merged: string[] = [];
		const thinned = new Set<string>();
		const seen = new Set<string>([stack]);
		if (made) seen.add(target);
		for (const id of dropped) {
			if (seen.has(id)) continue;
			seen.add(id);
			const shape = shapes.get(id);
			if (isStackable(shape?.type)) {
				const from = stackOf(shapes, id);
				if (from === stack) continue;
				if (from) thinned.add(from);
				incoming.push(id);
			} else if (shape?.type === "stack") {
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
			const at = stackAtSticky(targetShape);
			addShape(doc, stack, {
				type: "stack",
				x: Math.round(at.x),
				y: Math.round(at.y),
				z: nextZ(doc),
				parent: typeof targetShape.parent === "string" ? targetShape.parent : null,
			});
			// Someone's name for a stack dropped on a lone sticky comes along.
			const named = merged
				.map((id) => shapes.get(id))
				.find((shape) => nameState(shape) === "person");
			if (named?.title) map.get(stack)?.set("title", named.title);
		}
		const stackShape = readShape(map.get(stack) as Y.Map<unknown>);
		const at = memberAt(stackShape);
		const parent = typeof stackShape.parent === "string" ? stackShape.parent : null;
		const joining = made ? [target, ...incoming] : incoming;
		// On top of the stack, in the order they came (the first dropped lowest).
		const top = topZ(doc);
		const keys = top ? [top, ...generateNKeysBetween(top, null, joining.length - 1)] : [];
		joining.forEach((id, i) => {
			const sticky = map.get(id);
			if (!sticky) return;
			sticky.set("stack", stack);
			sticky.set("x", at.x);
			sticky.set("y", at.y);
			sticky.set("parent", parent);
			if (keys[i]) sticky.set("z", keys[i] as string);
		});
		for (const id of merged) {
			// Connectors to a stack that's gone in go to the one it went into.
			for (const [connectorId, shape] of shapes) {
				if (shape.type !== "connector") continue;
				for (const which of ["from", "to"] as const) {
					const end = shape[which];
					if (isEnd(end) && end.shape === id) {
						map.get(connectorId)?.set(which, { ...end, shape: stack });
					}
				}
			}
			map.delete(id);
			thinned.delete(id);
		}
		settleStacks(doc, thinned, sizeOf);
		result = stack;
	});
	return result;
}

/**
 * Stack up a selection of stickies, cards and stacks where the first of
 * them, in reading order, is.
 */
export function stackSelection(doc: Y.Doc, ids: readonly string[], sizeOf?: SizeOf): string | null {
	const shapes = readShapes(doc);
	const candidates = ids.filter((id) => {
		const type = shapes.get(id)?.type;
		return isStackable(type) || type === "stack";
	});
	if (candidates.length < 2) return null;
	const order = readingOrder(
		candidates.map((id) => {
			const shape = shapes.get(id) as ShapeProps;
			return { id, x: shape.x, y: shape.y };
		}),
	);
	// Onto a stack if there's one, else the first sticky or card.
	const target = order.find((id) => shapes.get(id)?.type === "stack") ?? order[0];
	if (!target) return null;
	return stackUp(
		doc,
		target,
		order.filter((id) => id !== target),
		sizeOf,
	);
}

/**
 * Stickies dragged out of a stack, dropped at `moves`: themselves again, there
 * (in whichever section that is). A stack left with one sticky dissolves.
 */
export function leaveStack(doc: Y.Doc, moves: ReadonlyMap<string, Point>, sizeOf?: SizeOf): void {
	doc.transact(() => {
		const shapes = readShapes(doc);
		const map = shapesMap(doc);
		const thinned = new Set<string>();
		for (const id of moves.keys()) {
			const stack = stackOf(shapes, id);
			if (!stack) continue;
			thinned.add(stack);
			map.get(id)?.set("stack", null);
		}
		commitMoves(doc, moves, sizeOf);
		settleStacks(doc, thinned, sizeOf);
	});
}

/**
 * Move a sticky to `index` in its stack's order (0 is the top of the stack),
 * restacking only that sticky.
 */
export function reorderInStack(doc: Y.Doc, id: string, index: number): void {
	doc.transact(() => {
		const shapes = readShapes(doc);
		const stack = stackOf(shapes, id);
		if (!stack) return;
		const others = membersOf(shapes, stack).filter((member) => member !== id);
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
 * Spread a stack out for good: its members laid out in a grid where it is
 * (as it shows open), themselves again, and the stack gone. Connectors to it
 * go to its top member.
 */
export function spreadStack(doc: Y.Doc, stack: string, sizeOf?: SizeOf): string[] {
	let spread: string[] = [];
	doc.transact(() => {
		const shapes = readShapes(doc);
		const shape = shapes.get(stack);
		if (shape?.type !== "stack") return;
		const members = membersOf(shapes, stack);
		const layout = openLayout(shape, members, {
			typeOf: (id) => shapes.get(id)?.type,
			sizeOf: (id) => sizeOf?.(id),
			size: sizeOf?.(stack),
		});
		const map = shapesMap(doc);
		for (const id of members) map.get(id)?.set("stack", null);
		const [top] = members;
		for (const [id, other] of shapes) {
			if (other.type !== "connector" || !top) continue;
			for (const which of ["from", "to"] as const) {
				const end = other[which];
				if (isEnd(end) && end.shape === stack) map.get(id)?.set(which, { ...end, shape: top });
			}
		}
		map.delete(stack);
		// Below the tray's header, as the grid shows open.
		commitMoves(doc, layout.slots, sizeOf, { raise: false });
		spread = members;
	});
	return spread;
}

/** Name a stack. An empty name clears it, so suggestions show again. */
export function setStackName(doc: Y.Doc, stack: string, name: string): void {
	const shape = shapesMap(doc).get(stack);
	if (!shape || shape.get("type") !== "stack") return;
	const clean = cleanName(name);
	doc.transact(() => {
		if (clean) {
			if (shape.get("title") !== clean) shape.set("title", clean);
		} else if (shape.has("title")) {
			shape.delete("title");
		}
	});
}

// --- Grouping a selection (Auto-stack) --------------------------------------------------

/** Stacks proposed for some stickies: a name, and which stickies, best first. */
export interface ProposedStack {
	name: string;
	ids: string[];
	/** A person wrote (or changed) the name, so it's theirs, not a suggestion. */
	named?: boolean;
}

export interface PlannedStack extends ProposedStack {
	/** Where it goes: its top left. */
	at: Point;
}

/**
 * Where each proposed stack goes: where its first sticky (in reading order)
 * is, unless that's on a stack planned before it, then the nearest free
 * space. Only stickies with something to read count, each in one stack at
 * most; stacks of fewer than two are left out (those stickies stay put).
 */
export function planGrouping(
	shapes: ReadonlyMap<string, ShapeProps>,
	proposal: readonly ProposedStack[],
	sizeOf?: SizeOf,
): PlannedStack[] {
	const used = new Set<string>();
	const grouped = new Set<string>();
	const groups: ProposedStack[] = [];
	for (const stack of proposal) {
		const ids = stack.ids.filter((id) => {
			const shape = shapes.get(id);
			if (used.has(id) || !isStackable(shape?.type) || shape?.silent !== undefined) return false;
			used.add(id);
			return true;
		});
		if (ids.length < 2) {
			for (const id of ids) used.delete(id);
			continue;
		}
		const name = cleanName(stack.name);
		groups.push({ name, ids, ...(stack.named && name ? { named: true } : {}) });
		for (const id of ids) grouped.add(id);
	}
	// What's left on the board: everything but the stickies being stacked, and the stacks so far.
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
		const ideal = stackAtSticky(sticky);
		const box = { ...ideal, ...STACK_SIZE };
		const at = placed.some((other) => intersects(box, other))
			? (spotNear(others, ideal, STACK_SIZE, sizeOf) ?? ideal)
			: ideal;
		const rounded = { x: Math.round(at.x), y: Math.round(at.y) };
		placed.push({ ...rounded, ...STACK_SIZE });
		others.set(`planned:${i}`, { type: "stack", ...rounded, z: "" });
		return { ...group, at: rounded };
	});
}

/**
 * Make the planned stacks, each named with its proposed name as a
 * suggestion (✨), or as a person's name if they wrote it (`named`), as one
 * transaction. Returns the new stacks' ids.
 */
export function applyGrouping(
	doc: Y.Doc,
	plan: readonly PlannedStack[],
	sizeOf?: SizeOf,
	newId: () => string = () => crypto.randomUUID(),
): string[] {
	const made: string[] = [];
	doc.transact(() => {
		const map = shapesMap(doc);
		const thinned = new Set<string>();
		for (const planned of plan) {
			const shapes = readShapes(doc);
			const ids = planned.ids.filter((id) => isStackable(shapes.get(id)?.type));
			if (ids.length < 2) continue;
			const stack = newId();
			const section = shapes.get(ids[0] as string)?.parent;
			addShape(doc, stack, {
				type: "stack",
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
				const from = stackOf(shapes, id);
				if (from) thinned.add(from);
				const sticky = map.get(id);
				sticky?.set("stack", stack);
				sticky?.set("x", at.x);
				sticky?.set("y", at.y);
				if (keys[i]) sticky?.set("z", keys[i] as string);
			});
			// Which section it's in, from where it landed; its stickies follow.
			commitMoves(doc, new Map([[stack, planned.at]]), sizeOf, { raise: false });
			const texts = namingTexts(readShapes(doc), ids);
			if (planned.named && planned.name) {
				map.get(stack)?.set("title", planned.name);
			} else if (planned.name && texts.length > 0) {
				map.get(stack)?.set("suggested", { title: planned.name, hash: stackHash(texts) });
			}
			made.push(stack);
		}
		settleStacks(doc, thinned, sizeOf);
	});
	return made;
}
