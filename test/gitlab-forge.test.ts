// The GitLab adapter (#65), in Node against a fake GitLab (no network):
// cards for issues and merge requests, webhooks and their tokens, polling,
// and writes with the instance's own token, only where they're turned on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Card, MissingCard } from "../src/shared/cards.ts";
import type { Operation } from "../src/shared/changes.ts";
import { DEFAULT_FORGE_HOSTS, setForgeHosts } from "../src/shared/refs.ts";
import { configureForges } from "../src/server/forges/config.ts";
import { forge } from "../src/server/forges/index.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import type { FetchRef, RepoIdentity } from "../src/server/forges/types.ts";
import { FakeGitLab, forgesFetch } from "./fake-forges.ts";

const HOST = "git.example.com";
const SECRET = "hook-secret";
const gitlab = forge("gitlab");

let fake: FakeGitLab;
let env: Env;

function configure(extra: Record<string, unknown> = {}) {
	env = {
		TACK_FORGES: JSON.stringify([
			{
				host: HOST,
				forge: "gitlab",
				name: "Acme GitLab",
				token: fake.token,
				webhookSecret: SECRET,
				writes: true,
				...extra,
			},
		]),
	} as Env;
	// As every entry point does: keys may name the configured hosts.
	configureForges(env);
}

const REPO: RepoIdentity = {
	forge: "gitlab",
	host: HOST,
	id: "42",
	name: "acme/platform/app",
	private: false,
};

const ref = (item: string, repo = REPO.name): FetchRef => ({
	forge: "gitlab",
	host: HOST,
	repo,
	item,
});

beforeEach(() => {
	fake = new FakeGitLab(HOST);
	fake.addProject(42, "acme/platform/app");
	fake.addProject(43, "acme/secret", "private");
	fake.setIssue(42, {
		iid: 1,
		title: "Dark mode",
		labels: [{ name: "ux", color: "#a2eeef" }],
		assignees: ["ada"],
		notes: 3,
		upvotes: 2,
		milestone: "v2",
	});
	fake.setIssue(42, { iid: 2, title: "Embargoed", confidential: true });
	fake.setMergeRequest(42, {
		iid: 3,
		title: "Draft: Theme tokens",
		draft: true,
		pipeline: { id: 900, status: "failed", failedJobs: ["lint", "unit"] },
		reviewers: [{ username: "grace", state: "requested_changes" }],
	});
	fake.setIssue(43, { iid: 1, title: "Hidden" });
	configure();
	vi.stubGlobal("fetch", forgesFetch({ gitlab: [fake] }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	gate.clear();
	setForgeHosts(DEFAULT_FORGE_HOSTS);
});

describe("cards", () => {
	it("reads issues with their labels' colours, milestone and thumbs up", async () => {
		const [card] = (await gitlab.fetchItems([ref("#1")], env, REPO)) as Card[];
		expect(card).toMatchObject({
			key: "git.example.com/acme/platform/app#1",
			forge: "gitlab",
			kind: "issue",
			state: "open",
			title: "Dark mode",
			labels: [{ name: "ux", color: "a2eeef" }],
			assignees: [{ login: "ada" }],
			comments: 3,
			thumbsUp: { count: 2 },
			milestone: { title: "v2", dueOn: null },
			url: "https://git.example.com/acme/platform/app/-/issues/1",
		});
	});

	it("reads merge requests with their pipeline's failed jobs and reviewers", async () => {
		const [card] = (await gitlab.fetchItems([ref("!3")], env, REPO)) as Card[];
		expect(card?.key).toBe("git.example.com/acme/platform/app!3");
		expect(card?.kind).toBe("pull");
		expect(card?.state).toBe("draft");
		expect(card?.pull?.detail).toBe("full");
		expect(card?.pull?.checks).toMatchObject({ state: "failing", failed: 2 });
		expect(card?.pull?.checks?.failing.map((c) => c.name)).toEqual(["lint", "unit"]);
		expect(card?.pull?.review).toBe("changes_requested");
		expect(card?.pull?.reviewers).toEqual([
			{ login: "grace", avatarUrl: "", state: "changes_requested" },
		]);
	});

	it("never shows confidential issues, and says when an item doesn't exist", async () => {
		const [hidden, gone] = (await gitlab.fetchItems(
			[ref("#2"), ref("#99")],
			env,
			REPO,
		)) as MissingCard[];
		expect(hidden).toMatchObject({ missing: true, reason: "forbidden" });
		expect(gone).toMatchObject({ missing: true, reason: "not_found" });
	});

	it("reads public projects anonymously when the instance has no token", async () => {
		configure({ token: undefined, writes: false });
		const [card] = await gitlab.fetchItems([ref("#1")], env, REPO);
		expect(card && !("missing" in card) && card.title).toBe("Dark mode");
		// The confidential issue isn't even listed without a token.
		const [hidden] = await gitlab.fetchItems([ref("#2")], env, REPO);
		expect(hidden).toMatchObject({ missing: true, reason: "not_found" });
	});

	it("says hosts it doesn't serve are unsupported, without asking anyone", async () => {
		const before = fake.log.length;
		const [card] = await gitlab.fetchItems(
			[{ forge: "gitlab", host: "other.example", repo: "a/b", item: "#1" }],
			env,
		);
		expect(card).toMatchObject({ missing: true, reason: "unsupported" });
		expect(fake.log.length).toBe(before);
	});
});

describe("repositories", () => {
	it("resolves projects by path to their id and visibility", async () => {
		expect(await gitlab.resolveRepo?.(HOST, "acme/platform/app", env)).toEqual({
			forge: "gitlab",
			host: HOST,
			id: "42",
			name: "acme/platform/app",
			private: false,
		});
		// The token can read it, but nobody on the board will.
		const secret = await gitlab.resolveRepo?.(HOST, "acme/secret", env);
		expect(secret).toMatchObject({ id: "43", private: true });
		expect(await gitlab.canRead?.(secret as RepoIdentity, null, env)).toBe(false);
		expect(await gitlab.resolveRepo?.(HOST, "acme/nope", env)).toBe("not_found");
	});

	it("polls for what changed since the last look", async () => {
		const [card] = (await gitlab.fetchItems([ref("#1")], env, REPO)) as Card[];
		const quiet = await gitlab.poll?.(REPO, [card as Card], env, {
			etag: null,
			since: card?.updatedAt ?? null,
		});
		expect(quiet).toEqual({ status: "changed", etag: null, cards: [] });
		fake.setIssue(42, {
			iid: 1,
			title: "Dark mode, everywhere",
			updated_at: "2026-10-02T00:00:00Z",
		});
		const changed = await gitlab.poll?.(REPO, [card as Card], env, {
			etag: null,
			since: card?.updatedAt ?? null,
		});
		expect(changed?.status).toBe("changed");
		expect(changed?.status === "changed" && (changed.cards[0] as Card).title).toBe(
			"Dark mode, everywhere",
		);
	});
});

describe("webhooks", () => {
	const delivery = (body: unknown, token: string | null = SECRET) =>
		new Request("https://tack.example/webhooks/gitlab", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-gitlab-event": "Issue Hook",
				"x-gitlab-event-uuid": "uuid-1",
				...(token === null ? {} : { "x-gitlab-token": token }),
			},
			body: JSON.stringify(body),
		});

	const issueHook = {
		object_kind: "issue",
		project: {
			id: 42,
			path_with_namespace: "acme/platform/app",
			web_url: `https://${HOST}/acme/platform/app`,
			visibility_level: 20,
		},
		object_attributes: { iid: 1, action: "update" },
	};

	it("takes deliveries with the host's token, reading the item in full", async () => {
		const result = await gitlab.receiveWebhook?.(delivery(issueHook), env);
		expect(result?.type).toBe("delivery");
		if (result?.type !== "delivery") return;
		expect(result.delivery).toMatchObject({
			id: "uuid-1",
			event: "Issue Hook",
			action: "update",
			repo: { forge: "gitlab", host: HOST, id: "42", name: "acme/platform/app", private: false },
		});
		expect(result.delivery.cards.map((c) => c.key)).toEqual([
			"git.example.com/acme/platform/app#1",
		]);
		expect(result.delivery.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses a wrong or missing token, hosts it doesn't serve, and hosts without a secret", async () => {
		const status = async (request: Request, config = env) => {
			const result = await gitlab.receiveWebhook?.(request, config);
			return result?.type === "response" ? result.response.status : 0;
		};
		expect(await status(delivery(issueHook, "guess"))).toBe(401);
		expect(await status(delivery(issueHook, null))).toBe(401);
		expect(
			await status(
				delivery({
					...issueHook,
					project: { ...issueHook.project, web_url: "https://elsewhere.example/acme/app" },
				}),
			),
		).toBe(403);
		configure({ webhookSecret: undefined });
		expect(await status(delivery(issueHook))).toBe(403);
	});

	it("reads merge requests' pipelines again shortly, rather than trusting the payload", async () => {
		const result = await gitlab.receiveWebhook?.(
			delivery({
				object_kind: "pipeline",
				project: issueHook.project,
				object_attributes: { sha: "abc123", status: "failed" },
				merge_request: { iid: 3 },
			}),
			env,
		);
		expect(result?.type === "delivery" && result.delivery.refetch).toEqual({
			items: ["!3"],
			commits: ["abc123"],
		});
	});

	it("ignores events about nothing on a board", async () => {
		const result = await gitlab.receiveWebhook?.(
			delivery({ object_kind: "push", project: issueHook.project }),
			env,
		);
		expect(result?.type === "response" && result.response.status).toBe(202);
	});
});

describe("writes", () => {
	const apply = (op: Operation) =>
		gitlab.apply?.(op, REPO, { as: "app", token: "" }, env, {}) ?? Promise.reject();

	it("says what it can do, and nothing it can't", () => {
		expect(gitlab.capabilities.writes).not.toContain("item.subIssue");
		expect(gitlab.capabilities.writes).not.toContain("item.blockedBy");
		expect(gitlab.capabilities.writes).not.toContain("discussion.create");
		expect(gitlab.capabilities.writes).toContain("pr.create");
	});

	it("labels, closes, assigns and comments with the instance's token", async () => {
		const target = { key: "git.example.com/acme/platform/app#1" };
		expect(
			await apply({ kind: "item.labels", target, add: ["bug"], remove: ["ux"] }),
		).toMatchObject({
			ok: true,
			key: target.key,
			url: "https://git.example.com/acme/platform/app/-/issues/1",
		});
		expect(await apply({ kind: "item.state", target, state: "closed" })).toMatchObject({
			ok: true,
		});
		expect(await apply({ kind: "item.assignees", target, add: ["grace"] })).toMatchObject({
			ok: true,
		});
		expect(await apply({ kind: "item.comment", target, body: "Shipped" })).toMatchObject({
			ok: true,
			confirmed: true,
		});
		const issue = fake.project(42).issues.get(1);
		expect(issue?.labels?.map((l) => l.name)).toEqual(["bug"]);
		expect(issue?.state).toBe("closed");
		expect(issue?.assignees).toEqual(["ada", "grace"]);
		expect(fake.notesOn(42, 1)).toEqual(["Shipped"]);
	});

	it("creates issues, and merge requests from a commit on a new branch", async () => {
		const issue = await apply({
			kind: "issue.create",
			repo: "git.example.com/acme/platform/app",
			title: "From the board",
			labels: ["bug"],
		});
		expect(issue).toMatchObject({ ok: true, key: "git.example.com/acme/platform/app#3" });
		const mr = await apply({
			kind: "pr.create",
			repo: "git.example.com/acme/platform/app",
			title: "Record a decision",
			body: "From Tack",
			branch: "tack/adr-1",
			files: [{ path: "docs/decisions/0002-tokens.md", content: "# Tokens" }],
		});
		expect(mr).toMatchObject({ ok: true });
		expect(mr.ok && mr.key).toMatch(/^git\.example\.com\/acme\/platform\/app!\d+$/);
		expect(fake.project(42).branches.has("tack/adr-1")).toBe(true);
	});

	it("refuses plainly when writes are off, and never throws", async () => {
		configure({ writes: false });
		const result = await apply({
			kind: "item.state",
			target: { key: "git.example.com/acme/platform/app#1" },
			state: "closed",
		});
		expect(result).toMatchObject({ ok: false, retryable: false });
		expect(!result.ok && result.error).toMatch(/doesn't write to Acme GitLab/);
		expect(fake.log.some((line) => line.startsWith("PUT"))).toBe(false);
	});

	it("refuses items on another host", async () => {
		const result = await apply({
			kind: "item.state",
			target: { key: "gitlab.com/acme/platform/app#1" },
			state: "closed",
		});
		expect(result.ok).toBe(false);
	});

	it("lets people push when writes are on and they're one of its writers", async () => {
		const ada = { id: 1, login: "ada" };
		expect(gitlab.writable?.(REPO, env)).toBe(true);
		expect(await gitlab.canWrite?.(REPO, "", env, ada)).toBe(true);
		configure({ writers: ["grace"] });
		expect(await gitlab.canWrite?.(REPO, "", env, ada)).toBe(false);
		expect(await gitlab.canWrite?.(REPO, "", env, { id: 2, login: "Grace" })).toBe(true);
		configure({ writes: false });
		expect(gitlab.writable?.(REPO, env)).toBe(false);
		expect(await gitlab.canWrite?.(REPO, "", env, ada)).toBe(false);
	});

	it("reads labels, milestones and members for the push sheet", async () => {
		const meta = await gitlab.repoMeta?.(REPO, env);
		expect(meta).toMatchObject({
			repo: "git.example.com/acme/platform/app",
			labels: [
				{ name: "bug", color: "d73a4a" },
				{ name: "ux", color: "a2eeef" },
			],
			milestones: [{ title: "v2", dueOn: null }],
			assignees: ["ada", "grace", "tack-bot"],
			defaultBranch: "main",
			writable: true,
		});
		expect(await gitlab.listDirectory?.(REPO, "docs/decisions", env)).toEqual(["0001-first.md"]);
	});
});
