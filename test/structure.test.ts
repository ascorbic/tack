import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { repairBoard } from "../src/shared/repair.ts";
import { containerFor, readStructure, resizeRect } from "../src/shared/sections.ts";
import { addShape, nextZ, readShape, shapesMap } from "../src/shared/shapes.ts";
import {
	addConnector,
	addSection,
	commitMoves,
	removeShapes,
	resizeSection,
} from "../src/shared/structure.ts";

function board() {
	const doc = new Y.Doc();
	const sticky = (id: string, x: number, y: number) =>
		addShape(doc, id, { type: "sticky", text: id, x, y, z: nextZ(doc), parent: null });
	const get = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? readShape(shape) : undefined;
	};
	return { doc, sticky, get };
}

describe("containment", () => {
	const sections = [
		{ id: "outer", box: { x: 0, y: 0, w: 1000, h: 1000 }, depth: 0, z: "a0" },
		{ id: "inner", box: { x: 100, y: 100, w: 400, h: 400 }, depth: 1, z: "a1" },
		{ id: "beside", box: { x: 600, y: 100, w: 300, h: 300 }, depth: 1, z: "a2" },
	];

	it("picks the innermost section under a shape's centre", () => {
		expect(containerFor({ x: 200, y: 200, w: 100, h: 100 }, sections)).toBe("inner");
		expect(containerFor({ x: 50, y: 700, w: 100, h: 100 }, sections)).toBe("outer");
		expect(containerFor({ x: 2000, y: 0, w: 100, h: 100 }, sections)).toBeNull();
	});

	it("never puts a shape in a section smaller than itself, or in an excluded one", () => {
		expect(containerFor({ x: 550, y: 50, w: 500, h: 500 }, sections)).toBe("outer");
		expect(containerFor({ x: 200, y: 200, w: 100, h: 100 }, sections, new Set(["inner"]))).toBe(
			"outer",
		);
	});

	it("ignores dangling parents and cuts cycles", () => {
		const structure = readStructure(
			new Map([
				["a", { type: "section" as const, parent: "b" }],
				["b", { type: "section" as const, parent: "a" }],
				["c", { type: "sticky" as const, parent: "a" }],
				["d", { type: "sticky" as const, parent: "gone" }],
				["e", { type: "sticky" as const, parent: "c" }],
			]),
		);
		expect(structure.parentOf).toEqual(new Map([["c", "a"]]));
		expect(structure.broken).toEqual(new Set(["a", "b", "d", "e"]));
		expect(structure.depth.get("c")).toBe(1);
	});
});

describe("sections", () => {
	it("takes in what it's drawn around", () => {
		const { doc, sticky, get } = board();
		sticky("in", 100, 100);
		sticky("out", 900, 100);
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Now" });
		expect(get("in")?.parent).toBe(id);
		expect(get("out")?.parent).toBeNull();
		expect(get(id)).toMatchObject({ type: "section", title: "Now", w: 600, h: 400, parent: null });
	});

	it("puts dropped shapes in, and takes them out", () => {
		const { doc, sticky, get } = board();
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });
		sticky("s", 900, 100);
		commitMoves(doc, new Map([["s", { x: 100, y: 100 }]]));
		expect(get("s")?.parent).toBe(id);
		commitMoves(doc, new Map([["s", { x: 1000, y: 100 }]]));
		expect(get("s")?.parent).toBeNull();
	});

	it("moves its contents, nested sections and loose connector ends with it", () => {
		const { doc, sticky, get } = board();
		sticky("deep", 150, 150);
		sticky("shallow", 600, 500);
		const outer = addSection(doc, { x: 0, y: 0, w: 1000, h: 800 });
		const inner = addSection(doc, { x: 100, y: 100, w: 400, h: 400 });
		const line = addConnector(doc, {
			from: { x: 900, y: 100 },
			to: { x: 150, y: 150, shape: "deep" },
		});
		expect(get(inner)?.parent).toBe(outer);
		expect(get("deep")?.parent).toBe(inner);

		commitMoves(doc, new Map([[outer, { x: 50, y: 20 }]]));
		expect(get(inner)).toMatchObject({ x: 150, y: 120, parent: outer });
		expect(get("deep")).toMatchObject({ x: 200, y: 170, parent: inner });
		expect(get("shallow")).toMatchObject({ x: 650, y: 520, parent: outer });
		// The loose end moved; the bound end follows its shape by itself.
		expect(get(line)?.from).toEqual({ x: 950, y: 120 });
		expect(get(line)?.to).toEqual({ x: 150, y: 150, shape: "deep" });
	});

	it("brings what moved to the front in its existing order", () => {
		const { doc, sticky, get } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		sticky("c", 0, 0);
		commitMoves(
			doc,
			new Map([
				["b", { x: 10, y: 0 }],
				["a", { x: 10, y: 0 }],
			]),
		);
		const z = (id: string) => get(id)?.z ?? "";
		expect(z("c") < z("a")).toBe(true);
		expect(z("a") < z("b")).toBe(true);
	});

	it("nests a section it's drawn, dropped or resized around, with its contents", () => {
		const { doc, sticky, get } = board();
		sticky("s", 100, 100);
		const inner = addSection(doc, { x: 50, y: 50, w: 400, h: 300 });
		expect(get("s")?.parent).toBe(inner);

		const drawn = addSection(doc, { x: 0, y: 0, w: 800, h: 600 });
		expect(get(inner)?.parent).toBe(drawn);
		expect(get("s")?.parent).toBe(inner);

		const dropped = addSection(doc, { x: 2000, y: 0, w: 1000, h: 800 });
		commitMoves(doc, new Map([[dropped, { x: -50, y: -50 }]]));
		expect(get(drawn)?.parent).toBe(dropped);
		expect(get(inner)?.parent).toBe(drawn);
		expect(get("s")?.parent).toBe(inner);

		const grown = addSection(doc, { x: 3000, y: 0, w: 200, h: 200 });
		resizeSection(doc, grown, { x: -100, y: -100, w: 4000, h: 2000 });
		expect(get(dropped)?.parent).toBe(grown);
		expect(get("s")?.parent).toBe(inner);
	});

	it("takes in shapes it's dropped onto", () => {
		const { doc, sticky, get } = board();
		const id = addSection(doc, { x: 2000, y: 0, w: 600, h: 400 });
		sticky("s", 100, 100);
		commitMoves(doc, new Map([[id, { x: 0, y: 0 }]]));
		expect(get("s")).toMatchObject({ x: 100, y: 100, parent: id });
	});

	it("keeps contents in place when resized, letting go of anything left outside", () => {
		const { doc, sticky, get } = board();
		sticky("left", 100, 100);
		sticky("right", 700, 100);
		sticky("below", 100, 500);
		const id = addSection(doc, { x: 0, y: 0, w: 1000, h: 400 });
		expect(get("right")?.parent).toBe(id);
		expect(get("below")?.parent).toBeNull();
		resizeSection(doc, id, { x: 0, y: 0, w: 500, h: 800 });
		expect(get("left")).toMatchObject({ x: 100, y: 100, parent: id });
		expect(get("right")?.parent).toBeNull();
		expect(get("below")?.parent).toBe(id);
	});

	it("resizes from any handle, keeping the opposite edges put", () => {
		const start = { x: 100, y: 100, w: 400, h: 300 };
		expect(resizeRect(start, "se", { x: 50, y: -20 })).toEqual({ x: 100, y: 100, w: 450, h: 280 });
		expect(resizeRect(start, "nw", { x: 30, y: 40 })).toEqual({ x: 130, y: 140, w: 370, h: 260 });
		// Past the minimum, the dragged edge stops rather than flipping over.
		expect(resizeRect(start, "w", { x: 1000, y: 0 })).toEqual({ x: 340, y: 100, w: 160, h: 300 });
	});

	it("has a minimum size", () => {
		const { doc, get } = board();
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });
		resizeSection(doc, id, { x: 10, y: 10, w: 4, h: -20 });
		expect(get(id)).toMatchObject({ w: 160, h: 100 });
	});
});

describe("deleting", () => {
	it("deletes a section's contents, detaching connectors that lead out", () => {
		const { doc, sticky, get } = board();
		sticky("in", 100, 100);
		sticky("in2", 300, 100);
		sticky("out", 900, 100);
		const id = addSection(doc, { x: 0, y: 0, w: 600, h: 400 });
		const across = addConnector(doc, {
			from: { x: 0, y: 0, shape: "in", anchor: { x: 1, y: 0.5 } },
			to: { x: 0, y: 0, shape: "out" },
		});
		const within = addConnector(doc, {
			from: { x: 0, y: 0, shape: "in" },
			to: { x: 0, y: 0, shape: "in2" },
		});
		removeShapes(doc, [id]);
		expect(get(id)).toBeUndefined();
		expect(get("in")).toBeUndefined();
		expect(get("out")).toBeDefined();
		expect(get(within)).toBeUndefined();
		// Left where it was drawn: the right-middle of the sticky.
		expect(get(across)?.from).toEqual({ x: 276, y: 188 });
		expect(get(across)?.to).toMatchObject({ shape: "out" });
	});
});

describe("repair", () => {
	it("clears dangling parents and detaches connector ends from missing shapes", () => {
		const { doc, sticky, get } = board();
		sticky("s", 0, 0);
		sticky("orphan", 0, 0);
		shapesMap(doc).get("orphan")?.set("parent", "gone");
		const line = addConnector(doc, {
			from: { x: 10, y: 20, shape: "gone", anchor: { x: 1, y: 0 } },
			to: { x: 30, y: 40, shape: "s" },
		});
		addShape(doc, "broken", { type: "connector", x: 0, y: 0, z: nextZ(doc) });

		expect(repairBoard(doc)).toEqual({
			parents: 1,
			ends: 1,
			removed: 1,
			decisions: 0,
			widgets: 0,
			actions: 0,
			piles: 0,
		});
		expect(get("orphan")?.parent).toBeNull();
		expect(get(line)?.from).toEqual({ x: 10, y: 20 });
		expect(get(line)?.to).toEqual({ x: 30, y: 40, shape: "s" });
		expect(get("broken")).toBeUndefined();
		// Nothing left to fix.
		expect(repairBoard(doc)).toEqual({
			parents: 0,
			ends: 0,
			removed: 0,
			decisions: 0,
			widgets: 0,
			actions: 0,
			piles: 0,
		});
	});

	it("converges when a shape is deleted while someone attaches to it", () => {
		const alice = new Y.Doc();
		const bob = new Y.Doc();
		const sync = () => {
			Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
			Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
		};
		addShape(alice, "card", { type: "card", ref: "x", x: 0, y: 0, z: nextZ(alice) });
		const section = addSection(alice, { x: -100, y: -100, w: 800, h: 800 });
		sync();

		// Offline at the same time: Alice deletes the section (and the card in
		// it); Bob attaches a connector to the card and drops a sticky in.
		removeShapes(alice, [section]);
		addConnector(bob, { from: { x: 500, y: 500 }, to: { x: 126, y: 62, shape: "card" } }, "line");
		addShape(bob, "note", { type: "sticky", x: 300, y: 300, z: nextZ(bob), parent: section });
		sync();

		const server = new Y.Doc();
		Y.applyUpdate(server, Y.encodeStateAsUpdate(alice));
		expect(repairBoard(server)).toEqual({
			parents: 1,
			ends: 1,
			removed: 0,
			decisions: 0,
			widgets: 0,
			actions: 0,
			piles: 0,
		});
		const line = readShape(shapesMap(server).get("line") as Y.Map<unknown>);
		expect(line.to).toEqual({ x: 126, y: 62 });
		expect(readShape(shapesMap(server).get("note") as Y.Map<unknown>).parent).toBeNull();
	});
});
