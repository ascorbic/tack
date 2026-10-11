// A very old board compacted on the board's own object (#60): on waking,
// with nobody connected, the document is rebuilt without its tombstones,
// everyone who connects gets the same board, history carries on, and a
// browser still holding the old document is told to start again rather
// than putting it all back.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as encoding from "lib0/encoding";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { DocumentInfo } from "../src/server/compaction.ts";
import type { BoardInfo } from "../src/shared/boards.ts";
import { contentOf, stableJson } from "../src/shared/compaction.ts";
import { type Timeline, decodeSegment } from "../src/shared/history.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { connectBoard, eventually } from "./board-client.ts";
import { boardStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const DOCUMENT_REBUILT = 4410;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function worker(persist: string): Miniflare {
	const mf = startWorker({ devAuth: true, persist });
	cleanups.push(() => mf.dispose());
	return mf;
}

async function open(mf: Miniflare, board: string, cookie: string) {
	const result = await connectBoard(mf, board, cookie);
	if (!result.ok) throw new Error(`couldn't connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return result.client;
}

async function timeline(mf: Miniflare, board: string, cookie: string): Promise<Timeline> {
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards/${board}/history`, {
		headers: { cookie },
	});
	return (await response.json()) as Timeline;
}

function syncStep1(doc: Y.Doc): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	syncProtocol.writeSyncStep1(encoder, doc);
	return encoding.toUint8Array(encoder);
}

function syncUpdate(update: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	syncProtocol.writeUpdate(encoder, update);
	return encoding.toUint8Array(encoder);
}

describe("compacting a very old board", () => {
	it("rebuilds it on waking, the same board without its tombstones, and keeps old copies out", async () => {
		const persist = mkdtempSync(join(tmpdir(), "tack-compact-"));
		cleanups.push(() => rmSync(persist, { recursive: true, force: true }));

		// Years of use, in a few seconds: a dozen stickies moved thousands of times.
		const first = worker(persist);
		const cookie = await signIn(first, "olive");
		const board = (await (
			await first.dispatchFetch(`${ORIGIN}/api/boards`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ title: "Old faithful" }),
			})
		).json()) as BoardInfo;
		const owner = await open(first, board.id, cookie);
		for (let i = 0; i < 12; i++) {
			addShape(owner.doc, `s${i}`, { type: "sticky", x: 0, y: 0, z: `a${i}`, text: `Idea ${i}` });
		}
		const shapes = shapesMap(owner.doc);
		for (let n = 0; n < 1500; n++) {
			const shape = shapes.get(`s${n % 12}`)!;
			owner.doc.transact(() => {
				shape.set("x", n);
				shape.set("y", -n);
			});
		}
		shapes.get("s0")!.set("text", "Kept through it all");
		await owner.roundTrip();
		const stub = await boardStub(first, board.id);
		// Saved now (a history read saves first), and compact whenever it's quiet.
		await timeline(first, board.id, cookie);
		await stub.compactionLimits({ minBytes: 1024, idleMs: 0, everyMs: 0 });
		// Copied: results from a disposed Worker can't be read.
		const before = JSON.parse(JSON.stringify(await stub.documentInfo())) as DocumentInfo;
		expect(before.epoch).toBe("");
		expect(before.deleted).toBeGreaterThan(2500);
		const content = stableJson(contentOf(owner.doc));
		const old = new Y.Doc();
		Y.applyUpdate(old, Y.encodeStateAsUpdate(owner.doc));
		const steps = (await timeline(first, board.id, cookie)).steps.length;
		owner.close();
		await first.dispose();
		cleanups.pop();

		// It wakes with nobody connected: rebuilt before anyone syncs.
		const second = worker(persist);
		const again = await signIn(second, "olive");
		const after = (await (await boardStub(second, board.id)).documentInfo())!;
		expect(after.epoch).not.toBe("");
		expect(after.deleted).toBe(0);
		expect(after.bytes).toBeLessThan(before.bytes / 3);
		expect(after.retired).toBeGreaterThan(0);

		const fresh = await open(second, board.id, again);
		expect(stableJson(contentOf(fresh.doc))).toBe(content);
		expect(shapesMap(fresh.doc).get("s0")?.get("text")).toBe("Kept through it all");

		// History carries on from a keyframe of the rebuilt document.
		shapesMap(fresh.doc).get("s1")!.set("text", "Edited after");
		await fresh.roundTrip();
		const history = await timeline(second, board.id, again);
		expect(history.steps.length).toBeGreaterThan(steps);
		const rebase = history.steps.find((step) => step.rebase);
		expect(rebase).toBeDefined();
		const last = history.steps.at(-1)!;
		const segment = await second.dispatchFetch(
			`${ORIGIN}/api/boards/${board.id}/history/segment?step=${last.id}`,
			{ headers: { cookie: again } },
		);
		const decoded = decodeSegment(new Uint8Array(await segment.arrayBuffer()));
		const replayed = new Y.Doc();
		Y.applyUpdate(replayed, decoded.base.state);
		for (const step of decoded.steps) if (step.update) Y.applyUpdate(replayed, step.update);
		expect(shapesMap(replayed).get("s1")?.get("text")).toBe("Edited after");

		// A tab that slept through it still has the old document: it's told to start again.
		const sleeper = await open(second, board.id, again);
		sleeper.sendRaw(syncStep1(old));
		await eventually(() => sleeper.closed !== null);
		expect(sleeper.closed?.code).toBe(DOCUMENT_REBUILT);

		// So is an edit made offline on the old document, from a fresh tab.
		let offline: Uint8Array | null = null;
		const kept = new Y.Doc();
		Y.applyUpdate(kept, Y.encodeStateAsUpdate(old));
		kept.on("update", (update: Uint8Array) => {
			offline = update;
		});
		shapesMap(kept).get("s2")!.set("text", "Typed on the train");
		const restored = await open(second, board.id, again);
		restored.sendRaw(syncUpdate(offline!));
		await eventually(() => restored.closed !== null);
		expect(restored.closed?.code).toBe(DOCUMENT_REBUILT);

		// Nothing of either got in.
		const check = await open(second, board.id, again);
		expect(shapesMap(check.doc).size).toBe(12);
		expect(shapesMap(check.doc).get("s2")?.get("text")).toBe("Idea 2");
		expect(stableJson(contentOf(check.doc))).toBe(stableJson(contentOf(fresh.doc)));
	});

	it("leaves boards someone's used lately alone", async () => {
		const persist = mkdtempSync(join(tmpdir(), "tack-compact-"));
		cleanups.push(() => rmSync(persist, { recursive: true, force: true }));
		const first = worker(persist);
		const cookie = await signIn(first, "olive");
		const board = (await (
			await first.dispatchFetch(`${ORIGIN}/api/boards`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ title: "Busy" }),
			})
		).json()) as BoardInfo;
		const owner = await open(first, board.id, cookie);
		addShape(owner.doc, "s", { type: "sticky", x: 0, y: 0, z: "a", text: "Busy" });
		for (let n = 0; n < 2000; n++) shapesMap(owner.doc).get("s")!.set("x", n);
		await owner.roundTrip();
		await timeline(first, board.id, cookie);
		// The default: quiet for six hours first.
		await (await boardStub(first, board.id)).compactionLimits({ minBytes: 1024 });
		owner.close();
		await first.dispose();
		cleanups.pop();

		const second = worker(persist);
		const info = (await (await boardStub(second, board.id)).documentInfo())!;
		expect(info.epoch).toBe("");
		expect(info.deleted).toBeGreaterThan(1000);
	});
});
