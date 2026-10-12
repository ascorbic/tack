import type * as Y from "yjs";
import type { Point } from "./geometry.ts";
import { type Growth, planGrowth, writeBoxes } from "./growth.ts";
import { PLACE_GAP } from "./placement.ts";
import { NOMINAL_SIZE, type Size, type SizeOf, boxOf } from "./sections.ts";
import { type ShapeProps, shapesMap } from "./shapes.ts";
import { spreadStack } from "./stackEdits.ts";
import { stackOf } from "./stacks.ts";
import { readShapes } from "./structure.ts";

// Making room for cards before stickies turn into them (#11.1 of the
// writeback review). A pushed brainstorm swaps each sticky for its new
// issue's card, in place, and cards are wider than stickies: people place
// stickies about 200 px apart, and a 252 px card centred where a 176 px
// sticky was overlaps its neighbour. So when a push starts, the rows those
// stickies are in spread out, left to right, just enough for every card to
// fit with a gap, and anything else in the row slides along with them. A
// section grows to keep what's in it. Rows stay rows, and nothing moves that
// doesn't need to: a lone sticky with room beside it stays exactly where it
// is. Pure, so the push engine and the playground's pretend server agree.

/** Room a card takes: as it's first drawn, before its data arrives. */
const CARD: Size = NOMINAL_SIZE.card ?? { w: 252, h: 124 };

/** What can sit in a row, and slide along to make room. */
const IN_ROWS: ReadonlySet<ShapeProps["type"]> = new Set([
	"sticky",
	"card",
	"text",
	"action",
	"decision",
]);

export interface RoomPlan {
	/** Shapes to move: the stickies about to become cards, and their neighbours. */
	moves: Map<string, Point>;
	/** Sections to grow so they keep what's in them, and their new boxes. */
	sections: Growth;
}

interface Item {
	id: string;
	x: number;
	y: number;
	/** As it'll be once swapped: a card's size for the stickies that become cards. */
	w: number;
	h: number;
	/** Its width before: whether it grew decides whether its neighbours move. */
	was: number;
}

/**
 * Where everything goes so that `stickies` can each become a card where it
 * is. Rows are shapes in the same section (or none) whose tops are within
 * half a sticky of each other; in each, a shape that a card (or a shape
 * pushed along by one) would now overlap moves right until it doesn't.
 * Sections showing a list or grid are left alone: their rows are laid out
 * for them.
 */
export function planRoomForCards(
	shapes: ReadonlyMap<string, ShapeProps>,
	stickies: Iterable<string>,
	sizeOf?: SizeOf,
): RoomPlan {
	const swapping = new Set([...stickies].filter((id) => shapes.get(id)?.type === "sticky"));
	const plan: RoomPlan = { moves: new Map(), sections: new Map() };
	if (swapping.size === 0) return plan;

	const groups = new Map<string | null, Item[]>();
	for (const [id, shape] of shapes) {
		if (!IN_ROWS.has(shape.type)) continue;
		const parent =
			shape.parent && shapes.get(shape.parent)?.type === "section" ? shape.parent : null;
		const box = boxOf(id, shape, sizeOf);
		const size = swapping.has(id) ? CARD : box;
		const item = { id, x: box.x, y: box.y, w: size.w, h: size.h, was: box.w };
		const group = groups.get(parent);
		if (group) group.push(item);
		else groups.set(parent, [item]);
	}

	const half = (NOMINAL_SIZE.sticky?.h ?? 176) / 2;
	for (const [parent, items] of groups) {
		if (!items.some((item) => swapping.has(item.id))) continue;
		if (parent && shapes.get(parent)?.display) continue;
		for (const row of rowsOf(items, half)) {
			row.sort((a, b) => a.x - b.x);
			for (const [i, item] of row.entries()) {
				// Only shapes that grew (cards) or were pushed push what's after
				// them: shapes people overlapped on purpose stay overlapped.
				let clear = Number.NEGATIVE_INFINITY;
				for (const before of row.slice(0, i)) {
					if (before.w <= before.was && !plan.moves.has(before.id)) continue;
					if (item.y >= before.y + before.h || before.y >= item.y + item.h) continue;
					clear = Math.max(clear, before.x + before.w + PLACE_GAP);
				}
				if (item.x < clear) {
					item.x = clear;
					plan.moves.set(item.id, { x: Math.round(item.x), y: Math.round(item.y) });
				}
			}
		}
		// The section grows to keep its shapes, as they'll be, inside it.
		if (parent) {
			const boxes = items.map((item) => [item.id, item] as const);
			planGrowth(shapes, boxes, { plan: plan.sections });
		}
	}
	return plan;
}

/** Shapes whose tops are close together, top to bottom. */
function rowsOf(items: Item[], tolerance: number): Item[][] {
	const sorted = [...items].sort((a, b) => a.y - b.y);
	const rows: Item[][] = [];
	let top = Number.NEGATIVE_INFINITY;
	for (const item of sorted) {
		if (item.y - top > tolerance || rows.length === 0) {
			rows.push([item]);
			top = item.y;
		} else {
			rows.at(-1)?.push(item);
		}
	}
	return rows;
}

/**
 * Make room for `stickies` to become cards (see `planRoomForCards`). Call
 * inside a transaction with the right origin: the push engine's, which
 * nobody can undo. Moves write x, y and the section together, as every
 * committed move does. Returns how many shapes moved.
 */
export function makeRoomForCards(doc: Y.Doc, stickies: Iterable<string>, sizeOf?: SizeOf): number {
	const list = [...stickies];
	// A stack whose stickies are becoming cards spreads out where it is
	// first (#73), so the new issues land where people can see them, under
	// their parent, rather than in a stack nobody opened.
	const before = readShapes(doc);
	const spreading = new Set(list.flatMap((id) => stackOf(before, id) ?? []));
	for (const stack of spreading) spreadStack(doc, stack, sizeOf);
	const plan = planRoomForCards(readShapes(doc), list, sizeOf);
	const map = shapesMap(doc);
	doc.transact(() => {
		for (const [id, at] of plan.moves) {
			const shape = map.get(id);
			if (!shape) continue;
			shape.set("x", at.x);
			shape.set("y", at.y);
			shape.set("parent", shape.get("parent") ?? null);
		}
		writeBoxes(doc, plan.sections);
	});
	return plan.moves.size;
}
