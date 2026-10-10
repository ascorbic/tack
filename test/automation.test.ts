// Rules (#44) and inbox frames (#40) end to end: a real board in Miniflare,
// opened over a WebSocket, hearing webhook deliveries from a fake GitHub
// through its `Repo` objects, and searching the synthetic `fake.tack` forge.

import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import type { CardMessage } from "../src/shared/cards.ts";
import { inboxQuery, previewId, setInbox } from "../src/shared/inbox.ts";
import { addRule, listRules, readRuleLog } from "../src/shared/rules.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection } from "../src/shared/structure.ts";
import type { SearchResult, WidgetMessage } from "../src/shared/widgets.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = { id: 42, node_id: "R_42", full_name: "acme/widgets", private: false };
const ELSEWHERE = { id: 43, node_id: "R_43", full_name: "acme/elsewhere", private: false };
const REPO = "github.com/acme/widgets";
const T0 = "2026-10-01T00:00:00Z";
const ME = { name: "Alice", login: "alice" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(WIDGETS.id, WIDGETS.full_name);
	github.addRepo(ELSEWHERE.id, ELSEWHERE.full_name);
	github.setItem(WIDGETS.id, { number: 12, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	return github;
}

async function open(name: string): Promise<{ mf: Miniflare; client: BoardClient }> {
	const github = fakeGitHub();
	const mf = startWorker({ outboundService: github.fetch, bindings: { GITHUB_TOKEN: "t" } });
	cleanups.push(() => mf.dispose());
	const adopted = await mf.dispatchFetch(`${ORIGIN}/api/boards/legacy`, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	expect(adopted.status).toBe(200);
	const result = await connectBoard(mf, name);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return { mf, client: result.client };
}

async function deliver(mf: Miniflare, event: string, payload: Record<string, unknown>) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign("test-secret", body),
		},
	});
	expect(response.status).toBe(202);
}

function issuePayload(number: number, labels: string[] = []) {
	return {
		number,
		title: `Issue ${number}`,
		state: "open",
		html_url: `https://github.com/acme/widgets/issues/${number}`,
		updated_at: "2026-10-03T00:00:00Z",
		labels: labels.map((name) => ({ name, color: "d73a4a" })),
		assignees: [],
		comments: 0,
	};
}

function pullPayload(number: number, body: string, repo = "acme/widgets") {
	return {
		number,
		title: "Stop the wobble",
		body,
		state: "open",
		draft: false,
		html_url: `https://github.com/${repo}/pull/${number}`,
		updated_at: "2026-10-03T00:00:00Z",
		labels: [],
		assignees: [],
		head: { sha: "abc" },
	};
}

/** Put a card on the board, and wait for the board to subscribe to it. */
async function addCard(client: BoardClient, key: string, x = 0, y = 0) {
	addShape(client.doc, crypto.randomUUID(), { type: "card", ref: key, x, y, z: "a5" });
	await client.roundTrip();
	await eventually(
		() =>
			(client.messages as CardMessage[]).some(
				(message) => message.type === "cards" && message.cards.some((card) => card.key === key),
			),
		8000,
	);
}

function ruleCards(client: BoardClient) {
	return [...shapesMap(client.doc)]
		.map(([id, shape]) => ({ id, ...readShape(shape) }))
		.filter((shape) => shape.provenance?.via === "rule");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("rules", () => {
	it("places a pull request that closes an issue beside it, and logs it", async () => {
		const { mf, client } = await open("rules-pull");
		await addCard(client, `${REPO}#12`);
		const rule = addRule(client.doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		await client.roundTrip();

		await deliver(mf, "pull_request", {
			action: "opened",
			repository: WIDGETS,
			pull_request: pullPayload(40, "This fixes #12, finally."),
		});

		await eventually(() => ruleCards(client).length === 1, 8000);
		const [placed] = ruleCards(client);
		expect(placed).toMatchObject({
			ref: `${REPO}#40`,
			provenance: { via: "rule", source: rule },
		});
		expect(placed!.x).toBeGreaterThanOrEqual(252);
		expect(readRuleLog(client.doc)).toMatchObject([
			{ rule, outcome: "placed", key: `${REPO}#40`, near: `${REPO}#12` },
		]);
		expect(listRules(client.doc)[0]).toMatchObject({ fired: 1 });

		// The same pull request again: nothing more.
		await deliver(mf, "pull_request", {
			action: "edited",
			repository: WIDGETS,
			pull_request: { ...pullPayload(40, "Fixes #12"), updated_at: "2026-10-04T00:00:00Z" },
		});
		await sleep(300);
		await client.roundTrip();
		expect(ruleCards(client)).toHaveLength(1);
	});

	it("adds a newly labelled issue to a section", async () => {
		const { mf, client } = await open("rules-section");
		await addCard(client, `${REPO}#12`, -600, 0);
		const section = addSection(client.doc, { x: 0, y: 0, w: 640, h: 440 }, { title: "Bugs" });
		const rule = addRule(
			client.doc,
			{
				kind: "matches",
				query: { kind: "search", host: "github.com", q: "repo:acme/widgets is:issue label:bug" },
			},
			{ kind: "section", section },
			ME,
		);
		await client.roundTrip();

		await deliver(mf, "issues", {
			action: "opened",
			repository: WIDGETS,
			issue: issuePayload(50),
		});
		await sleep(300);
		await client.roundTrip();
		expect(ruleCards(client)).toHaveLength(0);

		await deliver(mf, "issues", {
			action: "labeled",
			repository: WIDGETS,
			issue: { ...issuePayload(50, ["bug"]), updated_at: "2026-10-04T00:00:00Z" },
		});
		await eventually(() => ruleCards(client).length === 1, 8000);
		expect(ruleCards(client)[0]).toMatchObject({
			ref: `${REPO}#50`,
			parent: section,
			provenance: { via: "rule", source: rule },
		});

		// Unlabelled again: it's marked as no longer matching, and stays put.
		const placed = ruleCards(client)[0]!;
		await deliver(mf, "issues", {
			action: "unlabeled",
			repository: WIDGETS,
			issue: { ...issuePayload(50), updated_at: "2026-10-05T00:00:00Z" },
		});
		await eventually(() => typeof ruleCards(client)[0]?.unmatched === "string", 8000);
		expect(ruleCards(client)[0]).toMatchObject({ x: placed.x, y: placed.y, parent: section });
	});

	it("never places items from repositories that aren't on the board", async () => {
		const { mf, client } = await open("rules-elsewhere");
		await addCard(client, `${REPO}#12`);
		addRule(client.doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		await client.roundTrip();
		await deliver(mf, "pull_request", {
			action: "opened",
			repository: ELSEWHERE,
			pull_request: pullPayload(7, "Fixes acme/widgets#12", "acme/elsewhere"),
		});
		await sleep(500);
		await client.roundTrip();
		expect(ruleCards(client)).toHaveLength(0);
		expect(readRuleLog(client.doc)).toHaveLength(0);
	});
});

describe("inbox frames", () => {
	const widgetData = (client: BoardClient, id: string) =>
		(client.messages as WidgetMessage[]).filter(
			(message) => message.type === "widget-data" && message.id === id,
		);
	const latest = (client: BoardClient, id: string) =>
		widgetData(client, id).at(-1)?.results.inbox as SearchResult | undefined;

	it("searches an inbox's query for whoever's watching it, and again when it changes", async () => {
		const { client } = await open("inbox-board");
		const section = addSection(client.doc, { x: 0, y: 0, w: 640, h: 440 }, { title: "Inbox" });
		setInbox(client.doc, section, { ...inboxQuery("repo:demo/inbox is:open"), host: "fake.tack" });
		await client.roundTrip();

		client.send({ type: "widget-watch", ids: [section, "not-an-inbox"] });
		await eventually(() => latest(client, section)?.kind === "search", 8000);
		const first = latest(client, section)!;
		expect(first.total).toBeGreaterThan(0);
		expect(first.items.every((card) => card.state === "open" || card.state === "draft")).toBe(true);
		expect(widgetData(client, "not-an-inbox")).toHaveLength(0);

		// Someone narrows the query: everyone watching gets new results.
		setInbox(client.doc, section, {
			...inboxQuery("repo:demo/inbox is:open label:docs"),
			host: "fake.tack",
		});
		await eventually(() => (latest(client, section)?.total ?? 0) < first.total, 8000);
	});

	it("previews a query as it's written", async () => {
		const { client } = await open("inbox-preview");
		const section = addSection(client.doc, { x: 0, y: 0, w: 640, h: 440 }, {});
		await client.roundTrip();
		client.send({
			type: "inbox-preview",
			id: section,
			query: { ...inboxQuery("repo:demo/inbox is:closed"), host: "fake.tack" },
		});
		await eventually(() => latest(client, previewId(section))?.kind === "search", 8000);
		client.send({ type: "inbox-preview", id: section, query: inboxQuery("is:open") });
		await eventually(
			() => widgetData(client, previewId(section)).at(-1)?.results.inbox?.kind === "error",
			8000,
		);
	});
});
