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
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";

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
		});
		expect(interpretText("ascorbic/unpic#1\n\n  ascorbic/unpic#2 \nascorbic/unpic#1")).toEqual({
			kind: "cards",
			keys: ["github.com/ascorbic/unpic#1", "github.com/ascorbic/unpic#2"],
		});
	});

	it("turns any other text into a sticky", () => {
		expect(interpretText("  remember the changelog \n")).toEqual({
			kind: "sticky",
			text: "remember the changelog",
		});
		expect(interpretText("see ascorbic/unpic#1 for why")).toEqual({
			kind: "sticky",
			text: "see ascorbic/unpic#1 for why",
		});
		expect(interpretText("https://example.com")?.kind).toBe("sticky");
	});

	it("ignores blank text and caps long text", () => {
		expect(interpretText("   \n ")).toBeNull();
		const long = interpretText("x".repeat(MAX_PASTED_TEXT + 100));
		expect(long?.kind === "sticky" && long.text.length).toBe(MAX_PASTED_TEXT);
	});
});
