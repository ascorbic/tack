import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import { watchCardRefs } from "../src/server/card-refs.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";

describe("debounced subscription sync", () => {
	let doc: Y.Doc;
	let calls: number;
	let stop: () => void;

	beforeEach(() => {
		vi.useFakeTimers();
		doc = new Y.Doc();
		calls = 0;
		stop = watchCardRefs(doc, () => calls++, { wait: 150, maxWait: 1_000 });
	});
	afterEach(() => {
		stop();
		vi.useRealTimers();
	});

	const card = (id: string, ref = `github.com/a/b#${id}`) =>
		addShape(doc, id, { type: "card", ref, x: 0, y: 0, z: "a0" });

	it("coalesces a burst of new cards into one sync", () => {
		for (let i = 1; i <= 20; i++) card(String(i));
		expect(calls).toBe(0);
		vi.advanceTimersByTime(150);
		expect(calls).toBe(1);
	});

	it("ignores edits that can't change which cards are shown", () => {
		card("1");
		vi.advanceTimersByTime(150);
		addShape(doc, "s", { type: "sticky", text: "", x: 0, y: 0, z: "a1" });
		vi.advanceTimersByTime(150);
		calls = 0;

		const shape = shapesMap(doc).get("1");
		const sticky = shapesMap(doc).get("s");
		for (let i = 0; i < 50; i++) {
			doc.transact(() => {
				shape?.set("x", i);
				shape?.set("y", i);
			});
			sticky?.set("text", "typing".slice(0, i % 6));
		}
		vi.advanceTimersByTime(1_000);
		expect(calls).toBe(0);
	});

	it("syncs when a card is removed or points somewhere else", () => {
		card("1");
		vi.advanceTimersByTime(150);
		shapesMap(doc).get("1")?.set("ref", "github.com/a/b#2");
		vi.advanceTimersByTime(150);
		shapesMap(doc).delete("1");
		vi.advanceTimersByTime(150);
		expect(calls).toBe(3);
	});

	it("still syncs during a long stream of changes", () => {
		for (let t = 0; t < 2_500; t += 100) {
			card(`c${t}`);
			vi.advanceTimersByTime(100);
		}
		expect(calls).toBe(2);
	});

	it("stops watching", () => {
		stop();
		card("1");
		vi.advanceTimersByTime(1_000);
		expect(calls).toBe(0);
	});
});
