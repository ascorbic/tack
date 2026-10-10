import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	dismissFromInbox,
	dismissedKeys,
	inboxQuery,
	inboxSections,
	inboxTray,
	restoreToInbox,
	setInbox,
	sortFromInbox,
	confirmMatches,
} from "../src/shared/inbox.ts";
import { refreshMatches } from "../src/shared/rules.ts";
import { readShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection } from "../src/shared/structure.ts";
import { card } from "./card-fixture.ts";

const query = inboxQuery("repo:acme/widgets is:issue is:open no:label");

function inbox() {
	const doc = new Y.Doc();
	const id = addSection(doc, { x: 0, y: 0, w: 640, h: 440 }, { title: "Inbox" });
	setInbox(doc, id, query);
	return { doc, id };
}

describe("inbox frames", () => {
	it("binds a query to a section, and unbinds it", () => {
		const { doc, id } = inbox();
		expect(readShape(shapesMap(doc).get(id)!).inbox).toEqual({ query });
		expect(inboxSections(doc).get(id)).toEqual(query);
		setInbox(doc, id, null);
		expect(inboxSections(doc).size).toBe(0);
	});

	it("collects matches that aren't on the board or dismissed in the tray", () => {
		const items = [12, 13, 14].map((n) => card({ item: `#${n}` }));
		const onBoard = new Set([items[0]!.key]);
		const dismissed = new Set([items[1]!.key]);
		expect(inboxTray({ items }, onBoard, dismissed).map((c) => c.item)).toEqual(["#14"]);
	});

	it("remembers dismissals from everyone, merging concurrent ones", () => {
		const { doc, id } = inbox();
		const other = new Y.Doc();
		Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
		dismissFromInbox(doc, id, ["github.com/acme/widgets#1"], "Alice");
		dismissFromInbox(other, id, ["github.com/acme/widgets#2"], "Bob");
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
		Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
		const keys = dismissedKeys(readShape(shapesMap(doc).get(id)!));
		expect([...keys].sort()).toEqual(["github.com/acme/widgets#1", "github.com/acme/widgets#2"]);
		restoreToInbox(doc, id, ["github.com/acme/widgets#1"]);
		expect([...dismissedKeys(readShape(shapesMap(doc).get(id)!))]).toEqual([
			"github.com/acme/widgets#2",
		]);
	});

	it("sorts a match onto the board as a card with the inbox's provenance", () => {
		const { doc, id } = inbox();
		const shape = sortFromInbox(doc, id, "github.com/acme/widgets#12", { x: 40, y: 40 });
		expect(readShape(shapesMap(doc).get(shape)!)).toMatchObject({
			type: "card",
			ref: "github.com/acme/widgets#12",
			parent: id,
			provenance: { via: "inbox", source: id },
		});
	});

	it("marks a card that stops matching from webhook data, and never moves it", () => {
		const { doc, id } = inbox();
		const query12 = { ...query, host: "github.com" };
		setInbox(doc, id, query12);
		const shape = sortFromInbox(doc, id, card().key, { x: 40, y: 40 });
		const before = readShape(shapesMap(doc).get(shape)!);
		// Someone labels it: it no longer matches "no:label".
		const labelled = card({ labels: [{ name: "bug", color: "f00" }] });
		expect(refreshMatches(doc, { cards: [labelled] })).toBe(1);
		const after = readShape(shapesMap(doc).get(shape)!);
		expect(after.unmatched).toEqual(expect.any(String));
		expect({ ...after, unmatched: undefined }).toEqual({ ...before, unmatched: undefined });
		// A card that can't answer the query is left alone.
		setInbox(doc, id, inboxQuery("repo:acme/widgets milestone:v1", "github.com"));
		expect(refreshMatches(doc, { cards: [card()] })).toBe(0);
		// Showing up in anyone's results clears the mark; leaving them out says nothing.
		expect(confirmMatches(doc, id, { items: [] })).toEqual([]);
		expect(confirmMatches(doc, id, { items: [card()] })).toEqual([shape]);
		expect(readShape(shapesMap(doc).get(shape)!).unmatched).toBeUndefined();
	});
});
