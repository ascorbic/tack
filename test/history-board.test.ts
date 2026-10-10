// Board history (#47) on a real board in Miniflare: steps recorded as people
// edit over WebSockets and attributed to who's on each connection, segments
// that replay to the board's state, staying within budget, who may read
// history, and silent mode's hidden text never reaching it before the reveal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { BoardInfo, Role } from "../src/shared/boards.ts";
import { type Timeline, decodeSegment } from "../src/shared/history.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { joinSilentSession, parseSession } from "../src/shared/silent.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const SECRET = "the surprise party is on thursday";
const HOUR = 3_600_000;

let mf: Miniflare;
const github = new FakeGitHub();
let olive = ""; // owns the board
let eddie = ""; // an editor
let vera = ""; // a viewer
let otto = ""; // signed in, but not a member

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	olive = await signIn(mf, "olive", { name: "Olive Owner" });
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
	otto = await signIn(mf, "otto");
});
afterAll(() => mf.dispose());

const clients: BoardClient[] = [];
afterAll(() => {
	for (const client of clients) client.close();
});

function api(path: string, cookie?: string, body?: unknown, worker = mf) {
	return worker.dispatchFetch(`${ORIGIN}${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			...(cookie ? { cookie } : {}),
			...(body ? { "content-type": "application/json", origin: ORIGIN } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function boardWithMembers(visibility = "private"): Promise<string> {
	const board = (await (
		await api("/api/boards", olive, { title: "Retro", visibility })
	).json()) as BoardInfo;
	for (const [login, role] of [
		["eddie", "editor"],
		["vera", "viewer"],
	] as [string, Role][]) {
		const invited = await api(`/api/boards/${board.id}/members`, olive, { logins: [login], role });
		expect(invited.status).toBe(200);
	}
	return board.id;
}

async function open(id: string, cookie?: string, worker = mf): Promise<BoardClient> {
	const result = await connectBoard(worker, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status} ${result.error}`);
	clients.push(result.client);
	return result.client;
}

async function timeline(id: string, cookie = olive, worker = mf): Promise<Timeline> {
	const response = await api(`/api/boards/${id}/history`, cookie, undefined, worker);
	expect(response.status).toBe(200);
	return (await response.json()) as Timeline;
}

async function segmentBytes(id: string, step: number, cookie = olive): Promise<Uint8Array> {
	const response = await api(`/api/boards/${id}/history/segment?step=${step}`, cookie);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/octet-stream");
	return new Uint8Array(await response.arrayBuffer());
}

/** The board as it was after `step`, rebuilt from the segment holding it. */
async function stateAt(id: string, step: number): Promise<Y.Doc> {
	const segment = decodeSegment(await segmentBytes(id, step));
	const doc = new Y.Doc();
	Y.applyUpdate(doc, segment.base.state);
	for (const s of segment.steps) if (s.id <= step && s.update) Y.applyUpdate(doc, s.update);
	return doc;
}

function sticky(doc: Y.Doc, id: string, x: number, text = "") {
	addShape(doc, id, { type: "sticky", x, y: 0, z: `a${id}`, text });
}

const shapes = (doc: Y.Doc) => shapesMap(doc).toJSON();

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

describe("history", () => {
	it("records who changed what, and replays the board at any step", async () => {
		const id = await boardWithMembers();
		const owner = await open(id, olive);
		const editor = await open(id, eddie);
		sticky(owner.doc, "a", 0, "From Olive");
		await owner.roundTrip();
		await eventually(() => shapesMap(editor.doc).has("a"));
		// Steps are flushed with each save, and whenever history is read.
		const first = await timeline(id);
		sticky(editor.doc, "b", 300, "From Eddie");
		shapesMap(editor.doc).get("a")?.set("x", 40);
		await editor.roundTrip();

		const { steps, actors } = await timeline(id);
		expect(steps[0]?.origin).toBe(true);
		const byOlive = steps.find((step) => step.changes.some((c) => c.id === "a" && c.op === "add"));
		const byEddie = steps.at(-1)!;
		expect(byOlive && actors[byOlive.actors[0]!]?.login).toBe("olive");
		expect(actors[byEddie.actors[0]!]?.login).toBe("eddie");
		expect(byEddie.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "b", op: "add", type: "sticky" }),
				expect.objectContaining({ id: "a", op: "edit", keys: ["x"] }),
			]),
		);

		// Replaying: before Eddie's step, Olive's sticky alone; after, the board as it is.
		const before = await stateAt(id, first.steps.at(-1)!.id);
		expect(Object.keys(shapes(before))).toEqual(["a"]);
		expect(shapesMap(before).get("a")?.get("x")).toBe(0);
		expect(shapes(await stateAt(id, byEddie.id))).toEqual(shapes(owner.doc));
	});

	it("lets anyone who can open the board read its history, and nobody else", async () => {
		const id = await boardWithMembers();
		const owner = await open(id, olive);
		sticky(owner.doc, "a", 0);
		await owner.roundTrip();
		// A viewer's connection is read-only: nothing of theirs is recorded.
		const viewer = await open(id, vera);
		sticky(viewer.doc, "sneaky", 0);
		await viewer.roundTrip();

		const seen = await timeline(id, vera);
		expect(seen.steps.length).toBeGreaterThan(1);
		expect(Object.values(seen.actors).some((actor) => actor.login === "vera")).toBe(false);
		expect(seen.steps.flatMap((step) => step.changes).some((c) => c.id === "sneaky")).toBe(false);
		expect((await segmentBytes(id, seen.steps.at(-1)!.id, vera)).byteLength).toBeGreaterThan(0);

		for (const cookie of [otto, undefined]) {
			expect((await api(`/api/boards/${id}/history`, cookie)).status).toBe(404);
			expect((await api(`/api/boards/${id}/history/segment?step=1`, cookie)).status).toBe(404);
		}
		expect((await api(`/api/boards/nope/history`, olive)).status).toBe(404);
		expect((await api(`/api/boards/${id}/history/segment?step=x`, olive)).status).toBe(400);
	});

	it("opens to the public on public boards, read-only", async () => {
		const id = await boardWithMembers("public");
		const owner = await open(id, olive);
		sticky(owner.doc, "a", 0);
		await owner.roundTrip();
		expect((await timeline(id, "")).steps.length).toBeGreaterThan(1);
		// Instance boards: anyone allowed on the instance.
		const instance = await boardWithMembers("instance");
		expect((await api(`/api/boards/${instance}/history`, otto)).status).toBe(200);
		expect((await api(`/api/boards/${instance}/history`)).status).toBe(404);
	});

	it("stays within its budget, thinning and trimming the oldest history", async () => {
		const id = await boardWithMembers();
		const stub = await boardStub(mf, id);
		await stub.historyLimits({ budget: 12_000, keyframeMin: 2_000 });
		const owner = await open(id, olive);
		for (let i = 0; i < 60; i++) {
			sticky(owner.doc, `s${i}`, i * 10, "x".repeat(400));
			if (i >= 8) shapesMap(owner.doc).delete(`s${i - 8}`);
			await owner.roundTrip();
			// A step per edit: reading history writes what's waiting.
			await timeline(id);
		}
		// Over budget, with nothing old enough to thin: the oldest steps go.
		const trimmed = await stub.historyCompact(Date.now());
		expect(trimmed?.trimmed).toBeGreaterThan(0);
		const after = await timeline(id);
		expect(after.bytes).toBeLessThanOrEqual(12_000);
		expect(after.steps[0]?.origin).toBe(true);
		expect(after.generation).toBeGreaterThan(0);
		expect(shapes(await stateAt(id, after.steps[0]!.id))).not.toEqual({});
		// Hours later, what's left is merged into coarser steps.
		const thinned = await stub.historyCompact(Date.now() + 2 * HOUR);
		expect(thinned?.merged).toBeGreaterThan(0);
		const later = await timeline(id);
		expect(later.steps.length).toBeLessThan(after.steps.length);
		expect(shapes(await stateAt(id, later.steps.at(-1)!.id))).toEqual(shapes(owner.doc));
	});

	it("never holds silent mode's hidden text before the reveal", async () => {
		const id = await boardWithMembers();
		const facilitator = await open(id, olive);
		const writer = await open(id, eddie);
		addShape(facilitator.doc, "ideas", {
			type: "section",
			x: 0,
			y: 0,
			w: 800,
			h: 600,
			z: "a0",
			title: "Ideas",
		});
		await facilitator.roundTrip();
		facilitator.send({ type: "silent-start", section: "ideas", by: { name: "Olive", color: "" } });
		await eventually(
			() => parseSession(shapesMap(writer.doc).get("ideas")?.get("silent")) !== null,
		);
		const session = parseSession(shapesMap(writer.doc).get("ideas")?.get("silent"))!;
		writer.doc.transact(() => {
			addShape(writer.doc, "s1", { type: "sticky", x: 40, y: 40, z: "b1", parent: "ideas" });
			joinSilentSession(writer.doc, "s1");
		});
		await writer.roundTrip();
		writer.send({ type: "silent-text", shape: "s1", text: SECRET });
		await writer.roundTrip();
		await (await boardStub(mf, id)).historyCompact();

		const secret = new TextEncoder().encode(SECRET);
		const hidden = await timeline(id);
		expect(JSON.stringify(hidden)).not.toContain(SECRET);
		for (const step of hidden.steps) {
			expect(includesBytes(await segmentBytes(id, step.id), secret)).toBe(false);
		}

		// Revealed, it's in the document, so it's in history from then on.
		facilitator.send({ type: "silent-reveal", session: session.id });
		await eventually(() => shapesMap(writer.doc).get("s1")?.get("text") === SECRET);
		const revealed = await timeline(id);
		const reveal = revealed.steps.at(-1)!;
		expect(revealed.actors[reveal.actors[0]!]?.system).toBe("reveal");
		expect(
			shapesMap(await stateAt(id, reveal.id))
				.get("s1")
				?.get("text"),
		).toBe(SECRET);
		expect(JSON.stringify(revealed)).not.toContain(SECRET);
	});

	it("keeps history across restarts", async () => {
		const persist = mkdtempSync(join(tmpdir(), "tack-history-"));
		try {
			const first = startWorker({ devAuth: true, persist });
			const cookie = await signIn(first, "olive");
			const board = (await (
				await api("/api/boards", cookie, { title: "Sleepy" }, first)
			).json()) as BoardInfo;
			const owner = await open(board.id, cookie, first);
			sticky(owner.doc, "a", 0, "Before the nap");
			await owner.roundTrip();
			const before = await timeline(board.id, cookie, first);
			owner.close();
			await first.dispose();

			const woken = startWorker({ devAuth: true, persist });
			try {
				const again = await signIn(woken, "olive");
				const after = await timeline(board.id, again, woken);
				expect(after.steps.map((step) => step.id)).toEqual(before.steps.map((step) => step.id));
			} finally {
				await woken.dispose();
			}
		} finally {
			rmSync(persist, { recursive: true, force: true });
		}
	});
});
