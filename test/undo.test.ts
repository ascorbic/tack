import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { History, LOCAL_ORIGIN, transactLocal } from "../src/client/undo.ts";

// Two people on one board: each has their own Y.Doc, kept in sync the way a
// provider would, with remote updates applied under a non-local origin.
function pair() {
	const a = new Y.Doc();
	const b = new Y.Doc();
	const remote = Symbol("remote");
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== remote) Y.applyUpdate(b, update, remote);
	});
	b.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin !== remote) Y.applyUpdate(a, update, remote);
	});
	return { a, b };
}

function sticky(doc: Y.Doc, id: string, text = "", at = { x: 0, y: 0 }) {
	transactLocal(doc, () => addShape(doc, id, { type: "sticky", text, x: at.x, y: at.y, z: "a0" }));
}

function set(doc: Y.Doc, id: string, key: string, value: unknown) {
	transactLocal(doc, () => shapesMap(doc).get(id)?.set(key, value));
}

const shape = (doc: Y.Doc, id: string) => {
	const s = shapesMap(doc).get(id);
	return s ? readShape(s) : undefined;
};

const histories: History[] = [];
function history(doc: Y.Doc) {
	const h = new History(doc);
	histories.push(h);
	return h;
}

afterEach(() => {
	for (const h of histories.splice(0)) h.destroy();
});

describe("History", () => {
	it("undoes and redoes local changes", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		sticky(doc, "s1", "hello");
		set(doc, "s1", "x", 100);
		expect(shape(doc, "s1")?.x).toBe(100);

		expect(h.undo()).toBe(true);
		expect(shape(doc, "s1")?.x).toBe(0);
		expect(h.undo()).toBe(true);
		expect(shape(doc, "s1")).toBeUndefined();
		expect(h.undo()).toBe(false);

		expect(h.redo()).toBe(true);
		expect(shape(doc, "s1")?.text).toBe("hello");
		expect(h.redo()).toBe(true);
		expect(shape(doc, "s1")?.x).toBe(100);
	});

	it("never tracks changes from other people", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(b, "theirs", "from b");
		set(b, "theirs", "x", 50);
		expect(ha.canUndo()).toBe(false);
		expect(ha.undo()).toBe(false);
		expect(shape(a, "theirs")?.x).toBe(50);
	});

	it("ignores untracked writes, like seeding a board", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		addShape(doc, "seeded", { type: "sticky", x: 0, y: 0, z: "a0" });
		doc.transact(() => shapesMap(doc).get("seeded")?.set("x", 5));
		expect(h.canUndo()).toBe(false);
	});

	it("undoes only this person's changes when both edit", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(a, "mine");
		sticky(b, "theirs");
		set(b, "mine", "color", "pink");

		ha.undo();
		// Their sticky is untouched, and mine survives because they've
		// worked on it since.
		expect(shape(a, "theirs")).toBeDefined();
		expect(shape(b, "theirs")).toBeDefined();
		expect(shape(a, "mine")?.color).toBe("pink");
	});

	it("doesn't revert a property someone else changed afterwards", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(b, "s");
		set(a, "s", "x", 10);
		set(b, "s", "x", 30);

		ha.undo();
		expect(shape(a, "s")?.x).toBe(30);
		expect(shape(b, "s")?.x).toBe(30);
	});

	it("reverts its own move when nobody else moved it", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(b, "s", "", { x: 1, y: 1 });
		transactLocal(a, () => {
			shapesMap(a).get("s")?.set("x", 10);
			shapesMap(a).get("s")?.set("y", 20);
		});
		set(b, "s", "text", "they typed");

		ha.undo();
		expect(shape(b, "s")).toMatchObject({ x: 1, y: 1, text: "they typed" });
	});

	it("keeps a shape this person made once someone else has typed in it", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(a, "s");
		set(b, "s", "text", "their words");

		ha.undo();
		expect(shape(a, "s")).toMatchObject({ type: "sticky", text: "their words", x: 0, y: 0 });
		expect(shape(b, "s")).toMatchObject({ type: "sticky", text: "their words", x: 0, y: 0 });
	});

	it("still removes a shape this person made when nobody else touched it", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(a, "s");
		sticky(b, "other");
		ha.undo();
		expect(shape(b, "s")).toBeUndefined();
		expect(shape(b, "other")).toBeDefined();
	});

	it("never brings back a shape someone else deleted", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(b, "s");
		set(a, "s", "x", 10);
		transactLocal(b, () => shapesMap(b).delete("s"));

		ha.undo();
		expect(shape(a, "s")).toBeUndefined();
		expect(shape(b, "s")).toBeUndefined();
	});

	it("restores a deleted shape, and its contents, on undo", () => {
		const { a, b } = pair();
		const ha = history(a);
		sticky(b, "s", "keep me");
		transactLocal(a, () => shapesMap(a).delete("s"));
		expect(shape(b, "s")).toBeUndefined();

		ha.undo();
		expect(shape(b, "s")?.text).toBe("keep me");
	});

	it("makes each transaction its own step", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		sticky(doc, "s");
		set(doc, "s", "x", 1);
		set(doc, "s", "x", 2);
		h.undo();
		expect(shape(doc, "s")?.x).toBe(1);
	});

	it("merges an editing session into one step", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		sticky(doc, "s");
		h.manager.stopCapturing();
		const end = h.beginSession();
		for (const text of ["h", "hi", "hi!"]) set(doc, "s", "text", text);
		end();
		set(doc, "s", "x", 40);

		h.undo();
		expect(shape(doc, "s")).toMatchObject({ x: 0, text: "hi!" });
		h.undo();
		expect(shape(doc, "s")?.text).toBe("");
		expect(h.canUndo()).toBe(true);
	});

	it("joins an editing session to a change made a moment before", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		sticky(doc, "s");
		const end = h.beginSession();
		set(doc, "s", "text", "typed");
		end();
		h.undo();
		expect(shape(doc, "s")).toBeUndefined();
	});

	it("restores the selection saved with each step", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		let selection: string[] = [];
		const restored: { ids: string[]; affected: string[] }[] = [];
		h.bindSelection({
			get: () => selection,
			restore: (ids, affected) => {
				selection = ids;
				restored.push({ ids, affected: [...affected] });
			},
		});
		sticky(doc, "a");
		sticky(doc, "b");
		selection = ["a", "b"];
		transactLocal(doc, () => {
			shapesMap(doc).get("a")?.set("x", 5);
			shapesMap(doc).get("b")?.set("x", 5);
		});
		selection = [];

		h.undo();
		expect(selection).toEqual(["a", "b"]);
		expect(restored.at(-1)?.affected.sort()).toEqual(["a", "b"]);
	});

	it("notifies subscribers when the stacks change", () => {
		const doc = new Y.Doc();
		const h = history(doc);
		let calls = 0;
		const unsubscribe = h.subscribe(() => calls++);
		sticky(doc, "s");
		h.undo();
		unsubscribe();
		h.redo();
		expect(calls).toBeGreaterThanOrEqual(2);
		const before = calls;
		set(doc, "s", "x", 1);
		expect(calls).toBe(before);
	});

	it("uses the origin that applyNodeChanges writes with", () => {
		expect(LOCAL_ORIGIN).toBe("local");
	});
});
