// Piles' names (#73) on a real board in Miniflare, with a fake Workers AI:
// suggestions are on by default and off with TACK_AI=off or without the AI
// binding, a name a person gave a pile is never replaced, silent mode's
// hidden text never reaches the model, and "Group these" answers editors
// alone.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type * as Y from "yjs";
import type { SetupInfo } from "../src/shared/auth.ts";
import type { BoardInfo, Role } from "../src/shared/boards.ts";
import { pileUp, setPileName } from "../src/shared/pileEdits.ts";
import type { PileMessage } from "../src/shared/pileNamer.ts";
import { pileName } from "../src/shared/piles.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { joinSilentSession, parseSession } from "../src/shared/silent.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeAi } from "./fake-ai.ts";
import { FakeGitHub } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const SECRET = "the turnip plan nobody may see";

let mf: Miniflare;
const ai = new FakeAi();
const github = new FakeGitHub();
let olive = ""; // an admin, and owns the boards
let eddie = ""; // an editor
let vera = ""; // a viewer

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch, ai });
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	olive = await signIn(mf, "olive", { admin: true });
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
});
afterAll(() => mf.dispose());

const clients: BoardClient[] = [];
afterAll(() => {
	for (const client of clients) client.close();
});

function api(path: string, cookie: string, method = "GET", body?: unknown) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method,
		headers: {
			cookie,
			...(body ? { "content-type": "application/json", origin: ORIGIN } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function board(): Promise<string> {
	const made = (await (
		await api("/api/boards", olive, "POST", { title: "Plan" })
	).json()) as BoardInfo;
	for (const [login, role] of [
		["eddie", "editor"],
		["vera", "viewer"],
	] as [string, Role][]) {
		const invited = await api(`/api/boards/${made.id}/members`, olive, "POST", {
			logins: [login],
			role,
		});
		expect(invited.status).toBe(200);
	}
	return made.id;
}

async function open(id: string, cookie: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status} ${result.error}`);
	clients.push(result.client);
	return result.client;
}

const pileMessages = (client: BoardClient) => client.messages as PileMessage[];

function sticky(doc: Y.Doc, id: string, text: string, parent: string | null = null) {
	addShape(doc, id, { type: "sticky", text, x: 40, y: 40, z: `b${id}`, parent });
}

const pile = (client: BoardClient, id: string) => {
	const shape = shapesMap(client.doc).get(id);
	return shape ? readShape(shape) : undefined;
};

describe("AI suggestions", () => {
	it("are on by default, name piles from their text, and say so", async () => {
		const setup = (await (await api("/api/setup", olive)).json()) as Extract<
			SetupInfo,
			{ status: "configured" }
		>;
		expect(setup.ai).toMatchObject({ state: "on", provider: "workers-ai" });
		const id = await board();
		const editor = await open(id, eddie);
		await eventually(() => pileMessages(editor).some((m) => m.type === "piles-ai" && m.enabled));

		sticky(editor.doc, "a", "Provider docs are hard to find");
		sticky(editor.doc, "b", "No example of a custom loader");
		pileUp(editor.doc, "a", ["b"], undefined, () => "p");
		await editor.roundTrip();
		const before = ai.calls.length;
		await (await boardStub(mf, id)).namePiles();
		expect(ai.calls).toHaveLength(before + 1);
		expect(ai.calls.at(-1)?.model).toMatch(/^@cf\//);
		expect(ai.calls.at(-1)?.input.response_format?.type).toBe("json_schema");
		await eventually(() => pileName(pile(editor, "p")) === "No example of");
		expect(pile(editor, "p")?.suggested?.title).toBe("No example of");

		// The same text isn't asked about twice.
		await (await boardStub(mf, id)).namePiles();
		expect(ai.calls).toHaveLength(before + 1);
	});

	it("never replace a name a person gave a pile", async () => {
		const id = await board();
		const editor = await open(id, eddie);
		sticky(editor.doc, "a", "CI takes 25 minutes");
		sticky(editor.doc, "b", "Flaky e2e on Windows");
		pileUp(editor.doc, "a", ["b"], undefined, () => "p");
		setPileName(editor.doc, "p", "Our CI");
		await editor.roundTrip();
		const before = ai.calls.length;
		await (await boardStub(mf, id)).namePiles();
		expect(ai.calls.length).toBe(before);

		// Its text changing doesn't either.
		sticky(editor.doc, "c", "Can't rerun one job");
		pileUp(editor.doc, "p", ["c"]);
		await editor.roundTrip();
		await (await boardStub(mf, id)).namePiles();
		expect(ai.calls.length).toBe(before);
		expect(pile(editor, "p")?.title).toBe("Our CI");
		expect(pile(editor, "p")?.suggested).toBeUndefined();

		// Clearing the name lets suggestions in.
		setPileName(editor.doc, "p", "");
		await editor.roundTrip();
		await (await boardStub(mf, id)).namePiles();
		expect(ai.calls.length).toBe(before + 1);
		await eventually(() => pile(editor, "p")?.suggested !== undefined);
		expect(pile(editor, "p")?.title).toBeUndefined();
	});

	it("never send silent mode's hidden text, before or after it's piled", async () => {
		const id = await board();
		const facilitator = await open(id, olive);
		const writer = await open(id, eddie);
		addShape(facilitator.doc, "ideas", {
			type: "section",
			x: 0,
			y: 0,
			w: 1200,
			h: 900,
			z: "a0",
			title: "Ideas",
		});
		await facilitator.roundTrip();
		facilitator.send({ type: "silent-start", section: "ideas", by: { name: "Olive", color: "" } });
		await eventually(
			() => parseSession(shapesMap(writer.doc).get("ideas")?.get("silent")) !== null,
		);
		writer.doc.transact(() => {
			addShape(writer.doc, "hidden", {
				type: "sticky",
				x: 40,
				y: 40,
				z: "bh",
				parent: "ideas",
				text: "",
			});
			joinSilentSession(writer.doc, "hidden");
		});
		await writer.roundTrip();
		writer.send({ type: "silent-text", shape: "hidden", text: SECRET });
		sticky(writer.doc, "seen", "Release notes are thin", "ideas");
		sticky(writer.doc, "also", "Contributors don't get credit", "ideas");
		pileUp(writer.doc, "seen", ["hidden", "also"], undefined, () => "p");
		await writer.roundTrip();

		await (await boardStub(mf, id)).namePiles();
		writer.send({ type: "pile-group", request: "g1", ids: ["seen", "hidden", "also"] });
		await eventually(() => pileMessages(writer).some((m) => "request" in m && m.request === "g1"));
		expect(ai.sent).not.toContain(SECRET);
		expect(ai.sent).toContain("Release notes are thin");
	});
});

describe("Group these", () => {
	it("proposes piles to the editor who asked, and refuses viewers", async () => {
		const id = await board();
		const editor = await open(id, eddie);
		const viewer = await open(id, vera);
		for (const [i, text] of ["One", "Two", "Three", "Four"].entries()) {
			sticky(editor.doc, `s${i}`, text);
		}
		await editor.roundTrip();
		const ids = ["s0", "s1", "s2", "s3"];
		editor.send({ type: "pile-group", request: "mine", ids });
		viewer.send({ type: "pile-group", request: "theirs", ids });
		await eventually(() => pileMessages(editor).some((m) => m.type === "pile-groups"));
		const answer = pileMessages(editor).find((m) => m.type === "pile-groups");
		expect(answer).toEqual({
			type: "pile-groups",
			request: "mine",
			piles: [
				{ name: "First half", ids: ["s0", "s1"] },
				{ name: "Second half", ids: ["s2", "s3"] },
			],
		});
		await eventually(() => pileMessages(viewer).some((m) => m.type === "pile-group-failed"));
		expect(pileMessages(viewer).find((m) => m.type === "pile-group-failed")).toMatchObject({
			request: "theirs",
			reason: "not_editor",
		});
		// Nothing was written: it's a proposal.
		expect([...shapesMap(editor.doc).values()].some((s) => s.get("type") === "pile")).toBe(false);
	});

	it("says when the model fails", async () => {
		const id = await board();
		const editor = await open(id, eddie);
		for (const [i, text] of ["One", "Two", "Three"].entries()) sticky(editor.doc, `s${i}`, text);
		await editor.roundTrip();
		ai.failing = true;
		try {
			editor.send({ type: "pile-group", request: "down", ids: ["s0", "s1", "s2"] });
			await eventually(() =>
				pileMessages(editor).some((m) => m.type === "pile-group-failed" && m.request === "down"),
			);
			expect(
				pileMessages(editor).find((m) => "request" in m && m.request === "down"),
			).toMatchObject({ reason: "failed" });
		} finally {
			ai.failing = false;
		}
	});
});

describe("turned off", () => {
	for (const [what, options] of [
		["with TACK_AI=off", { bindings: { TACK_AI: "off" } }],
		["without the AI binding", { ai: null }],
	] as const) {
		it(`names nothing ${what}, and says so`, async () => {
			const off = new FakeAi();
			const worker = startWorker({
				devAuth: true,
				outboundService: github.fetch,
				ai: off,
				...options,
			});
			try {
				await (await instanceStub(worker)).completeSetup(github.manifestCode);
				const admin = await signIn(worker, "olive", { admin: true });
				const info = (await (
					await worker.dispatchFetch(`${ORIGIN}/api/setup`, { headers: { cookie: admin } })
				).json()) as Extract<SetupInfo, { status: "configured" }>;
				expect(info.ai?.state).toBe("ai" in options ? "unavailable" : "off");
				const made = (await (
					await worker.dispatchFetch(`${ORIGIN}/api/boards`, {
						method: "POST",
						headers: { cookie: admin, origin: ORIGIN, "content-type": "application/json" },
						body: JSON.stringify({ title: "Off" }),
					})
				).json()) as BoardInfo;
				const result = await connectBoard(worker, made.id, admin);
				if (!result.ok) throw new Error("connect");
				const client = result.client;
				clients.push(client);
				await eventually(() =>
					pileMessages(client).some((m) => m.type === "piles-ai" && !m.enabled),
				);
				for (const [i, text] of ["One", "Two", "Three"].entries()) {
					sticky(client.doc, `s${i}`, text);
				}
				pileUp(client.doc, "s0", ["s1"], undefined, () => "p");
				await client.roundTrip();
				await (await boardStub(worker, made.id)).namePiles();
				expect(pile(client, "p")?.suggested).toBeUndefined();
				expect(pileName(pile(client, "p"))).toBeNull();
				client.send({ type: "pile-group", request: "off", ids: ["s0", "s1", "s2"] });
				await eventually(() =>
					pileMessages(client).some((m) => m.type === "pile-group-failed" && m.request === "off"),
				);
				expect(
					pileMessages(client).find((m) => "request" in m && m.request === "off"),
				).toMatchObject({ reason: "off" });
				expect(off.calls).toHaveLength(0);
			} finally {
				await worker.dispose();
			}
		});
	}
});
