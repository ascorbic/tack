// Comments (#51) and "since you were here" (#46) end to end: real boards in
// Miniflare, opened over WebSockets by people with different roles, with
// requests checked on the server and notifications landing in the inbox.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { BoardInfo, Role } from "../src/shared/boards.ts";
import type {
	CommentEvent,
	CommentRequest,
	CommentThread,
	CommentsYou,
	Mentionable,
	NotificationList,
} from "../src/shared/comments.ts";
import { addShape, nextZ, shapesMap } from "../src/shared/shapes.ts";
import type { Digest, SinceEvent } from "../src/shared/since.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

let mf: Miniflare;
const github = new FakeGitHub();
let olive = ""; // owns the boards
let eddie = ""; // an editor
let vera = ""; // a viewer
let oscar = ""; // allowed on the instance, but not on the private board

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	olive = await signIn(mf, "olive", { name: "Olive Owner" });
	eddie = await signIn(mf, "eddie", { name: "Eddie Editor" });
	vera = await signIn(mf, "vera", { name: "Véra Viewer" });
	oscar = await signIn(mf, "oscar");
	// Known to the index, so invites resolve to them straight away.
	for (const cookie of [olive, eddie, vera, oscar]) await json("/api/boards", cookie);
});
afterAll(() => mf.dispose());

const clients: BoardClient[] = [];
afterAll(() => {
	for (const client of clients) client.close();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.body) {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

async function json<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
	const response = await api(path, cookie, init);
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json() as Promise<T>;
}

async function board(visibility = "private", members: [string, Role][] = []): Promise<BoardInfo> {
	const info = await json<BoardInfo>("/api/boards", olive, {
		method: "POST",
		body: JSON.stringify({ title: "Retro", visibility }),
	});
	for (const [login, role] of members) {
		await json(`/api/boards/${info.id}/members`, olive, {
			method: "POST",
			body: JSON.stringify({ logins: [login], role }),
		});
	}
	return info;
}

async function open(id: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status} ${result.error}`);
	clients.push(result.client);
	await eventually(() => events(result.client).some((e) => e.type === "comments"));
	return result.client;
}

function events(client: BoardClient): (CommentEvent | SinceEvent)[] {
	return client.messages as (CommentEvent | SinceEvent)[];
}

function you(client: BoardClient): CommentsYou {
	const latest = events(client)
		.filter((e) => e.type === "comments" || e.type === "comments-you")
		.at(-1) as { you: CommentsYou };
	return latest.you;
}

/** The latest state of a thread this client has heard about. */
function thread(client: BoardClient, id: string): CommentThread | null | undefined {
	let found: CommentThread | null | undefined;
	for (const event of events(client)) {
		if (event.type === "comments") {
			const match = event.threads.find((t) => t.id === id);
			if (event.first) found = match;
			else if (match) found = match;
		}
		if (event.type === "comment-thread" && event.thread.id === id) found = event.thread;
		if (event.type === "comment-removed" && event.thread === id) found = null;
	}
	return found;
}

function refusal(client: BoardClient, id: string): string | undefined {
	return events(client)
		.filter((e) => e.type === "comment-refused" && e.thread === id)
		.map((e) => (e as { reason: string }).reason)
		.at(-1);
}

let seq = 0;
const newId = (prefix: string) => `${prefix}${++seq}xxxxxx`;

function send(client: BoardClient, request: CommentRequest) {
	client.send(request);
}

function start(client: BoardClient, body: string, anchor = { x: 100, y: 200 }) {
	const id = newId("t");
	send(client, { type: "comment-start", thread: id, message: newId("m"), anchor, body });
	return id;
}

async function digest(client: BoardClient, since?: number): Promise<Digest> {
	const before = events(client).filter((e) => e.type === "since").length;
	client.send({ type: "since-request", ...(since === undefined ? {} : { since }) });
	await eventually(() => events(client).filter((e) => e.type === "since").length > before);
	return (
		events(client)
			.filter((e) => e.type === "since")
			.at(-1) as SinceEvent
	).digest;
}

describe("comments", () => {
	it("lets viewers comment, attributed by the server, and everyone sees it live", async () => {
		const info = await board("private", [
			["eddie", "editor"],
			["vera", "viewer"],
		]);
		const owner = await open(info.id, olive);
		const viewer = await open(info.id, vera);
		expect(you(viewer)).toMatchObject({ canComment: true, canTriage: false, canModerate: false });
		expect(you(owner)).toMatchObject({ canComment: true, canTriage: true, canModerate: true });

		const id = start(viewer, "  Should this be two issues?  ");
		await eventually(() => thread(owner, id) != null);
		const seen = thread(owner, id)!;
		expect(seen.messages).toHaveLength(1);
		expect(seen.messages[0]).toMatchObject({ body: "Should this be two issues?" });
		expect(seen.messages[0]?.author).toMatchObject({ login: "vera", name: "Véra Viewer" });
		expect(seen.anchor).toEqual({ x: 100, y: 200 });

		// Concurrent replies both land, in the order they arrived.
		const editor = await open(info.id, eddie);
		send(owner, { type: "comment-reply", thread: id, message: newId("m"), body: "Yes" });
		send(editor, { type: "comment-reply", thread: id, message: newId("m"), body: "Agreed" });
		await eventually(() => thread(viewer, id)?.messages.length === 3);
		expect(
			thread(viewer, id)
				?.messages.map((m) => m.body)
				.sort(),
		).toEqual(["Agreed", "Should this be two issues?", "Yes"]);

		// And they're stored: a new connection gets them all.
		const later = await open(info.id, eddie);
		expect(thread(later, id)?.messages).toHaveLength(3);
		expect(await (await boardStub(mf, info.id)).commentThreads()).toHaveLength(1);
	});

	it("only lets people edit and delete their own messages; owners can delete anyone's", async () => {
		const info = await board("private", [
			["eddie", "editor"],
			["vera", "viewer"],
		]);
		const owner = await open(info.id, olive);
		const viewer = await open(info.id, vera);
		const editor = await open(info.id, eddie);
		const id = newId("t");
		const first = newId("m");
		send(viewer, {
			type: "comment-start",
			thread: id,
			message: first,
			anchor: { x: 0, y: 0 },
			body: "First",
		});
		await eventually(() => thread(editor, id) != null);

		send(editor, { type: "comment-edit", thread: id, message: first, body: "Hijacked" });
		await eventually(() => refusal(editor, id) === "forbidden");
		send(editor, { type: "comment-delete", thread: id, message: first });
		await eventually(() => events(editor).filter((e) => e.type === "comment-refused").length === 2);
		expect(thread(owner, id)?.messages[0]?.body).toBe("First");

		send(viewer, { type: "comment-edit", thread: id, message: first, body: "First, edited" });
		await eventually(() => thread(owner, id)?.messages[0]?.body === "First, edited");
		expect(thread(owner, id)?.messages[0]?.editedAt).toBeTypeOf("number");

		// The owner moderates: the thread goes, for everyone.
		send(owner, { type: "comment-delete", thread: id, message: first });
		await eventually(() => thread(editor, id) === null);
		// Only its author can bring it back.
		send(owner, { type: "comment-restore", thread: id, message: first });
		await eventually(() => refusal(owner, id) === "forbidden");
		send(viewer, { type: "comment-restore", thread: id, message: first });
		await eventually(() => thread(editor, id)?.messages[0]?.body === "First, edited");
	});

	it("lets editors resolve any thread, and viewers only their own", async () => {
		const info = await board("private", [
			["eddie", "editor"],
			["vera", "viewer"],
		]);
		const owner = await open(info.id, olive);
		const viewer = await open(info.id, vera);
		const editor = await open(info.id, eddie);
		const mine = start(viewer, "Mine");
		const theirs = start(owner, "Theirs");
		await eventually(() => !!thread(viewer, theirs) && !!thread(viewer, mine));

		send(viewer, { type: "comment-resolve", thread: theirs, resolved: true });
		await eventually(() => refusal(viewer, theirs) === "forbidden");
		send(viewer, { type: "comment-resolve", thread: mine, resolved: true });
		await eventually(() => thread(owner, mine)?.resolved?.by.login === "vera");
		send(editor, { type: "comment-resolve", thread: theirs, resolved: true });
		await eventually(() => thread(owner, theirs)?.resolved?.by.login === "eddie");

		// Replying reopens.
		send(owner, { type: "comment-reply", thread: mine, message: newId("m"), body: "Not yet" });
		await eventually(() => thread(viewer, mine)?.resolved === null);
	});

	it("refuses signed-out visitors and archived boards, but they can still read", async () => {
		const info = await board("public");
		const owner = await open(info.id, olive);
		const id = start(owner, "Public note");
		await eventually(() => !!thread(owner, id));

		const anonymous = await open(info.id);
		expect(you(anonymous)).toMatchObject({ canComment: false, reason: "signed_out", id: null });
		expect(thread(anonymous, id)?.messages[0]?.body).toBe("Public note");
		const attempt = start(anonymous, "Drive-by");
		await eventually(() => refusal(anonymous, attempt) === "signed_out");

		const archived = await api(`/api/boards/${info.id}`, olive, {
			method: "PATCH",
			body: JSON.stringify({ archived: true }),
		});
		expect(archived.status).toBe(200);
		await eventually(() => you(owner).canComment === false);
		expect(you(owner).reason).toBe("archived");
		const late = start(owner, "After archiving");
		await eventually(() => refusal(owner, late) === "archived");
	});

	it("validates requests", async () => {
		const info = await board();
		const owner = await open(info.id, olive);
		const bad = newId("t");
		send(owner, {
			type: "comment-start",
			thread: bad,
			message: newId("m"),
			anchor: { x: Number.NaN, y: 0 } as never,
			body: "x",
		});
		await eventually(() => refusal(owner, bad) === "invalid");
		const empty = start(owner, "   ");
		await eventually(() => refusal(owner, empty) === "invalid");
		send(owner, { type: "comment-reply", thread: "nothere123", message: newId("m"), body: "x" });
		await eventually(() => refusal(owner, "nothere123") === "not_found");
	});

	it("checks mentions against the board's people and notifies them", async () => {
		const info = await board("private", [["vera", "viewer"]]);
		for (const cookie of [vera, olive]) {
			await json("/api/notifications/read", cookie, { method: "POST", body: '{"all":true}' });
		}
		const people = await json<{ people: Mentionable[] }>(`/api/boards/${info.id}/people`, olive);
		expect(people.people.map((p) => p.login).sort()).toEqual(["olive", "vera"]);
		expect((await api(`/api/boards/${info.id}/people`, oscar)).status).toBe(403);

		const owner = await open(info.id, olive);
		const id = start(owner, "@vera can you look? cc @oscar and me@olive.example");
		await eventually(() => !!thread(owner, id));
		// Oscar can't open the board, so isn't mentioned; an email address isn't a mention.
		expect(thread(owner, id)?.messages[0]?.mentions).toEqual(["vera"]);

		await eventually(async () => {
			const inbox = await json<NotificationList>("/api/notifications", vera);
			return inbox.unread === 1;
		});
		const inbox = await json<NotificationList>("/api/notifications", vera);
		expect(inbox.notifications[0]).toMatchObject({
			kind: "mention",
			thread: id,
			board: { id: info.id, title: "Retro" },
			by: { login: "olive" },
			read: false,
		});
		const oscars = await json<NotificationList>("/api/notifications", oscar);
		expect(oscars.notifications.filter((n) => n.board.id === info.id)).toEqual([]);

		// A reply notifies the people already in the thread.
		const viewer = await open(info.id, vera);
		send(viewer, { type: "comment-reply", thread: id, message: newId("m"), body: "On it" });
		await eventually(async () => {
			const list = await json<NotificationList>("/api/notifications", olive);
			return list.notifications.some((n) => n.kind === "reply" && n.thread === id);
		});

		const read = await json<NotificationList>("/api/notifications/read", vera, {
			method: "POST",
			body: JSON.stringify({ board: info.id, thread: id }),
		});
		expect(read.unread).toBe(0);
		expect((await api("/api/notifications", "")).status).toBe(401);

		// Losing access hides a board's notifications.
		await api(`/api/boards/${info.id}/members/vera`, olive, { method: "DELETE" });
		const after = await json<NotificationList>("/api/notifications", vera);
		expect(after.notifications.filter((n) => n.board.id === info.id)).toEqual([]);
	});

	it("keeps read state per person, private to them", async () => {
		const info = await board("private", [["vera", "viewer"]]);
		const owner = await open(info.id, olive);
		const viewer = await open(info.id, vera);
		const id = start(viewer, "Unread for Olive");
		await eventually(() => !!thread(owner, id));
		send(owner, { type: "comment-read", thread: id });
		await eventually(() => events(owner).some((e) => e.type === "comment-reads"));
		const reads = events(owner).find((e) => e.type === "comment-reads") as {
			reads: Record<string, number>;
		};
		expect(reads.reads[id]).toBeTypeOf("number");
		await viewer.roundTrip();
		expect(events(viewer).some((e) => e.type === "comment-reads")).toBe(false);

		// It's remembered.
		const again = await open(info.id, olive);
		expect(you(again).reads[id]).toBe(reads.reads[id]);
		expect(you(again).since).toBeTypeOf("number");
	});

	it("keeps a pin's resting place in step with its shape, and with it when deleted", async () => {
		const info = await board();
		const owner = await open(info.id, olive);
		addShape(owner.doc, "card-a", { type: "sticky", x: 10, y: 20, z: nextZ(owner.doc), text: "" });
		await owner.roundTrip();
		const id = start(owner, "On the sticky", { x: 40, y: 50 });
		// Anchored to the shape, at an offset.
		const id2 = newId("t");
		send(owner, {
			type: "comment-start",
			thread: id2,
			message: newId("m"),
			anchor: { x: 40, y: 50, shape: "card-a", dx: 30, dy: 30 },
			body: "Pinned",
		});
		await eventually(() => !!thread(owner, id) && !!thread(owner, id2));
		shapesMap(owner.doc).get("card-a")?.set("x", 500);
		await owner.roundTrip();
		shapesMap(owner.doc).delete("card-a");
		await eventually(() => thread(owner, id2)?.anchor.x === 530);
		expect(thread(owner, id2)?.anchor).toMatchObject({ shape: "card-a", dx: 30, y: 50 });
	});
});

describe("since you were here", () => {
	it("lists other people's edits since a visit, not your own", async () => {
		const info = await board("private", [["eddie", "editor"]]);
		const owner = await open(info.id, olive);
		// A first visit has nothing to show.
		expect((await digest(owner)).since).toBeNull();
		owner.send({ type: "since-seen" });
		await eventually(() => events(owner).filter((e) => e.type === "since").length === 2);
		const seen = (events(owner).at(-1) as SinceEvent).digest;
		expect(seen.since).toBeTypeOf("number");

		const editor = await open(info.id, eddie);
		addShape(editor.doc, "s1", { type: "sticky", x: 0, y: 0, z: nextZ(editor.doc), text: "hi" });
		addShape(editor.doc, "s2", { type: "sticky", x: 0, y: 0, z: nextZ(editor.doc), text: "" });
		await editor.roundTrip();
		shapesMap(editor.doc).get("s2")?.set("text", "edited later");
		addShape(owner.doc, "mine", { type: "sticky", x: 0, y: 0, z: nextZ(owner.doc), text: "" });
		await owner.roundTrip();
		await editor.roundTrip();

		const after = await digest(owner);
		expect(after.since).toBe(seen.since);
		// Shapes added since then are new; their later edits are part of that.
		expect(after.edits.map((e) => `${e.shape}:${e.kind}`).sort()).toEqual(["s1:added", "s2:added"]);
		expect(after.edits[0]?.by).toMatchObject({ kind: "person", login: "eddie" });
		expect(after.edits[0]?.type).toBe("sticky");

		// Mark all as seen: nothing left.
		owner.send({ type: "since-seen" });
		await eventually(() => {
			const latest = events(owner)
				.filter((e) => e.type === "since")
				.at(-1) as SinceEvent;
			return latest.digest.since !== seen.since && latest.digest.edits.length === 0;
		});
	});

	it("starts a new visit after time away, and reloading doesn't lose the digest", async () => {
		const info = await board("private", [["eddie", "editor"]]);
		const stub = await boardStub(mf, info.id);
		const first = await open(info.id, olive);
		expect((await digest(first)).since).toBeNull();
		first.close();

		// Away (any time at all counts, for the test), while Eddie works.
		await stub.sinceTiming({ gapMs: 0 });
		const editor = await open(info.id, eddie);
		addShape(editor.doc, "while-away", { type: "sticky", x: 0, y: 0, z: "a1", text: "hi" });
		await editor.roundTrip();
		const back = await open(info.id, olive);
		const result = await digest(back);
		expect(result.since).toBeTypeOf("number");
		expect(result.edits.map((e) => e.shape)).toEqual(["while-away"]);

		// A reload moments later is the same visit: the digest is still there.
		await stub.sinceTiming({ gapMs: 60 * 60_000 });
		back.close();
		const reloaded = await open(info.id, olive);
		const again = await digest(reloaded);
		expect(again.since).toBe(result.since);
		expect(again.edits.map((e) => e.shape)).toEqual(["while-away"]);
	});

	it("works from a time the browser remembers for signed-out visitors", async () => {
		const info = await board("public");
		const owner = await open(info.id, olive);
		const before = Date.now() - 1000;
		addShape(owner.doc, "pub", { type: "text", x: 0, y: 0, z: nextZ(owner.doc), text: "hello" });
		await owner.roundTrip();
		const anonymous = await open(info.id);
		const result = await digest(anonymous, before);
		expect(result.edits.map((e) => e.shape)).toEqual(["pub"]);
		expect(result.edits[0]?.by.login).toBe("olive");
		expect((await digest(anonymous)).since).toBeNull();
	});
});
