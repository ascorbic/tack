import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { exportBoard, importBoard, readBoardExport } from "../src/shared/boardExport.ts";
import { layoutDisplays } from "../src/shared/display.ts";
import {
	applyGrouping,
	leaveStack,
	stackSelection,
	stackUp,
	planGrouping,
	reorderInStack,
	setStackName,
	spreadStack,
} from "../src/shared/stackEdits.ts";
import {
	STACK_INSET,
	STACK_SIZE,
	gridColumns,
	isStacked,
	membersOf,
	nameState,
	nearestSlot,
	openLayout,
	stackName,
	stackOf,
} from "../src/shared/stacks.ts";
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
import { makeRoomForCards } from "../src/shared/swap.ts";
import { boardThumbnail } from "../src/shared/thumbnail.ts";

function board(doc = new Y.Doc()) {
	let n = 0;
	const newId = () => `stack-${++n}`;
	const sticky = (id: string, x: number, y: number, text = id) =>
		addShape(doc, id, { type: "sticky", text, x, y, z: nextZ(doc), parent: null });
	const get = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? readShape(shape) : undefined;
	};
	const members = (stack: string) => membersOf(readShapes(doc), stack);
	return { doc, sticky, get, members, newId };
}

function sync(a: Y.Doc, b: Y.Doc) {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("stacking up", () => {
	it("makes a stack where the sticky dropped on was, with the dropped one on top", () => {
		const { doc, sticky, get, members, newId } = board();
		sticky("a", 100, 100);
		sticky("b", 600, 400);
		const stack = stackUp(doc, "a", ["b"], undefined, newId);
		expect(stack).toBe("stack-1");
		expect(get("stack-1")).toMatchObject({
			type: "stack",
			x: 100 - STACK_INSET.x,
			y: 100 - STACK_INSET.y,
			parent: null,
		});
		expect(members("stack-1")).toEqual(["b", "a"]);
		expect(get("b")).toMatchObject({ stack: "stack-1", x: 100, y: 100, parent: null });
		expect(isStacked(readShapes(doc), "a")).toBe(true);
	});

	it("adds to a stack dropped on, and takes another stack's stickies with it", () => {
		const { doc, sticky, get, members, newId } = board();
		for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) sticky(id, i * 300, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		stackUp(doc, "c", ["d"], undefined, newId);
		addConnector(doc, { from: { x: 0, y: 0, shape: "stack-2" }, to: { x: 900, y: 900 } }, "line");
		// Drop stack 2 and a sticky on stack 1: one stack of five.
		expect(stackUp(doc, "stack-1", ["stack-2", "e"], undefined, newId)).toBe("stack-1");
		expect(get("stack-2")).toBeUndefined();
		expect(members("stack-1").sort()).toEqual(["a", "b", "c", "d", "e"]);
		expect(get("line")?.from).toMatchObject({ shape: "stack-1" });
	});

	it("dissolves a stack left with one sticky when the other's taken elsewhere", () => {
		const { doc, sticky, get, members, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		sticky("c", 600, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		addConnector(doc, { from: { x: 0, y: 0, shape: "stack-1" }, to: { x: 9, y: 9 } }, "line");
		// "b" goes onto "c": stack 1 is left with "a" alone.
		stackUp(doc, "c", ["b"], undefined, newId);
		expect(get("stack-1")).toBeUndefined();
		expect(get("a")?.stack ?? null).toBeNull();
		expect(get("a")).toMatchObject({ x: -STACK_INSET.x + STACK_INSET.x, y: 0 });
		expect(get("line")?.from).toMatchObject({ shape: "a" });
		expect(members("stack-2")).toEqual(["b", "c"]);
	});

	it("stacks a selection where its first sticky is, onto a stack if there is one", () => {
		const { doc, sticky, members, newId } = board();
		sticky("a", 500, 500);
		sticky("b", 0, 0);
		sticky("c", 250, 0);
		const stack = stackSelection(doc, ["a", "b", "c"]);
		expect(stack).not.toBeNull();
		expect(readShapes(doc).get(stack as string)).toMatchObject({ x: -STACK_INSET.x });
		expect(members(stack as string)).toHaveLength(3);
		expect(stackSelection(doc, ["a"])).toBeNull();
		void newId;
	});

	it("only stacks stickies and stacks", () => {
		const { doc, sticky, newId } = board();
		sticky("a", 0, 0);
		addShape(doc, "card", { type: "card", ref: "github.com/a/b#1", x: 0, y: 0, z: nextZ(doc) });
		expect(stackUp(doc, "card", ["a"], undefined, newId)).toBeNull();
		expect(stackUp(doc, "a", ["card"], undefined, newId)).toBeNull();
		expect(readShapes(doc).size).toBe(2);
	});
});

describe("leaving and spreading stacks", () => {
	it("drops a sticky out where it was let go; one left dissolves into a sticky", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		sticky("c", 600, 0);
		stackUp(doc, "a", ["b", "c"], undefined, newId);
		leaveStack(doc, new Map([["b", { x: 1000, y: 1000 }]]));
		expect(get("b")).toMatchObject({ x: 1000, y: 1000 });
		expect(get("b")?.stack ?? null).toBeNull();
		expect(get("stack-1")).toBeDefined();
		leaveStack(doc, new Map([["c", { x: 1500, y: 1000 }]]));
		expect(get("stack-1")).toBeUndefined();
		expect(get("a")?.stack ?? null).toBeNull();
		expect(get("a")).toMatchObject({ x: 0, y: 0 });
	});

	it("spreads a stack out into the grid it shows open, and goes", () => {
		const { doc, sticky, get, newId } = board();
		for (const id of ["a", "b", "c", "d"]) sticky(id, 0, 0);
		stackUp(doc, "a", ["b", "c", "d"], undefined, newId);
		const stack = get("stack-1");
		const layout = openLayout(stack as never, membersOf(readShapes(doc), "stack-1"));
		const spread = spreadStack(doc, "stack-1");
		expect(spread).toHaveLength(4);
		expect(get("stack-1")).toBeUndefined();
		for (const id of spread) {
			expect(get(id)?.stack ?? null).toBeNull();
			expect({ x: get(id)?.x, y: get(id)?.y }).toEqual(layout.slots.get(id));
		}
	});

	it("spreads out before its stickies become cards, so the cards land clear of each other", () => {
		const { doc, sticky, get, newId } = board();
		for (const id of ["a", "b", "c"]) sticky(id, 0, 0);
		stackUp(doc, "a", ["b", "c"], undefined, newId);
		makeRoomForCards(doc, ["a", "b"]);
		expect(get("stack-1")).toBeUndefined();
		const spots = ["a", "b", "c"].map((id) => `${get(id)?.x},${get(id)?.y}`);
		expect(new Set(spots).size).toBe(3);
		for (const id of ["a", "b", "c"]) expect(get(id)?.stack ?? null).toBeNull();
	});

	it("restacks a sticky within its stack", () => {
		const { doc, sticky, members, newId } = board();
		for (const id of ["a", "b", "c"]) sticky(id, 0, 0);
		stackUp(doc, "a", ["b", "c"], undefined, newId);
		expect(members("stack-1")).toEqual(["c", "b", "a"]);
		reorderInStack(doc, "a", 0);
		expect(members("stack-1")).toEqual(["a", "c", "b"]);
		reorderInStack(doc, "a", 2);
		expect(members("stack-1")).toEqual(["c", "b", "a"]);
	});

	it("keeps a person's name, and clears it back to suggestions", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		shapesMap(doc).get("stack-1")?.set("suggested", { title: "Docs gaps", hash: "x" });
		expect(nameState(get("stack-1"))).toBe("suggested");
		setStackName(doc, "stack-1", "  “Onboarding”.  ");
		expect(get("stack-1")?.title).toBe("Onboarding");
		expect(stackName(get("stack-1"))).toBe("Onboarding");
		setStackName(doc, "stack-1", "   ");
		expect(get("stack-1")?.title).toBeUndefined();
		expect(stackName(get("stack-1"))).toBe("Docs gaps");
	});
});

describe("stacks and the board's structure", () => {
	it("brings its stickies along when it moves, into whichever section it lands in", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		const section = addSection(doc, { x: 1000, y: 1000, w: 800, h: 600 }, { title: "Later" });
		commitMoves(doc, new Map([["stack-1", { x: 1100, y: 1100 }]]));
		expect(get("stack-1")).toMatchObject({ x: 1100, y: 1100, parent: section });
		for (const id of ["a", "b"]) {
			expect(get(id)).toMatchObject({
				x: 1100 + STACK_INSET.x,
				y: 1100 + STACK_INSET.y,
				parent: section,
				stack: "stack-1",
			});
		}
		// The section moving takes the stack and its stickies.
		commitMoves(doc, new Map([[section, { x: 2000, y: 1000 }]]));
		expect(get("stack-1")).toMatchObject({ x: 2100, y: 1100 });
		expect(get("a")).toMatchObject({ x: 2100 + STACK_INSET.x, parent: section });
	});

	it("never moves a stacked sticky on its own", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 300, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		commitMoves(doc, new Map([["a", { x: 5000, y: 5000 }]]));
		expect(get("a")).toMatchObject({ x: 0, y: 0, stack: "stack-1" });
	});

	it("deletes its stickies with it; deleting one of two dissolves it", () => {
		const { doc, sticky, get, newId } = board();
		for (const id of ["a", "b", "c", "d"]) sticky(id, 0, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		stackUp(doc, "c", ["d"], undefined, newId);
		removeShapes(doc, ["stack-1"]);
		expect(get("a")).toBeUndefined();
		expect(get("b")).toBeUndefined();
		removeShapes(doc, ["d"]);
		expect(get("stack-2")).toBeUndefined();
		expect(get("c")?.stack ?? null).toBeNull();
	});

	it("copies its stickies with it", () => {
		const { doc, sticky, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		sticky("c", 0, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		expect(copyClosure(doc, ["stack-1"]).sort()).toEqual(["a", "b", "stack-1"]);
	});

	it("shows in a list as one row, its stickies not on their own", () => {
		const { doc, sticky, newId } = board();
		const section = addSection(doc, { x: 0, y: 0, w: 800, h: 800 });
		sticky("a", 50, 50);
		sticky("b", 300, 50);
		sticky("c", 50, 300);
		placeInSections(doc, ["a", "b", "c"]);
		stackUp(doc, "a", ["b"], undefined, newId);
		shapesMap(doc).get(section)?.set("display", "list");
		const shapes = readShapes(doc);
		const layout = layoutDisplays(shapes, readStructure(shapes));
		expect([...layout.slots.keys()].sort()).toEqual(["c", "stack-1"]);
	});
});

describe("repairing stacks", () => {
	it("clears stacks that point at nothing, and settles thin ones", () => {
		const { doc, sticky, get, newId } = board();
		sticky("a", 0, 0);
		sticky("b", 0, 0);
		sticky("lost", 500, 0);
		stackUp(doc, "a", ["b"], undefined, newId);
		shapesMap(doc).get("lost")?.set("stack", "gone");
		addShape(doc, "empty", { type: "stack", x: 0, y: 0, z: nextZ(doc) });
		shapesMap(doc).get("b")?.set("parent", "nowhere");
		const result = repairBoard(doc);
		expect(result.stacks).toBeGreaterThanOrEqual(3);
		expect(get("lost")?.stack ?? null).toBeNull();
		expect(get("empty")).toBeUndefined();
		expect(get("b")?.parent).toBeNull();
		expect(repairBoard(doc).stacks).toBe(0);
	});

	it("converges when two people stack the same sticky at once", () => {
		const alice = new Y.Doc();
		const bob = new Y.Doc();
		const a = board(alice);
		a.sticky("x", 0, 0);
		a.sticky("y", 300, 0);
		a.sticky("z", 600, 0);
		sync(alice, bob);
		// Alice drops y on x; Bob drops y on z, offline from each other.
		stackUp(alice, "x", ["y"], undefined, () => "alice-stack");
		stackUp(bob, "z", ["y"], undefined, () => "bob-stack");
		sync(alice, bob);
		const server = new Y.Doc();
		Y.applyUpdate(server, Y.encodeStateAsUpdate(alice));
		repairBoard(server);
		const shapes = readShapes(server);
		const stacks = [...shapes].filter(([, shape]) => shape.type === "stack");
		// y ended up in one of them; the other, left with one sticky, dissolved.
		expect(stacks).toHaveLength(1);
		const [[stack]] = stacks as [[string, unknown]];
		expect(membersOf(shapes, stack)).toContain("y");
		expect(membersOf(shapes, stack)).toHaveLength(2);
		expect(repairBoard(server).stacks).toBe(0);
	});

	it("resolves a stack moving while someone drags a sticky out to one or the other, whole", () => {
		const alice = new Y.Doc();
		const bob = new Y.Doc();
		const a = board(alice);
		for (const id of ["p", "q", "r"]) a.sticky(id, 0, 0);
		stackUp(alice, "p", ["q", "r"], undefined, () => "stack");
		sync(alice, bob);
		commitMoves(alice, new Map([["stack", { x: 2000, y: 2000 }]]));
		leaveStack(bob, new Map([["q", { x: -900, y: -900 }]]));
		sync(alice, bob);
		const q = readShape(shapesMap(alice).get("q") as Y.Map<unknown>);
		const outside = q.x === -900 && q.y === -900 && (q.stack ?? null) === null;
		const inside = q.x === 2000 + STACK_INSET.x && q.stack === "stack";
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
		expect(centre).toBeCloseTo(STACK_SIZE.w / 2);
		const [first, second, third] = [...layout.slots.values()];
		expect(second?.y).toBe(first?.y);
		expect(third?.x).toBe(first?.x);
		expect(nearestSlot(layout, { x: (third?.x ?? 0) + 80, y: (third?.y ?? 0) + 80 })).toBe(2);
	});
});

describe("grouping a selection", () => {
	it("plans stacks where their first sticky is, clear of each other, and makes them as suggestions", () => {
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
		expect(plan.map((stack) => stack.name)).toEqual(["Hard-to-find docs", "Unreliable CI"]);
		expect(plan[1]?.ids).toEqual(["c", "d"]);
		const [first, second] = plan;
		const overlap =
			first &&
			second &&
			Math.abs(first.at.x - second.at.x) < STACK_SIZE.w &&
			Math.abs(first.at.y - second.at.y) < STACK_SIZE.h;
		expect(overlap).toBe(false);
		let n = 0;
		const made = applyGrouping(doc, plan, undefined, () => `g${++n}`);
		expect(made).toEqual(["g1", "g2"]);
		expect(members("g1")).toEqual(["a", "b"]);
		expect(nameState(get("g1"))).toBe("suggested");
		expect(stackName(get("g2"))).toBe("Unreliable CI");
		expect(get("e")?.stack ?? null).toBeNull();
	});
});

describe("stacks in exports, templates and thumbnails", () => {
	function stacked() {
		const { doc, sticky, newId } = board();
		sticky("a", 0, 0, "One");
		sticky("b", 0, 0, "Two");
		sticky("solo", 400, 0, "Three");
		stackUp(doc, "a", ["b"], undefined, newId);
		setStackName(doc, "stack-1", "Numbers");
		return doc;
	}

	it("exports and imports a stack with its stickies, ids remapped", () => {
		const { data } = exportBoard(stacked(), { title: "Board" });
		const read = readBoardExport(JSON.parse(JSON.stringify(data)));
		expect(read.ok).toBe(true);
		const target = new Y.Doc();
		let n = 0;
		importBoard(target, data, { by: { name: "Me" }, newId: () => `new-${++n}` });
		const shapes = readShapes(target);
		const stack = [...shapes].find(([, shape]) => shape.type === "stack")?.[0] as string;
		expect(shapes.get(stack)?.title).toBe("Numbers");
		expect(membersOf(shapes, stack)).toHaveLength(2);
		expect(
			stackOf(shapes, [...shapes.keys()].find((id) => shapes.get(id)?.text === "Three") ?? ""),
		).toBeNull();
	});

	it("saves a stack in a template with its content, and makes it again", () => {
		const { content } = extractTemplate(stacked(), { keepContent: true });
		const target = new Y.Doc();
		let n = 0;
		instantiateTemplate(target, content, { by: { name: "Me" }, newId: () => `t-${++n}` });
		const shapes = readShapes(target);
		const stack = [...shapes].find(([, shape]) => shape.type === "stack")?.[0] as string;
		expect(membersOf(shapes, stack)).toHaveLength(2);
	});

	it("sketches a stack as one stack in its top sticky's colour", () => {
		const doc = stacked();
		shapesMap(doc).get("b")?.set("color", "pink");
		const thumbnail = boardThumbnail(doc);
		const kinds = thumbnail?.shapes.map((shape) => shape[0]).sort();
		expect(kinds).toEqual(["stack", "sticky"]);
		expect(thumbnail?.shapes.find((shape) => shape[0] === "stack")?.[5]).toBe("pink");
	});
});
