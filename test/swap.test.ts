import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { ShapeProps } from "../src/shared/shapes.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { makeRoomForCards, planRoomForCards } from "../src/shared/swap.ts";

// Making room for cards before stickies turn into them: rows spread just
// enough for every card to fit, and nothing else moves.

const sticky = (x: number, y: number, parent: string | null = null): ShapeProps => ({
	type: "sticky",
	text: "An idea",
	x,
	y,
	z: "a0",
	parent,
});

function shapes(entries: Record<string, ShapeProps>): Map<string, ShapeProps> {
	return new Map(Object.entries(entries));
}

describe("making room for cards", () => {
	it("spreads a row of stickies so their cards don't overlap", () => {
		const board = shapes({
			a: sticky(0, 0),
			b: sticky(200, 10),
			c: sticky(400, 0),
			d: sticky(600, 5),
		});
		const plan = planRoomForCards(board, ["a", "b", "c", "d"]);
		// Cards are 252 wide, with a 24 px gap: the first stays put.
		expect(plan.moves.get("a")).toBeUndefined();
		expect(plan.moves.get("b")).toEqual({ x: 276, y: 10 });
		expect(plan.moves.get("c")).toEqual({ x: 552, y: 0 });
		expect(plan.moves.get("d")).toEqual({ x: 828, y: 5 });
	});

	it("leaves a sticky with room beside it, and other rows, where they are", () => {
		const board = shapes({ a: sticky(0, 0), far: sticky(600, 0), below: sticky(0, 260) });
		expect(planRoomForCards(board, ["a"]).moves.size).toBe(0);
	});

	it("slides what's beside a card along, and only as far as it needs", () => {
		const board = shapes({
			a: sticky(0, 0),
			card: { type: "card", ref: "github.com/acme/app#1", x: 220, y: 20, z: "a1" },
			next: sticky(800, 0),
		});
		const plan = planRoomForCards(board, ["a"]);
		expect(plan.moves.get("card")).toEqual({ x: 276, y: 20 });
		// 276 + 252 + 24 is clear of 800 already.
		expect(plan.moves.has("next")).toBe(false);
	});

	it("keeps shapes people overlapped on purpose overlapped", () => {
		const board = shapes({ a: sticky(0, 0), x: sticky(600, 0), y: sticky(650, 0) });
		expect(planRoomForCards(board, ["a"]).moves.size).toBe(0);
	});

	it("grows a section to keep its stickies' cards inside it", () => {
		const board = shapes({
			sec: { type: "section", title: "Ideas", x: 0, y: 0, w: 640, h: 300, z: "a0" },
			a: sticky(24, 40, "sec"),
			b: sticky(224, 40, "sec"),
			c: sticky(424, 40, "sec"),
		});
		const plan = planRoomForCards(board, ["a", "b", "c"]);
		expect(plan.moves.get("c")).toEqual({ x: 576, y: 40 });
		expect(plan.sections.get("sec")).toEqual({ x: 0, y: 0, w: 576 + 252 + 24, h: 300 });
	});

	it("leaves sections showing a list alone", () => {
		const board = shapes({
			sec: {
				type: "section",
				title: "Ideas",
				x: 0,
				y: 0,
				w: 640,
				h: 300,
				z: "a0",
				display: "list",
			},
			a: sticky(24, 40, "sec"),
			b: sticky(224, 40, "sec"),
		});
		const plan = planRoomForCards(board, ["a", "b"]);
		expect(plan.moves.size).toBe(0);
		expect(plan.sections.size).toBe(0);
	});

	it("writes the moves with their section, in one transaction", () => {
		const doc = new Y.Doc();
		doc.transact(() => {
			addShape(doc, "a", sticky(0, 0));
			addShape(doc, "b", sticky(200, 0));
		});
		let transactions = 0;
		doc.on("afterTransaction", () => transactions++);
		expect(doc.transact(() => makeRoomForCards(doc, ["a", "b"]), "push")).toBe(1);
		expect(transactions).toBe(1);
		const b = shapesMap(doc).get("b");
		expect([b?.get("x"), b?.get("y"), b?.get("parent")]).toEqual([276, 0, null]);
	});
});
