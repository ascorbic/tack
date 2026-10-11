import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";
import { type PendingChange, changesMadeFrom, listChanges, unstageChanges } from "./changes.ts";
import { isEnd, looseEnd, resolveEnds } from "./connectors.ts";
import {
	type DisplayLayout,
	displaySections,
	insertionIndex,
	joinDisplay,
	layoutDisplays,
	moveInList,
	sortOf,
} from "./display.ts";
import { type Point, type Rect, area, centre, contains, intersects } from "./geometry.ts";
import { isStacked, memberAt, stackMembers } from "./stacks.ts";
import {
	SECTION_DEFAULT,
	SECTION_MIN,
	type SectionColor,
	type SectionGeometry,
	type SizeOf,
	type Structure,
	boxOf,
	containerFor,
	descendantsOf,
	readStructure,
} from "./sections.ts";
import {
	type ConnectorEnd,
	type ShapeProps,
	addShape,
	nextZ,
	readShape,
	shapesMap,
	topZ,
} from "./shapes.ts";
import { normaliseWidgetRect } from "./widgetRegistry.ts";

// Edits that keep the board's structure consistent: dropping shapes in and
// out of sections, moving and resizing sections with their contents, and
// deleting shapes without leaving connectors bound to nothing. Each runs in
// one transaction; wrap calls in an outer transaction to set its origin.

type Shapes = Map<string, ShapeProps>;

export function readShapes(doc: Y.Doc): Shapes {
	const out: Shapes = new Map();
	for (const [id, shape] of shapesMap(doc)) out.set(id, readShape(shape));
	return out;
}

/**
 * Every section's geometry for containment. A section showing a list or grid
 * (display.ts) takes what lands on the list it draws, wherever its free-form
 * box is, and counts as at least as big as that box.
 */
export function sectionGeometries(
	shapes: ReadonlyMap<string, ShapeProps>,
	structure: Structure,
	layout: DisplayLayout = layoutDisplays(shapes, structure),
): SectionGeometry[] {
	const out: SectionGeometry[] = [];
	for (const [id, shape] of shapes) {
		if (shape.type !== "section") continue;
		const own = boxOf(id, shape);
		const drawn = layout.sections.get(id)?.box;
		out.push({
			id,
			box: drawn ?? own,
			depth: structure.depth.get(id) ?? 0,
			z: shape.z,
			...(drawn && { area: Math.max(area(own), area(drawn)) }),
		});
	}
	return out;
}

/**
 * Re-decide which section each of `ids` is in, from where it is now. Moved
 * shapes always have their parent written (see shapes.ts for why); other
 * shapes only when it changes.
 *
 * Bigger shapes go first, and containment is re-read after each change, so
 * a section that moves into another one is already nested (and so deeper)
 * by the time its own contents are considered: they stay in it rather than
 * jumping to the new outer section.
 */
function reparent(doc: Y.Doc, ids: Iterable<string>, always: boolean, sizeOf?: SizeOf): void {
	let shapes = readShapes(doc);
	let structure = readStructure(shapes);
	let sections = sectionGeometries(shapes, structure);
	let lists = displaySections(shapes, structure);
	const map = shapesMap(doc);
	const size = (id: string) => {
		const shape = shapes.get(id);
		if (!shape) return 0;
		const box = boxOf(id, shape, sizeOf);
		return box.w * box.h;
	};
	const ordered = [...new Set(ids)].sort((a, b) => size(b) - size(a));
	for (const id of ordered) {
		const shape = shapes.get(id);
		if (!shape || shape.type === "connector") continue;
		// A stacked sticky is wherever its stack is (see below).
		if (isStacked(shapes, id)) continue;
		const current = structure.parentOf.get(id) ?? null;
		// A list's rows stay in it until they're dropped somewhere else: their
		// free-form positions are hidden, so they say nothing about where they are.
		if (!always && current !== null && lists.has(current) && !structure.broken.has(id)) continue;
		const exclude = new Set([id, ...descendantsOf(structure, id)]);
		const container = containerFor(boxOf(id, shape, sizeOf), sections, exclude);
		const changed = container !== current || structure.broken.has(id);
		const target = map.get(id);
		if (always || changed) target?.set("parent", container);
		// A stack's stickies are in whichever section it's in.
		if (changed && shape.type === "stack") {
			for (const member of stackMembers(shapes).get(id) ?? []) {
				map.get(member)?.set("parent", container);
			}
		}
		if (changed) {
			// Its place in the old section's order means nothing in the new one.
			if (target?.has("order")) target.delete("order");
			if (container !== null && lists.has(container)) {
				// Into a list: where it landed among the rows (unless the list is
				// sorted, which decides), with a free-form spot for later.
				const at = centre(boxOf(id, shape, sizeOf));
				const index = insertionIndex(layoutDisplays(shapes, structure), container, at);
				joinDisplay(doc, id, container, sizeOf);
				if (!sortOf(shapes.get(container))) moveInList(doc, container, [id], index);
			}
			shapes = readShapes(doc);
			structure = readStructure(shapes);
			sections = sectionGeometries(shapes, structure);
			lists = displaySections(shapes, structure);
		}
	}
}

/**
 * Put newly added shapes into whichever section they landed in. Call in the
 * same transaction as adding them.
 */
export function placeInSections(doc: Y.Doc, ids: Iterable<string>, sizeOf?: SizeOf): void {
	doc.transact(() => reparent(doc, ids, true, sizeOf));
}

/** Non-connector shapes overlapping any of `boxes`, other than `skip`. */
function overlapping(
	shapes: Shapes,
	boxes: Rect[],
	skip: ReadonlySet<string>,
	sizeOf?: SizeOf,
): string[] {
	const out: string[] = [];
	for (const [id, shape] of shapes) {
		if (skip.has(id) || shape.type === "connector") continue;
		const box = boxOf(id, shape, sizeOf);
		if (boxes.some((other) => intersects(box, other))) out.push(id);
	}
	return out;
}

/**
 * Commit dropped shapes. Sections bring their contents (and loose connector
 * ends inside them) along, everything that moved comes to the front in its
 * existing order, and dropped shapes join whichever section they landed in.
 * A section dropped over shapes takes them in.
 */
export function commitMoves(
	doc: Y.Doc,
	moves: ReadonlyMap<string, Point>,
	sizeOf?: SizeOf,
	{ raise = true }: { /** Bring what moved to the front, as a drop does. */ raise?: boolean } = {},
): void {
	doc.transact(() => {
		const before = readShapes(doc);
		const structure = readStructure(before);
		const moved = [...moves.keys()].filter((id) => {
			const type = before.get(id)?.type;
			return type !== undefined && type !== "connector";
		});
		if (moved.length === 0) return;
		const movedSet = new Set(moved);

		// Where everything ends up, including contents following their section.
		const positions = new Map<string, Point>();
		for (const id of moved) {
			const to = moves.get(id) as Point;
			positions.set(id, { x: Math.round(to.x), y: Math.round(to.y) });
		}
		const follow = (section: string, delta: Point) => {
			for (const child of structure.children.get(section) ?? []) {
				// A moved child brings its own position and contents.
				if (movedSet.has(child)) continue;
				const shape = before.get(child) as ShapeProps;
				positions.set(child, { x: shape.x + delta.x, y: shape.y + delta.y });
				follow(child, delta);
			}
		};
		// A stack's stickies are where its top sticky is drawn, wherever it goes;
		// a stacked sticky moved on its own stays with its stack.
		const members = stackMembers(before);
		for (const id of moved) {
			const stack = before.get(id)?.stack;
			if (isStacked(before, id) && typeof stack === "string" && !movedSet.has(stack)) {
				positions.delete(id);
			}
		}
		const sectionMoves: { from: Rect; to: Rect; delta: Point }[] = [];
		for (const id of moved) {
			const shape = before.get(id) as ShapeProps;
			if (shape.type !== "section") continue;
			const to = positions.get(id) as Point;
			const delta = { x: to.x - shape.x, y: to.y - shape.y };
			const from = boxOf(id, shape);
			sectionMoves.push({ from, to: { ...from, x: to.x, y: to.y }, delta });
			if (delta.x !== 0 || delta.y !== 0) follow(id, delta);
		}

		for (const [stack, list] of members) {
			const at = positions.get(stack);
			if (!at) continue;
			for (const member of list) positions.set(member, memberAt(at));
		}

		const map = shapesMap(doc);
		for (const [id, position] of positions) {
			const shape = map.get(id);
			if (!shape) continue;
			shape.set("x", position.x);
			shape.set("y", position.y);
			if (!movedSet.has(id)) shape.set("parent", structure.parentOf.get(id) ?? null);
		}

		// Bring what moved to the front, keeping its stacking order.
		const order = [...positions.keys()].sort((a, b) => {
			const za = before.get(a)?.z ?? "";
			const zb = before.get(b)?.z ?? "";
			return za < zb ? -1 : za > zb ? 1 : 0;
		});
		const only = order.length === 1 ? order[0] : undefined;
		const first = !raise ? null : only === undefined ? topZ(doc) : topZ(doc, only);
		if (first) {
			const keys = [first, ...generateNKeysBetween(first, null, order.length - 1)];
			order.forEach((id, i) => map.get(id)?.set("z", keys[i] as string));
		}

		// Loose connector ends inside a moved section move with it. Bound ends
		// follow their shapes by themselves, and are left alone: rewriting
		// them here could undo someone re-attaching that end at the same time.
		for (const [id, shape] of before) {
			if (shape.type !== "connector") continue;
			const connector = map.get(id);
			for (const which of ["from", "to"] as const) {
				const end = shape[which];
				if (!isEnd(end) || end.shape) continue;
				const delta = sectionMoves.find((move) => contains(move.from, end))?.delta;
				if (delta && (delta.x !== 0 || delta.y !== 0)) {
					connector?.set(which, { ...end, x: end.x + delta.x, y: end.y + delta.y });
				}
			}
		}

		// Containment: what was dropped, then anything a moved section now covers.
		reparent(doc, moved, true, sizeOf);
		// Moved stacks write where their stickies are, which section, and that
		// they're in the stack, all together, so a concurrent drag out of the
		// stack either wins whole or loses whole (see stacks.ts).
		const after = readShapes(doc);
		for (const [stack, list] of members) {
			if (!positions.has(stack)) continue;
			const parent = after.get(stack)?.parent;
			for (const member of list) {
				const shape = map.get(member);
				shape?.set("parent", typeof parent === "string" ? parent : null);
				shape?.set("stack", stack);
			}
		}
		if (sectionMoves.length > 0) {
			const covered = overlapping(
				readShapes(doc),
				sectionMoves.map((move) => move.to),
				new Set(positions.keys()),
				sizeOf,
			);
			reparent(doc, covered, false, sizeOf);
		}
	});
}

/**
 * Resize a section. Its contents stay where they are: anything now outside
 * it leaves, and anything it now covers joins.
 */
export function resizeSection(doc: Y.Doc, id: string, rect: Rect, sizeOf?: SizeOf): void {
	doc.transact(() => {
		const shape = shapesMap(doc).get(id);
		if (!shape || shape.get("type") !== "section") return;
		const next = normaliseSectionRect(rect);
		shape.set("x", next.x);
		shape.set("y", next.y);
		shape.set("w", next.w);
		shape.set("h", next.h);

		const shapes = readShapes(doc);
		const structure = readStructure(shapes);
		const inside = new Set([id, ...descendantsOf(structure, id)]);
		reparent(doc, [id], true, sizeOf);
		reparent(
			doc,
			[...(structure.children.get(id) ?? []), ...overlapping(shapes, [next], inside, sizeOf)],
			false,
			sizeOf,
		);
	});
}

/**
 * Resize a widget (#37). Like any shape that moves, it then belongs to
 * whichever section it's in; unlike a section, it never takes anything in.
 */
export function resizeWidget(doc: Y.Doc, id: string, rect: Rect, sizeOf?: SizeOf): void {
	doc.transact(() => {
		const shape = shapesMap(doc).get(id);
		if (!shape || shape.get("type") !== "widget") return;
		const next = normaliseWidgetRect(rect);
		shape.set("x", next.x);
		shape.set("y", next.y);
		shape.set("w", next.w);
		shape.set("h", next.h);
		reparent(doc, [id], true, sizeOf);
	});
}

export function normaliseSectionRect(rect: Rect): Rect {
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		w: Math.round(Math.max(rect.w, SECTION_MIN.w)),
		h: Math.round(Math.max(rect.h, SECTION_MIN.h)),
	};
}

/** Add a section, taking in whatever it's drawn around. Returns its id. */
export function addSection(
	doc: Y.Doc,
	rect: Partial<Rect> & Point,
	{
		title = "",
		color = "grey",
		id = crypto.randomUUID(),
	}: {
		title?: string;
		color?: SectionColor;
		id?: string;
	} = {},
	sizeOf?: SizeOf,
): string {
	const box = normaliseSectionRect({
		w: SECTION_DEFAULT.w,
		h: SECTION_DEFAULT.h,
		...rect,
	});
	doc.transact(() => {
		addShape(doc, id, { type: "section", ...box, title, color, parent: null, z: nextZ(doc) });
		reparent(doc, [id], true, sizeOf);
		const shapes = readShapes(doc);
		reparent(doc, overlapping(shapes, [box], new Set([id]), sizeOf), false, sizeOf);
	});
	return id;
}

/**
 * Delete shapes. Deleting a section deletes what's in it. Connectors bound
 * to a deleted shape keep a loose end where it was; connectors whose ends
 * were both bound to deleted shapes go too.
 */
export function removeShapes(doc: Y.Doc, ids: Iterable<string>, sizeOf?: SizeOf): void {
	doc.transact(() => {
		const shapes = readShapes(doc);
		const doomed = doomedBy(shapes, ids);
		// Stacks that lose stickies without going themselves: one left dissolves.
		const thinned = new Set<string>();
		for (const id of doomed) {
			const stack = shapes.get(id)?.stack;
			if (isStacked(shapes, id) && typeof stack === "string" && !doomed.has(stack))
				thinned.add(stack);
		}
		// What was staged from them goes with them, in the same transaction,
		// so one Undo brings both back (see `changesMadeFrom`).
		const unstaged = changesMadeFrom(doc, doomed);
		if (unstaged.length > 0) unstageChanges(doc, unstaged);
		const map = shapesMap(doc);
		const box = (id: string) => {
			const shape = shapes.get(id);
			return shape ? boxOf(id, shape, sizeOf) : undefined;
		};
		for (const [id, shape] of shapes) {
			if (shape.type !== "connector" || doomed.has(id)) continue;
			const { from, to } = shape;
			if (!isEnd(from) || !isEnd(to)) continue;
			const fromGone = !!from.shape && doomed.has(from.shape);
			const toGone = !!to.shape && doomed.has(to.shape);
			if (fromGone && toGone) {
				doomed.add(id);
				continue;
			}
			if (!fromGone && !toGone) continue;
			const { start, end } = resolveEnds(from, to, box, 0);
			const connector = map.get(id);
			if (fromGone) connector?.set("from", looseEnd(start.point));
			if (toGone) connector?.set("to", looseEnd(end.point));
		}
		for (const id of doomed) map.delete(id);
		if (thinned.size > 0) settleStacks(doc, thinned, sizeOf);
	});
}

/**
 * Stacks that may have lost stickies: one left with a single sticky
 * dissolves back into it (the sticky lands where the stack's top sticky
 * was, and connectors to the stack go to it), and one left with none goes.
 * Returns how many it settled.
 */
export function settleStacks(doc: Y.Doc, stacks: Iterable<string>, sizeOf?: SizeOf): number {
	let settled = 0;
	doc.transact(() => {
		const map = shapesMap(doc);
		for (const stack of new Set(stacks)) {
			const shapes = readShapes(doc);
			const shape = shapes.get(stack);
			if (shape?.type !== "stack") continue;
			const members = stackMembers(shapes).get(stack) ?? [];
			if (members.length >= 2) continue;
			settled++;
			const [last] = members;
			if (last === undefined) {
				removeShapes(doc, [stack], sizeOf);
				continue;
			}
			const sticky = map.get(last);
			const at = memberAt(shape);
			sticky?.set("stack", null);
			sticky?.set("x", at.x);
			sticky?.set("y", at.y);
			sticky?.set("parent", typeof shape.parent === "string" ? shape.parent : null);
			for (const [id, other] of shapes) {
				if (other.type !== "connector") continue;
				for (const which of ["from", "to"] as const) {
					const end = other[which];
					if (isEnd(end) && end.shape === stack) map.get(id)?.set(which, { ...end, shape: last });
				}
			}
			map.delete(stack);
		}
	});
	return settled;
}

/**
 * What deleting `ids` deletes: the shapes, everything inside sections among
 * them, the stickies in stacks among them, and connectors whose ends are
 * both bound to those.
 */
function doomedBy(shapes: ReadonlyMap<string, ShapeProps>, ids: Iterable<string>): Set<string> {
	const structure = readStructure(shapes);
	const members = stackMembers(shapes);
	const doomed = new Set<string>();
	for (const id of ids) {
		if (!shapes.has(id)) continue;
		doomed.add(id);
		for (const inside of descendantsOf(structure, id)) doomed.add(inside);
	}
	for (const id of doomed) {
		for (const member of members.get(id) ?? []) doomed.add(member);
	}
	for (const [id, shape] of shapes) {
		if (shape.type !== "connector" || doomed.has(id)) continue;
		const { from, to } = shape;
		if (!isEnd(from) || !isEnd(to)) continue;
		if (from.shape && to.shape && doomed.has(from.shape) && doomed.has(to.shape)) doomed.add(id);
	}
	return doomed;
}

/**
 * The staged changes deleting `ids` would unstage (see `removeShapes`), so
 * the toast can say so before it happens.
 */
export function unstagedByDeleting(doc: Y.Doc, ids: Iterable<string>): PendingChange[] {
	const gone = new Set(changesMadeFrom(doc, doomedBy(readShapes(doc), ids)));
	return listChanges(doc).filter((change) => gone.has(change.id));
}

export interface NewConnector {
	from: ConnectorEnd;
	to: ConnectorEnd;
	route?: ShapeProps["route"];
	arrow?: ShapeProps["arrow"];
	dash?: boolean;
	color?: string;
	label?: string;
}

/** Add a connector and return its id. Pass ends with fallbacks (see `withFallbacks`). */
export function addConnector(
	doc: Y.Doc,
	connector: NewConnector,
	id: string = crypto.randomUUID(),
): string {
	addShape(doc, id, { type: "connector", x: 0, y: 0, z: nextZ(doc), ...connector });
	return id;
}

/**
 * What copying `ids` should take: sections bring what's in them, stacks
 * their stickies, and connectors come along when every shape they're
 * attached to is copied.
 */
export function copyClosure(doc: Y.Doc, ids: Iterable<string>): string[] {
	const shapes = readShapes(doc);
	const structure = readStructure(shapes);
	const members = stackMembers(shapes);
	const out = new Set<string>();
	for (const id of ids) {
		if (!shapes.has(id)) continue;
		out.add(id);
		for (const inside of descendantsOf(structure, id)) out.add(inside);
	}
	for (const id of out) {
		for (const member of members.get(id) ?? []) out.add(member);
	}
	for (const [id, shape] of shapes) {
		if (shape.type !== "connector" || out.has(id)) continue;
		const ends = [shape.from, shape.to].filter(isEnd);
		const bound = ends.filter((end) => end.shape);
		if (bound.length > 0 && bound.every((end) => out.has(end.shape as string))) out.add(id);
	}
	return [...out];
}

/**
 * Tidy shapes just pasted `offset` away from their originals. Copying
 * already points references between copied shapes at the copies; here,
 * connector ends move with the paste (and let go of shapes that weren't
 * copied), and pasted shapes join whichever section they landed in unless
 * they came with their own.
 */
export function settlePasted(
	doc: Y.Doc,
	ids: readonly string[],
	offset: Point,
	sizeOf?: SizeOf,
): void {
	doc.transact(() => {
		const map = shapesMap(doc);
		const pasted = new Set(ids);
		const place: string[] = [];
		for (const id of ids) {
			const shape = map.get(id);
			if (!shape) continue;
			if (shape.get("type") === "connector") {
				for (const which of ["from", "to"] as const) {
					const end = shape.get(which);
					if (!isEnd(end)) continue;
					const at = { x: Math.round(end.x + offset.x), y: Math.round(end.y + offset.y) };
					shape.set(which, end.shape && pasted.has(end.shape) ? { ...end, ...at } : at);
				}
				continue;
			}
			// A sticky copied out of a stack without it is a sticky of its own.
			const stack = shape.get("stack");
			if (stack !== undefined && (typeof stack !== "string" || !pasted.has(stack))) {
				shape.delete("stack");
			}
			const parent = shape.get("parent");
			if (typeof parent !== "string" || !pasted.has(parent)) place.push(id);
		}
		reparent(doc, place, true, sizeOf);
		// Stickies pasted in a stack are in whichever section it landed in.
		const shapes = readShapes(doc);
		for (const [stack, members] of stackMembers(shapes)) {
			if (!pasted.has(stack)) continue;
			const parent = shapes.get(stack)?.parent;
			for (const member of members) {
				if (shapes.get(member)?.parent !== parent) {
					map.get(member)?.set("parent", typeof parent === "string" ? parent : null);
				}
			}
		}
	});
}
