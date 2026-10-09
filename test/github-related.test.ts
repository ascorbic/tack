// Reading around an item for widgets (#42), in Node against the fake GitHub:
// what's related to an issue or pull request, and a repository's latest
// release with what's merged since. Plus the fake forge's synthetic answers.

import type { Request } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fake, fakeRelated } from "../src/server/forges/fake.ts";
import { relatedGitHub, releaseGitHub } from "../src/server/forges/github-related.ts";
import type { RepoIdentity } from "../src/server/forges/types.ts";
import { isMissing } from "../src/shared/cards.ts";
import type { RelatedResult } from "../src/shared/widgets.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";

const APP = 1;
const SECRET = 2;
const REPO: RepoIdentity = { forge: "github", host: "github.com", id: "1", name: "acme/app" };
const KEY = (n: number, repo = "acme/app") => `github.com/${repo}#${n}`;
const T0 = "2026-10-01T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "" };

let github: FakeGitHub;
const env = {} as Env;

beforeEach(() => {
	github = new FakeGitHub();
	github.addRepo(APP, "acme/app");
	github.addRepo(SECRET, "acme/secret", { private: true, collaborators: ["alice"] });
	github.install(7, "acme", ["acme/app", "acme/secret"]);
	const issue = (repo: number, number: number, title = `Issue ${number}`) =>
		github.setItem(repo, { number, kind: "issue", title, updatedAt: T0 });
	for (const n of [1, 2, 3, 4, 5, 6]) issue(APP, n);
	issue(SECRET, 1, "Secret plans");
	github.setItem(APP, {
		number: 10,
		kind: "pull",
		title: "Fix #2",
		state: "merged",
		updatedAt: T0,
		mergedAt: "2026-09-10T00:00:00Z",
		closes: [2],
	});
	github.setItem(APP, {
		number: 11,
		kind: "pull",
		title: "Mentions #2",
		state: "open",
		updatedAt: T0,
		mentions: [2],
	});
	github.setItem(APP, {
		number: 12,
		kind: "pull",
		title: "Old fix",
		state: "merged",
		updatedAt: T0,
		mergedAt: "2026-07-01T00:00:00Z",
	});
	github.setItem(APP, {
		number: 13,
		kind: "pull",
		title: "Into a branch",
		state: "merged",
		updatedAt: T0,
		mergedAt: "2026-09-20T00:00:00Z",
		base: "next",
	});
	// #2: parent #1, sub-issues #3 and the secret #1, blocked by #4, blocking #5.
	const id = (repo: number, n: number) => github.databaseId(repo, n);
	github.subIssues.set(`${APP}#1`, [id(APP, 2)]);
	github.subIssues.set(`${APP}#2`, [id(APP, 3), id(SECRET, 1)]);
	github.blockedBy.set(`${APP}#2`, [id(APP, 4)]);
	github.blockedBy.set(`${APP}#5`, [id(APP, 2)]);
	github.releases.set(APP, [
		{ tagName: "v1.0.0", name: "One", publishedAt: "2026-06-01T00:00:00Z" },
		{ tagName: "v1.1.0", name: null, publishedAt: "2026-08-01T00:00:00Z" },
	]);
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		github.fetch(new globalThis.Request(input, init) as unknown as Request),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function related(key: string, token: string | null) {
	return relatedGitHub(key, env, { token });
}

function asRelated(result: Awaited<ReturnType<typeof related>>): RelatedResult {
	if (result.kind !== "related") throw new Error(`Expected related, got ${result.message}`);
	return result;
}

describe("related on GitHub", () => {
	it("finds the parent, sub-issues, dependencies and linked pull requests in one query", async () => {
		const result = asRelated(await related(KEY(2), github.userTokenFor(ALICE)));
		expect(result).toMatchObject({
			key: KEY(2),
			parent: KEY(1),
			subIssues: [KEY(3), KEY(1, "acme/secret")],
			blockedBy: [KEY(4)],
			blocking: [KEY(5)],
			linkedPulls: [KEY(10), KEY(11)],
		});
		expect(result.closes).toBeUndefined();
		expect(github.count((r) => r.operation === "TackRelated")).toBe(1);
		expect(github.requests).toHaveLength(1);

		// Card data for every one, with its repository's visibility.
		const cards = new Map(result.cards.map((card) => [card.key, card]));
		expect([...cards.keys()].sort()).toEqual(
			[KEY(1), KEY(3), KEY(4), KEY(5), KEY(10), KEY(11), KEY(1, "acme/secret")].sort(),
		);
		const secret = cards.get(KEY(1, "acme/secret"));
		expect(secret && !isMissing(secret) && secret.visibility).toBe("private");
		const pull = cards.get(KEY(10));
		expect(pull && !isMissing(pull) && pull.state).toBe("merged");
		expect(pull && !isMissing(pull) && pull.visibility).toBe("public");
	});

	it("leaves out what the viewer can't see", async () => {
		const result = asRelated(await related(KEY(2), github.userTokenFor(BOB)));
		expect(result.subIssues).toEqual([KEY(3)]);
		expect(result.cards.some((card) => card.key.includes("secret"))).toBe(false);
	});

	it("says which issues a pull request closes", async () => {
		const result = asRelated(await related(KEY(10), github.userTokenFor(ALICE)));
		expect(result.closes).toEqual([KEY(2)]);
		expect(result.subIssues).toEqual([]);
		expect(result.linkedPulls).toEqual([]);
	});

	it("says why it couldn't answer", async () => {
		expect(await related(KEY(2), null)).toMatchObject({ kind: "error", reason: "signed_out" });
		expect(await related("github.com/acme/app!2", "token")).toMatchObject({ reason: "invalid" });
		expect(await related(KEY(99), github.userTokenFor(ALICE))).toMatchObject({
			kind: "error",
			reason: "no_access",
		});
		expect(await related(KEY(1, "acme/secret"), github.userTokenFor(BOB))).toMatchObject({
			kind: "error",
			reason: "no_access",
		});
		vi.stubGlobal("fetch", async () =>
			Response.json(
				{ message: "rate limited" },
				{
					status: 403,
					headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" },
				},
			),
		);
		expect(await related(KEY(2), "token")).toEqual({
			kind: "error",
			reason: "rate_limited",
			message: expect.any(String),
			retryAt: 1_900_000_000_000,
		});
	});
});

describe("release on GitHub", () => {
	it("finds the latest release and what's been merged into the default branch since", async () => {
		const result = await releaseGitHub(REPO, env, { token: github.userTokenFor(ALICE) });
		expect(result).toMatchObject({
			kind: "release",
			repo: "github.com/acme/app",
			latest: {
				tag: "v1.1.0",
				name: null,
				publishedAt: "2026-08-01T00:00:00Z",
				url: "https://github.com/acme/app/releases/tag/v1.1.0",
			},
		});
		if (result.kind !== "release") return;
		expect(result.mergedSince.map((card) => card.key)).toEqual([KEY(10)]);
		const search = github.requests.find((r) => r.operation === "TackMergedSince");
		expect(search?.variables?.q).toBe(
			"repo:acme/app is:pr is:merged sort:updated-desc base:main merged:>2026-08-01T00:00:00Z",
		);
	});

	it("without a release, lists everything merged", async () => {
		github.releases.clear();
		const result = await releaseGitHub(REPO, env, { token: github.userTokenFor(ALICE) });
		expect(result.kind === "release" && result.latest).toBeNull();
		expect(result.kind === "release" && result.mergedSince.map((card) => card.key)).toEqual([
			KEY(10),
			KEY(12),
		]);
	});

	it("doesn't reveal a private repository", async () => {
		const secret = { ...REPO, id: "2", name: "acme/secret" };
		expect(await releaseGitHub(secret, env, { token: github.userTokenFor(BOB) })).toMatchObject({
			kind: "error",
			reason: "no_access",
		});
	});
});

describe("the fake forge", () => {
	it("relates synthetic items consistently, both ways", async () => {
		const twelve = fakeRelated("acme/app", 12);
		const key = (n: number) => `fake.tack/acme/app#${n}`;
		expect(twelve).toMatchObject({
			parent: key(1),
			subIssues: [key(121), key(122), key(125)],
			blockedBy: [key(17)],
			blocking: [key(7)],
			linkedPulls: [key(13)],
		});
		expect(twelve.cards).toHaveLength(7);
		expect(fakeRelated("acme/app", 121).parent).toBe(key(12));
		expect(fakeRelated("acme/app", 17).blocking).toEqual([key(12)]);
		expect(fakeRelated("acme/app", 13).closes).toEqual([key(10), key(11), key(12)]);
		expect(fakeRelated("acme/app", 10).linkedPulls).toEqual([key(13), key(14)]);
		expect(await fake.related?.("fake.tack/acme/app#x", env)).toMatchObject({ reason: "invalid" });
	});

	it("has a release with merged pull requests", async () => {
		const result = await fake.release?.(
			{ forge: "fake", host: "fake.tack", id: "acme/app", name: "acme/app" },
			env,
		);
		expect(result).toMatchObject({ kind: "release", latest: { tag: "v1.4.0" } });
		expect(
			result?.kind === "release" && result.mergedSince.every((c) => c.state === "merged"),
		).toBe(true);
	});
});
