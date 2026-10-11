// Export and import (#59) end to end: boards imported from their JSON
// through the Worker, and backups of a board to an orphan branch, written
// as the app, only where the app's installed and the owner can write.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { BackupStatus } from "../src/shared/backups.ts";
import {
	BOARD_EXPORT_FORMAT,
	BOARD_EXPORT_VERSION,
	type BoardExport,
	type ImportedBoard,
	exportBoard,
	readBoardExport,
} from "../src/shared/boardExport.ts";
import { addShape } from "../src/shared/shapes.ts";
import { readShapes } from "../src/shared/structure.ts";
import { type BoardClient, connectBoard } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import {
	boardStub,
	instanceStub,
	setClock,
	signIn,
	signInWithGitHub,
	startWorker,
} from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = 1;
const ELSEWHERE = 2;
const SECRET = 3;
const T0 = "2026-10-01T00:00:00Z";
const DAY = 24 * 60 * 60_000;

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

let mf: Miniflare;
const github = new FakeGitHub();
let alice = ""; // owns boards, and can write to acme/widgets
let bob = ""; // owns a board, and can't write anywhere
let eddie = ""; // edits alice's board
const clients: BoardClient[] = [];
/** How far the Worker's clock (and the fake GitHub's, in step) has been moved on. */
let offset = 0;
github.now = () => Date.now() + offset;

async function later(ms: number): Promise<void> {
	offset = await setClock(mf, Date.now() + offset + ms);
}

beforeAll(async () => {
	github.addRepo(WIDGETS, "acme/widgets", { writers: ["alice"] });
	github.setItem(WIDGETS, { number: 12, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	// Alice could write here, but the app isn't installed.
	github.addRepo(ELSEWHERE, "acme/elsewhere", { writers: ["alice"] });
	github.addRepo(SECRET, "acme/secret", { private: true, collaborators: ["alice"] });
	github.setItem(SECRET, { number: 3, kind: "issue", title: "Secret plans", updatedAt: T0 });
	github.install(7, "acme", ["acme/widgets", "acme/secret"]);
	mf = startWorker({ devAuth: true, clock: true, outboundService: github.fetch });
	expect(await (await instanceStub(mf)).completeSetup(github.manifestCode)).toMatchObject({
		ok: true,
	});
	alice = await signInWithGitHub(mf, github, ALICE);
	bob = await signInWithGitHub(mf, github, BOB);
	eddie = await signIn(mf, "eddie");
});
afterAll(() => {
	for (const client of clients) client.close();
	return mf.dispose();
});

function api(path: string, cookie: string | null, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.body || init.method === "DELETE" || init.method === "PUT") {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

const send = (method: string, body?: unknown): RequestInit => ({
	method,
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function open(id: string, cookie: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`Connecting to ${id} failed: ${result.status}`);
	clients.push(result.client);
	return result.client;
}

async function createBoard(cookie: string, title: string): Promise<string> {
	const response = await api("/api/boards", cookie, send("POST", { title }));
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

const retro: BoardExport = {
	format: BOARD_EXPORT_FORMAT,
	version: BOARD_EXPORT_VERSION,
	title: "Retro, exported",
	exportedAt: T0,
	shapes: [
		{ id: "s", type: "section", x: 0, y: 0, w: 600, h: 400, title: "Went well", parent: null },
		{ id: "n", type: "sticky", x: 40, y: 80, text: "Shipped", color: "yellow", parent: "s" },
		{ id: "c", type: "card", x: 300, y: 80, ref: "github.com/acme/widgets#12", parent: "s" },
		{
			id: "k",
			type: "connector",
			x: 0,
			y: 0,
			from: { x: 0, y: 0, shape: "n" },
			to: { x: 0, y: 0, shape: "c" },
		},
	],
	rules: [],
	prepared: [{ id: "p", kind: "silent", section: "s", label: "Write", order: 0 }],
};

describe("importing a board", () => {
	it("makes a new board from an export, with fresh ids", async () => {
		const response = await api(
			"/api/boards/import",
			alice,
			send("POST", { board: retro, visibility: "private" }),
		);
		expect(response.status).toBe(201);
		const board = (await response.json()) as ImportedBoard;
		expect(board.title).toBe("Retro, exported");
		expect(board.visibility).toBe("private");
		expect(board.role).toBe("owner");
		expect(board.imported).toEqual({ shapes: 4, rules: 0, prepared: 1 });
		// The index has its thumbnail straight away.
		expect(board.thumbnail?.shapes.length).toBeGreaterThan(1);

		const client = await open(board.id, alice);
		const shapes = readShapes(client.doc);
		expect(shapes.size).toBe(4);
		expect([...shapes.keys()].some((id) => ["s", "n", "c", "k"].includes(id))).toBe(false);
		const section = [...shapes].find(([, shape]) => shape.type === "section")?.[0];
		const sticky = [...shapes.values()].find((shape) => shape.type === "sticky");
		expect(sticky?.parent).toBe(section);

		// Round trip: what it exports reads the same, ids aside.
		const again = exportBoard(client.doc, { title: board.title }).data;
		const plain = (data: BoardExport) =>
			data.shapes.map(({ id: _id, parent: _parent, from: _from, to: _to, ...shape }) => shape);
		expect(plain(again)).toEqual(plain(retro));
		expect(again.prepared).toHaveLength(1);
	});

	it("takes a title of its own", async () => {
		const response = await api(
			"/api/boards/import",
			alice,
			send("POST", { board: retro, title: "  Retro again " }),
		);
		expect(((await response.json()) as ImportedBoard).title).toBe("Retro again");
	});

	it("says why it can't import something, and makes no board", async () => {
		const before = (await (await api("/api/boards", alice)).json()) as { mine: unknown[] };
		const newer = await api(
			"/api/boards/import",
			alice,
			send("POST", { board: { ...retro, version: 99 } }),
		);
		expect(newer.status).toBe(422);
		expect(await newer.json()).toMatchObject({
			error: "invalid",
			reason: "newer",
			message: expect.stringMatching(/newer version of Tack/),
		});
		const broken = await api(
			"/api/boards/import",
			alice,
			send("POST", { board: { ...retro, shapes: [{ id: "x", type: "sticky", x: "left" }] } }),
		);
		expect(broken.status).toBe(422);
		const huge = await api(
			"/api/boards/import",
			alice,
			send("POST", { board: { ...retro, title: "x".repeat(5 * 1024 * 1024) } }),
		);
		expect(huge.status).toBe(413);
		const after = (await (await api("/api/boards", alice)).json()) as { mine: unknown[] };
		expect(after.mine.length).toBe(before.mine.length);
	});

	it("needs someone who may make boards", async () => {
		const response = await api("/api/boards/import", null, send("POST", { board: retro }));
		expect(response.status).toBe(401);
		const crossSite = await mf.dispatchFetch(`${ORIGIN}/api/boards/import`, {
			method: "POST",
			headers: {
				cookie: alice,
				origin: "https://evil.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({ board: retro }),
		});
		expect(crossSite.status).toBe(403);
	});
});

describe("backing a board up to a branch", () => {
	let board = "";
	let client: BoardClient;

	beforeAll(async () => {
		board = await createBoard(alice, "Roadmap");
		await api(
			`/api/boards/${board}/members`,
			alice,
			send("POST", { logins: ["eddie"], role: "editor" }),
		);
		client = await open(board, alice);
		client.doc.transact(() => {
			addShape(client.doc, "n1", { type: "sticky", x: 0, y: 0, z: "a0", text: "Ship v2" });
			addShape(client.doc, "c1", {
				type: "card",
				x: 300,
				y: 0,
				z: "a1",
				ref: "github.com/acme/widgets#12",
			});
			addShape(client.doc, "c2", {
				type: "card",
				x: 600,
				y: 0,
				z: "a2",
				ref: "github.com/acme/secret#3",
			});
		});
		await client.roundTrip();
	});

	const backup = (cookie: string, init: RequestInit = {}) =>
		api(`/api/boards/${board}/backup`, cookie, init);

	it("is off to start with, and only its owner can turn it on", async () => {
		const status = (await (await backup(alice)).json()) as BackupStatus & { canManage: boolean };
		expect(status).toMatchObject({ settings: null, canManage: true, path: `boards/${board}.json` });
		expect(await (await backup(eddie)).json()).toMatchObject({ settings: null, canManage: false });
		const refused = await backup(
			eddie,
			send("PUT", { repo: "acme/widgets", branch: "tack-backups", every: "day" }),
		);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: "owner_required" });
	});

	it("refuses repositories without the app, or that the owner can't write to", async () => {
		const elsewhere = await backup(
			alice,
			send("PUT", { repo: "acme/elsewhere", branch: "tack-backups", every: "day" }),
		);
		expect(elsewhere.status).toBe(422);
		expect(await elsewhere.json()).toMatchObject({ error: "not_installed" });

		const secret = await backup(
			alice,
			send("PUT", { repo: "acme/secret", branch: "tack-backups", every: "day" }),
		);
		expect(secret.status).toBe(403);
		expect(await secret.json()).toMatchObject({ error: "no_access" });

		const bobs = await createBoard(bob, "Bob’s");
		const notBobs = await api(
			`/api/boards/${bobs}/backup`,
			bob,
			send("PUT", { repo: "acme/widgets", branch: "tack-backups", every: "day" }),
		);
		expect(notBobs.status).toBe(403);
		expect(await notBobs.json()).toMatchObject({ error: "no_access" });

		const bad = await backup(
			alice,
			send("PUT", { repo: "acme/widgets", branch: "no spaces..", every: "day" }),
		);
		expect(await bad.json()).toMatchObject({ error: "invalid_branch" });
		expect(github.filesOn(WIDGETS, "tack-backups")).toBeNull();
	});

	it("writes the board to an orphan branch, as the app, straight away", async () => {
		const response = await backup(
			alice,
			send("PUT", { repo: "acme/widgets", branch: "tack-backups", every: "day" }),
		);
		expect(response.status).toBe(200);
		const status = (await response.json()) as BackupStatus;
		expect(status.settings).toEqual({
			repo: "github.com/acme/widgets",
			branch: "tack-backups",
			every: "day",
		});
		expect(status.error).toBeNull();
		expect(status.lastAt).not.toBeNull();
		expect(status.lastUrl).toMatch(/^https:\/\/github.com\/acme\/widgets\/commit\/\w+$/);
		expect(status.repoPublic).toBe(true);
		// The secret repository's card stayed out: anyone who can read acme/widgets can read this.
		expect(status.omitted).toEqual({ cards: 1, faceDown: 0 });

		const commits = github.commitsOn(WIDGETS, "tack-backups");
		expect(commits).toHaveLength(1);
		expect(commits[0]?.parents).toEqual([]);
		expect(commits[0]?.message).toBe("Back up “Roadmap” from Tack");
		const files = github.filesOn(WIDGETS, "tack-backups");
		expect([...(files?.keys() ?? [])]).toEqual([`boards/${board}.json`]);
		const read = readBoardExport(files?.get(`boards/${board}.json`));
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.data.title).toBe("Roadmap");
		expect(read.data.shapes.map((shape) => shape.id)).toEqual(["n1", "c1"]);
		expect(files?.get(`boards/${board}.json`)).not.toContain("secret");
	});

	it("commits on top when asked, and on schedule only when something changed", async () => {
		const run = await api(`/api/boards/${board}/backup/run`, alice, send("POST"));
		expect(run.status).toBe(200);
		expect(github.commitsOn(WIDGETS, "tack-backups")).toHaveLength(2);

		// A day later, nothing's changed: nothing's written.
		await later(DAY + 60_000);
		const stub = await boardStub(mf, board);
		await stub.runBackups();
		expect(github.commitsOn(WIDGETS, "tack-backups")).toHaveLength(2);

		addShape(client.doc, "n2", { type: "sticky", x: 0, y: 300, z: "a3", text: "And v3" });
		await client.roundTrip();
		await later(DAY + 60_000);
		await stub.runBackups();
		const commits = github.commitsOn(WIDGETS, "tack-backups");
		expect(commits).toHaveLength(3);
		expect(commits[0]?.parents).toEqual([commits[1]?.sha]);
		expect(github.filesOn(WIDGETS, "tack-backups")?.get(`boards/${board}.json`)).toContain(
			"And v3",
		);
	});

	it("says why a backup failed, and never writes to the default branch", async () => {
		const main = github.commitsOn(WIDGETS, "main").length;
		const response = await backup(
			alice,
			send("PUT", { repo: "acme/widgets", branch: "main", every: "hour" }),
		);
		const status = (await response.json()) as BackupStatus;
		expect(status.error).toMatch(/default branch/);
		expect(status.lastAt).toBeNull();
		expect(github.commitsOn(WIDGETS, "main")).toHaveLength(main);
	});

	it("stops when its owner turns it off", async () => {
		await backup(
			alice,
			send("PUT", { repo: "acme/widgets", branch: "tack-backups", every: "day" }),
		);
		const off = await backup(alice, send("DELETE"));
		expect(await off.json()).toMatchObject({ settings: null });
		const count = github.commitsOn(WIDGETS, "tack-backups").length;
		await later(2 * DAY);
		await (await boardStub(mf, board)).runBackups();
		expect(github.commitsOn(WIDGETS, "tack-backups")).toHaveLength(count);
	});
});
