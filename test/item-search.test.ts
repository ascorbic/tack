// The card tool's search (`GET /api/boards/:id/search?host=…&q=…`): issues
// and pull requests to add, as the person searching may see them.

import type { Miniflare, Response } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { QueryError, SearchResult } from "../src/shared/widgets.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const APP = 1;
const SECRET = 2;
const T0 = "2026-10-01T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(APP, "acme/app");
	github.addRepo(SECRET, "acme/secret", { private: true, collaborators: ["alice"] });
	github.install(7, "acme", ["acme/app", "acme/secret"]);
	github.setItem(APP, { number: 1, kind: "issue", title: "Migration guide", updatedAt: T0 });
	github.setItem(APP, { number: 2, kind: "issue", title: "Drop Node 18", updatedAt: T0 });
	github.setItem(APP, { number: 3, kind: "pull", title: "Migration codemod", updatedAt: T0 });
	github.setItem(SECRET, { number: 1, kind: "issue", title: "Migration secrets", updatedAt: T0 });
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

function cookies(response: Response): Record<string, string> {
	const jar: Record<string, string> = {};
	for (const header of response.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const eq = pair.indexOf("=");
		jar[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return jar;
}

/** Sign in through (fake) GitHub, so the person has a real user token. */
async function signInWithGitHub(mf: Miniflare, github: FakeGitHub, who: FakeUser) {
	await signIn(mf, who.login);
	const start = await mf.dispatchFetch(`${ORIGIN}/auth/signin?return_to=/`, { redirect: "manual" });
	const callback = new URL(github.authorize(start.headers.get("location") ?? "", who));
	const done = await mf.dispatchFetch(`${ORIGIN}${callback.pathname}${callback.search}`, {
		headers: {
			cookie: Object.entries(cookies(start))
				.map(([k, v]) => `${k}=${v}`)
				.join("; "),
		},
		redirect: "manual",
	});
	expect(done.status).toBe(302);
	return `tack_session=${cookies(done).tack_session ?? ""}`;
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
		body: JSON.stringify({ title: "Planning", visibility: "private" }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

async function search(
	mf: Miniflare,
	board: string,
	q: string,
	cookie: string | null,
	host = "github.com",
) {
	const response = await api(
		mf,
		`/api/boards/${board}/search?host=${encodeURIComponent(host)}&q=${encodeURIComponent(q)}`,
		cookie,
	);
	return { status: response.status, body: (await response.json()) as SearchResult | QueryError };
}

const titles = (result: { body: SearchResult | QueryError }) =>
	result.body.kind === "search" ? result.body.items.map((card) => card.title).sort() : result.body;

describe("searching for items to add", () => {
	it("answers as the viewer: private items only for people who can read them", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const bob = await signInWithGitHub(mf, github, BOB);
		const board = await createBoard(mf, alice);
		const bobs = await createBoard(mf, bob);
		const q = "repo:acme/app repo:acme/secret migration";

		expect(titles(await search(mf, board, q, alice))).toEqual([
			"Migration codemod",
			"Migration guide",
			"Migration secrets",
		]);
		expect(titles(await search(mf, bobs, q, bob))).toEqual([
			"Migration codemod",
			"Migration guide",
		]);
	});

	it("is only for people who can open the board, and says what's wrong", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const bob = await signInWithGitHub(mf, github, BOB);
		const board = await createBoard(mf, alice);

		expect((await search(mf, board, "repo:acme/app guide", null)).status).toBe(404);
		expect((await search(mf, board, "repo:acme/app guide", bob)).status).toBe(404);
		expect((await search(mf, "nope", "guide", alice)).status).toBe(404);
		expect(await search(mf, board, "  ", alice)).toMatchObject({
			status: 400,
			body: { reason: "invalid" },
		});
		expect(await search(mf, board, "guide", alice, "example.com")).toMatchObject({
			status: 404,
			body: { reason: "unsupported" },
		});
	});

	it("searches the fake forge with no network", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, alice);
		const before = github.requests.length;
		const result = await search(mf, board, "repo:stress/cards is:open", alice, "fake.tack");
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ kind: "search" });
		const items = (result.body as SearchResult).items;
		expect(items.length).toBeGreaterThan(0);
		expect(items.length).toBeLessThanOrEqual(10);
		expect(items.every((card) => card.key.startsWith("fake.tack/stress/cards#"))).toBe(true);
		expect(github.requests.length).toBe(before);
	});
});
