import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { Card, CardMessage, MissingCard } from "../src/shared/cards.ts";
import { addShape, nextZ } from "../src/shared/shapes.ts";
import { sign } from "../src/server/forges/hmac.ts";
import { FakeGitHub, type FakeRequest } from "./fake-github.ts";
import { startWorker } from "./harness.ts";

// Discussions on a real board: a card for a discussion (pasted as a
// `/discussions/` link, which is the same key as any item), kept live by
// `discussion` and `discussion_comment` webhooks through the `Repo` object,
// as issues are. Real Boards and Repos in Miniflare, a fake GitHub.

const ID = 42;
const REPOSITORY = { id: ID, node_id: `R_${ID}`, full_name: "acme/unpic" };
const RFC = "github.com/acme/unpic#41";
const QUESTION = "github.com/acme/unpic#42";
const T0 = "2026-10-01T00:00:00Z";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(ID, "acme/unpic", {
		labels: [{ name: "rfc", color: "5319e7" }],
		discussionCategories: ["Ideas", "Q&A"],
	});
	github.setItem(ID, { number: 40, kind: "issue", title: "Providers", updatedAt: T0 });
	github.addDiscussion(ID, 41, {
		title: "RFC: a plugin API for providers",
		category: "Ideas",
		upvotes: 9,
		updatedAt: T0,
	});
	github.addDiscussion(ID, 42, {
		title: "How do I set a default quality?",
		category: "Q&A",
		updatedAt: T0,
	});
	return github;
}

function worker(github: FakeGitHub): Miniflare {
	const mf = startWorker({
		outboundService: github.fetch,
		bindings: { GITHUB_TOKEN: "test-token" },
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

async function openBoard(mf: Miniflare, name: string) {
	const url = await mf.ready;
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
	const waitFor = <T>(key: string, check: (card: Card | MissingCard | undefined) => T | false) =>
		vi.waitFor(
			() => {
				const found = check(cards.get(key));
				if (!found) throw new Error(`${key}: ${JSON.stringify(cards.get(key))}`);
				return found;
			},
			{ timeout: 12_000, interval: 50 },
		);
	return {
		add(...keys: string[]) {
			for (const key of keys) {
				addShape(doc, crypto.randomUUID(), { type: "card", ref: key, x: 0, y: 0, z: nextZ(doc) });
			}
		},
		until: (key: string, check: (card: Card) => boolean) =>
			waitFor(key, (card) => (card && !("missing" in card) && check(card) ? card : false)),
		missing: (key: string) => waitFor(key, (card) => (card && "missing" in card ? card : false)),
	};
}

const graphql = (operation: string) => (request: FakeRequest) => request.operation === operation;

describe("discussions on a board", () => {
	it("load beside issues, in one request", async () => {
		const github = fakeGitHub();
		const board = await openBoard(worker(github), "discussions-load");
		board.add("github.com/acme/unpic#40", RFC, QUESTION);
		const rfc = await board.until(RFC, () => true);
		expect(rfc).toMatchObject({
			kind: "discussion",
			title: "RFC: a plugin API for providers",
			url: "https://github.com/acme/unpic/discussions/41",
			visibility: "public",
			discussion: { category: { name: "Ideas", emoji: "💡" }, upvotes: 9, answered: false },
		});
		await board.until("github.com/acme/unpic#40", (card) => card.kind === "issue");
		await board.until(QUESTION, (card) => card.discussion?.category.answerable === true);
		expect(github.count(graphql("TackItems"))).toBe(1);
	});

	it("stay live: answered, labelled, commented on, closed, and deleted", async () => {
		const github = fakeGitHub();
		const mf = worker(github);
		const board = await openBoard(mf, "discussions-live");
		board.add(RFC, QUESTION);
		await board.until(RFC, (card) => card.discussion?.upvotes === 9);
		await board.until(QUESTION, () => true);

		// Someone answers the question on GitHub.
		const question = github.discussion(ID, 42);
		if (!question) throw new Error("no question");
		Object.assign(question, {
			answer: { login: "jo", chosenAt: "2026-10-02T00:00:00Z" },
			updatedAt: "2026-10-02T00:00:00Z",
		});
		const answered = await deliver(mf, "discussion", github.discussionEvent(ID, 42, "answered"));
		expect(answered).toMatchObject({ updated: [QUESTION] });
		const card = await board.until(QUESTION, (c) => !!c.discussion?.answered);
		expect(card.discussion?.answer).toMatchObject({ author: "jo" });

		// Labelled: the payload has no upvotes, so the card keeps the last read's.
		const rfc = github.discussion(ID, 41);
		if (!rfc) throw new Error("no rfc");
		Object.assign(rfc, {
			labels: [{ name: "rfc", color: "5319e7" }],
			updatedAt: "2026-10-03T00:00:00Z",
		});
		await deliver(mf, "discussion", github.discussionEvent(ID, 41, "labeled"));
		const labelled = await board.until(RFC, (c) => c.labels.length === 1);
		expect(labelled.discussion?.upvotes).toBe(9);
		expect(labelled.discussion?.category.emoji).toBe("💡");

		// A comment changes its count.
		Object.assign(rfc, {
			comments: [{ body: "+1", login: "kai", createdAt: T0 }],
			updatedAt: "2026-10-04T00:00:00Z",
		});
		await deliver(
			mf,
			"discussion_comment",
			github.discussionEvent(ID, 41, "created", { comment: "+1" }),
		);
		await board.until(RFC, (c) => c.comments === 1);

		// Closed as outdated.
		Object.assign(rfc, {
			closed: true,
			stateReason: "OUTDATED",
			updatedAt: "2026-10-05T00:00:00Z",
		});
		await deliver(mf, "discussion", github.discussionEvent(ID, 41, "closed"));
		await board.until(RFC, (c) => c.state === "closed" && c.stateReason === "outdated");

		// Deleted: gone from the board's view, not left as it was.
		await deliver(mf, "discussion", github.discussionEvent(ID, 42, "deleted"));
		expect(await board.missing(QUESTION)).toMatchObject({ missing: true, reason: "not_found" });
	});
});
