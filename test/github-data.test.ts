import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { Card, CardMessage, MissingCard } from "../src/shared/cards.ts";
import { addShape, nextZ } from "../src/shared/shapes.ts";
import { sign } from "../src/server/forges/hmac.ts";
import { repoObjectName } from "../src/server/routing.ts";
import { FakeGitHub, type FakeRequest } from "./fake-github.ts";
import { instanceStub, repoStub, startWorker, type WorkerOptions } from "./harness.ts";

// Integration tests for GitHub data: real Boards and Repos in Miniflare,
// talking to a fake GitHub, with boards opened over WebSockets like the app.

const ID = 42;
const REPOSITORY = { id: ID, node_id: `R_${ID}`, full_name: "acme/widgets" };
const ISSUE = "github.com/acme/widgets#7";
const PULL = "github.com/acme/widgets#8";
const T0 = "2026-10-01T00:00:00Z";
const T1 = "2026-10-02T00:00:00Z";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(ID, "acme/widgets");
	github.setItem(ID, { number: 7, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	github.setItem(ID, {
		number: 8,
		kind: "pull",
		title: "Stop the wobble",
		updatedAt: T0,
		head: "abc123",
		closes: [7],
		checks: [
			{ name: "build", state: "IN_PROGRESS" },
			{ name: "test", state: "IN_PROGRESS" },
			{ name: "lint", state: "SUCCESS" },
		],
		reviewDecision: "REVIEW_REQUIRED",
	});
	github.setItem(ID, { number: 9, kind: "issue", title: "Unrelated", updatedAt: T0 });
	return github;
}

function worker(github: FakeGitHub, options: WorkerOptions = {}): Miniflare {
	const mf = startWorker({
		outboundService: github.fetch,
		bindings: { GITHUB_TOKEN: "test-token" },
		...options,
	});
	cleanups.push(() => mf.dispose());
	return mf;
}

async function deliver(mf: Miniflare, event: string, payload: Record<string, unknown>) {
	const body = JSON.stringify({ repository: REPOSITORY, ...payload });
	const response = await mf.dispatchFetch("https://example.com/webhooks/github", {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign("test-secret", body),
		},
	});
	expect(response.status).toBe(202);
	return (await response.json()) as Record<string, unknown>;
}

interface BoardClient {
	cards: Map<string, Card | MissingCard>;
	add(...keys: string[]): void;
	card(key: string): Promise<Card>;
	until(key: string, check: (card: Card) => boolean): Promise<Card>;
}

/** Open a board the way the app does: a Yjs provider over a WebSocket. */
async function openBoard(mf: Miniflare, name: string): Promise<BoardClient> {
	const url = await mf.ready;
	// Boards must be in the index; adopt this one as a guest would from `/?board=name`.
	const adopted = await mf.dispatchFetch(new URL("/api/boards/legacy", url).toString(), {
		method: "POST",
		headers: { origin: url.origin, "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	expect(adopted.status).toBe(200);
	const doc = new Y.Doc();
	const cards = new Map<string, Card | MissingCard>();
	const provider = new YProvider(url.host, name, doc, { party: "board" });
	provider.on("custom-message", (raw: string) => {
		const message = JSON.parse(raw) as CardMessage | { type: string };
		// Boards send more than cards now (comments, widgets, the timer…).
		if (message.type === "cards") {
			for (const card of (message as Extract<CardMessage, { type: "cards" }>).cards) {
				cards.set(card.key, card);
			}
		} else if (message.type === "card" || message.type === "card-missing") {
			const { card } = message as Extract<CardMessage, { card: unknown }>;
			cards.set(card.key, card);
		}
	});
	await new Promise<void>((resolve) => {
		provider.on("sync", (synced: boolean) => synced && resolve());
	});
	cleanups.push(() => provider.destroy());

	const until = (key: string, check: (card: Card) => boolean) =>
		vi.waitFor(
			() => {
				const card = cards.get(key);
				if (!card || "missing" in card || !check(card)) {
					throw new Error(`${key}: ${JSON.stringify(card)}`);
				}
				return card;
			},
			{ timeout: 12_000, interval: 50 },
		);
	return {
		cards,
		add(...keys) {
			for (const key of keys) {
				addShape(doc, crypto.randomUUID(), { type: "card", ref: key, x: 0, y: 0, z: nextZ(doc) });
			}
		},
		card: (key) => until(key, () => true),
		until,
	};
}

const graphql = (operation: string) => (request: FakeRequest) => request.operation === operation;
const path = (p: string) => (request: FakeRequest) => request.path === p;

describe("repositories keyed by id", () => {
	it("keeps cards live across a rename, under the keys boards already use", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "rename");

		board.add(ISSUE);
		expect(await board.card(ISSUE)).toMatchObject({
			title: "Widgets wobble",
			repo: "acme/widgets",
		});

		// GitHub renames the repository and tells us.
		github.rename(ID, "acme/gizmos");
		const renamed = { ...REPOSITORY, full_name: "acme/gizmos" };
		await deliver(mf, "repository", { action: "renamed", repository: renamed });
		// The card keeps its key, and shows the new name.
		await board.until(ISSUE, (card) => card.repo === "acme/gizmos");

		// Webhooks name the repository by its new name, and still reach the card.
		github.updateItem(ID, 7, { title: "Gizmos wobble too", updatedAt: T1 });
		await deliver(mf, "issues", {
			action: "edited",
			repository: renamed,
			issue: {
				number: 7,
				title: "Gizmos wobble too",
				state: "open",
				html_url: "https://github.com/acme/gizmos/issues/7",
				updated_at: T1,
			},
		});
		await board.until(ISSUE, (card) => card.title === "Gizmos wobble too");

		// A reference by the new name reaches the same Repo and its cache.
		const NEW_KEY = "github.com/acme/gizmos#7";
		board.add(NEW_KEY);
		expect(await board.card(NEW_KEY)).toMatchObject({ title: "Gizmos wobble too" });

		const repo = await repoStub(mf, repoObjectName({ host: "github.com", id: String(ID) }));
		expect(await repo.subscribers(ISSUE)).toEqual(["rename"]);
		expect(await repo.subscribers(NEW_KEY)).toEqual(["rename"]);
		expect(await repo.identity()).toMatchObject({ id: "42", name: "acme/gizmos" });
		// Each name was resolved to the repository id once.
		expect(github.count(path("/repos/acme/widgets"))).toBe(1);
		expect(github.count(path("/repos/acme/gizmos"))).toBe(1);
	});

	it("batches a burst of new cards into one subscription and one query", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "burst");

		// Pasted one at a time, as separate document updates.
		board.add(ISSUE);
		board.add(PULL);
		board.add("github.com/acme/widgets#9");
		await board.card("github.com/acme/widgets#9");
		await board.card(ISSUE);
		await board.card(PULL);

		expect(github.count(path("/repos/acme/widgets"))).toBe(1);
		expect(github.count(graphql("TackItems"))).toBe(1);
		expect(github.requests.find(graphql("TackItems"))?.aliases).toEqual(["i7", "i8", "i9"]);
	});
});

describe("pull requests", () => {
	it("shows CI, reviews, mergeability and linked issues", async () => {
		const github = fakeGitHub();
		const board = await openBoard(worker(github), "details");
		board.add(PULL);
		const card = await board.card(PULL);
		expect(card.pull).toMatchObject({
			detail: "full",
			head: "abc123",
			checks: { state: "pending", passed: 1, pending: 2, failed: 0, failing: [] },
			review: "review_required",
			mergeable: "mergeable",
			linked: [{ key: ISSUE, item: "#7", title: "Widgets wobble", state: "open" }],
		});
	});

	it("coalesces a burst of CI events into one refetch, within seconds", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "ci");
		board.add(PULL);
		await board.until(PULL, (card) => card.pull?.checks?.pending === 2);
		const fetched = github.count(graphql("TackItems"));

		// CI fails, and GitHub sends a flurry of events about it.
		github.updateItem(ID, 8, {
			checks: [
				{ name: "build", state: "SUCCESS" },
				{ name: "test", state: "FAILURE" },
				{ name: "lint", state: "SUCCESS" },
			],
		});
		const run = { head_sha: "abc123", pull_requests: [{ number: 8 }] };
		const results = [
			await deliver(mf, "check_run", { action: "completed", check_run: { ...run, id: 1 } }),
			await deliver(mf, "check_run", { action: "completed", check_run: { ...run, id: 2 } }),
			await deliver(mf, "workflow_run", { action: "completed", workflow_run: run }),
			await deliver(mf, "check_suite", { action: "completed", check_suite: run }),
			// Statuses name only the commit, as do checks on PRs from forks.
			await deliver(mf, "status", { sha: "abc123", state: "failure" }),
		];
		for (const result of results) expect(result).toMatchObject({ refetching: ["#8"] });
		expect(github.count(graphql("TackItems"))).toBe(fetched);

		const card = await board.until(PULL, (c) => c.pull?.checks?.state === "failing");
		expect(card.pull?.checks).toMatchObject({
			passed: 2,
			failed: 1,
			pending: 0,
			failing: [{ name: "test", url: "https://github.com/checks/test" }],
		});
		expect(github.count(graphql("TackItems"))).toBe(fetched + 1);
		// Refetched by node id, not by number.
		expect(github.requests.filter(graphql("TackItems")).at(-1)?.variables?.ids).toEqual([
			`PR_${ID}_8`,
		]);
	});

	it("says which parent issue each issue has, and reads it again when a sub_issues event says it changed", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "parents");
		board.add(ISSUE, "github.com/acme/widgets#9");
		expect((await board.card(ISSUE)).parent).toBeNull();

		// #9 becomes #7's parent on GitHub.
		github.subIssues.set(`${ID}#9`, [github.databaseId(ID, 7)]);
		const issue = (n: number) => ({
			number: n,
			title: github.item(ID, n)?.title,
			state: "open",
			html_url: `https://github.com/acme/widgets/issues/${n}`,
			repository_url: "https://api.github.com/repos/acme/widgets",
			updated_at: T0,
		});
		const result = await deliver(mf, "sub_issues", {
			action: "sub_issue_added",
			parent_issue: issue(9),
			parent_issue_repo: REPOSITORY,
			sub_issue: issue(7),
			sub_issue_repo: REPOSITORY,
		});
		expect(result).toMatchObject({ refetching: ["#7"] });
		const card = await board.until(ISSUE, (c) => c.parent?.key === "github.com/acme/widgets#9");
		expect(card.parent).toEqual({ key: "github.com/acme/widgets#9", title: "Unrelated" });
	});

	it("picks up review decisions after a review", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "reviews");
		board.add(PULL);
		await board.card(PULL);

		github.updateItem(ID, 8, {
			reviewDecision: "CHANGES_REQUESTED",
			reviews: [
				{ login: "kai", state: "APPROVED" },
				{ login: "priya", state: "CHANGES_REQUESTED" },
			],
		});
		await deliver(mf, "pull_request_review", {
			action: "submitted",
			pull_request: { number: 8 },
			review: { state: "changes_requested" },
		});
		const card = await board.until(PULL, (c) => c.pull?.review === "changes_requested");
		expect(card.pull?.reviewers.map((r) => [r.login, r.state])).toEqual([
			["priya", "changes_requested"],
			["kai", "approved"],
		]);
	});

	it("keeps full details while a pull request webhook waits for its refetch", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "keep");
		board.add(PULL);
		await board.until(PULL, (card) => card.pull?.detail === "full");

		await deliver(mf, "pull_request", {
			action: "edited",
			pull_request: {
				number: 8,
				title: "Stop the wobble, properly",
				state: "open",
				html_url: "https://github.com/acme/widgets/pull/8",
				updated_at: T1,
				head: { sha: "abc123" },
				mergeable: null,
			},
		});
		const card = await board.until(PULL, (c) => c.title === "Stop the wobble, properly");
		expect(card.pull).toMatchObject({ detail: "full", checks: { pending: 2 } });
	});

	it("falls back to REST without a token, and says what's missing", async () => {
		const github = fakeGitHub();
		const board = await openBoard(worker(github, { bindings: { GITHUB_TOKEN: "" } }), "rest");
		board.add(PULL, ISSUE);
		expect(await board.card(ISSUE)).toMatchObject({ title: "Widgets wobble", kind: "issue" });
		expect((await board.card(PULL)).pull).toMatchObject({
			detail: "basic",
			head: "abc123",
			checks: null,
			review: null,
			mergeable: "mergeable",
		});
		expect(github.count((r) => r.path === "/graphql")).toBe(0);
	});
});

describe("freshness", () => {
	it("corrects a sleeping board's cards when it wakes, with one batched check", async () => {
		const github = fakeGitHub();
		const persist = mkdtempSync(join(tmpdir(), "tack-"));
		cleanups.push(() => rmSync(persist, { recursive: true, force: true }));

		const first = worker(github, { persist });
		const board = await openBoard(first, "sleepy");
		board.add(ISSUE, PULL, "github.com/acme/widgets#9");
		await board.card("github.com/acme/widgets#9");
		await board.card(ISSUE);
		await board.until(PULL, (card) => card.pull?.checks?.state === "pending");
		// Let the board save its document, then put everything to sleep.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		await first.dispose();

		// Meanwhile, on GitHub, with nobody watching (and no webhooks):
		github.updateItem(ID, 7, { title: "Widgets wobble on Tuesdays", updatedAt: T1 });
		// CI changes don't touch the pull request's updatedAt.
		github.updateItem(ID, 8, {
			checks: [
				{ name: "build", state: "SUCCESS" },
				{ name: "test", state: "FAILURE" },
				{ name: "lint", state: "SUCCESS" },
			],
		});
		github.requests = [];

		const woken = await openBoard(worker(github, { persist }), "sleepy");
		await woken.until(ISSUE, (card) => card.title === "Widgets wobble on Tuesdays");
		await woken.until(PULL, (card) => card.pull?.checks?.state === "failing");

		// No name lookups: the board remembers its repositories.
		expect(github.count((r) => r.path.startsWith("/repos/"))).toBe(0);
		// One cheap freshness query, then one fetch of just the stale cards.
		expect(github.count(graphql("TackFreshness"))).toBe(1);
		expect(github.requests.filter(graphql("TackItems")).map((r) => r.variables?.ids)).toEqual([
			[`I_${ID}_7`, `PR_${ID}_8`],
		]);
	});

	it("reconciles over REST without a token", async () => {
		const github = fakeGitHub();
		const mf = worker(github, { bindings: { GITHUB_TOKEN: "" } });
		const repo = await repoStub(mf, repoObjectName({ host: "github.com", id: String(ID) }));
		const identity = { forge: "github", host: "github.com", id: String(ID), name: "acme/widgets" };
		await repo.subscribe("b", [ISSUE, "github.com/acme/widgets#9"], identity as never);

		github.updateItem(ID, 7, { title: "Edited while nobody looked", updatedAt: T1 });
		expect(await repo.reconcile()).toEqual({ checked: 2, updated: [ISSUE] });
		expect((await repo.getCard(ISSUE))?.title).toBe("Edited while nobody looked");
	});
});

describe("webhook redelivery", () => {
	it("skips cleanly when no GitHub App is configured", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const result = await (await mf.getWorker()).scheduled({ cron: "*/10 * * * *" });
		expect(result.outcome).toBe("ok");
		expect(github.count((r) => r.path.startsWith("/app"))).toBe(0);
	});

	it("redelivers failed deliveries once the GitHub App is set up", async () => {
		const github = fakeGitHub();
		const mf = worker(github);

		// Create the app from its manifest, as an instance's first admin would.
		const setup = await mf.dispatchFetch("https://tack.test/api/setup");
		const { state } = (await setup.json()) as { state: string };
		const cookie = setup.headers
			.getSetCookie()
			.map((header) => header.split(";")[0])
			.join("; ");
		await mf.dispatchFetch(
			`https://tack.test/setup/callback?code=${github.manifestCode}&state=${state}`,
			{ headers: { cookie }, redirect: "manual" },
		);
		expect(await (await instanceStub(mf)).isConfigured()).toBe(true);

		const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
		github.hookDeliveries = [
			{
				id: 3,
				guid: "dropped",
				delivered_at: ago(2),
				redelivery: false,
				status_code: 502,
				event: "check_run",
			},
			{
				id: 2,
				guid: "fine",
				delivered_at: ago(3),
				redelivery: false,
				status_code: 202,
				event: "issues",
			},
			{
				id: 1,
				guid: "rejected",
				delivered_at: ago(4),
				redelivery: false,
				status_code: 401,
				event: "issues",
			},
		];
		const result = await (await mf.getWorker()).scheduled({ cron: "*/10 * * * *" });
		expect(result.outcome).toBe("ok");
		// The fake checks the app JWT on every call, so these used a real one.
		await vi.waitFor(() => expect(github.redelivered).toEqual([3]));
	});
});
