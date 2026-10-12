// Weekly digests (#68) end to end: a board's owner turns them on, a member
// asks for them by email and confirms, and the weeks go by on a test clock.
// Each week's digest is posted once as a Discussion (as the app, in a
// public repository, leaving out a private repository's cards) and emailed
// once to each member as they may see it; a quiet week sends nothing.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import type { CardMessage } from "../src/shared/cards.ts";
import type { DigestView } from "../src/shared/digests.ts";
import { addShape } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeEmail } from "./fake-email.ts";
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
const SECRET = 2;
const QUIET = 3;
const T0 = "2026-10-01T00:00:00Z";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

let mf: Miniflare;
const github = new FakeGitHub();
const mail = new FakeEmail();
let alice = ""; // owns the board, writes to acme/widgets, reads acme/secret
let bob = ""; // edits the board, can't read acme/secret
let carol = ""; // not on the board
let board = "";
let client: BoardClient;
let offset = 0;
github.now = () => Date.now() + offset;

/** Move the Worker's clock (and the fake GitHub's) to `at`. */
async function moveTo(at: number): Promise<void> {
	offset = await setClock(mf, Math.max(at, Date.now() + offset));
}
const now = () => Date.now() + offset;

function api(path: string, cookie: string | null, init: { method?: string; body?: unknown } = {}) {
	const headers = new Headers();
	if (cookie) headers.set("cookie", cookie);
	if (init.method && init.method !== "GET") headers.set("origin", ORIGIN);
	if (init.body !== undefined) headers.set("content-type", "application/json");
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method: init.method ?? "GET",
		headers,
		...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
	} as never);
}

async function deliver(payload: Record<string, unknown>, event = "issues") {
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

const digest = (cookie: string) => api(`/api/boards/${board}/digest`, cookie);
const view = async (cookie: string) => (await (await digest(cookie)).json()) as DigestView;

const SETTINGS = {
	discussion: { repo: "acme/widgets", category: "Announcements" },
	email: true,
	weekday: 1,
	hour: 9,
	timeZone: "Europe/London",
};

beforeAll(async () => {
	github.addRepo(WIDGETS, "acme/widgets", {
		writers: ["alice"],
		discussionCategories: ["General", "Announcements"],
	});
	github.setItem(WIDGETS, { number: 12, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	github.addRepo(SECRET, "acme/secret", {
		private: true,
		collaborators: ["alice"],
		writers: ["alice"],
	});
	github.setItem(SECRET, { number: 3, kind: "issue", title: "Secret plans", updatedAt: T0 });
	github.addRepo(QUIET, "acme/quiet", { writers: ["alice"] });
	github.install(7, "acme", ["acme/widgets", "acme/secret", "acme/quiet"]);
	mf = startWorker({
		devAuth: true,
		clock: true,
		outboundService: github.fetch,
		email: mail.fetch,
	});
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	alice = await signInWithGitHub(mf, github, ALICE);
	bob = await signInWithGitHub(mf, github, BOB);
	carol = await signIn(mf, "carol");

	const made = await api("/api/boards", alice, {
		method: "POST",
		body: { title: "Roadmap", visibility: "private" },
	});
	expect(made.status).toBe(201);
	board = ((await made.json()) as { id: string }).id;
	const invited = await api(`/api/boards/${board}/members`, alice, {
		method: "POST",
		body: { logins: ["bob"], role: "editor" },
	});
	expect(invited.status).toBe(200);

	const result = await connectBoard(mf, board, alice);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	client = result.client;
	addShape(client.doc, "c1", {
		type: "card",
		x: 0,
		y: 0,
		z: "a1",
		ref: "github.com/acme/widgets#12",
	});
	addShape(client.doc, "c2", {
		type: "card",
		x: 300,
		y: 0,
		z: "a2",
		ref: "github.com/acme/secret#3",
	});
	addShape(client.doc, "s1", { type: "sticky", x: 0, y: 300, z: "a3", text: "Ship faster" });
	await client.roundTrip();
	// Both cards are on the board, open, before the first week starts.
	const arrived = (key: string) =>
		(client.messages as CardMessage[]).some(
			(message) =>
				message.type === "cards" &&
				message.cards.some((card) => card.key === key && !("missing" in card)),
		);
	await eventually(
		() => arrived("github.com/acme/widgets#12") && arrived("github.com/acme/secret#3"),
		8000,
	);
});

afterAll(async () => {
	client?.close();
	await mf.dispose();
});

describe("turning digests on", () => {
	it("is off until the owner turns it on, and only the owner can", async () => {
		const first = await view(bob);
		expect(first).toMatchObject({ settings: null, canManage: false, emailAvailable: true });
		expect([403, 404]).toContain((await digest(carol)).status);
		expect((await api(`/api/boards/${board}/digest`, null)).status).toBe(401);
		const refused = await api(`/api/boards/${board}/digest`, bob, {
			method: "PUT",
			body: SETTINGS,
		});
		expect(refused.status).toBe(403);
	});

	it("only posts where the app's installed, Discussions are on, and the category's there", async () => {
		const put = (discussion: unknown) =>
			api(`/api/boards/${board}/digest`, alice, {
				method: "PUT",
				body: { ...SETTINGS, discussion },
			});
		const noCategory = await put({ repo: "acme/widgets", category: "Ideas" });
		expect(noCategory.status).toBe(422);
		expect(await noCategory.json()).toMatchObject({ error: "invalid_category" });
		const off = await put({ repo: "acme/quiet", category: "General" });
		expect(await off.json()).toMatchObject({ error: "discussions_off" });
		const nowhere = await api(`/api/boards/${board}/digest`, alice, {
			method: "PUT",
			body: { ...SETTINGS, discussion: null, email: false },
		});
		expect(nowhere.status).toBe(400);
		const zone = await api(`/api/boards/${board}/digest`, alice, {
			method: "PUT",
			body: { ...SETTINGS, timeZone: "Mars/Olympus" },
		});
		expect(zone.status).toBe(400);
	});

	it("turns on for the owner, with when the next one goes", async () => {
		const response = await api(`/api/boards/${board}/digest`, alice, {
			method: "PUT",
			body: SETTINGS,
		});
		expect(response.status).toBe(200);
		const status = (await response.json()) as DigestView;
		expect(status.settings).toEqual({
			...SETTINGS,
			discussion: { repo: "github.com/acme/widgets", category: "Announcements" },
		});
		expect(status.canManage).toBe(true);
		expect(status.repoPublic).toBe(true);
		expect(status.nextAt).toBeGreaterThan(now());
		expect(status.nextAt).toBeLessThanOrEqual(now() + 7 * DAY);
		// Editors see what the Discussion would say so far.
		const bobs = await view(bob);
		expect(bobs.preview.markdown).toContain("Roadmap");
		expect(bobs.settings?.discussion?.repo).toBe("github.com/acme/widgets");
	});
});

describe("asking for it by email", () => {
	it("sends a confirmation first, and nothing else until it's followed", async () => {
		const bad = await api(`/api/boards/${board}/digest/subscription`, bob, {
			method: "PUT",
			body: { email: "not an address" },
		});
		expect(bad.status).toBe(422);
		const outsider = await api(`/api/boards/${board}/digest/subscription`, carol, {
			method: "PUT",
			body: { email: "carol@example.com" },
		});
		expect([403, 404]).toContain(outsider.status);

		const asked = await api(`/api/boards/${board}/digest/subscription`, bob, {
			method: "PUT",
			body: { email: "bob@example.com" },
		});
		expect(asked.status).toBe(200);
		expect(((await asked.json()) as DigestView).subscription).toEqual({
			email: "bob@example.com",
			confirmed: false,
		});
		const [confirmation] = mail.to("bob@example.com");
		expect(confirmation?.subject).toBe("Confirm the weekly digest of Roadmap");
		// Asking again straight away doesn't send another.
		const again = await api(`/api/boards/${board}/digest/subscription`, bob, {
			method: "PUT",
			body: { email: "bob@example.com" },
		});
		expect(again.status).toBe(429);
		expect(mail.to("bob@example.com")).toHaveLength(1);

		const link = new URL(mail.link(confirmation!, `${ORIGIN}/digest?confirm=`));
		const token = link.searchParams.get("confirm");
		const forged = await api("/api/digests/confirm", null, {
			method: "POST",
			body: { token: `${token}x` },
		});
		expect(forged.status).toBe(410);
		const confirmed = await api("/api/digests/confirm", null, { method: "POST", body: { token } });
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).toMatchObject({ ok: true, title: "Roadmap" });
		expect((await view(bob)).subscription).toEqual({ email: "bob@example.com", confirmed: true });
		expect((await view(alice)).subscribers).toBe(1);
	});

	it("lets the owner have it too", async () => {
		await api(`/api/boards/${board}/digest/subscription`, alice, {
			method: "PUT",
			body: { email: "alice@example.com" },
		});
		const [confirmation] = mail.to("alice@example.com");
		const token = new URL(mail.link(confirmation!, `${ORIGIN}/digest?confirm=`)).searchParams.get(
			"confirm",
		);
		expect(
			(await api("/api/digests/confirm", null, { method: "POST", body: { token } })).status,
		).toBe(200);
	});
});

describe("the weeks going by", () => {
	let week1 = 0;
	let week2 = 0;

	it("posts the first week's Discussion and emails, once", async () => {
		week1 = (await view(alice)).nextAt ?? 0;
		await moveTo(week1 + MINUTE);
		await (await boardStub(mf, board)).runDigests();
		expect(github.discussions).toHaveLength(1);
		const [post] = github.discussions;
		expect(post?.category).toBe("Announcements");
		expect(post?.title).toMatch(/^Roadmap: the week of /);
		expect(post?.body).toContain("**Alice** added 2 cards and 1 sticky");
		expect(post?.body).toContain(`/b/${board}/roadmap`);
		const bobs = mail.to("bob@example.com").at(-1);
		expect(bobs?.subject).toBe(post?.title);
		expect(bobs?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
		expect(bobs?.html).toContain("Alice");

		// The alarm firing again, later the same week, sends nothing more.
		await moveTo(week1 + 2 * DAY);
		await (await boardStub(mf, board)).runDigests();
		expect(github.discussions).toHaveLength(1);
		const runs = (await view(alice)).runs;
		expect(runs.map((run) => [run.channel, run.status, run.sent ?? null])).toEqual([
			["discussion", "sent", null],
			["email", "sent", 2],
		]);
		expect(runs[0]?.url).toMatch(/discussions\/\d+$/);
	});

	it("tells each audience only what it may read", async () => {
		// During the second week: both issues close, a decision's made, an action item's due.
		github.updateItem(WIDGETS, 12, { state: "closed", updatedAt: new Date(now()).toISOString() });
		await deliver(github.event(WIDGETS, 12, "closed"));
		github.updateItem(SECRET, 3, { state: "closed", updatedAt: new Date(now()).toISOString() });
		await deliver(github.event(SECRET, 3, "closed"));
		addShape(client.doc, "d1", {
			type: "decision",
			x: 0,
			y: 600,
			z: "a4",
			title: "Ship on Fridays",
			status: "decided",
			decidedAt: new Date(now()).toISOString(),
			decidedBy: { name: "Alice", color: "#ff8800", login: "alice" },
		});
		addShape(client.doc, "a1", {
			type: "action",
			x: 300,
			y: 600,
			z: "a5",
			text: "Write the release notes",
			owner: { login: "bob" },
			due: "2026-01-01",
		});
		await client.roundTrip();
		const seen = async () => {
			const preview = (await view(alice)).preview.email;
			return preview.items.length === 2;
		};
		await eventually(seen, 8000);

		// Bob's preview leaves the private repository out; Alice's has it.
		const bobs = (await view(bob)).preview;
		expect(bobs.email.items.map((item) => item.ref)).toEqual(["acme/widgets#12"]);
		expect(bobs.discussion?.items.map((item) => item.ref)).toEqual(["acme/widgets#12"]);

		week2 = (await view(alice)).nextAt ?? 0;
		expect(week2).toBeGreaterThan(week1 + 6 * DAY);
		await moveTo(week2 + MINUTE);
		await (await boardStub(mf, board)).runDigests();
		expect(github.discussions).toHaveLength(2);
		const post = github.discussions[1];
		expect(post?.body).toContain("Ship on Fridays");
		expect(post?.body).toContain("Write the release notes");
		expect(post?.body).toContain("acme/widgets\\#12 Widgets wobble: closed");
		expect(post?.body).not.toContain("Secret plans");
		expect(post?.body).not.toContain("acme/secret");

		const forBob = mail.to("bob@example.com").at(-1)!;
		expect(forBob.text).toContain("Widgets wobble");
		expect(forBob.text).not.toContain("Secret plans");
		const forAlice = mail.to("alice@example.com").at(-1)!;
		expect(forAlice.text).toContain("Secret plans");
	});

	it("tries again later when email fails for a while, without sending twice", async () => {
		// Something new, so the third week isn't quiet.
		addShape(client.doc, "s2", { type: "sticky", x: 0, y: 900, z: "a6", text: "More" });
		await client.roundTrip();
		const week3 = (await view(alice)).nextAt ?? 0;
		await (await boardStub(mf, board)).digestTiming({ retryMs: 1 });
		mail.fail("E_RATE_LIMIT_EXCEEDED", "bob@example.com");
		await moveTo(week3 + MINUTE);
		const before = {
			alice: mail.to("alice@example.com").length,
			bob: mail.to("bob@example.com").length,
		};
		await (await boardStub(mf, board)).runDigests();
		expect(mail.to("alice@example.com")).toHaveLength(before.alice + 1);
		expect(mail.to("bob@example.com")).toHaveLength(before.bob);
		const emails = (await view(alice)).runs.find((run) => run.channel === "email");
		expect(emails).toMatchObject({ status: "sent", sent: 1, failed: 1 });
		expect(emails?.error).toMatch(/try again/);
		// The retry is due at once (retryMs: 1): Bob's goes, Alice's and the Discussion don't again.
		await moveTo(now() + 10);
		await (await boardStub(mf, board)).runDigests();
		expect(mail.to("bob@example.com")).toHaveLength(before.bob + 1);
		expect(mail.to("alice@example.com")).toHaveLength(before.alice + 1);
		expect(github.discussions).toHaveLength(3);
		const latest = await view(alice);
		expect(latest.nextAt).toBeGreaterThan(week3 + 6 * DAY);
	});

	it("sends nothing in a quiet week", async () => {
		const week4 = (await view(alice)).nextAt ?? 0;
		const sent = mail.sent.length;
		await moveTo(week4 + MINUTE);
		await (await boardStub(mf, board)).runDigests();
		expect(github.discussions).toHaveLength(3);
		expect(mail.sent).toHaveLength(sent);
		expect((await view(alice)).runs[0]).toMatchObject({ channel: "discussion", status: "quiet" });
	});
});

describe("stopping", () => {
	// Weeks of digests have gone by: sessions (30 days) may have run out,
	// depending on when in the week this runs. Sign in again, as people would.
	beforeAll(async () => {
		alice = await signInWithGitHub(mf, github, ALICE);
		bob = await signInWithGitHub(mf, github, BOB);
	});

	it("stops with one click from an email, without signing in", async () => {
		const last = mail.to("alice@example.com").at(-1)!;
		const header = last.headers?.["List-Unsubscribe"] ?? "";
		const url = new URL(header.slice(1, -1));
		expect(url.pathname).toBe("/api/digests/unsubscribe");
		// The email's own link is a page that asks first, for people (not link checkers).
		expect(last.text).toContain(`${ORIGIN}/digest?unsubscribe=1&token=`);
		// Mail clients post it from anywhere: the token's the only authority.
		const response = await mf.dispatchFetch(url.toString(), {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://mail.example",
			},
			body: "List-Unsubscribe=One-Click",
		});
		expect(response.status).toBe(200);
		expect((await view(alice)).subscription).toBeNull();
		// A made-up token does nothing.
		const forged = await mf.dispatchFetch(`${ORIGIN}/api/digests/unsubscribe?token=nope`, {
			method: "POST",
		});
		expect(forged.status).toBe(410);
	});

	it("stops for people who can't open the board any more", async () => {
		const removed = await api(`/api/boards/${board}/members/bob`, alice, { method: "DELETE" });
		expect(removed.status).toBe(200);
		addShape(client.doc, "s3", { type: "sticky", x: 300, y: 900, z: "a7", text: "Later" });
		await client.roundTrip();
		const bobs = mail.to("bob@example.com").length;
		const next = (await view(alice)).nextAt ?? 0;
		await moveTo(next + MINUTE);
		await (await boardStub(mf, board)).runDigests();
		expect(mail.to("bob@example.com")).toHaveLength(bobs);
		expect((await view(alice)).subscribers).toBe(0);
	});

	it("turns off for the owner only", async () => {
		expect((await api(`/api/boards/${board}/digest`, bob, { method: "DELETE" })).status).toBe(403);
		const turnedOff = await api(`/api/boards/${board}/digest`, alice, { method: "DELETE" });
		expect(((await turnedOff.json()) as DigestView).settings).toBeNull();
		const after = github.discussions.length;
		await moveTo(now() + 8 * DAY);
		await (await boardStub(mf, board)).runDigests();
		expect(github.discussions).toHaveLength(after);
	});
});
