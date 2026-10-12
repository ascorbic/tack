import type * as Y from "yjs";
import { displaySections } from "./display.ts";
import type { Rect } from "./geometry.ts";
import { PLACE_GAP } from "./placement.ts";
import { SECTION_MIN, type SizeOf, type Structure, boxOf, readStructure } from "./sections.ts";
import { type ShapeProps, readShape, shapesMap } from "./shapes.ts";
import { isStacked } from "./stacks.ts";

// Sections that grow to keep what's in them (free-form ones: a list or grid
// is as big as its contents already, display.ts). When a shape that belongs
// to a section reaches over its edge, as it's dropped, pasted, made, spread
// out of a stack or as it grows, the section grows to hold it with the usual
// margin, and the sections around that one grow to hold it in turn. They
// never shrink by themselves: Fit to contents (`fitSection`) does that, when
// asked. Growing only ever moves edges outwards, from the document and the
// sizes it's given, so it's idempotent and two people growing the same
// section at once can't undo each other: each only ever makes it bigger.

/**
 * The origin of growth that isn't part of a change someone can undo: a
 * client growing a section for its open stack's tray, or for a card that
 * loaded taller once its own undo step has been followed by another.
 */
export const GROW_ORIGIN = "grow";

/** Room kept between a section's edge and what's in it. */
export const SECTION_PAD = PLACE_GAP;

/** The smallest an empty section fits to: room for a sticky, with margins. */
export const FIT_EMPTY = { w: 320, h: 200 } as const;

/** Sections' new boxes, by id. */
export type Growth = Map<string, Rect>;

export interface GrowthOptions {
	/** Containment, if it's already been read. */
	structure?: Structure;
	/** Growth already planned, to grow further: sections' boxes start from it. */
	plan?: Growth;
}

/**
 * The sections to grow so each keeps `boxes` inside it (shapes' boxes, by
 * id, as they are or are about to be), and the sections around those in
 * turn. A section only grows where something reaches over its edge, and
 * then far enough to leave `SECTION_PAD` between them. Shapes that aren't
 * in a section, a stack's stickies (its own box stands for them) and
 * anything in a list or grid are left out. Pure.
 */
export function planGrowth(
	shapes: ReadonlyMap<string, ShapeProps>,
	boxes: Iterable<readonly [string, Rect]>,
	{ structure = readStructure(shapes), plan = new Map() }: GrowthOptions = {},
): Growth {
	const lists = displaySections(shapes, structure);
	// What each section must hold: the union of what reaches into it.
	const needs = new Map<string, Rect>();
	const need = (section: string, box: Rect) => {
		const known = needs.get(section);
		needs.set(section, known ? union(known, box) : box);
	};
	for (const [id, box] of boxes) {
		const shape = shapes.get(id);
		if (!shape || shape.type === "connector" || isStacked(shapes, id)) continue;
		const parent = structure.parentOf.get(id);
		if (parent !== undefined) need(parent, box);
	}
	// Innermost first, so a section has heard from everything inside it
	// (sections it grew included) before it grows itself.
	while (needs.size > 0) {
		let next: string | undefined;
		for (const id of needs.keys()) {
			if (next === undefined || depthOf(structure, id) > depthOf(structure, next)) next = id;
		}
		const id = next as string;
		const box = needs.get(id) as Rect;
		needs.delete(id);
		const shape = shapes.get(id);
		if (!shape || shape.type !== "section" || lists.has(id)) continue;
		const current = plan.get(id) ?? boxOf(id, shape);
		const grown = growAround(current, box);
		if (sameRect(grown, current)) continue;
		plan.set(id, grown);
		const parent = structure.parentOf.get(id);
		if (parent !== undefined) need(parent, grown);
	}
	return plan;
}

/**
 * Grow the sections `ids` are in to keep them inside (see `planGrowth`),
 * and the sections around those. Call in the same transaction as whatever
 * moved, added or resized them, so one undo reverts both. `boxFor` gives a
 * shape's box where it isn't the one `boxOf` would (an open stack's tray).
 * Only edges that move are written, and nothing joins or leaves a section.
 * Returns the sections that grew.
 */
export function growSections(
	doc: Y.Doc,
	ids: Iterable<string>,
	sizeOf?: SizeOf,
	boxFor?: (id: string) => Rect | undefined,
): string[] {
	const map = shapesMap(doc);
	const shapes = new Map<string, ShapeProps>();
	for (const [id, shape] of map) shapes.set(id, readShape(shape));
	const boxes: [string, Rect][] = [];
	for (const id of new Set(ids)) {
		const shape = shapes.get(id);
		if (!shape) continue;
		boxes.push([id, boxFor?.(id) ?? boxOf(id, shape, sizeOf)]);
	}
	const plan = planGrowth(shapes, boxes);
	writeBoxes(doc, plan);
	return [...plan.keys()];
}

/**
 * Write sections' new boxes, only the keys that changed: two people growing
 * one section at once, one to the right and one downwards, both land.
 */
export function writeBoxes(doc: Y.Doc, boxes: ReadonlyMap<string, Rect>): void {
	if (boxes.size === 0) return;
	const map = shapesMap(doc);
	doc.transact(() => {
		for (const [id, box] of boxes) {
			const shape = map.get(id);
			if (!shape || shape.get("type") !== "section") continue;
			for (const key of ["x", "y", "w", "h"] as const) {
				if (shape.get(key) !== box[key]) shape.set(key, box[key]);
			}
		}
	});
}

// --- Fit to contents -------------------------------------------------------------

/** Roughly how wide a section's title pill is, name and count, at 100%. */
export function titleWidth(title: string | undefined): number {
	const name = title?.trim() || "Untitled section";
	// 13px, semibold: about 7.4px a character, the pill's padding and gap,
	// and the count beside it.
	return Math.ceil(name.length * 7.4) + 15 + 7 + 28;
}

/**
 * The box that fits a section to what's in it: its direct contents (a
 * section inside counts as its box, a stack as its card), with `SECTION_PAD`
 * all round, at least wide enough for its title and never smaller than a
 * section can be. An empty section keeps its top left and goes to
 * `FIT_EMPTY`. Null for anything that isn't a free-form section.
 */
export function fitBox(
	shapes: ReadonlyMap<string, ShapeProps>,
	id: string,
	sizeOf?: SizeOf,
	structure: Structure = readStructure(shapes),
): Rect | null {
	const section = shapes.get(id);
	if (!section || section.type !== "section") return null;
	if (displaySections(shapes, structure).has(id)) return null;
	const own = boxOf(id, section);
	const minW = Math.max(SECTION_MIN.w, titleWidth(section.title));
	let contents: Rect | null = null;
	for (const child of structure.children.get(id) ?? []) {
		const shape = shapes.get(child);
		if (!shape || shape.type === "connector" || isStacked(shapes, child)) continue;
		const box = boxOf(child, shape, sizeOf);
		contents = contents ? union(contents, box) : box;
	}
	if (!contents) {
		return { x: own.x, y: own.y, w: Math.max(FIT_EMPTY.w, minW), h: FIT_EMPTY.h };
	}
	const x = Math.round(contents.x - SECTION_PAD);
	const y = Math.round(contents.y - SECTION_PAD);
	return {
		x,
		y,
		w: Math.max(minW, Math.round(contents.x + contents.w + SECTION_PAD) - x),
		h: Math.max(SECTION_MIN.h, Math.round(contents.y + contents.h + SECTION_PAD) - y),
	};
}

// --- Rectangles ------------------------------------------------------------------

function depthOf(structure: Structure, id: string): number {
	return structure.depth.get(id) ?? 0;
}

function union(a: Rect, b: Rect): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y,
	};
}

/** `box` with each edge that `inner` reaches over moved out past it, by the pad. */
function growAround(box: Rect, inner: Rect): Rect {
	let left = box.x;
	let top = box.y;
	let right = box.x + box.w;
	let bottom = box.y + box.h;
	if (inner.x < left) left = Math.floor(inner.x - SECTION_PAD);
	if (inner.y < top) top = Math.floor(inner.y - SECTION_PAD);
	if (inner.x + inner.w > right) right = Math.ceil(inner.x + inner.w + SECTION_PAD);
	if (inner.y + inner.h > bottom) bottom = Math.ceil(inner.y + inner.h + SECTION_PAD);
	return { x: left, y: top, w: right - left, h: bottom - top };
}

function sameRect(a: Rect, b: Rect): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
