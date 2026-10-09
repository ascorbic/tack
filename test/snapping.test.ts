import { describe, expect, it } from "vite-plus/test";
import { align, distribute, type Item, tidy } from "../src/client/arrange.ts";
import { intersects, snapRect, unionRect } from "../src/client/snapping.ts";

const box = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });
const item = (id: string, x: number, y: number, width = 100, height = 100): Item => ({
	id,
	...box(x, y, width, height),
});

describe("snapRect", () => {
	it("snaps a left edge to a nearby left edge", () => {
		const snap = snapRect(box(203, 400), [box(200, 0)], 6);
		expect(snap.dx).toBe(-3);
		expect(snap.dy).toBe(0);
		expect(snap.guides).toContainEqual({ axis: "x", at: 200, from: 0, to: 500 });
	});

	it("snaps edges to opposite edges, and centres to centres", () => {
		// Moving box's left meets the target's right.
		expect(snapRect(box(304, 0), [box(200, 200)], 6).dx).toBe(-4);
		// Centres line up: target centre 250, moving centre 50 + 196 = 246.
		const centred = snapRect(box(196, 300, 100, 40), [box(200, 0)], 6);
		expect(centred.dx).toBe(4);
		expect(centred.guides.some((g) => g.axis === "x" && g.at === 250)).toBe(true);
	});

	it("snaps each axis independently", () => {
		const snap = snapRect(box(102, 205), [box(100, 0), box(400, 200)], 6);
		expect(snap).toMatchObject({ dx: -2, dy: -5 });
		// Same-sized boxes: every edge and centre lines up on both axes.
		expect(snap.guides.map((g) => g.axis).sort()).toEqual(["x", "x", "x", "y", "y", "y"]);
	});

	it("picks the nearest line", () => {
		expect(snapRect(box(105, 0), [box(100, 300), box(108, 600)], 6).dx).toBe(3);
	});

	it("leaves the box alone beyond the threshold", () => {
		expect(snapRect(box(110, 210), [box(100, 0)], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
		expect(snapRect(box(110, 210), [], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
	});

	it("draws one guide per line, spanning everything aligned on it", () => {
		const snap = snapRect(box(0, 500), [box(0, 0), box(0, 200, 50, 50)], 6);
		const left = snap.guides.filter((g) => g.axis === "x" && g.at === 0);
		expect(left).toEqual([{ axis: "x", at: 0, from: 0, to: 600 }]);
	});
});

describe("rects", () => {
	it("unions and intersects", () => {
		expect(unionRect([box(0, 0), box(50, 200, 10, 10)])).toEqual(box(0, 0, 100, 210));
		expect(unionRect([])).toBeNull();
		expect(intersects(box(0, 0), box(99, 99))).toBe(true);
		expect(intersects(box(0, 0), box(100, 0))).toBe(false);
	});
});

describe("align", () => {
	const items = [item("a", 10, 0, 100, 50), item("b", 40, 100, 200, 80), item("c", 0, 300, 50, 50)];

	it("aligns edges and centres to the selection's bounds", () => {
		expect(Object.fromEntries(align(items, "left"))).toEqual({
			a: { x: 0, y: 0 },
			b: { x: 0, y: 100 },
		});
		expect(Object.fromEntries(align(items, "right"))).toEqual({
			a: { x: 140, y: 0 },
			c: { x: 190, y: 300 },
		});
		expect(align(items, "center").get("c")).toEqual({ x: 95, y: 300 });
		expect(align(items, "top").get("c")).toEqual({ x: 0, y: 0 });
		expect(align(items, "bottom").get("a")).toEqual({ x: 10, y: 300 });
		expect(align(items, "middle").get("b")).toEqual({ x: 40, y: 135 });
	});

	it("needs at least two shapes", () => {
		expect(align([item("a", 5, 5)], "left").size).toBe(0);
	});
});

describe("distribute", () => {
	it("makes the gaps equal and keeps the outermost shapes in place", () => {
		const items = [item("a", 0, 0, 100), item("c", 500, 0, 100), item("b", 120, 0, 60)];
		const out = distribute(items, "horizontal");
		// Span 0–600, shapes total 260, so two gaps of 170.
		expect(Object.fromEntries(out)).toEqual({ b: { x: 270, y: 0 } });
	});

	it("works vertically", () => {
		const items = [item("a", 0, 0, 50, 50), item("b", 0, 60, 50, 50), item("c", 0, 410, 50, 50)];
		expect(distribute(items, "vertical").get("b")).toEqual({ x: 0, y: 205 });
	});

	it("needs at least three shapes", () => {
		expect(distribute([item("a", 0, 0), item("b", 300, 0)], "horizontal").size).toBe(0);
	});
});

describe("tidy", () => {
	it("turns rough rows into a grid with even gaps", () => {
		const items = [
			item("a", 5, 3),
			item("b", 160, -8),
			item("c", 330, 10),
			item("d", -4, 170),
			item("e", 150, 190),
		];
		const out = tidy(items, 20);
		const at = (id: string) => out.get(id) ?? items.find((i) => i.id === id);
		expect(at("a")).toMatchObject({ x: -4, y: -8 });
		expect(at("b")).toMatchObject({ x: 116, y: -8 });
		expect(at("c")).toMatchObject({ x: 236, y: -8 });
		expect(at("d")).toMatchObject({ x: -4, y: 112 });
		expect(at("e")).toMatchObject({ x: 116, y: 112 });
	});

	it("keeps reading order within a row", () => {
		const out = tidy([item("right", 400, 0), item("left", 0, 20)], 10);
		expect(out.get("right")).toEqual({ x: 110, y: 0 });
	});

	it("leaves a tidy selection alone", () => {
		expect(tidy([item("a", 0, 0), item("b", 132, 0)]).size).toBe(0);
	});
});
