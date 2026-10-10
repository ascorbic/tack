// Placing a parent issue's card above the section (or shapes) it was made from.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { intersects } from "../src/shared/geometry.ts";
import { placeCard } from "../src/shared/place.ts";
import { NOMINAL_SIZE, boxOf } from "../src/shared/sections.ts";
import { addShape, readShape, shapesMap, type ShapeProps } from "../src/shared/shapes.ts";

const KEY = "github.com/acme/app#7";

function board(shapes: Record<string, ShapeProps>) {
	const doc = new Y.Doc();
	for (const [id, props] of Object.entries(shapes)) addShape(doc, id, props);
	return doc;
}

const section: ShapeProps = {
	type: "section",
	x: 0,
	y: 0,
	z: "a0",
	w: 800,
	h: 400,
	title: "Resizing",
};

function read(doc: Y.Doc) {
	return new Map([...shapesMap(doc)].map(([id, shape]) => [id, readShape(shape)]));
}

describe("placeCard", () => {
	it("puts the card above the section's middle, connected to its top", () => {
		const doc = board({ section });
		const placed = placeCard(doc, KEY, ["section"]);
		expect(placed).toMatchObject({ added: true, connectors: [expect.any(String)] });
		const shapes = read(doc);
		const card = shapes.get(placed!.card)!;
		expect(card).toMatchObject({ type: "card", ref: KEY });
		expect(card.provenance).toBeUndefined();
		expect(card.parent ?? null).toBeNull();
		// Centred over the section, clear of it.
		const box = boxOf(placed!.card, card);
		expect(box.x + box.w / 2).toBe(400);
		expect(box.y + box.h).toBeLessThan(0);
		expect(shapes.get(placed!.connectors[0]!)).toMatchObject({
			type: "connector",
			route: "elbow",
			from: { shape: placed!.card, anchor: { x: 0.5, y: 1 } },
			to: { shape: "section", anchor: { x: 0.5, y: 0 } },
		});
	});

	it("slides clear of shapes in the way", () => {
		const doc = board({
			section,
			above: { type: "sticky", x: 300, y: -260, z: "a1", text: "In the way" },
		});
		const placed = placeCard(doc, KEY, ["section"]);
		const shapes = read(doc);
		const box = boxOf(placed!.card, shapes.get(placed!.card)!);
		const sticky = boxOf("above", shapes.get("above")!);
		expect(intersects(box, sticky)).toBe(false);
		expect(intersects(box, { x: 0, y: 0, w: 800, h: 400 })).toBe(false);
	});

	it("keeps clear of other sections' titles", () => {
		const doc = board({
			section,
			// A thin section just above, whose title pill reaches up to where the card would go.
			strip: { type: "section", x: 250, y: -60, z: "a1", w: 300, h: 40, title: "Strip" },
		});
		const placed = placeCard(doc, KEY, ["section"]);
		const box = boxOf(placed!.card, read(doc).get(placed!.card)!);
		expect(intersects(box, { x: 250, y: -96, w: 260, h: 36 })).toBe(false);
		expect(intersects(box, { x: 250, y: -60, w: 300, h: 40 })).toBe(false);
	});

	it("joins a section the section is in", () => {
		const doc = board({
			outer: { type: "section", x: -200, y: -600, z: "a0", w: 1200, h: 1200, title: "Q4" },
			section: { ...section, parent: "outer", z: "a1" },
		});
		const placed = placeCard(doc, KEY, ["section"]);
		expect(read(doc).get(placed!.card)?.parent).toBe("outer");
	});

	it("connects each of a cluster's shapes", () => {
		const doc = board({
			a: { type: "sticky", x: 0, y: 0, z: "a0", text: "One" },
			b: { type: "sticky", x: 400, y: 0, z: "a1", text: "Two" },
		});
		const placed = placeCard(doc, KEY, ["a", "b", "gone"]);
		const shapes = read(doc);
		const ends = placed!.connectors.map((id) => shapes.get(id)?.to?.shape);
		expect(ends).toEqual(["a", "b"]);
		const box = boxOf(placed!.card, shapes.get(placed!.card)!);
		const sticky = NOMINAL_SIZE.sticky!;
		expect(box.x + box.w / 2).toBe((400 + sticky.w) / 2);
	});

	it("connects a card already on the board instead of adding another", () => {
		const doc = board({
			section,
			existing: { type: "card", ref: KEY, x: 1000, y: 0, z: "a1" },
		});
		const placed = placeCard(doc, KEY, ["section"]);
		expect(placed).toMatchObject({ card: "existing", added: false });
		expect(placed!.connectors).toHaveLength(1);
		// Again: already connected, so nothing more.
		expect(placeCard(doc, KEY, ["section"])?.connectors).toEqual([]);
		expect([...read(doc).values()].filter((s) => s.type === "card")).toHaveLength(1);
	});

	it("does nothing once the shapes are gone", () => {
		const doc = board({});
		expect(placeCard(doc, KEY, ["section"])).toBeNull();
		expect(shapesMap(doc).size).toBe(0);
	});
});
