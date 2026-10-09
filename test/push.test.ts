// The push engine (#29) end to end: changes staged in a real board's
// document over a WebSocket, pushed through `POST /api/boards/:id/push` by
// people signed in through GitHub (a fake one), applied to the fake GitHub
// in dependency order, and confirmed by webhooks or reconciliation.

import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import {
	changesMap,
	type Operation,
	type PendingChange,
	readChange,
	stageChange,
	type Stager,
} from "../src/shared/changes.ts";
import type { AuditEntry, PushResponse, RepoMeta } from "../src/shared/push.ts";
import { addDecision, stageWriteBack } from "../src/shared/decisions.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = 1;
const ELSEWHERE = 2;
const SECRET = 3;
const REPO = "github.com/acme/widgets";
const ISSUE = `${REPO}#12`;
const T0 = "2026-10-01T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };
const STAGER: Stager = { id: 501, login: "alice", name: "Alice" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(WIDGETS, "acme/widgets", {
		writers: ["alice"],
		labels: [{ name: "bug", color: "d73a4a" }],
		files: { "docs/decisions/0001-first.md": "# First" },
	});
	github.setItem(WIDGETS, { number: 12, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	// Alice could write here, but the app isn't installed.
	github.addRepo(ELSEWHERE, "acme/elsewhere", { writers: ["alice"] });
	github.setItem(ELSEWHERE, { number: 1, kind: "issue", title: "Elsewhere", updatedAt: T0 });
	github.addRepo(SECRET, "acme/secret", {
		private: true,
		collaborators: ["alice"],
		writers: ["alice"],
	});
	github.install(7, "acme", ["acme/widgets", "acme/secret"]);
	return github;
}

async function configured(github: FakeGitHub): Promise<Miniflare> {
	const mf = startWorker({ devAuth: true, outboundService: github.fetch });
	cleanups.push(() => mf.dispose());
	expect(await (await instanceStub(mf)).completeSetup(github.manifestCode)).toMatchObject({
		ok: true,
	});
	return mf;
}

function api(mf: Miniflare, path: string, cookie: string | null, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.body) {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

async function createBoard(mf: Miniflare, cookie: string): Promise<string> {
	const response = await api(mf, "/api/boards", cookie, {
		method: "POST",
		body: JSON.stringify({ title: "Planning" }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

async function open(mf: Miniflare, board: string, cookie: string): Promise<BoardClient> {
	const result = await connectBoard(mf, board, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return result.client;
}

async function push(
	mf: Miniflare,
	board: string,
	cookie: string | null,
	ids: string[],
	as: "user" | "app" = "user",
) {
	const response = await api(mf, `/api/boards/${board}/push`, cookie, {
		method: "POST",
		body: JSON.stringify({ ids, as }),
	});
	return { status: response.status, body: (await response.json()) as PushResponse };
}

function change(client: BoardClient, id: string): PendingChange | undefined {
	const map = changesMap(client.doc).get(id);
	return map ? readChange(map) : undefined;
}

async function until(
	client: BoardClient,
	id: string,
	status: PendingChange["status"],
	timeout = 8000,
) {
	await eventually(() => change(client, id)?.status === status, timeout).catch(() => {
		throw new Error(`${id} is ${JSON.stringify(change(client, id))}, not ${status}`);
	});
	return change(client, id)!;
}

/** Alice, on a new board of hers, with the push engine's pauses shortened. */
async function setup(options: { confirmMs?: number; backoffMs?: number } = {}) {
	const github = fakeGitHub();
	const mf = await configured(github);
	const alice = await signInWithGitHub(mf, github, ALICE);
	const board = await createBoard(mf, alice);
	const client = await open(mf, board, alice);
	await (
		await boardStub(mf, board)
	).pushTiming({
		spacingMs: 10,
		confirmMs: options.confirmMs ?? 60_000,
		backoffMs: options.backoffMs ?? 50,
	});
	const stage = async (id: string, op: Operation, effect?: Parameters<typeof stageChange>[3]) => {
		stageChange(client.doc, op, STAGER, { id, ...effect });
		await client.roundTrip();
	};
	return { github, mf, alice, board, client, stage };
}

const writes = (github: FakeGitHub) =>
	github.requests
		.filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"))
		.map((r) => `${r.method} ${r.path}`);

async function deliver(mf: Miniflare, github: FakeGitHub, event: string, payload: unknown) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign(github.app.webhook_secret, body),
		},
	});
	expect(response.status).toBe(202);
}

function labeled(github: FakeGitHub) {
	const item = github.item(WIDGETS, 12)!;
	return {
		action: "labeled",
		repository: { id: WIDGETS, full_name: "acme/widgets", private: false },
		issue: {
			number: 12,
			title: item.title,
			state: "open",
			html_url: "https://github.com/acme/widgets/issues/12",
			updated_at: item.updatedAt,
			labels: item.labels,
			assignees: [],
			comments: 0,
		},
	};
}

/** Put a card on the board, so its repository's cache holds it. */
async function addCard(client: BoardClient, key: string) {
	addShape(client.doc, crypto.randomUUID(), { type: "card", ref: key, x: 0, y: 0, z: "a5" });
	await client.roundTrip();
}

describe("pushing", () => {
	it("creates an issue, then makes another its sub-issue, and turns the sticky into its card", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		const doc = client.doc;
		// A sticky in a section, with a connector to another sticky.
		addShape(doc, "section", {
			type: "section",
			x: 0,
			y: 0,
			z: "a0",
			w: 800,
			h: 600,
			title: "Now",
		});
		addShape(doc, "sticky", {
			type: "sticky",
			x: 40,
			y: 60,
			z: "a3",
			parent: "section",
			text: "Wobble",
		});
		addShape(doc, "other", {
			type: "sticky",
			x: 400,
			y: 60,
			z: "a4",
			parent: "section",
			text: "Hm",
		});
		addShape(doc, "line", {
			type: "connector",
			x: 0,
			y: 0,
			z: "a6",
			from: { x: 0, y: 0, shape: "other" },
			to: { x: 40, y: 60, shape: "sticky" },
		});
		await client.roundTrip();

		await stage("sub", {
			kind: "item.subIssue",
			parent: { pending: "parent" },
			child: { key: ISSUE },
		});
		await stage(
			"parent",
			{ kind: "issue.create", repo: REPO, title: "Fix the wobble", labels: ["bug"] },
			{ shapes: ["sticky"], effect: { kind: "replace", shapes: ["sticky"] } },
		);

		const pushed = await push(mf, board, alice, ["sub", "parent"]);
		expect(pushed).toMatchObject({ status: 202, body: { ok: true } });
		const pushId = pushed.body.ok ? pushed.body.pushId : "";

		// The create goes first, though it was staged second.
		const parent = await until(client, "parent", "applied");
		expect(parent).toMatchObject({
			pushId,
			pushedBy: { id: ALICE.id, login: "alice" },
			pushedAs: "user",
			result: { key: `${REPO}#13`, url: "https://github.com/acme/widgets/issues/13" },
		});
		expect(await until(client, "sub", "applied")).toMatchObject({ pushId });
		expect(writes(github)).toEqual([
			"POST /repos/acme/widgets/issues",
			"POST /repos/acme/widgets/issues/13/sub_issues",
		]);
		expect(github.subIssues.get(`${WIDGETS}#13`)).toEqual([github.databaseId(WIDGETS, 12)]);

		// The sticky is now a card for the new issue, in its place, and the
		// connector follows it.
		await eventually(() => !shapesMap(doc).has("sticky"));
		const cards = [...shapesMap(doc)].filter(([, s]) => s.get("type") === "card");
		expect(cards).toHaveLength(1);
		const [cardId, card] = cards[0]!;
		expect(readShape(card)).toEqual({
			type: "card",
			ref: `${REPO}#13`,
			x: 40,
			y: 60,
			z: "a3",
			parent: "section",
		});
		expect(shapesMap(doc).get("line")?.get("to")).toEqual({ x: 40, y: 60, shape: cardId });
		expect(change(client, "parent")?.shapes).toEqual([cardId]);

		// The audit log.
		const log = (await (
			await api(mf, `/api/boards/${board}/pushes`, alice)
		).json()) as AuditEntry[];
		expect(log).toEqual([
			{
				pushId,
				at: expect.any(String),
				by: { login: "alice", name: "Alice" },
				as: "user",
				changes: [
					{
						id: "parent",
						summary: "Create issue “Fix the wobble” in acme/widgets",
						status: "applied",
						url: "https://github.com/acme/widgets/issues/13",
					},
					{
						id: "sub",
						summary: "Make acme/widgets#12 a sub-issue of new issue “Fix the wobble”",
						status: "applied",
						url: "https://github.com/acme/widgets/issues/13",
					},
				],
			},
		]);
	});

	it("points a decision written back as a pull request at it, with no one's client involved", async () => {
		const { mf, alice, board, client } = await setup();
		const doc = client.doc;
		addDecision(doc, "decision", { x: 0, y: 0, title: "Use Yjs", status: "decided" });
		stageWriteBack(
			doc,
			"decision",
			{
				kind: "pr.create",
				repo: REPO,
				title: "ADR 0002: Use Yjs",
				body: "",
				branch: "tack/adr-0002-use-yjs",
				files: [{ path: "docs/decisions/0002-use-yjs.md", content: "# Use Yjs" }],
			},
			STAGER,
		);
		await client.roundTrip();
		const id = shapesMap(doc).get("decision")?.get("writeback") as string;

		expect(await push(mf, board, alice, [id])).toMatchObject({ status: 202 });
		const applied = await until(client, id, "applied");
		await eventually(() => shapesMap(doc).get("decision")?.get("ref") === applied.result?.key);
		expect(applied.result?.key).toMatch(/^github\.com\/acme\/widgets#\d+$/);
	});

	it("can't undo the server's writes, and never pushes a change twice", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		await stage("c", { kind: "item.comment", target: { key: ISSUE }, body: "Hello" });
		const [first, second] = await Promise.all([
			push(mf, board, alice, ["c"]),
			push(mf, board, alice, ["c"]),
		]);
		expect([first.status, second.status].sort((a, b) => a - b)).toEqual([202, 409]);
		await until(client, "c", "applied");
		// Someone sets it back to staged in the document: the server knows better.
		changesMap(client.doc).get("c")?.set("status", "staged");
		await client.roundTrip();
		expect(await push(mf, board, alice, ["c"])).toMatchObject({
			status: 409,
			body: { reason: "busy" },
		});
		expect(github.comments).toHaveLength(1);
	});

	it("writes as the app when asked, still checking the person can write", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		await stage("c", { kind: "item.comment", target: { key: ISSUE }, body: "Beep" });
		expect((await push(mf, board, alice, ["c"], "app")).status).toBe(202);
		expect(await until(client, "c", "applied")).toMatchObject({ pushedAs: "app" });
		expect(github.comments).toMatchObject([{ body: "Beep", login: "tack-test[bot]" }]);
	});

	it("refuses a push that leaves out an issue a change needs", async () => {
		const { github, mf, alice, board, stage } = await setup();
		await stage("parent", { kind: "issue.create", repo: REPO, title: "Parent" });
		await stage("sub", {
			kind: "item.subIssue",
			parent: { pending: "parent" },
			child: { key: ISSUE },
		});
		expect(await push(mf, board, alice, ["sub"])).toMatchObject({
			status: 422,
			body: { ok: false, reason: "missing_dependency" },
		});
		expect(writes(github)).toEqual([]);
	});

	it("fails the changes that needed a create that failed, and keeps them for retrying", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		await stage("parent", { kind: "issue.create", repo: REPO, title: "Parent", milestone: "nope" });
		await stage("sub", {
			kind: "item.subIssue",
			parent: { pending: "parent" },
			child: { key: ISSUE },
		});
		await push(mf, board, alice, ["parent", "sub"]);
		expect(await until(client, "parent", "failed")).toMatchObject({
			error: "There's no milestone called “nope” in acme/widgets.",
		});
		expect(await until(client, "sub", "failed")).toMatchObject({
			error: "This needed “Create issue “Parent” in acme/widgets”, which wasn't created.",
		});
		expect(writes(github)).toEqual([]);
	});
});

describe("the fake forge", () => {
	it("takes pushes without GitHub, even from dev sign-ins, so the flow can be tried locally", async () => {
		const { mf, board } = await setup();
		const dev = await signIn(mf, "devvy");
		const client = await open(mf, board, dev);
		addShape(client.doc, "note", { type: "sticky", x: 10, y: 20, z: "a1", text: "Idea" });
		stageChange(
			client.doc,
			{ kind: "issue.create", repo: "fake.tack/demo/board", title: "Idea" },
			{ name: "Devvy" },
			{ id: "idea", effect: { kind: "replace", shapes: ["note"] } },
		);
		stageChange(
			client.doc,
			{ kind: "item.labels", target: { key: "fake.tack/demo/board#1" }, add: ["[fail]"] },
			{ name: "Devvy" },
			{ id: "nope" },
		);
		// Sub-issues and blocked-by too, so the whole flow works locally.
		stageChange(
			client.doc,
			{
				kind: "item.subIssue",
				parent: { pending: "idea" },
				child: { key: "fake.tack/demo/board#5" },
			},
			{ name: "Devvy" },
			{ id: "sub" },
		);
		stageChange(
			client.doc,
			{
				kind: "item.blockedBy",
				target: { key: "fake.tack/demo/board#6" },
				blockedBy: { pending: "idea" },
			},
			{ name: "Devvy" },
			{ id: "blocked" },
		);
		await client.roundTrip();
		expect((await push(mf, board, dev, ["idea", "nope", "sub", "blocked"])).status).toBe(202);
		const idea = await until(client, "idea", "applied");
		expect(idea.result?.key).toMatch(/^fake\.tack\/demo\/board#\d+$/);
		await eventually(() =>
			[...shapesMap(client.doc).values()].some((shape) => shape.get("ref") === idea.result?.key),
		);
		expect(await until(client, "nope", "failed")).toMatchObject({
			error: "The fake forge refused this, as asked (“[fail]”).",
		});
		await until(client, "sub", "applied");
		await until(client, "blocked", "applied");

		// The new card is an open issue, and counts as writable without any app,
		// so its actions aren't held back with "Install the app".
		const stub = await boardStub(mf, board);
		await eventually(async () =>
			(await stub.liveCards()).some((card) => card.key === idea.result?.key),
		);
		const card = (await stub.liveCards()).find((card) => card.key === idea.result?.key);
		expect(card).toMatchObject({ kind: "issue", state: "open", live: true, writable: true });
	});
});

describe("who may push", () => {
	it("needs a GitHub sign-in, edit access, write access and the app installed", async () => {
		const { github, mf, alice, board, stage } = await setup();
		await stage("c", { kind: "item.comment", target: { key: ISSUE }, body: "Hi" });
		await stage("e", {
			kind: "item.comment",
			target: { key: "github.com/acme/elsewhere#1" },
			body: "Hi",
		});

		// Not signed in: the board isn't open to them at all.
		expect((await push(mf, board, null, ["c"])).status).toBe(404);
		// Signed in without GitHub (no token to check write access with).
		const dev = await signIn(mf, "devvy");
		expect(await push(mf, board, dev, ["c"])).toMatchObject({
			status: 401,
			body: { ok: false, reason: "signed_out" },
		});
		// Bob can edit the board, but can't write to the repository.
		const bob = await signInWithGitHub(mf, github, BOB);
		expect(await push(mf, board, bob, ["c"])).toMatchObject({
			status: 403,
			body: { ok: false, reason: "no_write_access", repos: [REPO] },
		});
		// Alice can write there, but the app isn't installed.
		expect(await push(mf, board, alice, ["c", "e"])).toMatchObject({
			status: 403,
			body: { ok: false, reason: "not_installed", repos: ["github.com/acme/elsewhere"] },
		});
		// Viewers can't push at all.
		const patch = await api(mf, `/api/boards/${board}`, alice, {
			method: "PATCH",
			body: JSON.stringify({ instanceRole: "viewer" }),
		});
		expect(patch.status).toBe(200);
		expect((await push(mf, board, bob, ["c"])).status).toBe(403);

		expect(writes(github)).toEqual([]);
	});
});

describe("rate limits and retries", () => {
	it("waits out a rate limit and carries on in order", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		github.failWrites({
			status: 403,
			headers: { "retry-after": "1" },
			message: "You have exceeded a secondary rate limit",
		});
		await stage("one", { kind: "item.comment", target: { key: ISSUE }, body: "One" });
		await stage("two", { kind: "item.comment", target: { key: ISSUE }, body: "Two" });
		await push(mf, board, alice, ["one", "two"]);
		// Rate limited: still sending, and the second waits behind it.
		await eventually(() => github.requests.some((r) => r.path.endsWith("/comments")));
		expect(change(client, "one")?.status).toBe("sending");
		expect(change(client, "two")?.status).toBe("sending");
		await until(client, "one", "applied", 5000);
		await until(client, "two", "applied");
		expect(github.comments.map((c) => c.body)).toEqual(["One", "Two"]);
		expect(writes(github).filter((w) => w.endsWith("/comments"))).toHaveLength(3);
	});

	it("doesn't make anything twice when GitHub did it but the answer was lost", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		github.failWrites(
			{ status: 502, match: "/issues", after: true },
			{ status: 504, match: "/comments", after: true },
		);
		await stage("issue", { kind: "issue.create", repo: REPO, title: "Only once" });
		await stage("comment", { kind: "item.comment", target: { key: ISSUE }, body: "Only once" });
		await push(mf, board, alice, ["issue", "comment"]);
		expect(await until(client, "issue", "applied")).toMatchObject({
			result: { key: `${REPO}#13` },
		});
		await until(client, "comment", "applied");
		expect(github.itemsIn(WIDGETS).map((item) => item.title)).toEqual([
			"Widgets wobble",
			"Only once",
		]);
		expect(github.comments).toHaveLength(1);
	});

	it("gives up on a change that keeps failing, and carries on with the rest", async () => {
		const { github, mf, alice, board, client, stage } = await setup({ backoffMs: 5 });
		github.failWrites(...Array.from({ length: 8 }, () => ({ status: 500, match: "/labels" })));
		await stage("label", { kind: "item.labels", target: { key: ISSUE }, add: ["bug"] });
		await stage("comment", { kind: "item.comment", target: { key: ISSUE }, body: "Still here" });
		await push(mf, board, alice, ["label", "comment"]);
		expect(await until(client, "label", "failed")).toMatchObject({
			error: expect.stringMatching(/^Gave up after 8 tries\. GitHub had a problem \(500\)/),
		});
		await until(client, "comment", "applied");
	});
});

describe("confirmation", () => {
	it("moves a change from sent to applied when its webhook arrives", async () => {
		const { github, mf, alice, board, client, stage } = await setup();
		await addCard(client, ISSUE);
		await eventually(async () => (await (await boardStub(mf, board)).liveCards()).length > 0);
		await stage("label", { kind: "item.labels", target: { key: ISSUE }, add: ["bug"] });
		await push(mf, board, alice, ["label"]);
		// GitHub took it, but the card doesn't show it yet.
		await until(client, "label", "sent");
		expect(github.item(WIDGETS, 12)?.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
		await deliver(mf, github, "issues", labeled(github));
		await until(client, "label", "applied");
	});

	it("fails a change that never shows up, after checking once more, and lets it be retried", async () => {
		const { github, mf, alice, board, client, stage } = await setup({ confirmMs: 300 });
		await addCard(client, ISSUE);
		await eventually(async () => (await (await boardStub(mf, board)).liveCards()).length > 0);
		await stage("label", { kind: "item.labels", target: { key: ISSUE }, add: ["bug"] });
		github.dropWrites = true;
		await push(mf, board, alice, ["label"]);
		await until(client, "label", "sent");
		expect(await until(client, "label", "failed")).toMatchObject({
			error: expect.stringContaining("GitHub accepted this, but acme/widgets#12 didn't show it"),
		});

		// Retrying works, and confirms by reconciliation.
		github.dropWrites = false;
		expect((await push(mf, board, alice, ["label"])).status).toBe(202);
		await until(client, "label", "applied");
		const log = (await (
			await api(mf, `/api/boards/${board}/pushes`, alice)
		).json()) as AuditEntry[];
		expect(log.map((entry) => entry.changes[0]?.status)).toEqual(["applied", "failed"]);
	});
});

describe("repository metadata", () => {
	it("describes repositories and lists files, to people who can read them", async () => {
		const { github, mf, alice } = await setup();
		const meta = await api(mf, `/api/repos/meta?repo=${REPO}`, alice);
		expect(meta.status).toBe(200);
		expect(meta.headers.get("cache-control")).toBe("private, max-age=60");
		expect((await meta.json()) as RepoMeta).toMatchObject({
			repo: REPO,
			labels: [{ name: "bug" }],
			defaultBranch: "main",
			writable: true,
			// The forge's writes, so the UI offers only those.
			writes: expect.arrayContaining(["issue.create", "item.blockedBy", "item.comment"]),
		});
		const files = await api(mf, `/api/repos/files?repo=${REPO}&path=docs/decisions`, alice);
		expect(await files.json()).toEqual(["0001-first.md"]);

		// Private repositories only to people who can read them.
		expect((await api(mf, "/api/repos/meta?repo=github.com/acme/secret", alice)).status).toBe(200);
		const bob = await signInWithGitHub(mf, github, BOB);
		expect((await api(mf, "/api/repos/meta?repo=github.com/acme/secret", bob)).status).toBe(404);
		// And only to people on the instance.
		expect((await api(mf, `/api/repos/meta?repo=${REPO}`, null)).status).toBe(401);
		expect((await api(mf, `/api/repos/files?repo=${REPO}&path=../x`, alice)).status).toBe(400);
	});
});
