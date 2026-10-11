// Compacting very old boards (#60): measuring tombstones, rebuilding a
// document with exactly the same content, recognising copies of the old
// one, and history across the rebuild.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	COMPACTION_LIMITS,
	clientsOf,
	contentOf,
	measureDoc,
	rebuildDoc,
	shouldCompact,
	stableJson,
	stateVectorNamesRetired,
	updateNamesRetired,
} from "../src/shared/compaction.ts";
import { HistoryLog, MemoryHistoryStore, planMerges } from "../src/shared/history.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { Replayer } from "../src/client/history/replay.ts";

const HOUR = 3_600_000;

/** A board that's been worked on for a long time: a few shapes, moved a great deal. */
function wornBoard(moves = 2000): Y.Doc {
	const doc = new Y.Doc();
	for (let i = 0; i < 20; i++) {
		addShape(doc, `s${i}`, { type: "sticky", x: i * 10, y: 0, z: `a${i}`, text: `Idea ${i}` });
	}
	addShape(doc, "gone", { type: "sticky", x: 0, y: 0, z: "z", text: "Deleted later" });
	const shapes = shapesMap(doc);
	for (let n = 0; n < moves; n++) {
		const shape = shapes.get(`s${n % 20}`)!;
		doc.transact(() => {
			shape.set("x", n);
			shape.set("y", n * 2);
		});
	}
	shapes.delete("gone");
	doc.getArray("ruleLog").push([
		{ rule: "r1", at: 1 },
		{ rule: "r2", at: 2 },
	]);
	const votes = doc.getMap("dotVotes");
	const vote = new Y.Map<unknown>();
	const ballots = new Y.Map<unknown>();
	ballots.set("u:1", ["s1", "s2"]);
	vote.set("ballots", ballots);
	vote.set("title", "What next?");
	votes.set("v1", vote);
	doc.getMap("facilitation").set("timer", { state: "stopped", bytes: new Uint8Array([1, 2]) });
	return doc;
}

/** A document loaded from its saved bytes, as the board's object loads one. */
function reload(doc: Y.Doc): Y.Doc {
	const loaded = new Y.Doc();
	Y.applyUpdate(loaded, Y.encodeStateAsUpdate(doc));
	return loaded;
}

describe("measuring", () => {
	it("counts live items, tombstones and clients", () => {
		const doc = wornBoard(500);
		const stats = measureDoc(doc);
		expect(stats.live).toBeGreaterThan(20);
		expect(stats.deleted).toBeGreaterThan(900);
		expect(stats.clients).toBe(1);
		expect(stats.bytes).toBe(Y.encodeStateAsUpdate(doc).byteLength);
	});

	it("only compacts big, mostly dead documents nobody's touched lately, once in a while", () => {
		const stats = { bytes: 400 * 1024, live: 1000, deleted: 9000, clients: 300 };
		const now = Date.now();
		const quiet = { now, lastSavedAt: now - 7 * HOUR, compactedAt: null };
		expect(shouldCompact(stats, COMPACTION_LIMITS, quiet)).toBe(true);
		expect(shouldCompact({ ...stats, bytes: 10_000 }, COMPACTION_LIMITS, quiet)).toBe(false);
		expect(shouldCompact({ ...stats, deleted: 500 }, COMPACTION_LIMITS, quiet)).toBe(false);
		expect(shouldCompact(stats, COMPACTION_LIMITS, { ...quiet, lastSavedAt: now - HOUR })).toBe(
			false,
		);
		// Saved before saves were timed: wait for one.
		expect(shouldCompact(stats, COMPACTION_LIMITS, { ...quiet, lastSavedAt: null })).toBe(false);
		expect(
			shouldCompact(stats, COMPACTION_LIMITS, { ...quiet, compactedAt: now - 24 * HOUR }),
		).toBe(false);
	});
});

describe("rebuilding", () => {
	it("keeps exactly the same content, and drops the tombstones", () => {
		const doc = reload(wornBoard());
		const before = measureDoc(doc);
		const rebuilt = rebuildDoc(doc);
		expect(rebuilt).not.toBeNull();
		expect(stableJson(contentOf(rebuilt!))).toBe(stableJson(contentOf(doc)));
		expect(shapesMap(rebuilt!).get("s3")?.get("text")).toBe("Idea 3");
		expect(shapesMap(rebuilt!).has("gone")).toBe(false);
		const after = measureDoc(rebuilt!);
		expect(after.deleted).toBe(0);
		expect(after.bytes).toBeLessThan(before.bytes / 4);
		// Loading the rebuild from its bytes gives the same again.
		expect(stableJson(contentOf(reload(rebuilt!)))).toBe(stableJson(contentOf(doc)));
	});

	it("knows a copy of the old document by its clients, and leaves new ones alone", () => {
		const old = reload(wornBoard(50));
		const retired = new Set(clientsOf(old));
		const rebuilt = rebuildDoc(old)!;

		// Someone still holding the old document.
		const stale = new Y.Doc();
		Y.applyUpdate(stale, Y.encodeStateAsUpdate(old));
		expect(stateVectorNamesRetired(Y.encodeStateVector(stale), retired)).toBe(true);
		// An edit they made on it, even as a new client (a fresh tab with edits kept offline).
		const offline = new Y.Doc();
		Y.applyUpdate(offline, Y.encodeStateAsUpdate(old));
		let edit: Uint8Array | null = null;
		offline.on("update", (update: Uint8Array) => {
			edit = update;
		});
		shapesMap(offline).get("s1")!.set("x", 999);
		expect(updateNamesRetired(edit!, retired)).toBe(true);
		const removal = new Y.Doc();
		Y.applyUpdate(removal, Y.encodeStateAsUpdate(old));
		let removed: Uint8Array | null = null;
		removal.on("update", (update: Uint8Array) => {
			removed = update;
		});
		shapesMap(removal).delete("s2");
		expect(updateNamesRetired(removed!, retired)).toBe(true);

		// Someone who loaded the rebuilt one, and edits it.
		const fresh = new Y.Doc();
		Y.applyUpdate(fresh, Y.encodeStateAsUpdate(rebuilt));
		expect(stateVectorNamesRetired(Y.encodeStateVector(fresh), retired)).toBe(false);
		let ok: Uint8Array | null = null;
		fresh.on("update", (update: Uint8Array) => {
			ok = update;
		});
		shapesMap(fresh).get("s1")!.set("x", 5);
		expect(updateNamesRetired(ok!, retired)).toBe(false);
		// And a brand-new page with nothing yet.
		expect(stateVectorNamesRetired(Y.encodeStateVector(new Y.Doc()), retired)).toBe(false);
	});
});

describe("history across a rebuild", () => {
	function recorded(doc: Y.Doc, store: MemoryHistoryStore, clock: { now: number }, epoch = "") {
		const history = new HistoryLog({
			doc,
			store,
			now: () => clock.now,
			attribute: () => ({ key: "u:1", actor: { key: "u:1", name: "Ana", color: "" } }),
			limits: { compactEvery: Number.POSITIVE_INFINITY },
			epoch,
		});
		history.start();
		return history;
	}

	it("starts a new stretch with a keyframe, which nothing replays or merges across", async () => {
		const clock = { now: Date.UTC(2026, 0, 1) };
		const store = new MemoryHistoryStore();
		const doc = reload(wornBoard(200));
		const before = recorded(doc, store, clock);
		addShape(doc, "late", { type: "sticky", x: 0, y: 0, z: "l", text: "Before the rebuild" });
		before.flush();
		before.stop();
		const lastOld = store.steps().at(-1)!.id;

		// The board compacts on its next load.
		const rebuilt = reload(rebuildDoc(reload(doc))!);
		clock.now += HOUR;
		const after = recorded(rebuilt, store, clock, "epoch-2");
		const rebase = store.steps().at(-1)!;
		expect(rebase).toMatchObject({ rebase: true, actors: ["sys:server"] });
		expect(store.keyframe(rebase.id)).not.toBeNull();
		expect(after.timeline().generation).toBeGreaterThan(0);

		clock.now += HOUR;
		addShape(rebuilt, "new", { type: "sticky", x: 1, y: 1, z: "n", text: "After the rebuild" });
		// An edit to a shape from before: only the rebuilt document has it as it is now.
		shapesMap(rebuilt).get("s3")!.set("text", "Edited after the rebuild");
		after.flush();
		const latest = store.steps().at(-1)!.id;

		// Seeking either side gives the board as it was.
		expect(shapesMap(after.docAt(lastOld)).get("late")?.get("text")).toBe("Before the rebuild");
		expect(shapesMap(after.docAt(lastOld)).has("new")).toBe(false);
		const now = after.docAt(latest);
		expect(stableJson(contentOf(now))).toBe(stableJson(contentOf(rebuilt)));

		// Thinning never merges across it, and keeps its keyframe.
		expect(planMerges(store.steps(), clock.now + 30 * 24 * HOUR).flat()).not.toContain(
			store.steps().findIndex((step) => step.id === rebase.id),
		);
		after.compact(clock.now + 30 * 24 * HOUR);
		expect(store.keyframes().map((frame) => frame.step)).toContain(rebase.id);
		expect(stableJson(contentOf(after.docAt(store.steps().at(-1)!.id)))).toBe(
			stableJson(contentOf(rebuilt)),
		);

		// A client playing forwards from before the rebuild loads its keyframe rather than walking on.
		const replayer = new Replayer({
			timeline: async () => after.timeline(),
			segment: async (step: number) => after.segment(step)!,
		} as never);
		replayer.setTimeline(after.timeline());
		const ids = store.steps().map((step) => step.id);
		const beforeRebase = ids[ids.indexOf(rebase.id) - 1]!;
		// Both stretches loaded, then from before the rebuild to after it.
		await replayer.docAt(ids.at(-1)!);
		expect(shapesMap(await replayer.docAt(beforeRebase)).has("new")).toBe(false);
		const played = await replayer.docAt(ids.at(-1)!);
		expect(stableJson(contentOf(played))).toBe(stableJson(contentOf(rebuilt)));
		after.stop();
	});
});
