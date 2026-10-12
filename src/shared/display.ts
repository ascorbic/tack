import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";
import type { CardKind, CardState } from "./cards.ts";
import { type Point, type Rect, contains } from "./geometry.ts";
import { isStacked, stackName } from "./stacks.ts";
import { PLACE_GAP, spotInSection } from "./placement.ts";
import { SECTION_DEFAULT, type SizeOf, type Structure, boxOf, readStructure } from "./sections.ts";
import { type ShapeProps, readShape, shapesMap } from "./shapes.ts";

// Section display modes (#72): what's inside a section can show as cards
// (free-form, as placed), as a list of compact rows, or as a dense grid of
// mini cards. The mode is the section's `display` key, and a list's sort its
// `sort` key; a shape's place in its section's manual order is its own
// `order` key (a fractional index). Nothing else changes in the document:
// shapes keep their free-form x and y while their section shows them as rows,
// so switching back to cards puts everything back where it was.
//
// The layout is a pure function of the document (row and tile sizes are
// fixed, never measured), so containment, the server and every client agree
// on where a list's rows are and how big the list is.

export type SectionDisplay = "cards" | "list" | "mini";
export const SECTION_DISPLAYS: readonly SectionDisplay[] = ["cards", "list", "mini"];

export type ListSortBy = "state" | "number" | "title";
export const LIST_SORTS: readonly ListSortBy[] = ["state", "number", "title"];

/** How a list or mini grid is sorted; absent means by hand (manual order). */
export interface ListSort {
	by: ListSortBy;
	desc?: boolean;
}

/** A list's geometry, in board units. */
export const LIST = {
	/** Inset from the section's edge to its rows. */
	pad: 8,
	row: 36,
	gap: 2,
	/** A list is never narrower or wider than this, whatever its section's width. */
	minW: 320,
	maxW: 600,
	/** An empty list's well, for dropping into. */
	empty: 64,
} as const;

/** A mini grid's geometry, in board units. */
export const MINI = {
	pad: 10,
	gap: 8,
	/** Tiles are at least this wide; columns fill the section's width. */
	tile: 128,
	tileH: 82,
	minW: 300,
} as const;

/** A section nested in a list or grid: a header row, then its contents. */
export const GROUP = { head: 30, pad: 6 } as const;

/** How a shape shows inside a list or grid. */
export type SlotKind = "row" | "mini" | "group";

export interface Slot {
	id: string;
	/** The section it's directly in. */
	section: string;
	kind: SlotKind;
	rect: Rect;
	/** Its place in its section's displayed order. */
	index: number;
}

export interface SectionLayout {
	id: string;
	/** For a nested section, its outermost list's mode or its own. */
	mode: "list" | "mini";
	box: Rect;
	/** Direct contents, in the order shown. */
	order: string[];
	/** Nested in another list or grid (drawn as a group). */
	nested: boolean;
	/** Where a gap is held open for something being dragged in, if anywhere. */
	gap?: { index: number; count: number };
}

export interface DisplayLayout {
	/** Every section showing a list or grid, nested ones included. */
	sections: Map<string, SectionLayout>;
	/** Every shape drawn as a row, mini card or group. */
	slots: Map<string, Slot>;
}

/** What sorting needs to know about a card: kept small so tests can make them. */
export interface SortableCard {
	state: CardState;
	title: string;
	kind: CardKind;
}

export interface LayoutOptions {
	/** Where a section is drawn, if not where the document says (being dragged). */
	at?: (id: string) => Point | undefined;
	/** Live card data, for sorting by state or title. */
	cardOf?: (ref: string) => SortableCard | undefined;
	/** Shapes left out of every list: being dragged. */
	exclude?: ReadonlySet<string>;
	/** Hold a gap open in a list, for shapes being dragged in. */
	gap?: { section: string; index: number; count: number };
}

type Shapes = ReadonlyMap<string, ShapeProps>;

export function displayOf(shape: Pick<ShapeProps, "type" | "display"> | undefined): SectionDisplay {
	if (shape?.type !== "section") return "cards";
	return shape.display === "list" || shape.display === "mini" ? shape.display : "cards";
}

export function sortOf(shape: Pick<ShapeProps, "sort"> | undefined): ListSort | null {
	const sort = shape?.sort as unknown;
	if (!sort || typeof sort !== "object") return null;
	const by = (sort as { by?: unknown }).by;
	if (!LIST_SORTS.includes(by as ListSortBy)) return null;
	return {
		by: by as ListSortBy,
		...((sort as { desc?: unknown }).desc === true && { desc: true }),
	};
}

/** How far apart two tops can be and still read as one row of a free-form layout. */
const ROW_TOLERANCE = 48;

/**
 * Shapes in reading order: top to bottom in rows (tops within a tolerance of
 * the row's first), each row left to right. This is a section's order until
 * someone reorders it by hand, so a list reads the way the cards were laid out.
 */
export function readingOrder(items: readonly { id: string; x: number; y: number }[]): string[] {
	const byTop = [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
	const rows: (typeof byTop)[] = [];
	for (const item of byTop) {
		const row = rows.at(-1);
		if (row && item.y - (row[0]?.y ?? 0) <= ROW_TOLERANCE) row.push(item);
		else rows.push([item]);
	}
	return rows.flatMap((row) =>
		row.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1)).map((item) => item.id),
	);
}

/** Whether `key` is an order key fractional-indexing can build on. */
function validKey(key: unknown): key is string {
	if (typeof key !== "string" || key === "") return false;
	try {
		generateNKeysBetween(key, null, 1);
		return true;
	} catch {
		return false;
	}
}

/**
 * A section's manual order: shapes someone has put in order (an `order` key)
 * first, by key, then the rest in reading order (new arrivals go last).
 */
export function manualOrder(shapes: Shapes, ids: readonly string[]): string[] {
	const keyed: { id: string; key: string }[] = [];
	const loose: { id: string; x: number; y: number }[] = [];
	for (const id of ids) {
		const shape = shapes.get(id);
		if (!shape) continue;
		if (validKey(shape.order)) keyed.push({ id, key: shape.order });
		else loose.push({ id, x: shape.x, y: shape.y });
	}
	keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
	return [...keyed.map((item) => item.id), ...readingOrder(loose)];
}

/** An item's number, from its card key (`…#123`), for sorting by number. */
export function itemNumber(ref: string | undefined): number | null {
	const match = ref ? /[#!](\d+)$/.exec(ref) : null;
	return match ? Number(match[1]) : null;
}

/** Open first, then drafts, then merged, then closed. */
const STATE_RANK: Record<CardState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

/** What a shape is called, for sorting by title. */
export function titleOf(shape: ShapeProps, card?: SortableCard): string {
	if (shape.type === "card") return card?.title ?? "";
	if (shape.type === "sticky" || shape.type === "text" || shape.type === "action") {
		return shape.text ?? "";
	}
	if (shape.type === "stack") return stackName(shape) ?? "";
	if (shape.type === "image") return shape.alt ?? "";
	return shape.title ?? "";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Sort a section's contents. Ties, and anything that can't say (a sticky has
 * no state or number), keep their manual order; things without a value go
 * last, whichever way the sort runs.
 */
export function sortItems(
	shapes: Shapes,
	manual: readonly string[],
	sort: ListSort | null,
	cardOf?: LayoutOptions["cardOf"],
): string[] {
	if (!sort) return [...manual];
	const rank = new Map(manual.map((id, i) => [id, i]));
	const value = (id: string): number | string | null => {
		const shape = shapes.get(id);
		if (!shape) return null;
		const card = shape.type === "card" && shape.ref ? cardOf?.(shape.ref) : undefined;
		if (sort.by === "state") return card ? STATE_RANK[card.state] : null;
		if (sort.by === "number") return shape.type === "card" ? itemNumber(shape.ref) : null;
		const title = titleOf(shape, card).trim();
		return title === "" ? null : title;
	};
	const values = new Map(manual.map((id) => [id, value(id)]));
	const direction = sort.desc ? -1 : 1;
	return [...manual].sort((a, b) => {
		const va = values.get(a) ?? null;
		const vb = values.get(b) ?? null;
		if (va === null || vb === null) {
			if (va !== vb) return va === null ? 1 : -1;
		} else {
			const compared =
				typeof va === "number" && typeof vb === "number"
					? va - vb
					: collator.compare(String(va), String(vb));
			if (compared !== 0) return compared * direction;
		}
		return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
	});
}

/** Whether a shape is drawn inside a list or grid (rather than free-form). */
export function isInDisplay(shapes: Shapes, structure: Structure, id: string): boolean {
	const seen = new Set<string>();
	let current = structure.parentOf.get(id);
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		if (displayOf(shapes.get(current)) !== "cards") return true;
		current = structure.parentOf.get(current);
	}
	return false;
}

/**
 * Lay out every list and grid on the board: each list or grid that isn't in
 * another one sits where its section is, as wide as its section (within
 * limits) and as tall as its contents; sections inside are groups, a header
 * and then their own contents, in their own mode or their list's.
 */
export function layoutDisplays(
	shapes: Shapes,
	structure: Structure,
	options: LayoutOptions = {},
): DisplayLayout {
	const out: DisplayLayout = { sections: new Map(), slots: new Map() };
	for (const [id, shape] of shapes) {
		if (shape.type !== "section" || displayOf(shape) === "cards") continue;
		if (isInDisplay(shapes, structure, id)) continue;
		const at = options.at?.(id) ?? { x: shape.x, y: shape.y };
		const mode = displayOf(shape) as "list" | "mini";
		const stored = shape.w ?? SECTION_DEFAULT.w;
		const w =
			mode === "list"
				? Math.min(Math.max(stored, LIST.minW), LIST.maxW)
				: Math.max(stored, MINI.minW);
		layoutSection(shapes, structure, options, out, id, mode, { x: at.x, y: at.y, w }, false);
	}
	return out;
}

/**
 * Lay out one section's contents from the top-left of `frame` (its x, y and
 * width), recursing into nested sections, and return how tall it came out.
 */
function layoutSection(
	shapes: Shapes,
	structure: Structure,
	options: LayoutOptions,
	out: DisplayLayout,
	id: string,
	mode: "list" | "mini",
	frame: { x: number; y: number; w: number },
	nested: boolean,
): number {
	const children = (structure.children.get(id) ?? []).filter(
		(child) =>
			!options.exclude?.has(child) &&
			shapes.get(child)?.type !== "connector" &&
			// A stacked sticky shows as part of its stack's row (stacks.ts).
			!isStacked(shapes, child),
	);
	const order = sortItems(
		shapes,
		manualOrder(shapes, children),
		sortOf(shapes.get(id)),
		options.cardOf,
	);
	const gap = options.gap?.section === id ? options.gap : undefined;
	const pad = nested ? GROUP.pad : mode === "list" ? LIST.pad : MINI.pad;
	const top = frame.y + (nested ? GROUP.head : 0) + pad;
	const inner = { x: frame.x + pad, w: frame.w - pad * 2 };
	let y = top;

	// Rows (and groups, which always take a whole line) in a list.
	const columns =
		mode === "mini" ? Math.max(1, Math.floor((inner.w + MINI.gap) / (MINI.tile + MINI.gap))) : 1;
	const tileW = mode === "mini" ? (inner.w - MINI.gap * (columns - 1)) / columns : inner.w;
	let column = 0;
	const newLine = () => {
		if (column > 0) {
			y += MINI.tileH + MINI.gap;
			column = 0;
		}
	};
	const placeTile = (): Rect => {
		const rect = { x: inner.x + column * (tileW + MINI.gap), y, w: tileW, h: MINI.tileH };
		column += 1;
		if (column === columns) newLine();
		return rect;
	};
	const placeRow = (): Rect => {
		const rect = { x: inner.x, y, w: inner.w, h: LIST.row };
		y += LIST.row + LIST.gap;
		return rect;
	};
	const placeGap = (count: number) => {
		for (let i = 0; i < count; i++) {
			if (mode === "mini") placeTile();
			else placeRow();
		}
	};

	order.forEach((child, index) => {
		if (gap && gap.index === index) placeGap(gap.count);
		const shape = shapes.get(child);
		if (shape?.type === "section") {
			newLine();
			const own = displayOf(shape);
			const childMode = own === "cards" ? mode : own;
			const height = layoutSection(
				shapes,
				structure,
				options,
				out,
				child,
				childMode,
				{ x: inner.x, y, w: inner.w },
				true,
			);
			out.slots.set(child, {
				id: child,
				section: id,
				kind: "group",
				rect: { x: inner.x, y, w: inner.w, h: height },
				index,
			});
			y += height + (mode === "mini" ? MINI.gap : LIST.gap);
			return;
		}
		const rect = mode === "mini" ? placeTile() : placeRow();
		out.slots.set(child, {
			id: child,
			section: id,
			kind: mode === "mini" ? "mini" : "row",
			rect,
			index,
		});
	});
	if (gap && gap.index >= order.length) placeGap(gap.count);
	newLine();

	let bottom: number;
	if (y === top) {
		// Nothing in it: a well to drop into (a nested one stays slim).
		bottom = top + (nested ? LIST.row : LIST.empty) + pad;
	} else {
		// The last row's or grid line's trailing gap gives way to the padding.
		bottom = y - (mode === "mini" ? MINI.gap : LIST.gap) + pad;
	}
	const height = bottom - frame.y;
	out.sections.set(id, {
		id,
		mode,
		box: { x: frame.x, y: frame.y, w: frame.w, h: height },
		order,
		nested,
		...(gap && { gap: { index: Math.min(gap.index, order.length), count: gap.count } }),
	});
	return height;
}

/**
 * Where something dropped at `point` would go in a section's list or grid:
 * its index in the order shown, leaving out whatever is being dragged.
 */
export function insertionIndex(
	layout: DisplayLayout,
	section: string,
	point: Point,
	exclude: ReadonlySet<string> = new Set(),
): number {
	const list = layout.sections.get(section);
	if (!list) return 0;
	const order = list.order.filter((id) => !exclude.has(id));
	for (let i = 0; i < order.length; i++) {
		const slot = layout.slots.get(order[i] as string);
		if (!slot) continue;
		const { rect } = slot;
		if (slot.kind === "mini") {
			// Above this tile's line, or on it and left of its middle.
			if (point.y < rect.y) return i;
			if (point.y <= rect.y + rect.h + MINI.gap && point.x < rect.x + rect.w / 2) return i;
		} else if (point.y < rect.y + rect.h / 2) {
			return i;
		}
	}
	return order.length;
}

/** The sections showing a list or grid, nested ones included. */
export function displaySections(shapes: Shapes, structure: Structure): Set<string> {
	const out = new Set<string>();
	for (const [id, shape] of shapes) {
		if (shape.type !== "section") continue;
		if (displayOf(shape) !== "cards" || isInDisplay(shapes, structure, id)) out.add(id);
	}
	return out;
}

// Writes ---------------------------------------------------------------

/** Show sections as cards, a list or mini cards. Call inside a local transaction. */
export function setDisplay(doc: Y.Doc, ids: Iterable<string>, mode: SectionDisplay): void {
	const shapes = shapesMap(doc);
	doc.transact(() => {
		for (const id of ids) {
			const shape = shapes.get(id);
			if (!shape || shape.get("type") !== "section") continue;
			if (mode === "cards") {
				if (shape.has("display")) shape.delete("display");
			} else if (shape.get("display") !== mode) {
				shape.set("display", mode);
			}
		}
	});
}

/** Sort a section's list, or (with null) go back to its manual order. */
export function setSort(doc: Y.Doc, id: string, sort: ListSort | null): void {
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("type") !== "section") return;
	doc.transact(() => {
		if (!sort) {
			if (shape.has("sort")) shape.delete("sort");
			return;
		}
		const current = sortOf({ sort: shape.get("sort") as ListSort });
		if (current?.by === sort.by && !!current.desc === !!sort.desc) return;
		shape.set("sort", sort.desc ? { by: sort.by, desc: true } : { by: sort.by });
	});
}

function readShapes(doc: Y.Doc): Map<string, ShapeProps> {
	const out = new Map<string, ShapeProps>();
	for (const [id, shape] of shapesMap(doc)) out.set(id, readShape(shape));
	return out;
}

/** Write order keys so `sequence` is the section's manual order, touching as few keys as it can. */
function writeOrder(
	doc: Y.Doc,
	shapes: Shapes,
	sequence: readonly string[],
	moving: ReadonlySet<string>,
) {
	const map = shapesMap(doc);
	const keyOf = (id: string) => shapes.get(id)?.order;
	const steady = sequence.filter((id) => !moving.has(id));
	const steadyKeys = steady.map(keyOf);
	const canSplice =
		steadyKeys.every(validKey) &&
		steadyKeys.every((key, i) => i === 0 || (key as string) > (steadyKeys[i - 1] as string));
	const keys = new Map<string, string>();
	if (canSplice) {
		// Only what moved gets new keys, between its new neighbours.
		let i = 0;
		while (i < sequence.length) {
			if (!moving.has(sequence[i] as string)) {
				i++;
				continue;
			}
			const start = i;
			while (i < sequence.length && moving.has(sequence[i] as string)) i++;
			const before = start > 0 ? (keyOf(sequence[start - 1] as string) ?? null) : null;
			const after = i < sequence.length ? (keyOf(sequence[i] as string) ?? null) : null;
			const run = generateNKeysBetween(before, after, i - start);
			run.forEach((key, j) => keys.set(sequence[start + j] as string, key));
		}
	} else {
		const fresh = generateNKeysBetween(null, null, sequence.length);
		sequence.forEach((id, i) => keys.set(id, fresh[i] as string));
	}
	for (const [id, key] of keys) {
		const shape = map.get(id);
		if (shape && shape.get("order") !== key) shape.set("order", key);
	}
}

/**
 * Move `ids` (already in `section`) to `index` in what the section shows,
 * counted without them. A sorted list goes back to being sorted by hand,
 * starting from the order it showed. Returns true if it was sorted.
 */
export function moveInList(
	doc: Y.Doc,
	section: string,
	ids: readonly string[],
	index: number,
	cardOf?: LayoutOptions["cardOf"],
): boolean {
	const shapes = readShapes(doc);
	const structure = readStructure(shapes);
	const children = structure.children.get(section) ?? [];
	const sort = sortOf(shapes.get(section));
	const shown = sortItems(shapes, manualOrder(shapes, children), sort, cardOf);
	const moving = ids.filter((id) => structure.parentOf.get(id) === section);
	if (moving.length === 0) return false;
	const movingSet = new Set(moving);
	// Keep the moving shapes in the order they were shown in.
	const ordered = shown.filter((id) => movingSet.has(id));
	const rest = shown.filter((id) => !movingSet.has(id));
	const at = Math.max(0, Math.min(index, rest.length));
	const sequence = [...rest.slice(0, at), ...ordered, ...rest.slice(at)];
	doc.transact(() => {
		if (sort) {
			// Every key, so the manual order is what the sort showed.
			const map = shapesMap(doc);
			const fresh = generateNKeysBetween(null, null, sequence.length);
			sequence.forEach((id, i) => {
				const shape = map.get(id);
				if (shape && shape.get("order") !== fresh[i]) shape.set("order", fresh[i] as string);
			});
			map.get(section)?.delete("sort");
		} else {
			writeOrder(doc, shapes, sequence, movingSet);
		}
	});
	return sort !== null;
}

/**
 * A shape has just joined a list or grid: give it somewhere free inside the
 * section for when it shows as cards again, and put it last in the manual
 * order. Call in the same transaction as setting its parent.
 */
export function joinDisplay(doc: Y.Doc, id: string, section: string, sizeOf?: SizeOf): void {
	doc.transact(() => {
		const map = shapesMap(doc);
		const shape = map.get(id);
		if (!shape) return;
		const shapes = readShapes(doc);
		const self = shapes.get(id);
		if (!self) return;
		const structure = readStructure(shapes);
		const siblings = (structure.children.get(section) ?? []).filter((other) => other !== id);

		// Free-form: somewhere free in the section, or else stacked in its corner.
		const size = boxOf(id, self, sizeOf);
		const others = new Map(shapes);
		others.delete(id);
		const box = boxOf(section, shapes.get(section) as ShapeProps);
		const spot = spotInSection(others, section, { w: size.w, h: size.h }, sizeOf) ?? {
			x: Math.round(box.x + PLACE_GAP + ((siblings.length * 16) % 160)),
			y: Math.round(box.y + PLACE_GAP + ((siblings.length * 16) % 160)),
		};
		if (self.type !== "section") {
			shape.set("x", spot.x);
			shape.set("y", spot.y);
		}

		// Last in the manual order: everything before it needs a key first.
		const manual = manualOrder(shapes, siblings);
		const lastKey = manual.length > 0 ? shapes.get(manual.at(-1) as string)?.order : null;
		const allKeyed = manual.every((other) => validKey(shapes.get(other)?.order));
		if (!allKeyed) writeOrder(doc, shapes, manual, new Set(manual));
		const last = manual.at(-1);
		const written = last === undefined ? null : map.get(last)?.get("order");
		const after = allKeyed ? (lastKey ?? null) : typeof written === "string" ? written : null;
		const [key] = generateNKeysBetween(after, null, 1);
		shape.set("order", key as string);
	});
}

/**
 * Put `ids` in a list or grid at `index` (in what it shows), whether or not
 * they're in it yet: what's joining gets a free-form spot. One transaction.
 */
export function placeInDisplay(
	doc: Y.Doc,
	ids: readonly string[],
	section: string,
	index: number,
	options: { sizeOf?: SizeOf; cardOf?: LayoutOptions["cardOf"] } = {},
): boolean {
	let unsorted = false;
	doc.transact(() => {
		const map = shapesMap(doc);
		const sorted = sortOf({ sort: map.get(section)?.get("sort") as ListSort }) !== null;
		let reordering = false;
		for (const id of ids) {
			const shape = map.get(id);
			if (!shape || id === section) continue;
			if (shape.get("parent") !== section) {
				shape.set("parent", section);
				if (shape.has("order")) shape.delete("order");
				joinDisplay(doc, id, section, options.sizeOf);
			} else {
				reordering = true;
			}
		}
		// Joining a sorted list takes the place the sort gives it; only moving
		// rows within it puts it back in order by hand.
		if (sorted && !reordering) return;
		unsorted = moveInList(doc, section, ids, index, options.cardOf);
	});
	return unsorted;
}

/** The box a section's list or grid takes, if it shows one, from the document alone. */
export function displayBox(shapes: Shapes, structure: Structure, id: string): Rect | null {
	return layoutDisplays(shapes, structure).sections.get(id)?.box ?? null;
}

/** A shape's box as drawn: its slot in a list or grid, or its own. */
export function drawnBox(
	layout: DisplayLayout,
	id: string,
	shape: ShapeProps,
	sizeOf?: SizeOf,
): Rect {
	return layout.slots.get(id)?.rect ?? layout.sections.get(id)?.box ?? boxOf(id, shape, sizeOf);
}

/**
 * Make sure a shape put into a section by name (a rule's, or an inbox's tray
 * clicked) is in it, even if it's a list whose rows don't reach the spot its
 * free-form box had room at. Sections showing cards decide by geometry, as
 * ever. Call in the same transaction as placing it.
 */
export function keepInSection(doc: Y.Doc, id: string, section: string, sizeOf?: SizeOf): void {
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("parent") === section) return;
	const shapes = readShapes(doc);
	if (!displaySections(shapes, readStructure(shapes)).has(section)) return;
	doc.transact(() => {
		shape.set("parent", section);
		if (shape.has("order")) shape.delete("order");
		joinDisplay(doc, id, section, sizeOf);
	});
}

/** Whether a point is over a list or grid's box. */
export function overDisplay(layout: DisplayLayout, section: string, point: Point): boolean {
	const box = layout.sections.get(section)?.box;
	return !!box && contains(box, point);
}
