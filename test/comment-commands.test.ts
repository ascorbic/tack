// Comment commands (#58) end to end: people comment `@tack add to <board>`
// on issues and pull requests in a fake GitHub, the signed webhook reaches
// the Worker, the repository's `Repo` object runs the command once, the card
// lands on a real board (read back over a WebSocket), and the app answers
// on GitHub with reactions and a reply.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import type { BoardInfo } from "../src/shared/boards.ts";
import { addSection } from "../src/shared/structure.ts";
import { readShape, shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, repoStub, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = 42;
const SECRET = 43;
const T0 = "2026-10-01T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };
const CAROL = { id: 503, login: "carol" };

const github = new FakeGitHub();
github.addRepo(WIDGETS, "acme/widgets");
github.addRepo(SECRET, "acme/secret", { private: true, collaborators: ["alice"] });
for (let n = 1; n <= 30; n++) {
	github.setItem(WIDGETS, {
		number: n,
		kind: n % 2 ? "issue" : "pull",
		title: `Widget ${n}`,
		updatedAt: T0,
	});
}
for (const n of [5, 6, 7, 8]) {
	github.setItem(SECRET, { number: n, kind: "issue", title: `Secret ${n}`, updatedAt: T0 });
}
github.install(7, "acme", ["acme/widgets", "acme/secret"]);

let mf: Miniflare;
let alice: string;
let bob: string;
const clients: BoardClient[] = [];

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	expect(await (await instanceStub(mf)).completeSetup(github.manifestCode)).toMatchObject({
		ok: true,
	});
	alice = await signInWithGitHub(mf, github, ALICE);
	bob = await signInWithGitHub(mf, github, BOB);
	// The board index meets them, so invites to them resolve at once.
	for (const cookie of [alice, bob]) await api("/api/boards", cookie);
});

afterAll(async () => {
	for (const client of clients) client.close();
	await mf.dispose();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	headers.set("cookie", cookie);
	if (init.body) {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

async function createBoard(cookie: string, title: string, visibility = "instance") {
	const response = await api("/api/boards", cookie, {
		method: "POST",
		body: JSON.stringify({ title, visibility }),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as BoardInfo;
}

async function invite(cookie: string, id: string, logins: string[], role: "editor" | "viewer") {
	const response = await api(`/api/boards/${id}/members`, cookie, {
		method: "POST",
		body: JSON.stringify({ logins, role }),
	});
	expect(response.ok).toBe(true);
}

async function deliver(payload: Record<string, unknown>, delivery = crypto.randomUUID()) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": "issue_comment",
			"x-github-delivery": delivery,
			"x-hub-signature-256": await sign(github.app.webhook_secret, body),
		},
	});
	expect(response.status).toBe(202);
	return (await response.json()) as Record<string, unknown>;
}

async function open(id: string, cookie = alice): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`connect ${id}: ${result.status}`);
	clients.push(result.client);
	return result.client;
}

function commentCards(client: BoardClient) {
	return [...shapesMap(client.doc)]
		.map(([id, shape]) => ({ id, ...readShape(shape) }))
		.filter((shape) => shape.type === "card" && shape.provenance?.via === "comment");
}

/** Wait for the app to answer a comment: a reply, and 👀 swapped for how it went. */
async function answered(repo: number, number: number, comment: number, replies = 1) {
	await eventually(
		() =>
			github.botComments(repo, number).length >= replies &&
			github.reactionsOn(comment).length > 0 &&
			!github.reactionsOn(comment).includes("eyes"),
		10_000,
	);
	return github.botComments(repo, number).at(-1) ?? "";
}

/** Let any further work (a second run, say) happen, so tests can check it didn't. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 500));
}

describe("comment commands", () => {
	it("adds an issue to the board it names, answers, and credits who asked", async () => {
		const board = await createBoard(alice, "Roadmap");
		const payload = github.comment(WIDGETS, 1, ALICE, "Looks important.\n\n@tack add to roadmap");
		expect(await deliver(payload)).toMatchObject({ status: "processed", command: "queued" });

		const reply = await answered(WIDGETS, 1, payload.comment.id);
		expect(reply).toBe(`📌 Added this issue to [**Roadmap**](${ORIGIN}/b/${board.id}/roadmap).`);
		expect(github.reactionsOn(payload.comment.id)).toEqual(["rocket"]);

		const client = await open(board.id);
		await eventually(() => commentCards(client).length === 1);
		expect(commentCards(client)[0]).toMatchObject({
			ref: "github.com/acme/widgets#1",
			provenance: {
				via: "comment",
				source: `https://github.com/acme/widgets/issues/1#issuecomment-${payload.comment.id}`,
				by: "alice",
			},
		});
	});

	it("answers to the app's slug too, and puts pull requests into the section named", async () => {
		const board = await createBoard(alice, "Launch plan");
		const client = await open(board.id);
		const section = addSection(client.doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Next up" });
		await client.roundTrip();

		const payload = github.comment(
			WIDGETS,
			2,
			ALICE,
			"@tack-test add this to launch plan in next up",
		);
		await deliver(payload);
		const reply = await answered(WIDGETS, 2, payload.comment.id);
		expect(reply).toContain("Added this pull request to [**Launch plan**]");
		expect(reply).toContain("in “Next up”");
		await eventually(() => commentCards(client).length === 1);
		expect(commentCards(client)[0]).toMatchObject({
			ref: "github.com/acme/widgets#2",
			parent: section,
		});

		// Asked again (a new comment): it's already there.
		const again = github.comment(WIDGETS, 2, ALICE, "@tack add to launch plan");
		await deliver(again);
		expect(await answered(WIDGETS, 2, again.comment.id, 2)).toContain(
			"This pull request is already on [**Launch plan**]",
		);
		expect(commentCards(client)).toHaveLength(1);
	});

	it("runs each comment once, however often it's delivered or edited", async () => {
		const board = await createBoard(alice, "Once only");
		const delivery = crypto.randomUUID();
		const payload = github.comment(WIDGETS, 3, ALICE, "@tack add to once only");
		await deliver(payload, delivery);
		await answered(WIDGETS, 3, payload.comment.id);

		// GitHub redelivers with the same id; the same body again under a new id
		// is a replay (the id isn't signed), and a second delivery of the same
		// comment that isn't byte for byte the same is remembered by comment.
		expect(await deliver(payload, delivery)).toEqual({ status: "duplicate" });
		expect(await deliver(payload)).toEqual({ status: "duplicate" });
		expect(await deliver({ ...payload, sent: "again" })).toMatchObject({
			status: "processed",
			command: "duplicate",
		});
		// Editing a comment that was already a command doesn't run it again.
		const edited = github.comment(WIDGETS, 3, ALICE, "@tack add to once only!", {
			id: payload.comment.id,
			from: "@tack add to once only",
		});
		expect(await deliver(edited)).toMatchObject({ status: "ignored", reason: "already_a_command" });

		await settle();
		expect(github.botComments(WIDGETS, 3)).toHaveLength(1);
		const client = await open(board.id);
		expect(commentCards(client)).toHaveLength(1);
	});

	it("tries again when GitHub falls over, without replying twice", async () => {
		await createBoard(alice, "Wobbly");
		const repo = await repoStub(mf, `github.com/@${WIDGETS}`);
		await repo.commandTiming({ retryMs: [200, 200, 200] });
		// GitHub posts the reply, but the answer is lost.
		github.failWrites({ status: 502, match: "/issues/13/comments", after: true });
		const payload = github.comment(WIDGETS, 13, ALICE, "@tack add to wobbly");
		await deliver(payload);
		expect(await answered(WIDGETS, 13, payload.comment.id)).toContain("[**Wobbly**]");
		await eventually(async () =>
			(await repo.commentCommands()).some(
				(c) => c.comment === String(payload.comment.id) && c.status === "done",
			),
		);
		expect(
			(await repo.commentCommands()).find((c) => c.comment === String(payload.comment.id)),
		).toMatchObject({ attempts: 2, outcome: "added" });
		await settle();
		expect(github.botComments(WIDGETS, 13)).toHaveLength(1);
		expect(github.reactionsOn(payload.comment.id)).toEqual(["rocket"]);
	});

	it("runs a comment edited into a command", async () => {
		const board = await createBoard(alice, "Edited in");
		const first = github.comment(WIDGETS, 5, ALICE, "Should this go somewhere?");
		expect(await deliver(first)).toMatchObject({ status: "ignored", reason: "no_command" });
		const edited = github.comment(WIDGETS, 5, ALICE, "@tack add to edited in", {
			id: first.comment.id,
			from: "Should this go somewhere?",
		});
		expect(await deliver(edited)).toMatchObject({ command: "queued" });
		expect(await answered(WIDGETS, 5, first.comment.id)).toContain("[**Edited in**]");
		const client = await open(board.id);
		await eventually(() => commentCards(client).length === 1);
	});

	it("never listens to bots, its own replies included", async () => {
		await createBoard(alice, "Bots");
		const bot = github.comment(
			WIDGETS,
			7,
			{ id: 900, login: "renovate[bot]", type: "Bot" },
			"@tack add to bots",
		);
		expect(await deliver(bot)).toEqual({ status: "ignored", reason: "bot" });
		const own = github.comment(
			WIDGETS,
			7,
			{ id: 901, login: "tack-test[bot]", type: "Bot" },
			"👋 Try `@tack help`, or @tack add to bots",
		);
		expect(await deliver(own)).toEqual({ status: "ignored", reason: "bot" });
		await settle();
		expect(github.reactionsOn(bot.comment.id)).toEqual([]);
		expect(github.botComments(WIDGETS, 7)).toEqual(["👋 Try `@tack help`, or @tack add to bots"]);
	});

	it("says when a name could be several boards, naming only public ones", async () => {
		await createBoard(alice, "Big plans");
		await createBoard(alice, "Big plans 2025", "public");
		await createBoard(alice, "Big plans: acquisitions", "private");
		const payload = github.comment(WIDGETS, 9, ALICE, "@tack add to big");
		await deliver(payload);
		const reply = await answered(WIDGETS, 9, payload.comment.id);
		expect(reply).toContain("“big” could be more than one of your boards");
		expect(reply).toContain("[**Big plans 2025**]");
		expect(reply).toContain("and 2 more that aren't public");
		expect(reply).not.toMatch(/acquisitions|Big plans\*\*\]\(/);
		expect(github.reactionsOn(payload.comment.id)).toEqual(["confused"]);

		const none = github.comment(WIDGETS, 9, ALICE, "@tack add to nothing like it");
		await deliver(none);
		expect(await answered(WIDGETS, 9, none.comment.id, 2)).toContain(
			"I couldn't find a board called “nothing like it” that you can edit",
		);
	});

	it("only adds for people who can edit the board, and who've signed in", async () => {
		const board = await createBoard(alice, "Alice's notes", "private");
		await invite(alice, board.id, ["bob"], "viewer");
		const viewer = github.comment(WIDGETS, 11, BOB, "@tack add to alice's notes");
		await deliver(viewer);
		expect(await answered(WIDGETS, 11, viewer.comment.id)).toContain(
			"You can see “alice's notes” but can't edit it",
		);

		// Boards bob can't open at all aren't there, as far as he's concerned.
		const other = await createBoard(alice, "Hidden away", "private");
		const stranger = github.comment(WIDGETS, 11, BOB, `@tack add to ${ORIGIN}/b/${other.id}`);
		await deliver(stranger);
		expect(await answered(WIDGETS, 11, stranger.comment.id, 2)).toContain(
			"I couldn't find a board",
		);

		const unknown = github.comment(WIDGETS, 11, CAROL, "@tack add to roadmap");
		await deliver(unknown);
		expect(await answered(WIDGETS, 11, unknown.comment.id, 3)).toBe(
			`👋 I don't know you on Tack yet. [Sign in](${ORIGIN}/) once, then ask me again.`,
		);

		// Anyone can ask for help.
		const help = github.comment(WIDGETS, 11, CAROL, "@tack help");
		await deliver(help);
		expect(await answered(WIDGETS, 11, help.comment.id, 4)).toContain(
			"`@tack add to <board> in <section>`",
		);
		expect(github.reactionsOn(help.comment.id)).toEqual(["rocket"]);

		const client = await open(board.id);
		expect(commentCards(client)).toEqual([]);
	});

	it("only puts private items on private boards whose members can all read them", async () => {
		const mine = await createBoard(alice, "Secret plans", "private");
		const ok = github.comment(SECRET, 5, ALICE, "@tack add to secret plans");
		await deliver(ok);
		expect(await answered(SECRET, 5, ok.comment.id)).toContain("📌 Added this issue to");
		const client = await open(mine.id);
		await eventually(() => commentCards(client).length === 1);

		await createBoard(alice, "Open plans");
		const open_ = github.comment(SECRET, 6, ALICE, "@tack add to open plans");
		await deliver(open_);
		expect(await answered(SECRET, 6, open_.comment.id)).toContain("it isn't a private board");

		const shared = await createBoard(alice, "Shared plans", "private");
		await invite(alice, shared.id, ["bob"], "editor");
		// Bob shows up, so his invite resolves; he can't read acme/secret.
		await api("/api/boards", bob);
		const members = github.comment(SECRET, 7, ALICE, "@tack add to shared plans");
		await deliver(members);
		expect(await answered(SECRET, 7, members.comment.id)).toContain(
			"not everyone on it can read this repository",
		);

		const pending = await createBoard(alice, "Pending plans", "private");
		// On GitHub, but never signed in here: an invite that hasn't resolved.
		github.addUser({ id: 404, login: "dave", name: "Dave", avatar_url: "" });
		await invite(alice, pending.id, ["dave"], "viewer");
		const waiting = github.comment(SECRET, 8, ALICE, "@tack add to pending plans");
		await deliver(waiting);
		expect(await answered(SECRET, 8, waiting.comment.id)).toContain(
			"someone's been invited to it who hasn't signed in yet",
		);

		for (const id of [shared.id, pending.id]) {
			const board = await open(id);
			expect(commentCards(board)).toEqual([]);
		}
	});
});
