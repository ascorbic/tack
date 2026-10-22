// The Forgejo adapter (#65: Codeberg, and Gitea, which shares its API), in
// Node against a fake Forgejo (no network): cards, signed webhooks, polling,
// and writes with the instance's own token, only where they're turned on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Card } from "../src/shared/cards.ts";
import type { Operation } from "../src/shared/changes.ts";
import { configureForges } from "../src/server/forges/config.ts";
import { sign } from "../src/server/forges/hmac.ts";
import { forge } from "../src/server/forges/index.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import type { FetchRef, RepoIdentity } from "../src/server/forges/types.ts";
import { FakeForgejo, forgesFetch } from "./fake-forges.ts";

const HOST = "codeberg.org";
const SECRET = "hook-secret";
const forgejo = forge("forgejo");

let fake: FakeForgejo;
let env: Env;

function configure(extra: Record<string, unknown> = {}) {
	env = {
		TACK_FORGES: JSON.stringify([
			{ host: HOST, token: fake.token, webhookSecret: SECRET, writes: true, ...extra },
		]),
	} as Env;
	configureForges(env);
}

const REPO: RepoIdentity = {
	forge: "forgejo",
	host: HOST,
	id: "7",
	name: "acme/kite",
	private: false,
};

const ref = (item: string): FetchRef => ({ forge: "forgejo", host: HOST, repo: REPO.name, item });

beforeEach(() => {
	fake = new FakeForgejo(HOST);
	fake.addRepo(7, "acme/kite");
	fake.addRepo(8, "acme/private", true);
	fake.setItem("acme/kite", {
		number: 1,
		title: "Offline mode",
		labels: [{ id: 2, name: "enhancement", color: "84b6eb" }],
		assignees: ["ada"],
		comments: 4,
		milestone: "1.0",
	});
	fake.setItem("acme/kite", {
		number: 2,
		title: "WIP: Sync engine",
		pull: true,
		statuses: [
			{ status: "success", context: "build" },
			{ status: "failure", context: "test" },
			{ status: "skipped", context: "deploy" },
		],
		reviews: [{ login: "grace", state: "APPROVED" }],
	});
	configure();
	vi.stubGlobal("fetch", forgesFetch({ forgejo: [fake] }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	gate.clear();
});

describe("cards", () => {
	it("reads issues, with times in UTC whatever offset Forgejo answers with", async () => {
		const [card] = (await forgejo.fetchItems([ref("#1")], env, REPO)) as Card[];
		expect(card).toMatchObject({
			key: "codeberg.org/acme/kite#1",
			forge: "forgejo",
			kind: "issue",
			state: "open",
			labels: [{ name: "enhancement", color: "84b6eb" }],
			assignees: [{ login: "ada" }],
			comments: 4,
			milestone: { title: "1.0", dueOn: null },
			updatedAt: "2026-10-01T00:00:00.000Z",
			url: "https://codeberg.org/acme/kite/issues/1",
		});
	});

	it("reads pull requests with their statuses, reviews and size", async () => {
		const [card] = (await forgejo.fetchItems([ref("#2")], env, REPO)) as Card[];
		expect(card?.kind).toBe("pull");
		// A WIP title is how Forgejo marks a draft.
		expect(card?.state).toBe("draft");
		expect(card?.pull).toMatchObject({
			detail: "full",
			checks: {
				state: "failing",
				passed: 1,
				failed: 1,
				skipped: 1,
				pending: 0,
				failing: [{ name: "test" }],
			},
			review: "approved",
			reviewers: [{ login: "grace", state: "approved" }],
			mergeable: "mergeable",
			changedFiles: 3,
		});
	});

	it("never shows a private repository, though the instance's token can read it", async () => {
		const repo = await forgejo.resolveRepo?.(HOST, "acme/private", env);
		expect(repo).toMatchObject({ id: "8", private: true });
		expect(await forgejo.canRead?.(repo as RepoIdentity, null, env)).toBe(false);
		expect(await forgejo.canRead?.(REPO, null, env)).toBe(true);
	});

	it("takes no merge requests (`!`): Forgejo numbers everything with `#`", async () => {
		const [card] = await forgejo.fetchItems([ref("!2")], env, REPO);
		expect(card).toMatchObject({ missing: true, reason: "unsupported" });
	});

	it("polls for what changed since the last look", async () => {
		const [card] = (await forgejo.fetchItems([ref("#1")], env, REPO)) as Card[];
		fake.setItem("acme/kite", { number: 1, title: "Offline", updated_at: "2026-10-03T00:00:00Z" });
		const result = await forgejo.poll?.(REPO, [card as Card], env, {
			etag: null,
			since: card?.updatedAt ?? null,
		});
		expect(
			result?.status === "changed" && result.cards.map((c) => "title" in c && c.title),
		).toEqual(["Offline"]);
	});

	it("answers a rate limit at once with when to try again, rather than waiting it out", async () => {
		const route = forgesFetch({ forgejo: [fake] });
		let calls = 0;
		vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
			if (!String(input).includes("/issues?")) return route(input, init);
			calls++;
			return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
		});
		const started = Date.now();
		const poll = () => forgejo.poll?.(REPO, [], env, { etag: null, since: null });
		const first = await poll();
		expect(first).toMatchObject({ status: "error", retryAt: expect.any(Number) });
		expect(first?.status === "error" && (first.retryAt ?? 0) - started).toBeGreaterThan(25_000);
		// The gate answers the next one without asking Forgejo.
		expect(await poll()).toMatchObject({ status: "error" });
		expect(calls).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("webhooks", () => {
	const issueEvent = {
		action: "edited",
		issue: {
			number: 1,
			title: "Offline mode, at last",
			state: "open",
			html_url: "https://codeberg.org/acme/kite/issues/1",
			updated_at: "2026-10-04T00:00:00Z",
			labels: [],
			assignees: [],
			user: { login: "ada" },
			comments: 5,
		},
		repository: {
			id: 7,
			full_name: "acme/kite",
			private: false,
			html_url: "https://codeberg.org/acme/kite",
		},
	};

	async function delivery(body: unknown, secret = SECRET, header = "x-forgejo-signature") {
		const text = JSON.stringify(body);
		const signature = (await sign(secret, text)).replace(/^sha256=/, "");
		return new Request("https://tack.example/webhooks/forgejo", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forgejo-event": "issues",
				"x-forgejo-delivery": "d-1",
				[header]: signature,
			},
			body: text,
		});
	}

	it("takes signed deliveries, and their cards as they say", async () => {
		const result = await forgejo.receiveWebhook?.(await delivery(issueEvent), env);
		expect(result?.type).toBe("delivery");
		if (result?.type !== "delivery") return;
		expect(result.delivery).toMatchObject({
			id: "d-1",
			event: "issues",
			action: "edited",
			repo: { forge: "forgejo", host: HOST, id: "7", name: "acme/kite", private: false },
		});
		expect(result.delivery.cards[0]).toMatchObject({
			key: "codeberg.org/acme/kite#1",
			title: "Offline mode, at last",
			comments: 5,
		});
	});

	it("takes Gitea's headers too", async () => {
		const result = await forgejo.receiveWebhook?.(
			await delivery(issueEvent, SECRET, "x-gitea-signature"),
			env,
		);
		expect(result?.type).toBe("delivery");
	});

	it("refuses a bad signature, hosts it doesn't serve, and hosts without a secret", async () => {
		const status = async (request: Request) => {
			const result = await forgejo.receiveWebhook?.(request, env);
			return result?.type === "response" ? result.response.status : 0;
		};
		expect(await status(await delivery(issueEvent, "guess"))).toBe(401);
		expect(
			await status(
				await delivery({
					...issueEvent,
					repository: { ...issueEvent.repository, html_url: "https://git.evil.example/acme/kite" },
				}),
			),
		).toBe(403);
		configure({ webhookSecret: undefined });
		expect(await status(await delivery(issueEvent))).toBe(403);
	});

	it("reads pull requests' CI and reviews again shortly", async () => {
		const result = await forgejo.receiveWebhook?.(
			await delivery({
				action: "synchronized",
				pull_request: {
					...issueEvent.issue,
					number: 2,
					title: "Sync engine",
					html_url: "https://codeberg.org/acme/kite/pulls/2",
					head: { sha: "abc" },
					body: "Fixes #1",
				},
				repository: issueEvent.repository,
			}),
			env,
		);
		if (result?.type !== "delivery") throw new Error("expected a delivery");
		expect(result.delivery.cards[0]?.kind).toBe("pull");
		expect(result.delivery.refetch?.items).toEqual(["#2"]);
		expect(result.delivery.mentions?.["codeberg.org/acme/kite#2"]).toBeDefined();
	});
});

describe("writes", () => {
	const apply = (op: Operation) =>
		forgejo.apply?.(op, REPO, { as: "app", token: "" }, env, {}) ?? Promise.reject();
	const target = { key: "codeberg.org/acme/kite#1" };

	it("says what it can do: blocked-by, but not sub-issues or Discussions", () => {
		expect(forgejo.capabilities.writes).toContain("item.blockedBy");
		expect(forgejo.capabilities.writes).not.toContain("item.subIssue");
		expect(forgejo.capabilities.writes).not.toContain("discussion.create");
	});

	it("labels, closes, comments and links dependencies with the instance's token", async () => {
		expect(
			await apply({ kind: "item.labels", target, add: ["bug"], remove: ["enhancement"] }),
		).toMatchObject({ ok: true, key: target.key });
		expect(await apply({ kind: "item.state", target, state: "closed" })).toMatchObject({
			ok: true,
		});
		expect(await apply({ kind: "item.comment", target, body: "Done" })).toMatchObject({ ok: true });
		expect(
			await apply({
				kind: "item.blockedBy",
				target,
				blockedBy: { key: "codeberg.org/acme/kite#2" },
			}),
		).toMatchObject({ ok: true });
		const repo = fake.repo("acme/kite");
		const issue = repo.items.get(1);
		expect(issue?.labels?.map((l) => l.name)).toEqual(["bug"]);
		expect(issue?.state).toBe("closed");
		expect(repo.comments.map((c) => c.body)).toEqual(["Done"]);
		expect(repo.dependencies).toEqual([
			{ number: 1, on: { owner: "acme", repo: "kite", index: 2 } },
		]);
	});

	it("creates issues", async () => {
		const result = await apply({
			kind: "issue.create",
			repo: "codeberg.org/acme/kite",
			title: "From the board",
			labels: ["bug"],
		});
		expect(result).toMatchObject({ ok: true, key: "codeberg.org/acme/kite#3" });
		expect(
			fake
				.repo("acme/kite")
				.items.get(3)
				?.labels?.map((l) => l.name),
		).toEqual(["bug"]);
	});

	it("refuses plainly when writes are off, without calling Forgejo", async () => {
		configure({ writes: false });
		const before = fake.log.length;
		const result = await apply({ kind: "item.state", target, state: "closed" });
		expect(result).toMatchObject({ ok: false, retryable: false });
		expect(!result.ok && result.error).toMatch(/doesn't write to Codeberg/);
		expect(fake.log.length).toBe(before);
	});

	it("lets people push only where writes are on, and the token's account can", async () => {
		const ada = { id: 1, login: "ada" };
		expect(await forgejo.canWrite?.(REPO, "", env, ada)).toBe(true);
		configure({ writers: ["grace"] });
		expect(await forgejo.canWrite?.(REPO, "", env, ada)).toBe(false);
		configure({ token: undefined });
		expect(forgejo.writable?.(REPO, env)).toBe(false);
		expect(await forgejo.canWrite?.(REPO, "", env, ada)).toBe(false);
	});
});
