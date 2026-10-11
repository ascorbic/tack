import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { exportBoard, importBoard, readBoardExport } from "../src/shared/boardExport.ts";
import { layoutDisplays } from "../src/shared/display.ts";
import {
	applyGrouping,
	leavePile,
	pileSelection,
	pileUp,
	planGrouping,
	reorderInPile,
	setPileName,
	spreadPile,
} from "../src/shared/pileEdits.ts";
import {
	PILE_INSET,
	PILE_SIZE,
	gridColumns,
	isPiled,
	membersOf,
	nameState,
	nearestSlot,
	openLayout,
	pileName,
	pileOf,
} from "../src/shared/piles.ts";
import { repairBoard } from "../src/shared/repair.ts";
import { readStructure } from "../src/shared/sections.ts";
import { addShape, nextZ, readShape, shapesMap } from "../src/shared/shapes.ts";
import {
	addConnector,
	addSection,
	commitMoves,
	copyClosure,
	placeInSections,
	readShapes,
	removeShapes,
} from "../src/shared/structure.ts";
import { extractTemplate, instantiateTemplate } from "../src/shared/templates.ts";
import { boardThumbnail } from "../src/shared/thumbnail.ts";

function board(doc = new Y.Doc()) {
	let n = 0;
	const newId = () => `pile-${++n}`;
	const sticky = (id: string, x: number, y: number, text = id) =>
		addShape(doc, id, { type: "sticky", text, x, y, z: nextZ(doc), parent: null });
	const get = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? readShape(shape) : undefined;
	};
	const members = (pile: string) => membersOf(readShapes(doc), pile);
	return { doc, sticky, get, members, newId };
}

function sync(a: Y.Doc, b: Y.Doc) {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("piling up", () => {
	it("makes a pile where the sticky dropped on was, with the dropped one on top", () => {
		const { doc, sticky, get, members, newId } = board();
		sticky("a", 100, 100);
		sticky("b", 600, 400);
		const pile = pileUp(doc, "a", ["b"], undefined, newId);
		expect(pile).toBe("pile-1");
		expect(get("pile-1")).toMatchObject({
			type: "pile",
			x: 100 - PILE_INSET.x,
			y: 100 - PILE_INSET.y,
			parent: null,
		});
		expect(members("pile-1")).toEqual(["b", "a"]);
		expect(get("b")).toMatchObject({ pile: "pile-1", x: 100, y: 100, parent: null });
		expect(isPiled(readShapes(doc), "a")).toBe(true);
	});

	it("adds to a pile dropped on, and takes another pile's stickies with it", () => {
		const { doc, sticky, get, members, newId } = board();
		for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) sticky(id, i * 300, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		pileUp(doc, "c", ["d"], undefined, newId);
		addConnector(doc, { from: { x: 0, y: 0, shape: "pile-2" }, to: { x: 900, y: 900 } }, "line");
		// Drop pile 2 and a sticky on pile 1: one pile of five.
		expect(pileUp(doc, "pile-1", ["pile-2", "e"], undefined, newId)).toBe("pile-1");
		expect(get("pile-2")).toBeUndefined();
		expect(members("pile-1").sort()).toEqual(["a", "b", "c", "d", "e"]);
		expect(get("line")?.from).toMatchObject({ shape: "pile-1" });
	});

	it("dissolves a pile left with one sticky when the other's taken elsewhere", () => {
		const { doc, sticky, get, members, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		sticky("c", 600, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		addConnector(doc, { from: { x: 0, y: 0, shape: "pile-1" }, to: { x: 9, y: 9 } }, "line");
		// "b" goes onto "c": pile 1 is left with "a" alone.
		pileUp(doc, "c", ["b"], undefined, newId);
		expect(get("pile-1")).toBeUndefined();
		expect(get("a")?.pile ?? null).toBeNull();
		expect(get("a")).toMatchObject({ x: -PILE_INSET.x + PILE_INSET.x, y: 0 });
		expect(get("line")?.from).toMatchObject({ shape: "a" });
		expect(members("pile-2")).toEqual(["b", "c"]);
	});

	it("piles a selection where its first sticky is, onto a pile if there is one", () => {
		const { doc, sticky, members, newId } = board();
		sticky("a", 500, 500);
		sticky("b", 0, 0);
		sticky("c", 250, 0);
		const pile = pileSelection(doc, ["a", "b", "c"]);
		expect(pile).not.toBeNull();
		expect(readShapes(doc).get(pile as string)).toMatchObject({ x: -PILE_INSET.x });
		expect(members(pile as string)).toHaveLength(3);
		expect(pileSelection(doc, ["a"])).toBeNull();
		void newId;
	});

	it("only piles stickies and piles", () => {
		const { doc, sticky, newId } = board();
		sticky("a", 0, 0);
		addShape(doc, "card", { type: "card", ref: "github.com/a/b#1", x: 0, y: 0, z: nextZ(doc) });
		expect(pileUp(doc, "card", ["a"], undefined, newId)).toBeNull();
		expect(pileUp(doc, "a", ["card"], undefined, newId)).toBeNull();
		expect(readShapes(doc).size).toBe(2);
	});
});

describe("leaving and spreading piles", () => {
	it("drops a sticky out where it was let go; one left dissolves into a sticky", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		sticky("c", 600, 0);
		pileUp(doc, "a", ["b", "c"], undefined, newId);
		leavePile(doc, new Map([["b", { x: 1000, y: 1000 }]]));
		expect(get("b")).toMatchObject({ x: 1000, y: 1000 });
		expect(get("b")?.pile ?? null).toBeNull();
		expect(get("pile-1")).toBeDefined();
		leavePile(doc, new Map([["c", { x: 1500, y: 1000 }]]));
		expect(get("pile-1")).toBeUndefined();
		expect(get("a")?.pile ?? null).toBeNull();
		expect(get("a")).toMatchObject({ x: 0, y: 0 });
	});

	it("spreads a pile out into the grid it shows open, and goes", () => {
		const { doc, sticky, get, newId } = board();
		for (const id of ["a", "b", "c", "d"]) sticky(id, 0, 0);
		pileUp(doc, "a", ["b", "c", "d"], undefined, newId);
		const pile = get("pile-1");
		const layout = openLayout(pile as never, membersOf(readShapes(doc), "pile-1"));
		const spread = spreadPile(doc, "pile-1");
		expect(spread).toHaveLength(4);
		expect(get("pile-1")).toBeUndefined();
		for (const id of spread) {
			expect(get(id)?.pile ?? null).toBeNull();
			expect({ x: get(id)?.x, y: get(id)?.y }).toEqual(layout.slots.get(id));
		}
	});

	it("restacks a sticky within its pile", () => {
		const { doc, sticky, members, newId } = board();
		for (const id of ["a", "b", "c"]) sticky(id, 0, 0);
		pileUp(doc, "a", ["b", "c"], undefined, newId);
		expect(members("pile-1")).toEqual(["c", "b", "a"]);
		reorderInPile(doc, "a", 0);
		expect(members("pile-1")).toEqual(["a", "c", "b"]);
		reorderInPile(doc, "a", 2);
		expect(members("pile-1")).toEqual(["c", "b", "a"]);
	});

	it("keeps a person's name, and clears it back to suggestions", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		shapesMap(doc).get("pile-1")?.set("suggested", { title: "Docs gaps", hash: "x" });
		expect(nameState(get("pile-1"))).toBe("suggested");
		setPileName(doc, "pile-1", "  “Onboarding”.  ");
		expect(get("pile-1")?.title).toBe("Onboarding");
		expect(pileName(get("pile-1"))).toBe("Onboarding");
		setPileName(doc, "pile-1", "   ");
		expect(get("pile-1")?.title).toBeUndefined();
		expect(pileName(get("pile-1"))).toBe("Docs gaps");
	});
});

describe("piles and the board's structure", () => {
	it("brings its stickies along when it moves, into whichever section it lands in", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		const section = addSection(doc, { x: 1000, y: 1000, w: 800, h: 600 }, { title: "Later" });
		commitMoves(doc, new Map([["pile-1", { x: 1100, y: 1100 }]]));
		expect(get("pile-1")).toMatchObject({ x: 1100, y: 1100, parent: section });
		for (const id of ["a", "b"]) {
			expect(get(id)).toMatchObject({
				x: 1100 + PILE_INSET.x,
				y: 1100 + PILE_INSET.y,
				parent: section,
				pile: "pile-1",
			});
		}
		// The section moving takes the pile and its stickies.
		commitMoves(doc, new Map([[section, { x: 2000, y: 1000 }]]));
		expect(get("pile-1")).toMatchObject({ x: 2100, y: 1100 });
		expect(get("a")).toMatchObject({ x: 2100 + PILE_INSET.x, parent: section });
	});

	it("never moves a piled sticky on its own", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		commitMoves(doc, new Map([["a", { x: 5000, y: 5000 }]]));
		expect(get("a")).toMatchObject({ x: 0, y: 0, pile: "pile-1" });
	});

	it("deletes its stickies with it; deleting one of two dissolves it", () => {
		const { doc, sticky, get, newId } = board();
		for (const id of ["a", "b", "c", "d"]) sticky(id, 0, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		pileUp(doc, "c", ["d"], undefined, newId);
		removeShapes(doc, ["pile-1"]);
		expect(get("a")).toBeUndefined();
		expect(get("b")).toBeUndefined();
		removeShapes(doc, ["d"]);
		expect(get("pile-2")).toBeUndefined();
		expect(get("c")?.pile ?? null).toBeNull();
	});

	it("copies its stickies with it", () => {
		const { doc, sticky, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		sticky("c", 0, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		expect(copyClosure(doc, ["pile-1"]).sort()).toEqual(["a", "b", "pile-1"]);
	});

	it("shows in a list as one row, its stickies not on their own", () => {
		const { doc, sticky, newId } = board();
		const section = addSection(doc, { x: 0, y: 0, w: 800, h: 800 });
		sticky("a", 50, 50);
		sticky("b", 300, 50);
		sticky("c", 50, 300);
		placeInSections(doc, ["a", "b", "c"]);
		pileUp(doc, "a", ["b"], undefined, newId);
		shapesMap(doc).get(section)?.set("display", "list");
		const shapes = readShapes(doc);
		const layout = layoutDisplays(shapes, readStructure(shapes));
		expect([...layout.slots.keys()].sort()).toEqual(["c", "pile-1"]);
	});
});

describe("repairing piles", () => {
	it("clears piles that point at nothing, and settles thin ones", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		sticky("lost", 500, 0);
		pileUp(doc, "a", ["b"], undefined, newId);
		shapesMap(doc).get("lost")?.set("pile", "gone");
		addShape(doc, "empty", { type: "pile", x: 0, y: 0, z: nextZ(doc) });
		shapesMap(doc).get("b")?.set("parent", "nowhere");
		const result = repairBoard(doc);
		expect(result.piles).toBeGreaterThanOrEqual(3);
		expect(get("lost")?.pile ?? null).toBeNull();
		expect(get("empty")).toBeUndefined();
		expect(get("b")?.parent).toBeNull();
		expect(repairBoard(doc).piles).toBe(0);
	});

	it("converges when two people pile the same sticky at once", () => {
		const alice = new Y.Doc();
		const bob = new Y.Doc();
		const a = board(alice);
		a.sticky("x", 0, 0);
		a.sticky("y", 300, 0);
		a.sticky("z", 600, 0);
		sync(alice, bob);
		// Alice drops y on x; Bob drops y on z, offline from each other.
		pileUp(alice, "x", ["y"], undefined, () => "alice-pile");
		pileUp(bob, "z", ["y"], undefined, () => "bob-pile");
		sync(alice, bob);
		const server = new Y.Doc();
		Y.applyUpdate(server, Y.encodeStateAsUpdate(alice));
		repairBoard(server);
		const shapes = readShapes(server);
		const piles = [...shapes].filter(([, shape]) => shape.type === "pile");
		// y ended up in one of them; the other, left with one sticky, dissolved.
		expect(piles).toHaveLength(1);
		const [[pile]] = piles as [[string, unknown]];
		expect(membersOf(shapes, pile)).toContain("y");
		expect(membersOf(shapes, pile)).toHaveLength(2);
		expect(repairBoard(server).piles).toBe(0);
	});

	it("resolves a pile moving while someone drags a sticky out to one or the other, whole", () => {
		const alice = new Y.Doc();
		const bob = new Y.Doc();
		const a = board(alice);
		for (const id of ["p", "q", "r"]) a.sticky(id, 0, 0);
		pileUp(alice, "p", ["q", "r"], undefined, () => "pile");
		sync(alice, bob);
		commitMoves(alice, new Map([["pile", { x: 2000, y: 2000 }]]));
		leavePile(bob, new Map([["q", { x: -900, y: -900 }]]));
		sync(alice, bob);
		const q = readShape(shapesMap(alice).get("q") as Y.Map<unknown>);
		const outside = q.x === -900 && q.y === -900 && (q.pile ?? null) === null;
		const inside = q.x === 2000 + PILE_INSET.x && q.pile === "pile";
		expect(outside || inside).toBe(true);
		expect(readShape(shapesMap(bob).get("q") as Y.Map<unknown>)).toEqual(q);
	});
});

describe("the open grid", () => {
	it("lays stickies out in tidy columns, centred on the stack", () => {
		expect([1, 2, 3, 4, 5, 9, 10, 30].map(gridColumns)).toEqual([1, 2, 3, 2, 3, 3, 4, 5]);
		const layout = openLayout({ x: 0, y: 0 }, ["a", "b", "c", "d"]);
		expect(layout.columns).toBe(2);
		const centre = layout.tray.x + layout.tray.w / 2;
		expect(centre).toBeCloseTo(PILE_SIZE.w / 2);
		const [first, second, third] = [...layout.slots.values()];
		expect(second?.y).toBe(first?.y);
		expect(third?.x).toBe(first?.x);
		expect(nearestSlot(layout, { x: (third?.x ?? 0) + 80, y: (third?.y ?? 0) + 80 })).toBe(2);
	});
});

describe("grouping a selection", () => {
	it("plans piles where their first sticky is, clear of each other, and makes them as suggestions", () => {
		const { doc, sticky, get, members } = board();
		sticky("a", 0, 0, "Docs are hard to find");
		sticky("b", 200, 0, "No loader example");
		sticky("c", 0, 200, "CI is slow");
		sticky("d", 200, 200, "Flaky e2e");
		sticky("e", 400, 400, "Lone one");
		const plan = planGrouping(readShapes(doc), [
			{ name: "Hard-to-find docs", ids: ["a", "b"] },
			{ name: "Unreliable CI.", ids: ["c", "d", "a"] },
			{ name: "Just one", ids: ["e"] },
		]);
		expect(plan.map((pile) => pile.name)).toEqual(["Hard-to-find docs", "Unreliable CI"]);
		expect(plan[1]?.ids).toEqual(["c", "d"]);
		const [first, second] = plan;
		const overlap =
			first &&
			second &&
			Math.abs(first.at.x - second.at.x) < PILE_SIZE.w &&
			Math.abs(first.at.y - second.at.y) < PILE_SIZE.h;
		expect(overlap).toBe(false);
		let n = 0;
		const made = applyGrouping(doc, plan, undefined, () => `g${++n}`);
		expect(made).toEqual(["g1", "g2"]);
		expect(members("g1")).toEqual(["a", "b"]);
		expect(nameState(get("g1"))).toBe("suggested");
		expect(pileName(get("g2"))).toBe("Unreliable CI");
		expect(get("e")?.pile ?? null).toBeNull();
	});
});

describe("piles in exports, templates and thumbnails", () => {
	function piled() {
		const { doc, sticky, newId } = board();
		sticky("a", 0, 0, "One");
		sticky("b", 0, 0, "Two");
		sticky("solo", 400, 0, "Three");
		pileUp(doc, "a", ["b"], undefined, newId);
		setPileName(doc, "pile-1", "Numbers");
		return doc;
	}

	it("exports and imports a pile with its stickies, ids remapped", () => {
		const { data } = exportBoard(piled(), { title: "Board" });
		const read = readBoardExport(JSON.parse(JSON.stringify(data)));
		expect(read.ok).toBe(true);
		const target = new Y.Doc();
		let n = 0;
		importBoard(target, data, { by: { name: "Me" }, newId: () => `new-${++n}` });
		const shapes = readShapes(target);
		const pile = [...shapes].find(([, shape]) => shape.type === "pile")?.[0] as string;
		expect(shapes.get(pile)?.title).toBe("Numbers");
		expect(membersOf(shapes, pile)).toHaveLength(2);
		expect(
			pileOf(shapes, [...shapes.keys()].find((id) => shapes.get(id)?.text === "Three") ?? ""),
		).toBeNull();
	});

	it("saves a pile in a template with its content, and makes it again", () => {
		const { content } = extractTemplate(piled(), { keepContent: true });
		const target = new Y.Doc();
		let n = 0;
		instantiateTemplate(target, content, { by: { name: "Me" }, newId: () => `t-${++n}` });
		const shapes = readShapes(target);
		const pile = [...shapes].find(([, shape]) => shape.type === "pile")?.[0] as string;
		expect(membersOf(shapes, pile)).toHaveLength(2);
	});

	it("sketches a pile as one stack in its top sticky's colour", () => {
		const doc = piled();
		shapesMap(doc).get("b")?.set("color", "pink");
		const thumbnail = boardThumbnail(doc);
		const kinds = thumbnail?.shapes.map((shape) => shape[0]).sort();
		expect(kinds).toEqual(["pile", "sticky"]);
		expect(thumbnail?.shapes.find((shape) => shape[0] === "pile")?.[5]).toBe("pink");
	});
});
