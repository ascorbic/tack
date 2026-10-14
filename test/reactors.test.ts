// Who reacted (the tooltip on a card's reaction count): `GET
// /api/boards/:id/reactors?key=…` asks the forge, as the person asking, only
// about items they can read.

import type { Miniflare, Response } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ReactorsResult } from "../src/shared/reactions.ts";
import type { QueryError } from "../src/shared/widgets.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const APP = 1;
const SECRET = 2;
const T0 = "2026-10-01T00:00:00Z";
const KEY = (n: number, repo = "tack/cirrus") => `github.com/${repo}#${n}`;

const KAI: FakeUser = { id: 501, login: "kai", name: "Kai Andersen", avatar_url: "" };
const PRIYA: FakeUser = { id: 502, login: "priya", name: "Priya Shah", avatar_url: "" };
const JO: FakeUser = { id: 503, login: "jo", name: null, avatar_url: "" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(APP, "tack/cirrus");
	github.addRepo(SECRET, "tack/secret", { private: true, collaborators: ["kai"] });
	github.install(7, "tack", ["tack/cirrus", "tack/secret"]);
	github.addUser(JO);
	github.setItem(APP, {
		number: 1,
		kind: "issue",
		title: "Cache tiles at the edge",
		updatedAt: T0,
		thumbsUp: ["kai", "priya", "jo"],
		reactions: { HEART: ["priya"], ROCKET: [] },
	});
	github.setItem(SECRET, {
		number: 1,
		kind: "issue",
		title: "Secret plans",
		updatedAt: T0,
		reactions: { HEART: ["kai"] },
	});
	github.discussions.push({
		repoId: APP,
		number: 2,
		title: "Ideas for the next release",
		body: "",
		category: "Ideas",
		createdAt: T0,
		reactions: { HOORAY: ["jo"] },
	});
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

async function reactors(mf: Miniflare, board: string, key: string, cookie: string | null) {
	const response = await api(
		mf,
		`/api/boards/${board}/reactors?key=${encodeURIComponent(key)}`,
		cookie,
	);
	return { status: response.status, body: (await response.json()) as ReactorsResult | QueryError };
}

describe("who reacted", () => {
	it("names who left each reaction, with their names where GitHub has them", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const kai = await signInWithGitHub(mf, github, KAI);
		await signInWithGitHub(mf, github, PRIYA);
		const board = await createBoard(mf, kai);
		const result = await reactors(mf, board, KEY(1), kai);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			kind: "reactors",
			key: KEY(1),
			groups: [
				{
					emoji: "👍",
					count: 3,
					reactors: [
						{ login: "kai", name: "Kai Andersen" },
						{ login: "priya", name: "Priya Shah" },
						{ login: "jo" },
					],
				},
				{ emoji: "❤️", count: 1, reactors: [{ login: "priya", name: "Priya Shah" }] },
			],
		});
		// One query, as Kai, and only when asked.
		expect(github.count((r) => r.operation === "TackReactors")).toBe(1);
	});

	it("reads discussions, which share the repository's numbers", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const kai = await signInWithGitHub(mf, github, KAI);
		const board = await createBoard(mf, kai);
		expect((await reactors(mf, board, KEY(2), kai)).body).toMatchObject({
			groups: [{ emoji: "🎉", count: 1, reactors: [{ login: "jo" }] }],
		});
	});

	it("as if a private repository weren't there, for people who can't read it", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const kai = await signInWithGitHub(mf, github, KAI);
		const priya = await signInWithGitHub(mf, github, PRIYA);
		const kais = await createBoard(mf, kai);
		const priyas = await createBoard(mf, priya);
		expect((await reactors(mf, kais, KEY(1, "tack/secret"), kai)).body).toMatchObject({
			groups: [{ emoji: "❤️", reactors: [{ login: "kai" }] }],
		});
		const refused = await reactors(mf, priyas, KEY(1, "tack/secret"), priya);
		expect(refused).toMatchObject({ status: 404, body: { reason: "no_access" } });
		expect(JSON.stringify(refused.body)).not.toContain("kai");
	});

	it("only for people who can open the board, about real items", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const kai = await signInWithGitHub(mf, github, KAI);
		const board = await createBoard(mf, kai);
		expect((await reactors(mf, board, KEY(1), null)).status).toBe(404);
		expect((await reactors(mf, "nope", KEY(1), kai)).status).toBe(404);
		expect(await reactors(mf, board, "nonsense", kai)).toMatchObject({
			status: 400,
			body: { reason: "invalid" },
		});
		expect(await reactors(mf, board, KEY(99), kai)).toMatchObject({
			status: 404,
			body: { reason: "no_access" },
		});
		const post = await api(mf, `/api/boards/${board}/reactors?key=x`, kai, { method: "POST" });
		expect(post.status).not.toBe(200);
	});

	it("works for the fake forge, with no network", async () => {
		const github = fakeGitHub();
		const mf = await configured(github);
		const kai = await signInWithGitHub(mf, github, KAI);
		const board = await createBoard(mf, kai);
		const before = github.requests.length;
		const result = await reactors(mf, board, "fake.tack/tack/cirrus#8", kai);
		expect(result.status).toBe(200);
		const body = result.body as ReactorsResult;
		expect(body.groups.reduce((n, g) => n + g.count, 0)).toBe(8);
		expect(github.requests.length).toBe(before);
	});
});
