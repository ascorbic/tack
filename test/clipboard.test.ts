import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	type ClipboardPayload,
	copyShapes,
	fromHtml,
	interpretText,
	MAX_PASTED_TEXT,
	parsePayload,
	pasteShapes,
	payloadBounds,
	toHtml,
	toPlainText,
} from "../src/client/clipboard.ts";
import { addDecision, castVote } from "../src/shared/decisions.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addWidget } from "../src/shared/widgetRegistry.ts";

function board() {
	const doc = new Y.Doc();
	addShape(doc, "card", {
		type: "card",
		ref: "github.com/ascorbic/unpic#100",
		x: 0,
		y: 0,
		z: "a1",
	});
	addShape(doc, "note", {
		type: "sticky",
		text: 'Ship it <now> & "later"',
		color: "pink",
		author: { name: "Priya", color: "#b4467a" },
		x: 300,
		y: 40,
		z: "a0",
	});
	return doc;
}

const roundTrip = (payload: ClipboardPayload) => parsePayload(JSON.stringify(payload));

describe("copyShapes", () => {
	it("copies every property, bottom to top", () => {
		const payload = copyShapes(board(), ["card", "note"], { board: "demo" });
		expect(payload.board).toBe("demo");
		expect(payload.shapes.map((s) => s.id)).toEqual(["note", "card"]);
		expect(payload.shapes[0]?.props).toMatchObject({
			type: "sticky",
			color: "pink",
			author: { name: "Priya", color: "#b4467a" },
		});
	});

	it("includes measured sizes, and skips shapes that don't exist", () => {
		const payload = copyShapes(board(), ["note", "gone"], {
			sizes: (id) => (id === "note" ? { width: 176, height: 176 } : undefined),
		});
		expect(payload.shapes).toHaveLength(1);
		expect(payload.shapes[0]).toMatchObject({ width: 176, height: 176 });
	});

	it("carries properties of shape types it doesn't know about", () => {
		const doc = new Y.Doc();
		addShape(doc, "f", { type: "frame" as never, x: 0, y: 0, z: "a0" });
		shapesMap(doc).get("f")?.set("title", "Sprint 12");
		shapesMap(doc).get("f")?.set("w", 640);
		const [shape] = copyShapes(doc, ["f"]).shapes;
		expect(shape?.props).toMatchObject({ type: "frame", title: "Sprint 12", w: 640 });
	});
});

describe("pasteShapes", () => {
	it("adds copies with new ids, offset, on top and in the same order", () => {
		const doc = board();
		const payload = roundTrip(copyShapes(doc, ["card", "note"]));
		expect(payload).not.toBeNull();
		const ids = pasteShapes(doc, payload as ClipboardPayload, { x: 24, y: 24 });
		expect(ids).toHaveLength(2);
		expect(ids).not.toContain("card");
		expect(ids).not.toContain("note");
		const [note, card] = ids.map((id) => readShape(shapesMap(doc).get(id) as Y.Map<unknown>));
		expect(note).toMatchObject({ type: "sticky", x: 324, y: 64, text: 'Ship it <now> & "later"' });
		expect(card).toMatchObject({ type: "card", x: 24, y: 24 });
		// Above everything that was there, keeping their relative order.
		expect(note?.z && note.z > "a1").toBe(true);
		expect(card?.z && note?.z && card.z > note.z).toBe(true);
	});

	it("pastes into another board", () => {
		const payload = roundTrip(copyShapes(board(), ["note"])) as ClipboardPayload;
		const other = new Y.Doc();
		const [id] = pasteShapes(other, payload, { x: 0, y: 0 });
		expect(readShape(shapesMap(other).get(id ?? "") as Y.Map<unknown>).text).toBe(
			'Ship it <now> & "later"',
		);
	});

	it("points references between copied shapes at the new copies", () => {
		const doc = board();
		addShape(doc, "arrow", { type: "connector" as never, x: 0, y: 0, z: "a2" });
		shapesMap(doc).get("arrow")?.set("from", { shape: "card", side: "right" });
		shapesMap(doc).get("arrow")?.set("to", { shape: "elsewhere" });
		const payload = roundTrip(copyShapes(doc, ["card", "arrow"])) as ClipboardPayload;
		const ids = pasteShapes(doc, payload, { x: 10, y: 10 });
		const arrow = shapesMap(doc).get(ids[1] ?? "");
		expect(arrow?.get("from")).toEqual({ shape: ids[0], side: "right" });
		// References to shapes that weren't copied are left alone.
		expect(arrow?.get("to")).toEqual({ shape: "elsewhere" });
	});

	it("leaves silent mode with the original", () => {
		const doc = new Y.Doc();
		addShape(doc, "s", { type: "section", x: 0, y: 0, w: 400, h: 300, z: "a0" });
		addShape(doc, "hidden", { type: "sticky", x: 10, y: 10, z: "a1", parent: "s", silent: "x" });
		shapesMap(doc)
			.get("s")
			?.set("silent", { id: "x", by: { name: "P", color: "" }, at: "" });
		const payload = roundTrip(copyShapes(doc, ["s", "hidden"])) as ClipboardPayload;
		const ids = pasteShapes(doc, payload, { x: 600, y: 0 });
		for (const id of ids)
			expect(
				shapesMap(doc)
					.get(id ?? "")
					?.has("silent"),
			).toBe(false);
	});

	it("round-trips nested Yjs types", () => {
		const doc = new Y.Doc();
		addShape(doc, "t", { type: "text" as never, x: 0, y: 0, z: "a0" });
		doc.transact(() => {
			const shape = shapesMap(doc).get("t");
			shape?.set("body", new Y.Text("rich words"));
			const items = new Y.Array<unknown>();
			items.push(["one", "two"]);
			shape?.set("items", items);
		});
		const payload = roundTrip(copyShapes(doc, ["t"])) as ClipboardPayload;
		const [id] = pasteShapes(doc, payload, { x: 0, y: 0 });
		const copy = shapesMap(doc).get(id ?? "") as Y.Map<unknown>;
		expect(copy.get("body")).toBeInstanceOf(Y.Text);
		expect(String((copy.get("body") as Y.Text).toJSON())).toBe("rich words");
		expect((copy.get("items") as Y.Array<unknown>).toArray()).toEqual(["one", "two"]);
	});
});

describe("clipboard encodings", () => {
	it("rejects anything that isn't a payload", () => {
		expect(parsePayload("")).toBeNull();
		expect(parsePayload("not json")).toBeNull();
		expect(parsePayload(JSON.stringify({ tack: 2, shapes: [] }))).toBeNull();
		expect(parsePayload(JSON.stringify({ tack: 1, shapes: [] }))).toBeNull();
		expect(
			parsePayload(
				JSON.stringify({ tack: 1, shapes: [{ id: "a", props: { type: "sticky", x: "1", y: 0 } }] }),
			),
		).toBeNull();
	});

	it("survives a trip through HTML, including non-ASCII text", () => {
		const doc = new Y.Doc();
		addShape(doc, "s", { type: "sticky", text: "naïve café ☕ 日本", x: 1, y: 2, z: "a0" });
		const payload = copyShapes(doc, ["s"], { board: "demo" });
		const html = toHtml(payload, toPlainText(payload));
		// Rich-text editors wrap what they're given; the payload still comes out.
		const wrapped = `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`;
		expect(fromHtml(wrapped)).toEqual(payload);
		expect(html).toContain("naïve café");
		expect(fromHtml("<p>just some html</p>")).toBeNull();
	});

	it("escapes text in the readable HTML", () => {
		const payload = copyShapes(board(), ["note"]);
		expect(toHtml(payload, toPlainText(payload))).toContain(
			"Ship it &lt;now&gt; &amp; &quot;later&quot;",
		);
	});

	it("writes plain text with sticky text and card links", () => {
		const payload = copyShapes(board(), ["card", "note"]);
		expect(toPlainText(payload, () => "https://github.com/ascorbic/unpic/issues/100")).toBe(
			'Ship it <now> & "later"\n\nhttps://github.com/ascorbic/unpic/issues/100',
		);
		expect(toPlainText(payload)).toContain("github.com/ascorbic/unpic#100");
	});

	it("measures the copied shapes' bounds", () => {
		const payload = copyShapes(board(), ["card", "note"], {
			sizes: (id) => (id === "card" ? { width: 252, height: 120 } : { width: 176, height: 176 }),
		});
		expect(payloadBounds(payload)).toEqual({ x: 0, y: 0, width: 476, height: 216 });
	});
});

describe("interpretText", () => {
	it("turns issue and PR links into cards", () => {
		expect(interpretText("https://github.com/ascorbic/unpic/pull/42")).toEqual({
			kind: "cards",
			keys: ["github.com/ascorbic/unpic#42"],
			links: [],
		});
		expect(interpretText("ascorbic/unpic#1\n\n  ascorbic/unpic#2 \nascorbic/unpic#1")).toEqual({
			kind: "cards",
			keys: ["github.com/ascorbic/unpic#1", "github.com/ascorbic/unpic#2"],
			links: [],
		});
	});

	it("turns a bare web address that isn't an item into a link card", () => {
		expect(interpretText(" https://unpic.pics \n")).toEqual({
			kind: "cards",
			keys: [],
			links: ["https://unpic.pics/"],
		});
		expect(interpretText("www.emdashcms.com/docs")).toEqual({
			kind: "cards",
			keys: [],
			links: ["https://www.emdashcms.com/docs"],
		});
		// A repository's page, or its pull requests' list, isn't an item: a link card.
		expect(interpretText("https://github.com/ascorbic/cirrus")).toEqual({
			kind: "cards",
			keys: [],
			links: ["https://github.com/ascorbic/cirrus"],
		});
	});

	it("reads several addresses at once, items as cards and the rest as link cards", () => {
		expect(
			interpretText(
				"https://unpic.pics https://github.com/ascorbic/unpic/issues/7\nhttps://tack.social\nhttps://unpic.pics/",
			),
		).toEqual({
			kind: "cards",
			keys: ["github.com/ascorbic/unpic#7"],
			links: ["https://unpic.pics/", "https://tack.social/"],
		});
	});

	it("keeps an address with words around it a sticky", () => {
		expect(interpretText("  remember the changelog \n")).toEqual({
			kind: "sticky",
			text: "remember the changelog",
		});
		expect(interpretText("see ascorbic/unpic#1 for why")).toEqual({
			kind: "sticky",
			text: "see ascorbic/unpic#1 for why",
		});
		expect(interpretText("Read https://tack.social/docs first")).toEqual({
			kind: "sticky",
			text: "Read https://tack.social/docs first",
		});
		// Not web addresses: other schemes, and hosts that aren't hosts.
		expect(interpretText("javascript:alert(1)")?.kind).toBe("sticky");
		expect(interpretText("ftp://tack.social/file")?.kind).toBe("sticky");
		expect(interpretText("https://intranet/wiki")?.kind).toBe("sticky");
	});

	it("makes a sticky of more addresses than make sense at once", () => {
		const many = Array.from({ length: 21 }, (_, i) => `https://tack.social/${i}`).join("\n");
		expect(interpretText(many)?.kind).toBe("sticky");
	});

	it("ignores blank text and caps long text", () => {
		expect(interpretText("   \n ")).toBeNull();
		const long = interpretText("x".repeat(MAX_PASTED_TEXT + 100));
		expect(long?.kind === "sticky" && long.text.length).toBe(MAX_PASTED_TEXT);
	});
});

describe("decisions", () => {
	it("copy with their votes, but leave their write-back with the original", () => {
		const doc = new Y.Doc();
		addDecision(doc, "d", { x: 10, y: 20, title: "Drop Node 18", text: "EOL" });
		castVote(doc, "d", { name: "Priya", login: "priya" }, "agree");
		const decision = shapesMap(doc).get("d");
		decision?.set("status", "decided");
		decision?.set("writeback", "change-1");
		decision?.set("ref", "github.com/acme/x#88");

		const payload = roundTrip(copyShapes(doc, ["d"])) as ClipboardPayload;
		expect(toPlainText(payload)).toContain("Drop Node 18");
		const [id] = pasteShapes(doc, payload, { x: 40, y: 40 });
		const copy = shapesMap(doc).get(id as string) as Y.Map<unknown>;
		expect(copy.get("votes")).toBeInstanceOf(Y.Map);
		expect(readShape(copy)).toMatchObject({
			type: "decision",
			title: "Drop Node 18",
			status: "decided",
			votes: { "@priya": { choice: "agree" } },
		});
		expect(copy.has("writeback")).toBe(false);
		expect(copy.has("ref")).toBe(false);
	});

	it("always get a votes map, even from a payload without one", () => {
		const doc = new Y.Doc();
		const [id] = pasteShapes(
			doc,
			{ tack: 1, shapes: [{ id: "x", props: { type: "decision", x: 0, y: 0, title: "t" } }] },
			{ x: 0, y: 0 },
		);
		expect(
			shapesMap(doc)
				.get(id as string)
				?.get("votes"),
		).toBeInstanceOf(Y.Map);
	});
});

describe("widgets", () => {
	it("copy with their config and size; pasted cards from them were placed by hand", () => {
		const doc = new Y.Doc();
		const list = addWidget(doc, "list", { x: 0, y: 0 }, { title: "Bugs", q: "label:bug" });
		addShape(doc, "c", {
			type: "card",
			ref: "github.com/acme/widgets#1",
			x: 400,
			y: 0,
			z: "a9",
			provenance: { via: "list", source: list },
		});
		const payload = roundTrip(copyShapes(doc, [list, "c"])) as ClipboardPayload;
		expect(toPlainText(payload)).toContain("Bugs: label:bug");
		const ids = pasteShapes(doc, payload, { x: 40, y: 40 });
		const [copy, card] = ids.map((id) => readShape(shapesMap(doc).get(id) as Y.Map<unknown>));
		expect(copy).toMatchObject({ type: "widget", widget: "list", w: 360, h: 440 });
		expect(copy?.config).toMatchObject({ title: "Bugs", q: "label:bug" });
		// Whoever pastes a copy placed it.
		expect(card?.provenance).toBeUndefined();
	});
});
