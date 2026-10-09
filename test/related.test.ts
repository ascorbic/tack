// Expand related's route (#42): `GET /api/boards/:id/related?key=…` answers
// with what's related to an item, as the person asking may see it.

import type { Miniflare, Response } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { QueryError, RelatedResult } from "../src/shared/widgets.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const APP = 1;
const SECRET = 2;
const T0 = "2026-10-01T00:00:00Z";
const KEY = (n: number, repo = "acme/app") => `github.com/${repo}#${n}`;

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
	for (const n of [1, 2, 3]) {
		github.setItem(APP, { number: n, kind: "issue", title: `Issue ${n}`, updatedAt: T0 });
	}
	github.setItem(SECRET, { number: 1, kind: "issue", title: "Secret plans", updatedAt: T0 });
	github.setItem(SECRET, { number: 2, kind: "issue", title: "Secret child", updatedAt: T0 });
	github.setItem(APP, {
		number: 4,
		kind: "pull",
		title: "Fix #2",
		state: "open",
		updatedAt: T0,
		closes: [2],
	});
	const id = (repo: number, n: number) => github.databaseId(repo, n);
	github.subIssues.set(`${APP}#1`, [id(APP, 2)]);
	github.subIssues.set(`${APP}#2`, [id(APP, 3), id(SECRET, 1)]);
	github.subIssues.set(`${SECRET}#1`, [id(SECRET, 2)]);
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
		body: JSON.stringify({ title: "Planning" }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

async function related(mf: Miniflare, board: string, key: string, cookie: string | null) {
	const response = await api(
		mf,
		`/api/boards/${board}/related?key=${encodeURIComponent(key)}`,
		cookie,
	);
	return { status: response.status, body: (await response.json()) as RelatedResult | QueryError };
}

describe("related items", () => {
	it("answers as the viewer: private items only for people who can read them", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const bob = await signInWithGitHub(mf, github, BOB);
		const board = await createBoard(mf, alice);
		const bobs = await createBoard(mf, bob);

		const forAlice = await related(mf, board, KEY(2), alice);
		expect(forAlice.status).toBe(200);
		expect(forAlice.body).toMatchObject({
			kind: "related",
			key: KEY(2),
			parent: KEY(1),
			subIssues: [KEY(3), KEY(1, "acme/secret")],
			linkedPulls: [KEY(4)],
		});

		// Bob can't read acme/secret: it isn't there at all, not even its key.
		const forBob = await related(mf, bobs, KEY(2), bob);
		expect(forBob.body).toMatchObject({ subIssues: [KEY(3)] });
		expect(JSON.stringify(forBob.body)).not.toContain("secret");

		// Nor what's related to something in it.
		expect(await related(mf, bobs, KEY(1, "acme/secret"), bob)).toMatchObject({
			status: 404,
			body: { kind: "error", reason: "no_access" },
		});
		expect((await related(mf, board, KEY(1, "acme/secret"), alice)).body).toMatchObject({
			subIssues: [KEY(2, "acme/secret")],
		});
	});

	it("filters what the app's token reads for people without a token of their own", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		// Dev sign-in: allowed on the instance, but no GitHub token.
		const carol = await signIn(mf, "carol");
		const board = await createBoard(mf, carol);
		const result = await related(mf, board, KEY(2), carol);
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ parent: KEY(1), subIssues: [KEY(3)] });
		expect(JSON.stringify(result.body)).not.toContain("secret");
		// The app's token did read it; the route left it out.
		expect(github.requests.some((r) => r.operation === "TackRelated" && r.authorized)).toBe(true);
	});

	it("only for people who can open the board, about real items", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, alice);
		// Signed out, and not on the instance: as if there were no board.
		expect((await related(mf, board, KEY(2), null)).status).toBe(404);
		expect((await related(mf, "nope", KEY(2), alice)).status).toBe(404);
		expect(await related(mf, board, "nonsense", alice)).toMatchObject({
			status: 400,
			body: { reason: "invalid" },
		});
		expect(await related(mf, board, "example.com/a/b#1", alice)).toMatchObject({ status: 400 });
		expect(await related(mf, board, KEY(99), alice)).toMatchObject({
			status: 404,
			body: { reason: "no_access" },
		});
	});

	it("works for the fake forge, with no network", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, alice);
		const before = github.requests.length;
		const result = await related(mf, board, "fake.tack/acme/app#12", alice);
		expect(result.body).toMatchObject({
			kind: "related",
			parent: "fake.tack/acme/app#1",
			blockedBy: ["fake.tack/acme/app#17"],
		});
		expect(github.requests.length).toBe(before);
	});
});
