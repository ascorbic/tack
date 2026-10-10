// The client's side of history (#47): rebuilding the board from segments,
// mirroring a replay into the document the canvas shows, and restoring
// shapes from the past as a new, undoable edit.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	HistoryLog,
	MemoryHistoryStore,
	type StepMeta,
	whatHappened,
} from "../src/shared/history.ts";
import { addShape, readShape, shapesMap, transactLocal } from "../src/shared/shapes.ts";
import { mirrorDoc } from "../src/client/history/mirror.ts";
import { indexOf } from "../src/client/history/position.ts";
import { Replayer } from "../src/client/history/replay.ts";
import { restoreShapes } from "../src/client/history/restore.ts";
import type { HistorySource } from "../src/client/history/source.ts";
import { History } from "../src/client/undo.ts";

function recorded(keyframeMin = 200) {
	const doc = new Y.Doc();
	const log = new HistoryLog({
		doc,
		store: new MemoryHistoryStore(),
		attribute: () => ({ key: "u:1" }),
		limits: { keyframeMin, compactEvery: Number.POSITIVE_INFINITY },
	});
	log.start();
	let fetched = 0;
	const source: HistorySource = {
		timeline: async () => log.timeline(),
		segment: async (step) => {
			fetched++;
			return log.segment(step)!;
		},
	};
	return { doc, log, source, fetches: () => fetched };
}

const sticky = (doc: Y.Doc, id: string, x: number, text = "x".repeat(60)) =>
	addShape(doc, id, { type: "sticky", x, y: 0, z: `a${id}`, text });

const json = (doc: Y.Doc) => shapesMap(doc).toJSON();

describe("replaying", () => {
	it("rebuilds any step, fetching each segment once and walking forwards", async () => {
		const { doc, log, source, fetches } = recorded();
		const states = new Map<number, unknown>();
		for (let i = 0; i < 20; i++) {
			sticky(doc, `s${i}`, i * 10);
			if (i > 2) shapesMap(doc).delete(`s${i - 2}`);
			log.flush();
			states.set(log.timeline().steps.at(-1)!.id, json(doc));
		}
		const replayer = new Replayer(source);
		replayer.setTimeline(log.timeline());
		for (const [id, state] of states) expect(json(await replayer.docAt(id))).toEqual(state);
		const forwards = fetches();
		// Backwards and forwards again: everything's cached.
		for (const [id, state] of [...states].reverse()) {
			expect(json(await replayer.docAt(id))).toEqual(state);
		}
		expect(fetches()).toBe(forwards);
		expect(forwards).toBeLessThan(states.size);
	});

	it("starts afresh when history is thinned under it", async () => {
		const { doc, log, source } = recorded();
		for (let i = 0; i < 6; i++) {
			sticky(doc, `s${i}`, i);
			log.flush();
		}
		const replayer = new Replayer(source);
		replayer.setTimeline(log.timeline());
		const last = log.timeline().steps.at(-1)!.id;
		await replayer.docAt(last);
		log.compact(Date.now() + 3 * 3_600_000);
		const thinned = log.timeline();
		expect(thinned.generation).toBe(1);
		replayer.setTimeline(thinned);
		expect(replayer.ready(last)).toBe(false);
		expect(json(await replayer.docAt(thinned.steps.at(-1)!.id))).toEqual(json(doc));
	});

	it("finds where a step falls among those shown", () => {
		const steps = [2, 5, 9].map((id) => ({ id }) as never);
		expect(indexOf(steps, 5)).toBe(1);
		expect(indexOf(steps, 7)).toBe(1);
		expect(indexOf(steps, null)).toBe(3);
	});
});

describe("mirroring", () => {
	it("makes one document match another, changing only what differs", () => {
		const past = new Y.Doc();
		const view = new Y.Doc();
		sticky(past, "a", 0, "Hello");
		addShape(past, "d", { type: "decision", x: 0, y: 0, z: "a1", title: "Ship" });
		shapesMap(past).get("d")?.set("votes", new Y.Map());
		(shapesMap(past).get("d")!.get("votes") as Y.Map<unknown>).set("ana", "agree");
		past.getArray("ruleLog").push([{ id: 1 }]);
		mirrorDoc(past, view);
		expect(view.getMap("shapes").toJSON()).toEqual(past.getMap("shapes").toJSON());
		expect(view.getArray("ruleLog").toJSON()).toEqual([{ id: 1 }]);
		expect(shapesMap(view).get("d")?.get("votes")).toBeInstanceOf(Y.Map);

		// Only the changed key is written: the shape keeps its identity.
		const before = shapesMap(view).get("a");
		let writes = 0;
		view.on("update", () => writes++);
		shapesMap(past).get("a")?.set("x", 50);
		shapesMap(past).delete("d");
		past.getArray("ruleLog").push([{ id: 2 }]);
		mirrorDoc(past, view);
		expect(writes).toBe(1);
		expect(shapesMap(view).get("a")).toBe(before);
		expect(shapesMap(view).get("a")?.get("x")).toBe(50);
		expect(shapesMap(view).has("d")).toBe(false);
		expect(view.getArray("ruleLog").toJSON()).toEqual([{ id: 1 }, { id: 2 }]);

		// Nothing differs: nothing's written.
		mirrorDoc(past, view);
		expect(writes).toBe(1);
	});

	it("mirrors documents rebuilt from updates, whose roots don't know their kind yet", () => {
		const source = new Y.Doc();
		sticky(source, "a", 0);
		source.getArray("ruleLog").push(["x"]);
		const rebuilt = new Y.Doc();
		Y.applyUpdate(rebuilt, Y.encodeStateAsUpdate(source));
		const view = new Y.Doc();
		mirrorDoc(rebuilt, view);
		expect(json(view)).toEqual(json(source));
		expect(view.getArray("ruleLog").toJSON()).toEqual(["x"]);
	});
});

describe("restoring", () => {
	function board() {
		const live = new Y.Doc();
		addShape(live, "sec", {
			type: "section",
			x: 0,
			y: 0,
			w: 600,
			h: 400,
			z: "a0",
			title: "Ideas",
			parent: null,
		});
		addShape(live, "s1", { type: "sticky", x: 40, y: 40, z: "a1", parent: "sec", text: "One" });
		addShape(live, "s2", { type: "sticky", x: 300, y: 40, z: "a2", parent: "sec", text: "Two" });
		addShape(live, "keep", { type: "card", x: 800, y: 40, z: "a3", ref: "github.com/o/r#1" });
		addShape(live, "line", {
			type: "connector",
			x: 0,
			y: 0,
			z: "a4",
			from: { x: 100, y: 100, shape: "s1" },
			to: { x: 800, y: 60, shape: "keep" },
		});
		const past = new Y.Doc();
		Y.applyUpdate(past, Y.encodeStateAsUpdate(live));
		return { live, past };
	}

	it("brings a deleted shape back where it was, joined up again, as one undo step", () => {
		const { live, past } = board();
		const history = new History(live);
		transactLocal(live, () => {
			shapesMap(live).delete("s1");
			shapesMap(live).delete("line");
		});
		history.destroy();
		const undo = new History(live);
		const restored = restoreShapes(past, live, ["s1", "line"])!;
		expect(restored).toMatchObject({ inPlace: true, count: 2, type: null });
		const [sticky, line] = restored.ids.map((id) => readShape(shapesMap(live).get(id)!));
		expect(sticky).toMatchObject({ type: "sticky", x: 40, y: 40, text: "One", parent: "sec" });
		// Its connector joins it, and the card that's still there.
		expect(line?.from?.shape).toBe(restored.ids[0]);
		expect(line?.to?.shape).toBe("keep");
		undo.undo();
		for (const id of restored.ids) expect(shapesMap(live).has(id)).toBe(false);
	});

	it("restores a section as it was beside the one that's there now, contents and all", () => {
		const { live, past } = board();
		shapesMap(live).get("s2")?.set("text", "Two, edited");
		shapesMap(live).delete("s1");
		const restored = restoreShapes(past, live, ["sec"])!;
		expect(restored.inPlace).toBe(false);
		expect(restored.type).toBe("section");
		const copies = restored.ids.map((id) => readShape(shapesMap(live).get(id)!));
		const section = copies.find((shape) => shape.type === "section")!;
		expect(section.x).toBeGreaterThanOrEqual(600);
		const texts = copies.filter((shape) => shape.type === "sticky").map((shape) => shape.text);
		expect(texts.sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["One", "Two"]);
		// The original's untouched.
		expect(shapesMap(live).get("s2")?.get("text")).toBe("Two, edited");
	});

	it("never restores silent mode's marks", () => {
		const { live, past } = board();
		shapesMap(past).get("s1")?.set("silent", "session-1");
		shapesMap(live).delete("s1");
		const restored = restoreShapes(past, live, ["s1"])!;
		expect(shapesMap(live).get(restored.ids[0]!)?.has("silent")).toBe(false);
	});
});

describe("describing steps", () => {
	const actors = {
		"sys:reveal": { key: "sys:reveal", name: "Silent mode", color: "", system: "reveal" as const },
	};
	const step = (changes: StepMeta["changes"]): StepMeta => ({
		id: 2,
		at: 0,
		until: 0,
		actors: ["sys:reveal"],
		changes,
		span: 0,
		bytes: 10,
	});

	it("tells silent mode starting from its reveal", () => {
		const start = step([{ id: "s", op: "edit", type: "section", keys: ["silent"] }]);
		expect(whatHappened(start, actors)).toBe("changed a section");
		const reveal = step([
			{ id: "s", op: "edit", type: "section", keys: ["silent"] },
			{ id: "a", op: "edit", type: "sticky", keys: ["text", "silent"] },
		]);
		expect(whatHappened(reveal, actors)).toBe("turned the stickies over");
	});
});
