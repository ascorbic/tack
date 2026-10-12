import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	FIT_EMPTY,
	SECTION_PAD,
	fitBox,
	growSections,
	planGrowth,
	titleWidth,
} from "../src/shared/growth.ts";
import { addShape, readShape, shapesMap, type ShapeProps } from "../src/shared/shapes.ts";
import {
	addSection,
	commitMoves,
	fitSection,
	placeInSections,
	readShapes,
	resizeSection,
	settlePasted,
} from "../src/shared/structure.ts";

// Sections grow to keep what's in them, never shrink by themselves, and fit
// to their contents when asked.

const STICKY = 176;

const section = (
	x: number,
	y: number,
	w: number,
	h: number,
	parent: string | null = null,
	extra: Partial<ShapeProps> = {},
): ShapeProps => ({ type: "section", title: "Ideas", x, y, w, h, z: "a0", parent, ...extra });

const sticky = (x: number, y: number, parent: string | null = null): ShapeProps => ({
	type: "sticky",
	text: "An idea",
	x,
	y,
	z: "a1",
	parent,
});

function shapes(entries: Record<string, ShapeProps>): Map<string, ShapeProps> {
	return new Map(Object.entries(entries));
}

const box = (x: number, y: number, w = STICKY, h = STICKY) => ({ x, y, w, h });

function board(entries: Record<string, ShapeProps>) {
	const doc = new Y.Doc();
	doc.transact(() => {
		for (const [id, shape] of Object.entries(entries)) addShape(doc, id, shape);
	});
	const get = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? readShape(shape) : undefined;
	};
	const rect = (id: string) => {
		const shape = get(id);
		return shape && { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
	};
	return { doc, get, rect };
}

describe("planning growth", () => {
	it("grows a section past whatever reaches over its edge, with a margin", () => {
		const board = shapes({ sec: section(0, 0, 600, 400), a: sticky(500, 100, "sec") });
		const plan = planGrowth(board, [["a", box(500, 100)]]);
		expect(plan.get("sec")).toEqual({ x: 0, y: 0, w: 500 + STICKY + SECTION_PAD, h: 400 });
	});

	it("grows to the left and upwards too, keeping the far edges where they are", () => {
		const board = shapes({ sec: section(100, 100, 600, 400), a: sticky(60, 40, "sec") });
		const plan = planGrowth(board, [["a", box(60, 40)]]);
		expect(plan.get("sec")).toEqual({
			x: 60 - SECTION_PAD,
			y: 40 - SECTION_PAD,
			w: 700 - (60 - SECTION_PAD),
			h: 500 - (40 - SECTION_PAD),
		});
	});

	it("leaves a section alone when its contents are inside it, margin or not", () => {
		const board = shapes({ sec: section(0, 0, 600, 400), a: sticky(420, 220, "sec") });
		// 420 + 176 = 596: inside, though closer to the edge than the margin.
		expect(planGrowth(board, [["a", box(420, 220)]]).size).toBe(0);
	});

	it("grows the sections around a section it grew, innermost first", () => {
		const board = shapes({
			outer: section(0, 0, 800, 600),
			inner: section(100, 100, 500, 400, "outer"),
			a: sticky(500, 300, "inner"),
		});
		const plan = planGrowth(board, [["a", box(500, 300)]]);
		const inner = plan.get("inner");
		expect(inner).toEqual({ x: 100, y: 100, w: 500 + STICKY + SECTION_PAD - 100, h: 400 });
		// The inner section's new right edge, 700, still fits; its bottom does too.
		expect(plan.has("outer")).toBe(false);

		const far = planGrowth(board, [["a", box(700, 450)]]);
		expect(far.get("inner")).toEqual({
			x: 100,
			y: 100,
			w: 700 + STICKY + SECTION_PAD - 100,
			h: 450 + STICKY + SECTION_PAD - 100,
		});
		expect(far.get("outer")).toEqual({
			x: 0,
			y: 0,
			w: 700 + STICKY + SECTION_PAD * 2,
			h: 450 + STICKY + SECTION_PAD * 2,
		});
	});

	it("grows once for everything reaching into a section", () => {
		const board = shapes({
			sec: section(0, 0, 600, 400),
			a: sticky(500, 0, "sec"),
			b: sticky(0, 300, "sec"),
		});
		const plan = planGrowth(board, [
			["a", box(500, 0)],
			["b", box(0, 300)],
		]);
		expect(plan.get("sec")).toEqual({
			x: 0,
			y: 0,
			w: 500 + STICKY + SECTION_PAD,
			h: 300 + STICKY + SECTION_PAD,
		});
	});

	it("leaves lists, grids and what's in them, stacked stickies and the top level alone", () => {
		const board = shapes({
			list: section(0, 0, 400, 300, null, { display: "list" }),
			grid: section(1000, 0, 400, 300, null, { display: "mini" }),
			group: section(1050, 50, 200, 200, "grid"),
			sec: section(0, 1000, 400, 300),
			stack: { type: "stack", x: 100, y: 1100, z: "a2", parent: "sec" },
			member: { ...sticky(100, 1100, "sec"), stack: "stack" },
			a: sticky(350, 100, "list"),
			b: sticky(1200, 200, "group"),
			loose: sticky(3000, 3000),
		});
		const plan = planGrowth(board, [
			["a", box(350, 100)],
			["b", box(1200, 200)],
			["member", box(380, 1200)],
			["loose", box(3000, 3000)],
		]);
		expect(plan.size).toBe(0);
	});
});

describe("growing sections in the document", () => {
	it("is idempotent, and writes only the edges that move", () => {
		const { doc, rect } = board({ sec: section(0, 0, 600, 400), a: sticky(500, 100, "sec") });
		const writes: string[] = [];
		shapesMap(doc)
			.get("sec")
			?.observe((event) => writes.push(...event.keysChanged));
		expect(growSections(doc, ["a"])).toEqual(["sec"]);
		expect(writes).toEqual(["w"]);
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 700, h: 400 });
		expect(growSections(doc, ["a"])).toEqual([]);
		expect(writes).toEqual(["w"]);
	});

	it("never fights between people: concurrent growth lands both ways", () => {
		const one = board({
			sec: section(0, 0, 600, 400),
			a: sticky(100, 100, "sec"),
			b: sticky(100, 100, "sec"),
		});
		const two = new Y.Doc();
		Y.applyUpdate(two, Y.encodeStateAsUpdate(one.doc));
		// One person drops a sticky over the right edge, the other over the bottom.
		one.doc.transact(() => commitMoves(one.doc, new Map([["a", { x: 500, y: 100 }]])));
		two.transact(() => commitMoves(two, new Map([["b", { x: 100, y: 300 }]])));
		Y.applyUpdate(one.doc, Y.encodeStateAsUpdate(two));
		Y.applyUpdate(two, Y.encodeStateAsUpdate(one.doc));
		const expected = { x: 0, y: 0, w: 700, h: 300 + STICKY + SECTION_PAD };
		expect(one.rect("sec")).toEqual(expected);
		expect(readShapes(two).get("sec")).toMatchObject(expected);
		// Nothing left for either to do.
		expect(growSections(one.doc, ["a", "b"])).toEqual([]);
		expect(growSections(two, ["a", "b"])).toEqual([]);
	});

	it("grows a section as a sticky is dropped over its edge, in the drop's undo step", () => {
		const { doc, rect, get } = board({
			sec: section(0, 0, 600, 400),
			a: sticky(1000, 100),
		});
		const undo = new Y.UndoManager(shapesMap(doc), { trackedOrigins: new Set(["local"]) });
		doc.transact(() => commitMoves(doc, new Map([["a", { x: 480, y: 300 }]])), "local");
		expect(get("a")?.parent).toBe("sec");
		expect(rect("sec")).toEqual({
			x: 0,
			y: 0,
			w: 480 + STICKY + SECTION_PAD,
			h: 300 + STICKY + SECTION_PAD,
		});
		undo.undo();
		expect(get("a")).toMatchObject({ x: 1000, y: 100, parent: null });
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 600, h: 400 });
	});

	it("doesn't grow for contents following their section, or for shapes dragged out", () => {
		const { doc, rect } = board({
			sec: section(0, 0, 600, 400),
			// Already reaching over, from before sections grew.
			over: sticky(500, 100, "sec"),
			a: sticky(100, 100, "sec"),
		});
		doc.transact(() => commitMoves(doc, new Map([["sec", { x: 50, y: 0 }]])));
		expect(rect("sec")).toEqual({ x: 50, y: 0, w: 600, h: 400 });
		doc.transact(() => commitMoves(doc, new Map([["a", { x: 1000, y: 100 }]])));
		expect(rect("sec")).toEqual({ x: 50, y: 0, w: 600, h: 400 });
	});

	it("grows the sections around a nested section as it grows", () => {
		const { doc, rect } = board({
			outer: section(0, 0, 650, 560),
			inner: section(100, 100, 500, 400, "outer"),
			a: sticky(1000, 1000),
		});
		doc.transact(() => commitMoves(doc, new Map([["a", { x: 480, y: 380 }]])));
		expect(rect("inner")).toEqual({
			x: 100,
			y: 100,
			w: 480 + STICKY + SECTION_PAD - 100,
			h: 380 + STICKY + SECTION_PAD - 100,
		});
		expect(rect("outer")).toEqual({
			x: 0,
			y: 0,
			w: 480 + STICKY + SECTION_PAD * 2,
			h: 380 + STICKY + SECTION_PAD * 2,
		});
	});

	it("grows for shapes added, pasted and resized", () => {
		const { doc, rect } = board({
			outer: section(-200, -200, 1000, 800),
			sec: section(0, 0, 600, 400, "outer"),
		});
		doc.transact(() => {
			addShape(doc, "new", sticky(500, 50));
			placeInSections(doc, ["new"]);
		});
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 700, h: 400 });

		doc.transact(() => {
			addShape(doc, "pasted", sticky(50, 300));
			settlePasted(doc, ["pasted"], { x: 24, y: 24 });
		});
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 700, h: 500 });

		// A section resized over its parent's edge grows its parent, not itself.
		doc.transact(() => resizeSection(doc, "sec", { x: 0, y: 0, w: 900, h: 500 }));
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 900, h: 500 });
		expect(rect("outer")).toEqual({ x: -200, y: -200, w: 900 + 200 + SECTION_PAD, h: 800 });
	});

	it("never grows a section someone resized smaller than what's in it", () => {
		const { doc, rect } = board({ sec: section(0, 0, 600, 400), a: sticky(300, 100, "sec") });
		doc.transact(() => resizeSection(doc, "sec", { x: 0, y: 0, w: 420, h: 400 }));
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 420, h: 400 });
	});

	it("grows a section a new section is drawn in", () => {
		const { doc, rect } = board({ sec: section(0, 0, 600, 400) });
		addSection(doc, { x: 300, y: 100, w: 400, h: 200 });
		expect(rect("sec")).toEqual({ x: 0, y: 0, w: 700 + SECTION_PAD, h: 400 });
	});
});

describe("fitting a section to its contents", () => {
	it("shrinks and grows to its contents, with the margin all round", () => {
		const board = shapes({
			sec: section(0, 0, 1000, 800),
			a: sticky(100, 120, "sec"),
			b: sticky(400, 300, "sec"),
		});
		expect(fitBox(board, "sec")).toEqual({
			x: 100 - SECTION_PAD,
			y: 120 - SECTION_PAD,
			w: 400 + STICKY - 100 + SECTION_PAD * 2,
			h: 300 + STICKY - 120 + SECTION_PAD * 2,
		});
		const over = shapes({ sec: section(0, 0, 300, 200), a: sticky(200, 100, "sec") });
		expect(fitBox(over, "sec")).toEqual({
			x: 200 - SECTION_PAD,
			y: 100 - SECTION_PAD,
			w: STICKY + SECTION_PAD * 2,
			h: STICKY + SECTION_PAD * 2,
		});
	});

	it("uses measured sizes, a nested section's box and a stack's card", () => {
		const board = shapes({
			sec: section(0, 0, 2000, 2000),
			inner: section(100, 100, 300, 300, "sec"),
			deep: sticky(1500, 1500, "inner"),
			card: { type: "card", ref: "github.com/acme/app#1", x: 500, y: 100, z: "a1", parent: "sec" },
		});
		const fit = fitBox(board, "sec", (id) => (id === "card" ? { w: 252, h: 300 } : undefined));
		expect(fit).toEqual({
			x: 100 - SECTION_PAD,
			y: 100 - SECTION_PAD,
			w: 752 - 100 + SECTION_PAD * 2,
			h: 400 - 100 + SECTION_PAD * 2,
		});
	});

	it("keeps room for the title, and a sensible size when empty", () => {
		const long = "A long name for a section about everything we want to do next";
		const narrow = shapes({
			sec: section(0, 0, 1000, 800, null, { title: long }),
			a: sticky(100, 100, "sec"),
		});
		expect(fitBox(narrow, "sec")?.w).toBe(titleWidth(long));
		expect(titleWidth(long)).toBeGreaterThan(STICKY + SECTION_PAD * 2);

		const empty = shapes({ sec: section(40, 60, 1000, 800) });
		expect(fitBox(empty, "sec")).toEqual({ x: 40, y: 60, ...FIT_EMPTY });
	});

	it("isn't offered for lists, grids or what isn't a section", () => {
		const board = shapes({
			list: section(0, 0, 400, 300, null, { display: "list" }),
			a: sticky(0, 0, "list"),
			b: sticky(0, 0),
		});
		expect(fitBox(board, "list")).toBeNull();
		expect(fitBox(board, "b")).toBeNull();
		expect(fitBox(board, "gone")).toBeNull();
	});

	it("is one undo step, which grows the sections around it if it needs to", () => {
		const { doc, rect } = board({
			outer: section(0, 0, 700, 600),
			sec: section(100, 100, 400, 400, "outer"),
			a: sticky(300, 450, "sec"),
		});
		const undo = new Y.UndoManager(shapesMap(doc), { trackedOrigins: new Set(["local"]) });
		expect(doc.transact(() => fitSection(doc, "sec"), "local")).toBe(true);
		expect(rect("sec")).toEqual({
			x: 300 - SECTION_PAD,
			y: 450 - SECTION_PAD,
			w: STICKY + SECTION_PAD * 2,
			h: STICKY + SECTION_PAD * 2,
		});
		expect(rect("outer")).toEqual({ x: 0, y: 0, w: 700, h: 450 + STICKY + SECTION_PAD * 2 });
		// Already fits: nothing to do.
		expect(doc.transact(() => fitSection(doc, "sec"), "local")).toBe(false);
		expect(undo.undoStack.length).toBe(1);
		undo.undo();
		expect(rect("sec")).toEqual({ x: 100, y: 100, w: 400, h: 400 });
		expect(rect("outer")).toEqual({ x: 0, y: 0, w: 700, h: 600 });
	});
});
