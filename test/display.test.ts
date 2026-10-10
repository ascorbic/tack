import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	GROUP,
	LIST,
	MINI,
	type SortableCard,
	displayOf,
	insertionIndex,
	keepInSection,
	layoutDisplays,
	manualOrder,
	moveInList,
	placeInDisplay,
	readingOrder,
	setDisplay,
	setSort,
	sortItems,
	sortOf,
} from "../src/shared/display.ts";
import { readStructure } from "../src/shared/sections.ts";
import { type ShapeProps, addShape, nextZ, readShape, shapesMap } from "../src/shared/shapes.ts";
import {
	addSection,
	commitMoves,
	readShapes,
	resizeSection,
	sectionGeometries,
} from "../src/shared/structure.ts";
import { containerFor } from "../src/shared/sections.ts";

function board() {
	const doc = new Y.Doc();
	const add = (id: string, props: Partial<ShapeProps> & Pick<ShapeProps, "type" | "x" | "y">) =>
		addShape(doc, id, { z: nextZ(doc), parent: null, ...props });
	const sticky = (id: string, x: number, y: number, parent: string | null = null, text = id) =>
		add(id, { type: "sticky", text, x, y, parent });
	const card = (id: string, ref: string, x: number, y: number, parent: string | null = null) =>
		add(id, { type: "card", ref, x, y, parent });
	const section = (
		id: string,
		x: number,
		y: number,
		w = 640,
		h = 440,
		parent: string | null = null,
	) => add(id, { type: "section", x, y, w, h, title: id, parent });
	const get = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? readShape(shape) : undefined;
	};
	const layout = (options?: Parameters<typeof layoutDisplays>[2]) => {
		const shapes = readShapes(doc);
		return layoutDisplays(shapes, readStructure(shapes), options);
	};
	return { doc, add, sticky, card, section, get, layout };
}

const CARDS: Record<string, SortableCard> = {
	"github.com/a/b#3": { state: "closed", title: "Charlie", kind: "issue" },
	"github.com/a/b#12": { state: "open", title: "alpha", kind: "issue" },
	"github.com/a/b#7": { state: "merged", title: "Bravo", kind: "pull" },
	"github.com/a/b#20": { state: "draft", title: "delta 10", kind: "pull" },
	"github.com/a/b#21": { state: "open", title: "delta 9", kind: "issue" },
};
const cardOf = (ref: string) => CARDS[ref];

describe("reading order", () => {
	it("reads rows top to bottom, each left to right, forgiving a ragged layout", () => {
		expect(
			readingOrder([
				{ id: "c", x: 600, y: 10 },
				{ id: "a", x: 0, y: 30 },
				{ id: "b", x: 300, y: 0 },
				{ id: "e", x: 300, y: 260 },
				{ id: "d", x: 0, y: 250 },
			]),
		).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("puts shapes someone ordered first, by key, and the rest after in reading order", () => {
		const { doc, sticky } = board();
		sticky("late", 0, 0);
		sticky("first", 300, 300);
		sticky("second", 0, 300);
		shapesMap(doc).get("first")?.set("order", "a1");
		shapesMap(doc).get("second")?.set("order", "a2");
		// A key fractional-indexing can't read is no key at all.
		shapesMap(doc).get("late")?.set("order", "");
		expect(manualOrder(readShapes(doc), ["late", "first", "second"])).toEqual([
			"first",
			"second",
			"late",
		]);
	});
});

describe("sorting", () => {
	const { doc, card, sticky } = board();
	card("c3", "github.com/a/b#3", 0, 0);
	card("c12", "github.com/a/b#12", 0, 100);
	card("c7", "github.com/a/b#7", 0, 200);
	card("c20", "github.com/a/b#20", 0, 300);
	card("c21", "github.com/a/b#21", 0, 400);
	sticky("note", 0, 500, null, "Bananas");
	sticky("blank", 0, 600, null, "");
	const shapes = readShapes(doc);
	const manual = ["c3", "c12", "note", "c7", "c20", "blank", "c21"];

	it("by state: open, draft, merged, closed, then what has no state, in manual order", () => {
		expect(sortItems(shapes, manual, { by: "state" }, cardOf)).toEqual([
			"c12",
			"c21",
			"c20",
			"c7",
			"c3",
			"note",
			"blank",
		]);
	});

	it("by number, either way, with stickies last both ways", () => {
		expect(sortItems(shapes, manual, { by: "number" }, cardOf)).toEqual([
			"c3",
			"c7",
			"c12",
			"c20",
			"c21",
			"note",
			"blank",
		]);
		expect(sortItems(shapes, manual, { by: "number", desc: true }, cardOf)).toEqual([
			"c21",
			"c20",
			"c12",
			"c7",
			"c3",
			"note",
			"blank",
		]);
	});

	it("by title, case-insensitively and numbers as numbers, empty last", () => {
		expect(sortItems(shapes, manual, { by: "title" }, cardOf)).toEqual([
			"c12",
			"note",
			"c7",
			"c3",
			"c21",
			"c20",
			"blank",
		]);
	});

	it("leaves manual order alone without a sort", () => {
		expect(sortItems(shapes, manual, null, cardOf)).toEqual(manual);
	});

	it("reads only sorts it knows", () => {
		expect(sortOf({ sort: { by: "state", desc: true } })).toEqual({ by: "state", desc: true });
		expect(sortOf({ sort: { by: "colour" } as never })).toBeNull();
		expect(sortOf({})).toBeNull();
		expect(displayOf({ type: "section", display: "list" })).toBe("list");
		expect(displayOf({ type: "section", display: "table" as never })).toBe("cards");
		expect(displayOf({ type: "card", display: "list" })).toBe("cards");
	});
});

describe("list layout", () => {
	it("draws rows from the section's corner, as tall as its contents, within width limits", () => {
		const { doc, section, sticky, layout } = board();
		section("s", 100, 200, 900);
		sticky("a", 120, 220, "s");
		sticky("b", 400, 220, "s");
		sticky("c", 120, 500, "s");
		setDisplay(doc, ["s"], "list");
		const { sections, slots } = layout();
		const list = sections.get("s");
		expect(list?.order).toEqual(["a", "b", "c"]);
		expect(list?.box).toEqual({
			x: 100,
			y: 200,
			w: LIST.maxW,
			h: LIST.pad * 2 + LIST.row * 3 + LIST.gap * 2,
		});
		expect(slots.get("a")?.rect).toEqual({
			x: 100 + LIST.pad,
			y: 200 + LIST.pad,
			w: LIST.maxW - LIST.pad * 2,
			h: LIST.row,
		});
		expect(slots.get("c")).toMatchObject({ kind: "row", index: 2, section: "s" });
		expect(slots.get("c")?.rect.y).toBe(200 + LIST.pad + (LIST.row + LIST.gap) * 2);
	});

	it("keeps a well to drop into when it's empty, and sits where a drag puts it", () => {
		const { doc, section, layout } = board();
		section("s", 0, 0, 200);
		setDisplay(doc, ["s"], "list");
		const box = layout({ at: (id) => (id === "s" ? { x: 50, y: 60 } : undefined) }).sections.get(
			"s",
		)?.box;
		expect(box).toEqual({ x: 50, y: 60, w: LIST.minW, h: LIST.pad * 2 + LIST.empty });
	});

	it("holds a gap open for what's being dragged in, and leaves out what's being dragged", () => {
		const { doc, section, sticky, layout } = board();
		section("s", 0, 0);
		sticky("a", 20, 20, "s");
		sticky("b", 220, 20, "s");
		sticky("c", 420, 20, "s");
		setDisplay(doc, ["s"], "list");
		const { slots, sections } = layout({
			exclude: new Set(["a"]),
			gap: { section: "s", index: 1, count: 2 },
		});
		expect(slots.has("a")).toBe(false);
		expect(sections.get("s")?.order).toEqual(["b", "c"]);
		const step = LIST.row + LIST.gap;
		expect(slots.get("b")?.rect.y).toBe(LIST.pad);
		expect(slots.get("c")?.rect.y).toBe(LIST.pad + step * 3);
	});

	it("lays mini cards out in as many columns as fit", () => {
		const { doc, section, sticky, layout } = board();
		section("s", 0, 0, 600);
		for (let i = 0; i < 6; i++) sticky(`n${i}`, i * 100, 20, "s");
		setDisplay(doc, ["s"], "mini");
		const { sections, slots } = layout();
		const columns = Math.floor((600 - MINI.pad * 2 + MINI.gap) / (MINI.tile + MINI.gap));
		expect(columns).toBe(4);
		const tile = (600 - MINI.pad * 2 - MINI.gap * (columns - 1)) / columns;
		expect(slots.get("n0")?.rect).toEqual({ x: MINI.pad, y: MINI.pad, w: tile, h: MINI.tileH });
		expect(slots.get("n3")?.rect.x).toBeCloseTo(MINI.pad + (tile + MINI.gap) * 3);
		expect(slots.get("n4")?.rect).toMatchObject({
			x: MINI.pad,
			y: MINI.pad + MINI.tileH + MINI.gap,
		});
		expect(slots.get("n4")?.kind).toBe("mini");
		expect(sections.get("s")?.box.h).toBe(MINI.pad * 2 + MINI.tileH * 2 + MINI.gap);
	});

	it("draws sections inside as groups with their own contents, in their own mode or the list's", () => {
		const { doc, section, sticky, layout } = board();
		section("outer", 0, 0, 640, 800);
		sticky("top", 20, 20, "outer");
		section("inner", 20, 300, 400, 300, "outer");
		sticky("deep", 40, 340, "inner");
		sticky("deeper", 240, 340, "inner");
		setDisplay(doc, ["outer"], "list");
		const { sections, slots } = layout();
		const inner = slots.get("inner");
		expect(inner?.kind).toBe("group");
		expect(sections.get("inner")).toMatchObject({ mode: "list", nested: true });
		const groupTop = LIST.pad + LIST.row + LIST.gap;
		expect(inner?.rect.y).toBe(groupTop);
		expect(slots.get("deep")?.rect).toMatchObject({
			x: LIST.pad + GROUP.pad,
			y: groupTop + GROUP.head + GROUP.pad,
			h: LIST.row,
		});
		expect(inner?.rect.h).toBe(GROUP.head + GROUP.pad * 2 + LIST.row * 2 + LIST.gap);

		// A grid inside a list is a grid.
		setDisplay(doc, ["inner"], "mini");
		expect(layout().slots.get("deep")?.kind).toBe("mini");
		expect(layout().sections.get("inner")?.mode).toBe("mini");
	});

	it("sorts by what cards say, and follows the sort", () => {
		const { doc, section, card, layout } = board();
		section("s", 0, 0);
		card("closed", "github.com/a/b#3", 20, 20, "s");
		card("open", "github.com/a/b#12", 300, 20, "s");
		setDisplay(doc, ["s"], "list");
		setSort(doc, "s", { by: "state" });
		expect(layout({ cardOf }).sections.get("s")?.order).toEqual(["open", "closed"]);
		setSort(doc, "s", null);
		expect(layout({ cardOf }).sections.get("s")?.order).toEqual(["closed", "open"]);
	});
});

describe("insertion", () => {
	it("finds where a drop lands among rows and tiles", () => {
		const { doc, section, sticky, layout } = board();
		section("s", 0, 0, 600);
		for (let i = 0; i < 5; i++) sticky(`n${i}`, i * 110, 20, "s");
		setDisplay(doc, ["s"], "list");
		const rows = layout();
		const step = LIST.row + LIST.gap;
		expect(insertionIndex(rows, "s", { x: 50, y: 0 })).toBe(0);
		expect(insertionIndex(rows, "s", { x: 50, y: LIST.pad + step + LIST.row * 0.75 })).toBe(2);
		expect(insertionIndex(rows, "s", { x: 50, y: 900 })).toBe(5);
		// Leaving out what's dragged counts positions without it.
		expect(insertionIndex(rows, "s", { x: 50, y: 900 }, new Set(["n0"]))).toBe(4);

		setDisplay(doc, ["s"], "mini");
		const grid = layout();
		const second = grid.slots.get("n1")?.rect;
		if (!second) throw new Error("no tile");
		expect(insertionIndex(grid, "s", { x: second.x + 4, y: second.y + 10 })).toBe(1);
		expect(insertionIndex(grid, "s", { x: second.x + second.w - 4, y: second.y + 10 })).toBe(2);
		const fifth = grid.slots.get("n4")?.rect;
		if (!fifth) throw new Error("no tile");
		expect(insertionIndex(grid, "s", { x: fifth.x + 4, y: fifth.y + 4 })).toBe(4);
	});
});

describe("reordering", () => {
	it("moves rows by hand, giving only what moved new keys once everything has one", () => {
		const { doc, section, sticky, get, layout } = board();
		section("s", 0, 0);
		sticky("a", 20, 20, "s");
		sticky("b", 220, 20, "s");
		sticky("c", 420, 20, "s");
		setDisplay(doc, ["s"], "list");
		moveInList(doc, "s", ["c"], 0);
		expect(layout().sections.get("s")?.order).toEqual(["c", "a", "b"]);
		// The first move gave everything a key.
		const keys = ["a", "b"].map((id) => get(id)?.order);
		moveInList(doc, "s", ["a"], 2);
		expect(layout().sections.get("s")?.order).toEqual(["c", "b", "a"]);
		expect(get("b")?.order).toBe(keys[1]);
		expect(get("a")?.order).not.toBe(keys[0]);
		// Free-form positions are left as they were.
		expect([get("a")?.x, get("b")?.x, get("c")?.x]).toEqual([20, 220, 420]);
	});

	it("keeps several moved rows in the order they showed", () => {
		const { doc, section, sticky, layout } = board();
		section("s", 0, 0);
		for (const [i, id] of ["a", "b", "c", "d"].entries()) sticky(id, 20 + i * 150, 20, "s");
		setDisplay(doc, ["s"], "list");
		moveInList(doc, "s", ["d", "b"], 0);
		expect(layout().sections.get("s")?.order).toEqual(["b", "d", "a", "c"]);
	});

	it("goes back to manual order, starting from what the sort showed", () => {
		const { doc, section, card, get, layout } = board();
		section("s", 0, 0);
		card("closed", "github.com/a/b#3", 20, 20, "s");
		card("merged", "github.com/a/b#7", 300, 20, "s");
		card("open", "github.com/a/b#12", 20, 200, "s");
		setDisplay(doc, ["s"], "list");
		setSort(doc, "s", { by: "state" });
		expect(layout({ cardOf }).sections.get("s")?.order).toEqual(["open", "merged", "closed"]);
		expect(moveInList(doc, "s", ["closed"], 1, cardOf)).toBe(true);
		expect(get("s")?.sort).toBeUndefined();
		expect(layout({ cardOf }).sections.get("s")?.order).toEqual(["open", "closed", "merged"]);
	});
});

describe("containment with lists", () => {
	function listBoard() {
		const b = board();
		b.section("s", 0, 0, 640, 600);
		b.sticky("a", 20, 20, "s");
		b.sticky("b", 220, 20, "s");
		b.sticky("far", 400, 400, "s");
		setDisplay(b.doc, ["s"], "list");
		return b;
	}

	it("takes what's dropped on the list it draws, giving it a free-form spot and the last place", () => {
		const { doc, sticky, get, layout } = listBoard();
		sticky("new", 2000, 2000);
		// Dropped over the rows, right of where the section's box would be.
		commitMoves(doc, new Map([["new", { x: 40, y: 30 }]]));
		expect(get("new")?.parent).toBe("s");
		expect(layout().sections.get("s")?.order.at(-1)).toBe("new");
		// Somewhere free in the section's own box, clear of the others.
		const spot = get("new");
		expect(spot && spot.x >= 0 && spot.x + 176 <= 640 && spot.y + 176 <= 600).toBe(true);
		expect(spot?.x === 40 && spot?.y === 30).toBe(false);
	});

	it("leaves rows in their list when the section moves, or things around it change", () => {
		const { doc, get } = listBoard();
		commitMoves(doc, new Map([["s", { x: 1000, y: 1000 }]]));
		expect(["a", "b", "far"].map((id) => get(id)?.parent)).toEqual(["s", "s", "s"]);
		expect(get("far")).toMatchObject({ x: 1400, y: 1400 });
		// A new section drawn over a row's hidden free-form spot doesn't take it.
		addSection(doc, { x: 1350, y: 1350, w: 400, h: 400 });
		expect(get("far")?.parent).toBe("s");
	});

	it("keeps what's in a list when its section is resized", () => {
		const { doc, get } = listBoard();
		resizeSection(doc, "s", { x: 0, y: 0, w: 200, h: 200 });
		expect(get("far")?.parent).toBe("s");
	});

	it("counts a list as big as its section, so cards fit in a short one", () => {
		const { doc } = listBoard();
		const shapes = readShapes(doc);
		const geometry = sectionGeometries(shapes, readStructure(shapes));
		const list = geometry.find((section) => section.id === "s");
		expect(list?.box.h).toBe(LIST.pad * 2 + LIST.row * 3 + LIST.gap * 2);
		expect(list?.area).toBe(640 * 600);
		// A card's centre on the rows: in.
		expect(containerFor({ x: 20, y: 0, w: 252, h: 124 }, geometry)).toBe("s");
		// Below the rows, though inside the section's free-form box: out.
		expect(containerFor({ x: 20, y: 300, w: 252, h: 124 }, geometry)).toBeNull();
	});

	it("puts what's placed into a list by name in it, whatever its box covers", () => {
		const { doc, card, get } = listBoard();
		card("ruled", "github.com/a/b#3", 300, 300);
		keepInSection(doc, "ruled", "s");
		expect(get("ruled")?.parent).toBe("s");
		expect(typeof get("ruled")?.order).toBe("string");
	});

	it("places shapes at a position in a list, joining it or moving within it", () => {
		const { doc, sticky, get, layout } = listBoard();
		sticky("new", 2000, 2000);
		placeInDisplay(doc, ["new"], "s", 1);
		expect(layout().sections.get("s")?.order).toEqual(["a", "new", "b", "far"]);
		expect(get("new")?.x).toBeLessThan(640);
		placeInDisplay(doc, ["far"], "s", 0);
		expect(layout().sections.get("s")?.order).toEqual(["far", "a", "new", "b"]);
	});

	it("forgets a shape's place in the order when it leaves", () => {
		const { doc, get } = listBoard();
		moveInList(doc, "s", ["b"], 0);
		expect(get("b")?.order).toBeDefined();
		commitMoves(doc, new Map([["b", { x: 3000, y: 3000 }]]));
		expect(get("b")?.parent).toBeNull();
		expect(get("b")?.order).toBeUndefined();
	});

	it("shows cards again where they were", () => {
		const { doc, get } = listBoard();
		moveInList(doc, "s", ["far"], 0);
		setDisplay(doc, ["s"], "cards");
		expect(get("s")?.display).toBeUndefined();
		expect(get("far")).toMatchObject({ x: 400, y: 400, parent: "s" });
	});
});
