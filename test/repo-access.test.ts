// Repository access (#9 and #10), end to end: real boards over WebSockets in
// Miniflare, signed in as real GitHub users (through the OAuth flow against
// a fake GitHub), so every check uses the viewer's own token.
//
// - Per-viewer filtering: `Repo` caches are shared, so the board filters what
//   each connection receives. Viewers who can't read a private repository
//   get a placeholder, and the title, labels and every other field never
//   reach their socket: tests look at the raw messages, not just the parsed
//   cards.
// - Two tiers: repositories without the app are read lazily (fetched on
//   view, ETag-polled while watched) and marked not live; installing the
//   app upgrades their cards in place.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare, Response } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import { sign } from "../src/server/forges/hmac.ts";
import type { Card, CardMessage, MissingCard } from "../src/shared/cards.ts";
import { addShape, nextZ } from "../src/shared/shapes.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, repoStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

const PUBLIC_ID = 1;
const PRIVATE_ID = 2;
const HIDDEN_ID = 3;
const PUBLIC_CARD = "github.com/acme/widgets#1";
const PRIVATE_CARD = "github.com/acme/secret#5";
const HIDDEN_CARD = "github.com/acme/hidden#9";
const SECRET_TITLE = "Secret roadmap";
const SECRET_LABEL = "embargoed";
const T0 = "2026-10-01T00:00:00Z";
const T1 = "2026-10-02T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(PUBLIC_ID, "acme/widgets");
	github.setItem(PUBLIC_ID, {
		number: 1,
		kind: "issue",
		title: "Widgets wobble",
		updatedAt: T0,
		labels: [{ name: "bug", color: "d73a4a" }],
	});
	github.addRepo(PRIVATE_ID, "acme/secret", { private: true, collaborators: ["alice"] });
	github.setItem(PRIVATE_ID, {
		number: 5,
		kind: "issue",
		title: SECRET_TITLE,
		updatedAt: T0,
		labels: [{ name: SECRET_LABEL, color: "000000" }],
	});
	// The app is installed on the private repository, but not the public one.
	github.install(7, "acme", ["acme/secret"]);
	github.addRepo(HIDDEN_ID, "acme/hidden", { private: true, collaborators: ["alice"] });
	github.setItem(HIDDEN_ID, { number: 9, kind: "issue", title: "Hidden plans", updatedAt: T0 });
	return github;
}

/** A Worker whose GitHub App is set up, so sign-in and installations are real. */
async function configured(github: FakeGitHub, persist?: string): Promise<Miniflare> {
	const mf = startWorker({ devAuth: true, outboundService: github.fetch, persist });
	cleanups.push(() => mf.dispose());
	const instance = await instanceStub(mf);
	if (!(await instance.isConfigured())) {
		expect(await instance.completeSetup(github.manifestCode)).toMatchObject({ ok: true });
	}
	return mf;
}

function cookies(response: Response): Record<string, string> {
	const jar: Record<string, string> = {};
	for (const header of response.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const eq = pair.indexOf("=");
		jar[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return jar;
}

function cookieHeader(jar: Record<string, string>): string {
	return Object.entries(jar)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

/**
 * Sign in through GitHub as `who`, returning a Cookie header. A dev sign-in
 * first puts their login on the instance's allowlist.
 */
async function signInWithGitHub(mf: Miniflare, github: FakeGitHub, who: FakeUser) {
	await signIn(mf, who.login);
	const start = await mf.dispatchFetch(`${ORIGIN}/auth/signin?return_to=/`, { redirect: "manual" });
	const callback = new URL(github.authorize(start.headers.get("location") ?? "", who));
	const done = await mf.dispatchFetch(`${ORIGIN}${callback.pathname}${callback.search}`, {
		headers: { cookie: cookieHeader(cookies(start)) },
		redirect: "manual",
	});
	expect(done.status).toBe(302);
	return cookieHeader({ tack_session: cookies(done).tack_session ?? "" });
}

interface Socket {
	/** The latest entry for each key. */
	cards: Map<string, Card | MissingCard>;
	/** Every custom message, exactly as it arrived. */
	raw: string[];
	add(...keys: string[]): void;
	recheck(): void;
	until(key: string, check: (entry: Card | MissingCard) => boolean): Promise<Card | MissingCard>;
	close(): void;
}

/**
 * Open a board over a raw WebSocket, as `cookie` (or anonymously), keeping
 * every custom message. Shapes are added with Yjs sync messages, as the
 * app's provider sends them.
 */
/** Create a board as the person with `cookie`, returning its id. */
async function createBoard(
	mf: Miniflare,
	cookie: string,
	visibility: "private" | "instance" | "public" = "instance",
): Promise<string> {
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ title: "Repo access", visibility }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

/** Adopt a board by name, as a guest would before sign-in is set up. */
async function adoptBoard(mf: Miniflare, name: string): Promise<string> {
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards/legacy`, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	expect(response.status).toBe(200);
	return name;
}

/** Alice, signed in through GitHub, on a new board of hers. */
async function aliceOnBoard(mf: Miniflare, github: FakeGitHub) {
	const cookie = await signInWithGitHub(mf, github, ALICE);
	const board = await createBoard(mf, cookie);
	return { alice: await connect(mf, board, cookie), board, cookie };
}

async function connect(mf: Miniflare, board: string, cookie?: string): Promise<Socket> {
	const response = await mf.dispatchFetch(`${ORIGIN}/parties/board/${board}`, {
		headers: { upgrade: "websocket", ...(cookie ? { cookie } : {}) },
	});
	expect(response.status).toBe(101);
	const ws = response.webSocket;
	if (!ws) throw new Error("no WebSocket");
	ws.accept();
	const cards = new Map<string, Card | MissingCard>();
	const raw: string[] = [];
	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string" || !event.data.startsWith("__YPS:")) return;
		const text = event.data.slice("__YPS:".length);
		raw.push(text);
		const message = JSON.parse(text) as CardMessage;
		for (const card of message.type === "cards" ? message.cards : [message.card]) {
			cards.set(card.key, card);
		}
	});
	const close = () => {
		try {
			ws.close();
		} catch {
			// Already closed.
		}
	};
	cleanups.push(close);
	return {
		cards,
		raw,
		add(...keys) {
			const doc = new Y.Doc();
			const updates: Uint8Array[] = [];
			doc.on("update", (update: Uint8Array) => updates.push(update));
			for (const key of keys) {
				addShape(doc, crypto.randomUUID(), { type: "card", ref: key, x: 0, y: 0, z: nextZ(doc) });
			}
			for (const update of updates) ws.send(syncUpdate(update));
		},
		recheck() {
			ws.send(`__YPS:${JSON.stringify({ type: "recheck" })}`);
		},
		until(key, check) {
			return vi.waitFor(
				() => {
					const entry = cards.get(key);
					if (!entry || !check(entry)) throw new Error(`${key}: ${JSON.stringify(entry)}`);
					return entry;
				},
				{ timeout: 10_000, interval: 50 },
			);
		},
		close,
	};
}

/** A y-protocols sync message carrying a document update: [sync, update, bytes]. */
function syncUpdate(update: Uint8Array): Uint8Array<ArrayBuffer> {
	const length: number[] = [];
	let n = update.length;
	while (n > 0x7f) {
		length.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	length.push(n);
	return new Uint8Array([0, 2, ...length, ...update]);
}

const isCard = (entry: Card | MissingCard): entry is Card => !("missing" in entry);
const isPlaceholder = (entry: Card | MissingCard) =>
	"missing" in entry && entry.reason === "private";

async function deliver(
	mf: Miniflare,
	github: FakeGitHub,
	event: string,
	payload: unknown,
	secret = github.app.webhook_secret,
) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign(secret, body),
		},
	});
	expect(response.status).toBe(202);
}

function issuePayload(
	repo: { id: number; full_name: string; private: boolean },
	issue: Record<string, unknown>,
) {
	return {
		action: "edited",
		repository: repo,
		issue: {
			state: "open",
			html_url: `https://github.com/${repo.full_name}/issues/${String(issue.number)}`,
			assignees: [],
			comments: 0,
			...issue,
		},
	};
}

const SECRET_REPO = { id: PRIVATE_ID, full_name: "acme/secret", private: true };

describe("per-viewer filtering", () => {
	it("sends different payloads to viewers with different access, and never a private title", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const aliceCookie = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, aliceCookie);
		const alice = await connect(mf, board, aliceCookie);
		// Bob's on the board too (anyone on the instance may open it), but
		// board roles never grant access to repository data.
		const bob = await connect(mf, board, await signInWithGitHub(mf, github, BOB));

		alice.add(PUBLIC_CARD, PRIVATE_CARD);

		// Alice can read the private repository: she gets the card.
		const secret = await alice.until(PRIVATE_CARD, isCard);
		expect(secret).toMatchObject({
			title: SECRET_TITLE,
			labels: [{ name: SECRET_LABEL }],
			visibility: "private",
			live: true,
		});
		// Bob can't: a placeholder with nothing but the key.
		expect(await bob.until(PRIVATE_CARD, isPlaceholder)).toEqual({
			key: PRIVATE_CARD,
			missing: true,
			reason: "private",
		});
		// Both see the public card.
		for (const socket of [alice, bob]) {
			expect(await socket.until(PUBLIC_CARD, isCard)).toMatchObject({
				title: "Widgets wobble",
				visibility: "public",
			});
		}

		// Updates fan out filtered too.
		const sent = bob.raw.length;
		await deliver(
			mf,
			github,
			"issues",
			issuePayload(SECRET_REPO, {
				number: 5,
				title: `${SECRET_TITLE} v2`,
				updated_at: T1,
				labels: [{ name: `${SECRET_LABEL}-2`, color: "000000" }],
			}),
		);
		await alice.until(PRIVATE_CARD, (card) => isCard(card) && card.title === `${SECRET_TITLE} v2`);
		// Bob's socket heard about it, as a placeholder.
		await vi.waitFor(() => expect(bob.raw.length).toBeGreaterThan(sent));
		expect(bob.cards.get(PRIVATE_CARD)).toEqual({
			key: PRIVATE_CARD,
			missing: true,
			reason: "private",
		});

		// Nothing private ever reached Bob's socket, in any form.
		const everything = bob.raw.join("\n");
		expect(everything).not.toContain(SECRET_TITLE);
		expect(everything).not.toContain(SECRET_LABEL);
		expect(alice.raw.join("\n")).toContain(SECRET_TITLE);
	});

	it("shows the card once a viewer gains access, after a recheck, and hides it once they lose it", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const bobCookie = await signInWithGitHub(mf, github, BOB);
		const board = await createBoard(mf, bobCookie);
		const bob = await connect(mf, board, bobCookie);
		bob.add(PRIVATE_CARD);
		await bob.until(PRIVATE_CARD, isPlaceholder);

		// Bob is added to the repository, and asks the board to check again.
		github.addCollaborator(PRIVATE_ID, "bob");
		bob.recheck();
		expect(await bob.until(PRIVATE_CARD, isCard)).toMatchObject({ title: SECRET_TITLE });

		// Removed again: the next recheck (past its throttle) withdraws it.
		github.removeCollaborator(PRIVATE_ID, "bob");
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		bob.recheck();
		await bob.until(PRIVATE_CARD, isPlaceholder);

		// Added again, then a reload: a new connection checks afresh (once the
		// last check is past the reconnect grace).
		bob.close();
		github.addCollaborator(PRIVATE_ID, "bob");
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		const again = await connect(mf, board, bobCookie);
		await again.until(PRIVATE_CARD, isCard);
	}, 30_000);

	it("gives anonymous viewers, and people without a token, only public cards", async () => {
		const github = fakeGitHub();
		// No app: anyone may open boards, and a personal token reads everything,
		// so the shared cache holds the private card.
		github.personalTokens.add("pat");
		const mf = startWorker({
			devAuth: true,
			outboundService: github.fetch,
			bindings: { GITHUB_TOKEN: "pat" },
		});
		cleanups.push(() => mf.dispose());

		await adoptBoard(mf, "open");
		const anonymous = await connect(mf, "open");
		// Dev sign-in users have no GitHub token, so can't show they may read anything.
		const dev = await connect(mf, "open", await signIn(mf, "alice"));
		anonymous.add(PUBLIC_CARD, PRIVATE_CARD);

		for (const socket of [anonymous, dev]) {
			await socket.until(PUBLIC_CARD, isCard);
			await socket.until(PRIVATE_CARD, isPlaceholder);
			expect(socket.raw.join("\n")).not.toContain(SECRET_TITLE);
		}
		// The board holds the private card; filtering is what keeps it in.
		const board = await boardStub(mf, "open");
		expect(await board.liveCards()).toContainEqual(
			expect.objectContaining({ key: PRIVATE_CARD, title: SECRET_TITLE }),
		);

		// The public repository is made private: its card is withdrawn from both.
		// (No app, so webhooks are signed with the configured secret.)
		github.setPrivate(PUBLIC_ID, true);
		const privatized = {
			action: "privatized",
			repository: { id: PUBLIC_ID, full_name: "acme/widgets", private: true },
		};
		await deliver(mf, github, "repository", privatized, "test-secret");
		for (const socket of [anonymous, dev]) await socket.until(PUBLIC_CARD, isPlaceholder);

		// And published again.
		const publicized = {
			action: "publicized",
			repository: { id: PUBLIC_ID, full_name: "acme/widgets", private: false },
		};
		await deliver(mf, github, "repository", publicized, "test-secret");
		for (const socket of [anonymous, dev]) await socket.until(PUBLIC_CARD, isCard);
	});

	it("gives anonymous viewers of a public board only public-repo cards", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const aliceCookie = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, aliceCookie, "public");
		const alice = await connect(mf, board, aliceCookie);
		// Signed out: public boards are readable by anyone, as viewers.
		const anonymous = await connect(mf, board);
		alice.add(PUBLIC_CARD, PRIVATE_CARD);

		await alice.until(PRIVATE_CARD, isCard);
		expect(await anonymous.until(PUBLIC_CARD, isCard)).toMatchObject({ title: "Widgets wobble" });
		await anonymous.until(PRIVATE_CARD, isPlaceholder);

		// Updates to the private card reach the anonymous socket only as placeholders.
		const sent = anonymous.raw.length;
		await deliver(
			mf,
			github,
			"issues",
			issuePayload(SECRET_REPO, { number: 5, title: `${SECRET_TITLE} v3`, updated_at: T1 }),
		);
		await alice.until(PRIVATE_CARD, (card) => isCard(card) && card.title === `${SECRET_TITLE} v3`);
		await vi.waitFor(() => expect(anonymous.raw.length).toBeGreaterThan(sent));
		const everything = anonymous.raw.join("\n");
		expect(everything).not.toContain(SECRET_TITLE);
		expect(everything).not.toContain(SECRET_LABEL);

		// The home page's thumbnail of the board (anyone can see a public
		// board's) carries shapes and colours only: no card text, and no
		// state colour from the private card.
		await new Promise((resolve) => setTimeout(resolve, 2_500)); // the debounced save
		const info = await mf.dispatchFetch(`${ORIGIN}/api/boards/${board}`);
		expect(info.status).toBe(200);
		const text = await info.text();
		expect(text).not.toContain(SECRET_TITLE);
		expect(text).not.toContain("Widgets wobble");
		const { thumbnail } = JSON.parse(text) as {
			thumbnail: { shapes: [string, number, number, number, number, string][] } | null;
		};
		const tones = thumbnail?.shapes.filter(([kind]) => kind === "card").map((shape) => shape[5]);
		expect(tones?.sort()).toEqual(["", "open"]);
	}, 20_000);
});

describe("two tiers of repository access", () => {
	it("mixes live cards from an installed repo with lazy cards from a public one", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const { alice } = await aliceOnBoard(mf, github);
		alice.add(PUBLIC_CARD, PRIVATE_CARD);

		expect(await alice.until(PRIVATE_CARD, isCard)).toMatchObject({
			live: true,
			writable: true,
		});
		expect(await alice.until(PUBLIC_CARD, isCard)).toMatchObject({
			live: false,
			writable: false,
			visibility: "public",
		});
	});

	it("polls repositories that aren't live with ETags, only while someone's watching", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const { alice, board } = await aliceOnBoard(mf, github);
		alice.add(PUBLIC_CARD);
		await alice.until(PUBLIC_CARD, isCard);
		const repo = await repoStub(mf, `github.com/@${PUBLIC_ID}`);
		expect(await repo.watchers()).toEqual([board]);

		const polls = () => github.count((r) => r.path === "/repos/acme/widgets/issues");
		await repo.pollNow();
		await repo.pollNow();
		expect(polls()).toBe(2);
		// The second poll was conditional, and nothing had changed.
		expect(github.notModified).toBe(1);
		// With Alice's own token: the app isn't installed, so there's no other.
		expect(
			github.requests.filter((r) => r.path.endsWith("/issues")).every((r) => r.authorized),
		).toBe(true);

		// Someone edits the issue on GitHub: no webhook, but the next poll sees it.
		github.updateItem(PUBLIC_ID, 1, { title: "Widgets wobble a lot", updatedAt: T1 });
		await repo.pollNow();
		await alice.until(PUBLIC_CARD, (card) => isCard(card) && card.title === "Widgets wobble a lot");
		expect(github.notModified).toBe(1);
	});

	it("doesn't poll when nobody's looking", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		// Subscribed by a board, but nobody has it open.
		const repo = await repoStub(mf, `github.com/@${PUBLIC_ID}`);
		await repo.subscribe("asleep", [PUBLIC_CARD], {
			forge: "github",
			host: "github.com",
			id: String(PUBLIC_ID),
			name: "acme/widgets",
			private: false,
		});
		expect(await repo.watchers()).toEqual([]);
		await repo.pollNow();
		expect(github.count((r) => r.path === "/repos/acme/widgets/issues")).toBe(0);
	});

	it("upgrades a card in place when the app is installed", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const { alice } = await aliceOnBoard(mf, github);
		alice.add(PUBLIC_CARD);
		await alice.until(PUBLIC_CARD, (card) => isCard(card) && card.live === false);

		// Someone installs the app on the repository, from the card's prompt.
		github.install(8, "acme", ["acme/secret", "acme/widgets"]);
		await deliver(mf, github, "installation_repositories", {
			action: "added",
			installation: { id: 8, account: { login: "acme" }, repository_selection: "selected" },
			repositories_added: [{ full_name: "acme/widgets" }],
			repositories_removed: [],
		});
		// The open board upgrades without reconnecting.
		expect(
			await alice.until(PUBLIC_CARD, (card) => isCard(card) && card.live === true),
		).toMatchObject({ title: "Widgets wobble", writable: true });

		// And downgrades when it's removed.
		github.install(8, "acme", ["acme/secret"]);
		await deliver(mf, github, "installation_repositories", {
			action: "removed",
			installation: { id: 8, account: { login: "acme" }, repository_selection: "selected" },
			repositories_added: [],
			repositories_removed: [{ full_name: "acme/widgets" }],
		});
		await alice.until(PUBLIC_CARD, (card) => isCard(card) && card.live === false);
	});

	it("says a private repo without the app can't be read, until it's installed", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const { alice } = await aliceOnBoard(mf, github);
		alice.add(HIDDEN_CARD);
		expect(await alice.until(HIDDEN_CARD, (card) => "missing" in card)).toEqual({
			key: HIDDEN_CARD,
			missing: true,
			reason: "not_found",
			installed: false,
		});

		// Installed through the install flow: GitHub sends Alice back to the board.
		github.install(9, "acme", ["acme/hidden"]);
		const back = await mf.dispatchFetch(
			`${ORIGIN}/setup/installed?installation_id=9&setup_action=install&state=${encodeURIComponent("/b/hidden")}`,
			{ redirect: "manual" },
		);
		expect(back.headers.get("location")).toBe("/b/hidden");
		// The board that couldn't read it hears, and the card appears.
		expect(await alice.until(HIDDEN_CARD, isCard)).toMatchObject({
			title: "Hidden plans",
			live: true,
			visibility: "private",
		});
	});

	it("sends people to GitHub to install the app, returning to the board", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const response = await mf.dispatchFetch(
			`${ORIGIN}/setup/install?state=${encodeURIComponent("/b/1/plan")}`,
			{ redirect: "manual" },
		);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.origin + location.pathname).toBe(
			"https://github.com/apps/tack-test/installations/new",
		);
		expect(location.searchParams.get("state")).toBe("/b/1/plan");

		// Only ever back to this site.
		const offsite = await mf.dispatchFetch(`${ORIGIN}/setup/install?state=//evil.example`, {
			redirect: "manual",
		});
		expect(new URL(offsite.headers.get("location") ?? "").searchParams.has("state")).toBe(false);
	});

	it("keeps a repository's status across restarts", async () => {
		const github = fakeGitHub();
		const persist = mkdtempSync(join(tmpdir(), "tack-access-"));
		cleanups.push(() => rmSync(persist, { recursive: true, force: true }));
		let mf = await configured(github, persist);
		const cookie = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, cookie);
		const first = await connect(mf, board, cookie);
		first.add(PUBLIC_CARD, PRIVATE_CARD);
		await first.until(PRIVATE_CARD, isCard);
		// Let the board save its document (debounced) before stopping.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		first.close();
		await mf.dispose();

		mf = await configured(github, persist);
		const second = await connect(mf, board, cookie);
		expect(await second.until(PRIVATE_CARD, isCard)).toMatchObject({ live: true });
		expect(await second.until(PUBLIC_CARD, isCard)).toMatchObject({ live: false });
	}, 30_000);
});
