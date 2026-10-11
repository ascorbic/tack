// Cards people add with the card tool or by pasting links: free space, rows
// of four from where the run started, and no silent duplicates.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { readCardInput } from "../src/client/cardInput.ts";
import { addCardsInRun, cardsOnBoard, searchScopeOf } from "../src/shared/addCards.ts";
import { inboxQuery, setInbox } from "../src/shared/inbox.ts";
import { intersects } from "../src/shared/geometry.ts";
import { boxOf } from "../src/shared/sections.ts";
import { addShape, type ShapeProps } from "../src/shared/shapes.ts";
import { readShapes } from "../src/shared/structure.ts";

const key = (n: number) => `github.com/acme/app#${n}`;

function board(shapes: Record<string, ShapeProps> = {}) {
	const doc = new Y.Doc();
	for (const [id, props] of Object.entries(shapes)) addShape(doc, id, props);
	return doc;
}

function overlaps(doc: Y.Doc): [string, string][] {
	const shapes = [...readShapes(doc)].filter(([, shape]) => shape.type !== "section");
	const out: [string, string][] = [];
	for (const [i, [a, shapeA]] of shapes.entries()) {
		for (const [b, shapeB] of shapes.slice(i + 1)) {
			if (intersects(boxOf(a, shapeA), boxOf(b, shapeB))) out.push([a, b]);
		}
	}
	return out;
}

describe("where the card tool searches", () => {
	it("is the board's repositories, those with most cards first, then its inboxes'", () => {
		const doc = board({
			a: { type: "card", ref: "github.com/acme/docs#1", x: 0, y: 0, z: "a0" },
			b: { type: "card", ref: "github.com/acme/app#1", x: 0, y: 0, z: "a1" },
			c: { type: "card", ref: "github.com/acme/app#2", x: 0, y: 0, z: "a2" },
			d: { type: "card", ref: "fake.tack/x/y#2", x: 0, y: 0, z: "a3" },
			inbox: { type: "section", x: 0, y: 0, w: 10, h: 10, z: "a4", title: "New" },
		});
		setInbox(doc, "inbox", inboxQuery("repo:acme/site is:open"));
		expect(searchScopeOf(doc)).toEqual({
			host: "github.com",
			repos: ["acme/app", "acme/docs", "acme/site"],
		});
		// A board just made from a template has an inbox before it has cards.
		const fresh = board({
			inbox: { type: "section", x: 0, y: 0, w: 10, h: 10, z: "a0", title: "New" },
		});
		setInbox(fresh, "inbox", inboxQuery("repo:emdash-cms/emdash is:open"));
		expect(searchScopeOf(fresh)).toEqual({ host: "github.com", repos: ["emdash-cms/emdash"] });
		expect(searchScopeOf(board())).toEqual({ host: "github.com", repos: [] });
	});
});

describe("reading the card tool's input", () => {
	const scope = { host: "github.com", repos: ["emdash-cms/emdash", "emdash-cms/docs"] };

	it("takes links, references and bare numbers in the busiest repository", () => {
		expect(readCardInput("https://github.com/emdash-cms/emdash/issues/412", scope)).toEqual({
			kind: "ref",
			key: "github.com/emdash-cms/emdash#412",
		});
		expect(readCardInput("ascorbic/cirrus#9", scope)).toEqual({
			kind: "ref",
			key: "github.com/ascorbic/cirrus#9",
		});
		expect(readCardInput("#412", scope)).toEqual({
			kind: "ref",
			key: "github.com/emdash-cms/emdash#412",
		});
		expect(readCardInput(" 413 ", scope)).toMatchObject({
			key: "github.com/emdash-cms/emdash#413",
		});
	});

	it("searches the board's repositories for words, or one repository named first", () => {
		expect(readCardInput("migration guide", scope)).toEqual({
			kind: "search",
			host: "github.com",
			q: "repo:emdash-cms/emdash repo:emdash-cms/docs migration guide",
			where: "2 repositories on this board",
		});
		expect(readCardInput("ascorbic/cirrus blob storage", scope)).toEqual({
			kind: "search",
			host: "github.com",
			q: "repo:ascorbic/cirrus blob storage",
			where: "ascorbic/cirrus",
		});
	});

	it("explains what it can't use", () => {
		expect(readCardInput("", scope)).toEqual({ kind: "empty" });
		expect(readCardInput("https://example.com/a/b/issues/1", scope)).toMatchObject({
			kind: "invalid",
		});
		// Words with nowhere to search: say how to add one.
		expect(readCardInput("migration", { host: "github.com", repos: [] })).toMatchObject({
			kind: "invalid",
			message: expect.stringContaining("owner/repo"),
		});
		expect(readCardInput("#3", { host: "github.com", repos: [] })).toMatchObject({
			kind: "invalid",
		});
	});
});

describe("addCardsInRun", () => {
	it("lays a run out in rows of four from its origin, none on another", () => {
		const doc = board();
		let run = { origin: { x: 0, y: 0 }, count: 0 };
		for (let n = 1; n <= 3; n++) run = addCardsInRun(doc, [key(n)], run).run;
		const more = addCardsInRun(doc, [key(4), key(5), key(6)], run);
		expect(more.run.count).toBe(6);
		const shapes = readShapes(doc);
		const positions = [...shapes.values()].map((shape) => [shape.x, shape.y]);
		expect(new Set(positions.map(([, y]) => y)).size).toBe(2);
		expect(positions[0]).toEqual([0, 0]);
		// The fifth starts the second row, under the first.
		expect(positions[4]?.[0]).toBe(0);
		expect(overlaps(doc)).toEqual([]);
		expect([...shapes.values()].every((shape) => shape.provenance === undefined)).toBe(true);
	});

	it("slides clear of what's already where it would go", () => {
		const doc = board({
			note: { type: "sticky", x: 10, y: 10, z: "a0", text: "In the way" },
			other: { type: "card", ref: key(99), x: 300, y: 0, z: "a1" },
		});
		addCardsInRun(doc, [key(1), key(2)], { origin: { x: 0, y: 0 }, count: 0 });
		expect(overlaps(doc)).toEqual([]);
	});

	it("doesn't add a second card for an item on the board, unless asked for a copy", () => {
		const doc = board({ there: { type: "card", ref: key(3), x: 0, y: 0, z: "a0" } });
		const run = { origin: { x: 600, y: 0 }, count: 0 };
		const first = addCardsInRun(doc, [key(3), "GitHub.com/Acme/App#4", key(4)], run);
		expect(first.existing).toEqual([{ key: key(3), id: "there" }]);
		expect(first.added.map((entry) => entry.key)).toEqual([key(4)]);
		expect(cardsOnBoard(doc).size).toBe(2);

		const copy = addCardsInRun(doc, [key(3)], first.run, { copies: true });
		expect(copy.added).toHaveLength(1);
		expect(copy.existing).toEqual([]);
		expect([...readShapes(doc).values()].filter((shape) => shape.ref === key(3))).toHaveLength(2);
		expect(overlaps(doc)).toEqual([]);
	});

	it("joins a section it lands wholly inside", () => {
		const doc = board({
			now: { type: "section", x: -40, y: -40, w: 800, h: 600, z: "a0", title: "Now" },
		});
		const { added } = addCardsInRun(doc, [key(1)], { origin: { x: 0, y: 0 }, count: 0 });
		expect(readShapes(doc).get(added[0]!.id)?.parent).toBe("now");
	});
});
