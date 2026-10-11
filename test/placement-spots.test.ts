import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { type Rect, intersects } from "../src/shared/geometry.ts";
import { sectionSpot, slideClear } from "../src/shared/placement.ts";
import { SECTION_DEFAULT, boxOf } from "../src/shared/sections.ts";
import { addShape, nextZ } from "../src/shared/shapes.ts";
import { addSection, readShapes } from "../src/shared/structure.ts";

// Finding space for shapes people place: a section placed with a click
// starts empty, where there's room, never taking shapes from other sections
// (canvas review 19), and a tidied selection slides clear of shapes that
// weren't selected (28).

function nowNextLater() {
	const doc = new Y.Doc();
	const now = addSection(doc, { x: 0, y: 0, w: 320, h: 600 }, { title: "Now" });
	const next = addSection(doc, { x: 360, y: 0, w: 320, h: 600 }, { title: "Next" });
	addShape(doc, "s1", {
		type: "sticky",
		text: "In next",
		x: 400,
		y: 300,
		z: nextZ(doc),
		parent: next,
	});
	addSection(doc, { x: 720, y: 0, w: 320, h: 600 }, { title: "Later" });
	return { doc, now, next };
}

function overlapsAnything(doc: Y.Doc, rect: Rect, except?: string) {
	for (const [id, shape] of readShapes(doc)) {
		if (id === except || shape.type === "connector") continue;
		if (intersects(rect, boxOf(id, shape))) return id;
	}
	return null;
}

describe("sectionSpot", () => {
	it("centres a full-size section on the click when there's room", () => {
		const doc = new Y.Doc();
		expect(sectionSpot(readShapes(doc), { x: 100, y: 100 }, SECTION_DEFAULT)).toEqual({
			x: 100 - SECTION_DEFAULT.w / 2,
			y: 100 - SECTION_DEFAULT.h / 2,
			...SECTION_DEFAULT,
		});
	});

	it("never lands across other sections, and so never takes their shapes", () => {
		const { doc, next } = nowNextLater();
		// Low in the columns, where the review's click landed.
		const rect = sectionSpot(readShapes(doc), { x: 520, y: 640 }, SECTION_DEFAULT);
		expect(overlapsAnything(doc, rect)).toBeNull();
		const id = addSection(doc, rect, {});
		const shapes = readShapes(doc);
		expect(shapes.get("s1")?.parent).toBe(next);
		expect([...shapes.values()].filter((shape) => shape.parent === id)).toHaveLength(0);
	});

	it("shrinks to fit a gap rather than going far away", () => {
		const doc = new Y.Doc();
		addSection(doc, { x: -1000, y: -1000, w: 600, h: 2400 }, { title: "Left" });
		addSection(doc, { x: 200, y: -1000, w: 600, h: 2400 }, { title: "Right" });
		// A 600px gap between them, not wide enough for the default.
		const rect = sectionSpot(readShapes(doc), { x: -100, y: 0 }, SECTION_DEFAULT);
		expect(rect.w).toBeLessThan(SECTION_DEFAULT.w);
		expect(rect.x + rect.w / 2).toBe(-100);
		expect(overlapsAnything(doc, rect)).toBeNull();
	});

	it("finds the nearest free space when there's no gap to shrink into", () => {
		const doc = new Y.Doc();
		for (let i = 0; i < 6; i++) {
			addShape(doc, `s${i}`, {
				type: "sticky",
				text: "",
				x: i * 200,
				y: 0,
				z: nextZ(doc),
				parent: null,
			});
		}
		const rect = sectionSpot(readShapes(doc), { x: 500, y: 80 }, SECTION_DEFAULT);
		expect(rect).toMatchObject(SECTION_DEFAULT);
		expect(overlapsAnything(doc, rect)).toBeNull();
	});

	it("goes inside a section with room for it", () => {
		const doc = new Y.Doc();
		const outer = addSection(doc, { x: 0, y: 0, w: 1600, h: 1200 }, { title: "Big" });
		const rect = sectionSpot(readShapes(doc), { x: 800, y: 600 }, SECTION_DEFAULT);
		expect(rect).toMatchObject({ ...SECTION_DEFAULT, x: 480, y: 380 });
		const id = addSection(doc, rect, {});
		expect(readShapes(doc).get(id)?.parent).toBe(outer);
	});
});

describe("slideClear", () => {
	const sticky = (doc: Y.Doc, id: string, x: number, y: number, parent: string | null = null) =>
		addShape(doc, id, { type: "sticky", text: id, x, y, z: nextZ(doc), parent });

	it("leaves a layout that's clear where it is", () => {
		const doc = new Y.Doc();
		sticky(doc, "a", 0, 0);
		sticky(doc, "b", 1000, 0);
		expect(slideClear(readShapes(doc), new Set(["a"]), { x: 0, y: 0, w: 400, h: 176 })).toBeNull();
	});

	it("slides a layout that lands on an unselected shape to clear space nearby", () => {
		const doc = new Y.Doc();
		sticky(doc, "a", 0, 0);
		sticky(doc, "b", 0, 200);
		sticky(doc, "card", 220, 20);
		const box = { x: 0, y: 0, w: 600, h: 376 };
		const spot = slideClear(readShapes(doc), new Set(["a", "b"]), box)!;
		expect(spot).not.toBeNull();
		const moved = { ...box, ...spot };
		expect(intersects(moved, boxOf("card", readShapes(doc).get("card")!))).toBe(false);
		expect(Math.hypot(spot.x, spot.y)).toBeLessThan(1200);
	});

	it("doesn't count what's inside the shapes being laid out", () => {
		const doc = new Y.Doc();
		const section = addSection(doc, { x: 0, y: 0, w: 400, h: 400 }, { title: "Moving" });
		sticky(doc, "inside", 40, 40, section);
		expect(
			slideClear(readShapes(doc), new Set([section]), { x: 0, y: 0, w: 400, h: 400 }),
		).toBeNull();
	});
});
