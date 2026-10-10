import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import {
	type SilentMessage,
	faceDownCounts,
	joinSilentSession,
	parseSession,
	sessionAt,
	silentOf,
} from "../src/shared/silent.ts";
import { MemorySilentStore, type SilentPeer, SilentHub } from "../src/shared/silentHub.ts";

const FACILITATOR: SilentPeer = { id: "c1", author: "u:1", canEdit: true, owner: false };
const ALICE: SilentPeer = { id: "c2", author: "u:2", canEdit: true, owner: false };
const ALICE_TAB: SilentPeer = { id: "c3", author: "u:2", canEdit: true, owner: false };
const BOB: SilentPeer = { id: "c4", author: "u:3", canEdit: true, owner: false };
const VIEWER: SilentPeer = { id: "c5", author: "u:4", canEdit: false, owner: false };
const OWNER: SilentPeer = { id: "c6", author: "u:5", canEdit: true, owner: true };
const PRIYA = { name: "Priya", color: "#b4467a" };

function setup(peers = [FACILITATOR, ALICE, ALICE_TAB, BOB, VIEWER, OWNER]) {
	const doc = new Y.Doc();
	addShape(doc, "s", { type: "section", x: 0, y: 0, w: 600, h: 400, z: "a0", title: "Ideas" });
	addShape(doc, "old", { type: "sticky", x: 10, y: 10, z: "a1", parent: "s", text: "Before" });
	const sent: { to: string; message: SilentMessage }[] = [];
	const connected = [...peers];
	const store = new MemorySilentStore();
	const hub = new SilentHub({
		doc,
		store,
		peers: () => connected,
		send: (to, message) => sent.push({ to, message }),
	});
	return { doc, hub, sent, connected, store };
}

/** A sticky made in the section by a client, as `addSticky` makes it. */
function stickyIn(doc: Y.Doc, id: string, author = PRIYA) {
	doc.transact(() => {
		addShape(doc, id, { type: "sticky", x: 50, y: 50, z: "b0", parent: "s", text: "", author });
		joinSilentSession(doc, id);
	});
}

const session = (doc: Y.Doc) => parseSession(shapesMap(doc).get("s")?.get("silent"));

describe("silent mode", () => {
	it("keeps new stickies' text out of the document, and only sends it to its author", () => {
		const { doc, hub, sent } = setup();
		expect(hub.start(FACILITATOR, "s", PRIYA)).toBe(true);
		const id = session(doc)!.id;
		expect(session(doc)!.by).toEqual(PRIYA);

		stickyIn(doc, "mine");
		const shape = readShape(shapesMap(doc).get("mine")!);
		expect(silentOf(shape)).toBe(id);
		expect(shape.text).toBeUndefined();

		expect(hub.text(ALICE, "mine", "a secret idea")).toBe(true);
		expect(JSON.stringify(doc.toJSON())).not.toContain("a secret idea");
		// Only Alice's other tab hears about it.
		expect(sent.filter((s) => JSON.stringify(s.message).includes("a secret idea"))).toEqual([
			{ to: ALICE_TAB.id, message: { type: "silent-texts", texts: { mine: "a secret idea" } } },
		]);

		// Coming back, she gets her own text, and Bob gets nothing of hers.
		sent.length = 0;
		hub.hello(ALICE);
		hub.hello(BOB);
		expect(sent).toEqual([
			{
				to: ALICE.id,
				message: { type: "silent-texts", texts: { mine: "a secret idea" }, replace: true },
			},
			{ to: BOB.id, message: { type: "silent-texts", texts: {}, replace: true } },
		]);
	});

	it("doesn't silence stickies that were there before, or made outside", () => {
		const { doc, hub } = setup();
		hub.start(FACILITATOR, "s", PRIYA);
		expect(silentOf(readShape(shapesMap(doc).get("old")!))).toBeNull();
		addShape(doc, "outside", { type: "sticky", x: 900, y: 0, z: "c0", text: "" });
		expect(joinSilentSession(doc, "outside")).toBeNull();
		// Nested sections inherit silence.
		addShape(doc, "inner", { type: "section", x: 0, y: 0, w: 100, h: 100, z: "c1", parent: "s" });
		expect(sessionAt(doc, "inner")?.id).toBe(session(doc)!.id);
	});

	it("won't let anyone else write into someone's sticky, or viewers write at all", () => {
		const { doc, hub, sent } = setup();
		hub.start(FACILITATOR, "s", PRIYA);
		stickyIn(doc, "mine");
		hub.text(ALICE, "mine", "hers");
		expect(hub.text(BOB, "mine", "his")).toBe(false);
		expect(hub.text(VIEWER, "mine", "nope")).toBe(false);
		expect(hub.text(ALICE, "old", "not silent")).toBe(false);
		expect(sent.filter((s) => s.message.type === "silent-refused").map((s) => s.message)).toEqual([
			{ type: "silent-refused", request: "silent-text", shape: "mine", reason: "not_yours" },
			{ type: "silent-refused", request: "silent-text", shape: "mine", reason: "not_editor" },
			{ type: "silent-refused", request: "silent-text", shape: "old", reason: "not_silent" },
		]);
		expect(hub.start(VIEWER, "s", PRIYA)).toBe(false);
		expect(hub.start(ALICE, "s", PRIYA)).toBe(false); // already silent
		expect(hub.start(ALICE, "old", PRIYA)).toBe(false); // not a section
	});

	it("reveals everything at once, for the facilitator or the owner", () => {
		const { doc, hub, store } = setup();
		hub.start(FACILITATOR, "s", PRIYA);
		const id = session(doc)!.id;
		stickyIn(doc, "a");
		stickyIn(doc, "b", { name: "Bob", color: "#1f7a6b" });
		stickyIn(doc, "empty");
		hub.text(ALICE, "a", "Alice's idea");
		hub.text(BOB, "b", "Bob's idea");
		expect(faceDownCounts(doc, id)).toEqual([
			{ name: "Priya", color: "#b4467a", count: 2 },
			{ name: "Bob", color: "#1f7a6b", count: 1 },
		]);

		expect(hub.reveal(ALICE, id)).toBe(false);
		expect(hub.reveal(VIEWER, id)).toBe(false);
		const updates: Uint8Array[] = [];
		doc.on("update", (update: Uint8Array) => updates.push(update));
		expect(hub.reveal(OWNER, id)).toBe(true);
		// One transaction: every sticky turns over together.
		expect(updates).toHaveLength(1);
		const shapes = shapesMap(doc);
		expect(shapes.get("a")?.get("text")).toBe("Alice's idea");
		expect(shapes.get("b")?.get("text")).toBe("Bob's idea");
		expect(shapes.get("empty")?.get("text")).toBe("");
		for (const sticky of ["a", "b", "empty"]) expect(shapes.get(sticky)?.has("silent")).toBe(false);
		expect(shapes.get("s")?.has("silent")).toBe(false);
		expect(store.texts()).toEqual([]);
		expect(store.sessions()).toEqual([]);
	});

	it("lets any editor reveal once the facilitator has gone", () => {
		const { doc, hub, connected } = setup();
		hub.start(FACILITATOR, "s", PRIYA);
		const id = session(doc)!.id;
		expect(hub.reveal(BOB, id)).toBe(false);
		connected.splice(connected.indexOf(FACILITATOR), 1);
		expect(hub.reveal(BOB, id)).toBe(true);
	});

	it("puts back marks nobody's server made, and keeps real ones", async () => {
		const { doc, hub } = setup();
		addShape(doc, "fake", { type: "section", x: 0, y: 900, w: 100, h: 100, z: "d0" });
		shapesMap(doc).get("fake")?.set("silent", { id: "made-up", by: PRIYA, at: "" });
		await Promise.resolve();
		expect(shapesMap(doc).get("fake")?.has("silent")).toBe(false);

		hub.start(FACILITATOR, "s", PRIYA);
		const real = session(doc)!;
		shapesMap(doc).get("s")?.delete("silent");
		await Promise.resolve();
		expect(session(doc)).toEqual(real);
	});
});
