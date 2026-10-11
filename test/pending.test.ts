import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import { KEEP_MS, type KeptStore, PendingEdits } from "../src/client/pending.ts";

// Edits kept on this device until the server has surely had them (canvas
// review 37): offline edits survive a reload, and say how many are waiting.

class MemoryStore implements KeptStore {
	items = new Map<string, string>();
	get length() {
		return this.items.size;
	}
	key(index: number) {
		return [...this.items.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.items.set(key, value);
	}
	removeItem(key: string) {
		this.items.delete(key);
	}
}

const SERVER = Symbol("server");

function text(doc: Y.Doc): string {
	return doc.getText("t").toJSON();
}

describe("PendingEdits", () => {
	let store: MemoryStore;
	beforeEach(() => {
		vi.useFakeTimers();
		store = new MemoryStore();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const open = (doc: Y.Doc, tab = "a") =>
		new PendingEdits(doc, "board", SERVER, store, () => Date.now(), tab);

	it("counts edits made offline, bursts of typing once", () => {
		const doc = new Y.Doc();
		const pending = open(doc);
		pending.setSynced(true);
		doc.getText("t").insert(0, "online");
		expect(pending.waiting).toBe(0);

		pending.setSynced(false);
		for (const char of "typing") doc.getText("t").insert(0, char);
		expect(pending.waiting).toBe(1);
		vi.advanceTimersByTime(3000);
		doc.getText("t").insert(0, "!");
		expect(pending.waiting).toBe(2);

		// Back online: everything's sent.
		pending.setSynced(true);
		expect(pending.waiting).toBe(0);
	});

	it("never counts the server's own updates", () => {
		const doc = new Y.Doc();
		const pending = open(doc);
		const other = new Y.Doc();
		other.getText("t").insert(0, "theirs");
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), SERVER);
		expect(pending.waiting).toBe(0);
		pending.flush();
		expect(store.length).toBe(0);
	});

	it("brings offline edits back after a reload, waiting to be sent", () => {
		const server = new Y.Doc();
		server.getText("t").insert(0, "base ");

		const before = new Y.Doc();
		Y.applyUpdate(before, Y.encodeStateAsUpdate(server), SERVER);
		const pending = open(before);
		pending.setSynced(true);
		pending.setSynced(false);
		before.getText("t").insert(5, "offline");
		before.getMap("shapes").set("s1", "a new sticky");
		pending.flush();
		// The tab's closed or reloaded before the connection comes back.
		pending.destroy();

		const after = new Y.Doc();
		const sent: Uint8Array[] = [];
		const restored = new PendingEdits(after, "board", SERVER, store, Date.now, "a", (update) =>
			sent.push(update),
		);
		expect(restored.waiting).toBe(1);

		// Once synced, the server's state has arrived, and they take their place.
		Y.applyUpdate(after, Y.encodeStateAsUpdate(server), SERVER);
		restored.setSynced(true);
		expect(text(after)).toBe("base offline");
		expect(after.getMap("shapes").get("s1")).toBe("a new sticky");
		expect(restored.waiting).toBe(0);
		// They arrived as the server's, so they're sent again explicitly.
		expect(sent).toHaveLength(1);
		for (const update of sent) Y.applyUpdate(server, update);
		expect(text(server)).toBe("base offline");
		expect(server.getMap("shapes").get("s1")).toBe("a new sticky");
	});

	it("keeps edits made online a little while, to outlast the server's save", () => {
		const doc = new Y.Doc();
		const pending = open(doc);
		pending.setSynced(true);
		doc.getText("t").insert(0, "just now");
		pending.flush();
		expect(store.length).toBe(1);

		// Lost with the server's unsaved state, a reload still has it.
		const copy = new MemoryStore();
		copy.items = new Map(store.items);
		const reloaded = new Y.Doc();
		new PendingEdits(reloaded, "board", SERVER, copy, () => Date.now(), "b").destroy();
		expect(text(reloaded)).toBe("just now");

		// The first tab keeps it until it's surely been saved.
		doc.getText("t").insert(0, "and ");
		pending.flush();
		vi.advanceTimersByTime(KEEP_MS + 100);
		expect(store.length).toBe(0);
	});

	it("keeps offline edits however long the connection's away", () => {
		const doc = new Y.Doc();
		const pending = open(doc);
		pending.setSynced(false);
		doc.getText("t").insert(0, "waiting");
		vi.advanceTimersByTime(KEEP_MS * 10);
		pending.prune();
		pending.flush();
		expect(store.length).toBe(1);
		expect(pending.waiting).toBe(1);
	});

	it("tells subscribers when the count changes", () => {
		const doc = new Y.Doc();
		const pending = open(doc);
		const seen: number[] = [];
		pending.subscribe(() => seen.push(pending.waiting));
		doc.getText("t").insert(0, "x");
		pending.setSynced(true);
		expect(seen).toEqual([1, 0]);
	});

	it("carries on without storage", () => {
		const doc = new Y.Doc();
		const pending = new PendingEdits(doc, "board", SERVER, null, () => Date.now(), "a");
		doc.getText("t").insert(0, "x");
		pending.flush();
		expect(pending.waiting).toBe(1);
	});
});
