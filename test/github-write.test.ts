// The GitHub adapter's writes (#28), in Node against the fake GitHub: every
// operation, retries that never write twice, rate limits, write access,
// repository metadata and directory listings.

import type { Request } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Operation } from "../src/shared/changes.ts";
import {
	applyGitHub,
	canWriteGitHub,
	listDirectoryGitHub,
	repoMetaGitHub,
} from "../src/server/forges/github-write.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import type { RepoIdentity, WriteAuth } from "../src/server/forges/types.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";

const REPO_ID = 1;
const OTHER_ID = 2;
const REPO: RepoIdentity = { forge: "github", host: "github.com", id: "1", name: "acme/widgets" };
const KEY = "github.com/acme/widgets";
const T0 = "2026-10-01T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "" };

let github: FakeGitHub;
let auth: WriteAuth;
const env = {} as Env;

beforeEach(() => {
	github = new FakeGitHub();
	github.addRepo(REPO_ID, "acme/widgets", {
		writers: ["alice"],
		assignable: ["alice", "carol"],
		labels: [{ name: "bug", color: "d73a4a", description: "Broken" }],
		milestones: ["v1", "v2"],
		discussionCategories: ["Ideas", "Q&A"],
		watchers: 12,
		files: { "README.md": "# Widgets", "docs/decisions/0001-first.md": "# First" },
	});
	github.addRepo(OTHER_ID, "acme/gadgets", { writers: ["alice"] });
	github.install(7, "acme", ["acme/widgets", "acme/gadgets"]);
	for (const number of [12, 13, 14]) {
		github.setItem(REPO_ID, { number, kind: "issue", title: `Issue ${number}`, updatedAt: T0 });
	}
	github.setItem(OTHER_ID, { number: 3, kind: "issue", title: "Gadget", updatedAt: T0 });
	auth = { as: "user", token: github.userTokenFor(ALICE) };
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		github.fetch(new globalThis.Request(input, init) as unknown as Request),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	gate.clear();
});

function apply(op: Operation, options = {}) {
	return applyGitHub(op, REPO, auth, options);
}

const writes = () =>
	github.requests
		.filter((r) => r.method !== "GET" && r.path !== "/graphql")
		.map((r) => `${r.method} ${r.path}`);

describe("apply", () => {
	it("creates an issue with labels, assignees and a milestone", async () => {
		const result = await apply({
			kind: "issue.create",
			repo: KEY,
			title: "Wobbly widgets",
			body: "They wobble.",
			labels: ["bug"],
			assignees: ["carol"],
			milestone: "v2",
		});
		expect(result).toEqual({
			ok: true,
			key: `${KEY}#15`,
			url: "https://github.com/acme/widgets/issues/15",
			confirmed: false,
		});
		expect(github.item(REPO_ID, 15)).toMatchObject({
			title: "Wobbly widgets",
			body: "They wobble.",
			labels: [{ name: "bug", color: "d73a4a" }],
			assignees: ["carol"],
			milestone: "v2",
		});
	});

	it("fails clearly for a milestone that doesn't exist, without creating anything", async () => {
		const result = await apply({ kind: "issue.create", repo: KEY, title: "T", milestone: "v9" });
		expect(result).toEqual({
			ok: false,
			error: "There's no milestone called “v9” in acme/widgets.",
			retryable: false,
		});
		expect(writes()).toEqual([]);
	});

	it("adds and removes labels, and removing one that isn't there is fine", async () => {
		const target = { key: `${KEY}#12` };
		expect(await apply({ kind: "item.labels", target, add: ["bug", "help"] })).toMatchObject({
			ok: true,
			key: `${KEY}#12`,
			confirmed: false,
		});
		// Again: idempotent.
		await apply({ kind: "item.labels", target, add: ["bug"] });
		expect(github.item(REPO_ID, 12)?.labels?.map((l) => l.name)).toEqual(["bug", "help"]);
		expect(await apply({ kind: "item.labels", target, remove: ["help", "nope"] })).toMatchObject({
			ok: true,
		});
		expect(github.item(REPO_ID, 12)?.labels?.map((l) => l.name)).toEqual(["bug"]);
	});

	it("sets and clears milestones, confirmed by GitHub's answer", async () => {
		const target = { key: `${KEY}#12` };
		expect(await apply({ kind: "item.milestone", target, milestone: "v1" })).toMatchObject({
			ok: true,
			confirmed: true,
		});
		expect(github.item(REPO_ID, 12)?.milestone).toBe("v1");
		await apply({ kind: "item.milestone", target, milestone: null });
		expect(github.item(REPO_ID, 12)?.milestone).toBeNull();
	});

	it("assigns and unassigns, and says who couldn't be assigned", async () => {
		const target = { key: `${KEY}#12` };
		expect(await apply({ kind: "item.assignees", target, add: ["alice", "carol"] })).toMatchObject({
			ok: true,
		});
		expect(github.item(REPO_ID, 12)?.assignees).toEqual(["alice", "carol"]);
		await apply({ kind: "item.assignees", target, remove: ["alice"] });
		expect(github.item(REPO_ID, 12)?.assignees).toEqual(["carol"]);
		expect(await apply({ kind: "item.assignees", target, add: ["mallory"] })).toEqual({
			ok: false,
			error:
				"GitHub wouldn't assign @mallory to acme/widgets#12: they can't be assigned issues in acme/widgets.",
			retryable: false,
		});
	});

	it("closes with a reason and reopens", async () => {
		const target = { key: `${KEY}#12` };
		await apply({ kind: "item.state", target, state: "closed", reason: "not_planned" });
		expect(github.item(REPO_ID, 12)).toMatchObject({ state: "closed", stateReason: "not_planned" });
		await apply({ kind: "item.state", target, state: "open" });
		expect(github.item(REPO_ID, 12)).toMatchObject({ state: "open" });
	});

	it("adds a sub-issue by database id, across repositories, and only once", async () => {
		const op: Operation = {
			kind: "item.subIssue",
			parent: { key: `${KEY}#12` },
			child: { key: "github.com/acme/gadgets#3" },
		};
		expect(await apply(op)).toMatchObject({ ok: true, key: `${KEY}#12`, confirmed: true });
		expect(await apply(op)).toMatchObject({ ok: true });
		expect(github.subIssues.get(`${REPO_ID}#12`)).toEqual([github.databaseId(OTHER_ID, 3)]);
		expect(writes().filter((w) => w.endsWith("/sub_issues"))).toHaveLength(1);
	});

	it("says so, in plain words, when the child already has another parent", async () => {
		await apply({
			kind: "item.subIssue",
			parent: { key: `${KEY}#12` },
			child: { key: `${KEY}#14` },
		});
		const result = await apply({
			kind: "item.subIssue",
			parent: { key: `${KEY}#13` },
			child: { key: `${KEY}#14` },
		});
		expect(result).toEqual({
			ok: false,
			retryable: false,
			error: "#14 already has a parent issue (#12), and an issue can only have one.",
			detail:
				"GitHub said (422): An error occurred while adding the sub-issue to the parent issue. Sub issue may only have one parent",
			problem: { code: "has_parent", parent: `${KEY}#12` },
		});
		expect(github.subIssues.get(`${REPO_ID}#13`)).toBeUndefined();
	});

	it("refuses before writing when GitHub says which parent it has", async () => {
		github.restParentUrls = true;
		await apply({
			kind: "item.subIssue",
			parent: { key: `${KEY}#12` },
			child: { key: `${KEY}#14` },
		});
		const before = writes().length;
		const result = await apply({
			kind: "item.subIssue",
			parent: { key: `${KEY}#13` },
			child: { key: `${KEY}#14` },
		});
		expect(result).toMatchObject({
			ok: false,
			error: "#14 already has a parent issue (#12), and an issue can only have one.",
			problem: { code: "has_parent", parent: `${KEY}#12` },
		});
		expect(writes()).toHaveLength(before);
	});

	it("moves a sub-issue from its parent with replaceParent, once", async () => {
		await apply({
			kind: "item.subIssue",
			parent: { key: `${KEY}#12` },
			child: { key: `${KEY}#14` },
		});
		const move: Operation = {
			kind: "item.subIssue",
			parent: { key: `${KEY}#13` },
			child: { key: `${KEY}#14` },
			replaceParent: true,
			previousParent: `${KEY}#12`,
		};
		expect(await apply(move)).toMatchObject({ ok: true, key: `${KEY}#13`, confirmed: true });
		expect(github.subIssues.get(`${REPO_ID}#12`)).toEqual([]);
		expect(github.subIssues.get(`${REPO_ID}#13`)).toEqual([github.databaseId(REPO_ID, 14)]);
		const posts = github.requests.filter(
			(r) => r.method === "POST" && r.path.endsWith("/13/sub_issues"),
		);
		expect(posts).toHaveLength(1);
		// Already a sub-issue of this parent: applied, with nothing written.
		expect(await apply(move)).toMatchObject({ ok: true });
		expect(
			github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/13/sub_issues")),
		).toHaveLength(1);
	});

	it("explains loops, limits and an issue under itself, and keeps what GitHub said", async () => {
		const sub = (parent: number, child: number) =>
			apply({
				kind: "item.subIssue",
				parent: { key: `${KEY}#${parent}` },
				child: { key: `${KEY}#${child}` },
			});
		expect(await sub(12, 12)).toMatchObject({
			ok: false,
			error: "An issue can't be its own sub-issue.",
			problem: { code: "self" },
		});
		await sub(12, 13);
		const loop = await sub(13, 12);
		expect(loop).toMatchObject({
			ok: false,
			retryable: false,
			error: expect.stringContaining("#13 is already under #12"),
			detail: expect.stringContaining("ancestor"),
			problem: { code: "cycle" },
		});
		github.maxSubIssues = 1;
		expect(await sub(12, 14)).toMatchObject({
			ok: false,
			error: expect.stringContaining("#12 has as many sub-issues as GitHub allows"),
			problem: { code: "too_many" },
		});
	});

	it("explains blocked-by loops and an issue blocking itself", async () => {
		const block = (target: number, blocker: number) =>
			apply({
				kind: "item.blockedBy",
				target: { key: `${KEY}#${target}` },
				blockedBy: { key: `${KEY}#${blocker}` },
			});
		expect(await block(12, 12)).toMatchObject({
			ok: false,
			error: "An issue can't be blocked by itself.",
			problem: { code: "self" },
		});
		expect(await block(12, 13)).toMatchObject({ ok: true });
		expect(await block(13, 12)).toMatchObject({
			ok: false,
			error: expect.stringContaining("#12 is already waiting on #13"),
			detail: expect.stringContaining("circular"),
			problem: { code: "cycle" },
		});
	});

	it("marks an issue as blocked by another, only once", async () => {
		const op: Operation = {
			kind: "item.blockedBy",
			target: { key: `${KEY}#12` },
			blockedBy: { key: `${KEY}#13` },
		};
		expect(await apply(op)).toMatchObject({ ok: true, confirmed: true });
		expect(await apply(op)).toMatchObject({ ok: true });
		expect(github.blockedBy.get(`${REPO_ID}#12`)).toEqual([github.databaseId(REPO_ID, 13)]);
	});

	it("comments, as the person, and links to the comment", async () => {
		const result = await apply({
			kind: "item.comment",
			target: { key: `${KEY}#12` },
			body: "From the board",
		});
		expect(result).toEqual({
			ok: true,
			key: `${KEY}#12`,
			url: "https://github.com/acme/widgets/issues/12#issuecomment-1",
			confirmed: true,
		});
		expect(github.comments).toMatchObject([{ body: "From the board", login: "alice" }]);
	});

	it("opens a pull request with files: a branch from the default branch, one commit", async () => {
		const result = await apply({
			kind: "pr.create",
			repo: KEY,
			title: "ADR 2: Use Tack",
			body: "Decided on the board.",
			branch: "tack/adr-0002",
			files: [{ path: "docs/decisions/0002-use-tack.md", content: "# Use Tack" }],
		});
		expect(result).toEqual({
			ok: true,
			key: `${KEY}#15`,
			url: "https://github.com/acme/widgets/pull/15",
			confirmed: false,
		});
		const files = github.filesOn(REPO_ID, "tack/adr-0002");
		expect(files?.get("docs/decisions/0002-use-tack.md")).toBe("# Use Tack");
		// Built on the default branch.
		expect(files?.get("README.md")).toBe("# Widgets");
		const sha = github.refs.get(`${REPO_ID}:tack/adr-0002`) ?? "";
		expect(github.commits.get(sha)).toMatchObject({
			message: "ADR 2: Use Tack",
			parents: [github.refs.get(`${REPO_ID}:main`)],
		});
		expect(github.item(REPO_ID, 15)).toMatchObject({ kind: "pull", headRef: "tack/adr-0002" });
	});

	it("never overwrites someone else's branch, but finishes its own earlier attempt", async () => {
		const op: Operation = {
			kind: "pr.create",
			repo: KEY,
			title: "ADR",
			body: "",
			branch: "tack/adr",
			files: [{ path: "docs/adr.md", content: "A" }],
		};
		const pulls = () => github.itemsIn(REPO_ID).filter((i) => i.kind === "pull");
		// An earlier attempt made the branch, then GitHub fell over before the pull request.
		const started = Date.now();
		github.failWrites({ status: 502, match: "/pulls" });
		expect(await apply(op)).toMatchObject({ ok: false, retryable: true });
		expect(github.refs.has(`${REPO_ID}:tack/adr`)).toBe(true);
		expect(pulls()).toHaveLength(0);
		// Trying again reuses the branch (it holds exactly these files) and opens it.
		expect(await apply(op, { retryOf: started })).toMatchObject({ ok: true, key: `${KEY}#15` });
		// And again (say the answer was lost): finds that pull request.
		expect(await apply(op, { retryOf: started })).toMatchObject({ ok: true, key: `${KEY}#15` });
		expect(pulls()).toHaveLength(1);
		// Different files on a branch that exists: refused.
		const other = await apply({ ...op, files: [{ path: "docs/adr.md", content: "B" }] });
		expect(other).toMatchObject({
			ok: false,
			error: "There's already a branch called “tack/adr” in acme/widgets. Pick another name.",
		});
	});

	it("starts a discussion in a category, by name", async () => {
		const result = await apply({
			kind: "discussion.create",
			repo: KEY,
			category: "ideas",
			title: "Should widgets wobble?",
			body: "Discuss.",
		});
		expect(result).toEqual({
			ok: true,
			url: "https://github.com/acme/widgets/discussions/1000",
			confirmed: true,
		});
		expect(github.discussions).toMatchObject([
			{ title: "Should widgets wobble?", category: "Ideas" },
		]);
		expect(
			await apply({
				kind: "discussion.create",
				repo: KEY,
				category: "Nope",
				title: "T",
				body: "B",
			}),
		).toMatchObject({
			ok: false,
			error: "There's no discussion category called “Nope” in acme/widgets.",
		});
	});
});

describe("retries never write twice", () => {
	it("finds the issue an unanswered attempt created", async () => {
		const op: Operation = { kind: "issue.create", repo: KEY, title: "Only once" };
		const started = Date.now();
		await apply(op);
		expect(await apply(op, { retryOf: started })).toMatchObject({ ok: true, key: `${KEY}#15` });
		expect(github.itemsIn(REPO_ID)).toHaveLength(4);
		// Without the hint, it's a new issue: people may file the same title twice.
		expect(await apply(op)).toMatchObject({ key: `${KEY}#16` });
	});

	it("finds the comment an unanswered attempt posted", async () => {
		const op: Operation = { kind: "item.comment", target: { key: `${KEY}#12` }, body: "Once" };
		const started = Date.now();
		await apply(op);
		await apply(op, { retryOf: started });
		expect(github.comments).toHaveLength(1);
	});

	it("finds the discussion an unanswered attempt started", async () => {
		const op: Operation = {
			kind: "discussion.create",
			repo: KEY,
			category: "Ideas",
			title: "Once",
			body: "B",
		};
		const started = Date.now();
		await apply(op);
		await apply(op, { retryOf: started });
		expect(github.discussions).toHaveLength(1);
	});
});

describe("failures", () => {
	const op: Operation = { kind: "item.labels", target: { key: `${KEY}#12` }, add: ["bug"] };

	it("comes back retryable, with when, for primary and secondary rate limits", async () => {
		const reset = Math.floor(Date.now() / 1000) + 600;
		github.failWrites({
			status: 403,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
			message: "API rate limit exceeded",
		});
		expect(await apply(op)).toMatchObject({ ok: false, retryable: true, retryAt: reset * 1000 });
		// Until then, writes with that token wait without asking GitHub (rateLimit.ts).
		const asked = github.requests.length;
		expect(await apply(op)).toMatchObject({ ok: false, retryable: true, retryAt: reset * 1000 });
		expect(github.requests.length).toBe(asked);
		gate.clear();

		const before = Date.now();
		github.failWrites({
			status: 403,
			headers: { "retry-after": "30" },
			message: "You have exceeded a secondary rate limit",
		});
		const secondary = await apply(op);
		expect(secondary).toMatchObject({ ok: false, retryable: true });
		expect(!secondary.ok && secondary.retryAt).toBeGreaterThanOrEqual(before + 30_000);
		gate.clear();

		github.failWrites({ status: 403, message: "You have exceeded a secondary rate limit" });
		const unsaid = await apply(op);
		expect(!unsaid.ok && unsaid.retryAt).toBeGreaterThanOrEqual(before + 60_000);
	});

	it("comes back retryable for outages, and not for refusals", async () => {
		github.failWrites({ status: 502, message: "Bad gateway" });
		expect(await apply(op)).toMatchObject({ ok: false, retryable: true });
		expect(await apply(op)).toMatchObject({ ok: true });

		auth = { as: "user", token: github.userTokenFor(BOB) };
		expect(await apply(op)).toMatchObject({
			ok: false,
			retryable: false,
			error: expect.stringContaining("GitHub didn't let you add labels to acme/widgets#12"),
		});
	});

	it("says what GitHub's refusals mean, keeping its own words as the detail", async () => {
		github.failWrites({ status: 403, message: "Resource not accessible by integration" });
		expect(await apply(op)).toMatchObject({
			error:
				"GitHub didn't let you add labels to acme/widgets#12. Check you can write to the repository and that Tack's app has access to it, or push as Tack's bot.",
			detail: "GitHub said (403): Resource not accessible by integration",
		});
		auth = { ...auth, as: "app" };
		github.failWrites({ status: 403, message: "Resource not accessible by integration" });
		expect(await apply(op)).toEqual({
			ok: false,
			retryable: false,
			error:
				"Tack's GitHub App doesn't have permission to add labels to acme/widgets#12. An owner of the repository may need to accept the app's new permissions, or give it access to this repository, in GitHub's settings.",
			detail: "GitHub said (403): Resource not accessible by integration",
		});
		github.failWrites({ status: 422, message: "Validation Failed: could not be assigned" });
		expect(await apply(op)).toMatchObject({
			error: expect.stringContaining("someone can't be assigned there"),
		});
		github.failWrites({ status: 410, message: "Issues are disabled for this repo" });
		expect(await apply(op)).toMatchObject({
			error: "Couldn't add labels to acme/widgets#12: issues are turned off in this repository.",
		});
		github.failWrites({ status: 429, headers: { "retry-after": "40" }, message: "slow down" });
		expect(await apply(op)).toMatchObject({
			retryable: true,
			error: expect.stringMatching(/^GitHub is rate limiting Tack until \d\d:\d\d UTC/),
		});
	});

	it("never throws, even when GitHub can't be reached", async () => {
		vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network down")));
		expect(await apply(op)).toEqual({
			ok: false,
			error: "Couldn't reach GitHub.",
			retryable: true,
		});
	});

	it("refuses targets that aren't GitHub items, or aren't created yet", async () => {
		expect(
			await apply({ kind: "item.comment", target: { pending: "x" }, body: "B" }),
		).toMatchObject({
			ok: false,
			retryable: false,
		});
		expect(
			await apply({ kind: "item.comment", target: { key: "fake.tack/a/b#1" }, body: "B" }),
		).toMatchObject({ ok: false, retryable: false });
		expect(writes()).toEqual([]);
	});
});

describe("reading what writes need", () => {
	it("checks write access with the person's own token", async () => {
		expect(await canWriteGitHub(REPO, github.userTokenFor(ALICE))).toBe(true);
		expect(await canWriteGitHub(REPO, github.userTokenFor(BOB))).toBe(false);
		expect(await canWriteGitHub({ ...REPO, id: "999" }, github.userTokenFor(ALICE))).toBe(false);
	});

	it("describes a repository: labels, milestones, people, categories, watchers", async () => {
		const meta = await repoMetaGitHub(REPO, env, { token: github.userTokenFor(ALICE) });
		expect(meta).toEqual({
			repo: KEY,
			labels: [{ name: "bug", color: "d73a4a", description: "Broken" }],
			milestones: [
				{ title: "v1", dueOn: null },
				{ title: "v2", dueOn: null },
			],
			assignees: ["alice", "carol"],
			discussionCategories: ["Ideas", "Q&A"],
			watchers: 12,
			defaultBranch: "main",
			// No app configured in this test.
			writable: false,
		});
	});

	it("lists files in a directory on the default branch", async () => {
		const token = { token: github.userTokenFor(ALICE) };
		expect(await listDirectoryGitHub(REPO, "docs/decisions", env, token)).toEqual([
			"0001-first.md",
		]);
		expect(await listDirectoryGitHub(REPO, "/docs/", env, token)).toEqual([]);
		expect(await listDirectoryGitHub(REPO, "nowhere", env, token)).toEqual([]);
	});
});
