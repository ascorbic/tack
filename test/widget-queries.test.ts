// Widget queries (#37) end to end: list widgets in a real board's document,
// watched over WebSockets by people signed in through (a fake) GitHub, so
// every search runs with the viewer's own token. Private repositories'
// rows only ever reach people who can read them: tests look at the raw
// messages, not just parsed results.

import type { Miniflare, Response } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import { inboxQuery, setInbox } from "../src/shared/inbox.ts";
import { addShape, shapesMap, transactLocal } from "../src/shared/shapes.ts";
import { addSection } from "../src/shared/structure.ts";
import { addWidget, updateWidgetConfig } from "../src/shared/widgetRegistry.ts";
import type { RelatedResult, SearchResult, WidgetMessage } from "../src/shared/widgets.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, repoStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = 1;
const SECRET = 2;
const T0 = "2026-10-01T00:00:00Z";
const T1 = "2026-10-02T00:00:00Z";
const SECRET_TITLE = "Secret roadmap";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 502, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BUG = { name: "bug", color: "d73a4a" };

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(WIDGETS, "acme/widgets");
	github.setItem(WIDGETS, {
		number: 1,
		kind: "issue",
		title: "Widgets wobble",
		updatedAt: T0,
		labels: [BUG],
		assignees: ["alice"],
	});
	github.setItem(WIDGETS, { number: 2, kind: "issue", title: "Docs typo", updatedAt: T0 });
	github.addRepo(SECRET, "acme/secret", { private: true, collaborators: ["alice"] });
	github.setItem(SECRET, {
		number: 5,
		kind: "issue",
		title: SECRET_TITLE,
		updatedAt: T0,
		labels: [BUG],
	});
	github.install(7, "acme", ["acme/widgets", "acme/secret"]);
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

/** Sign in through GitHub, so the person has a real user token. */
async function signInWithGitHub(mf: Miniflare, github: FakeGitHub, who: FakeUser) {
	await signIn(mf, who.login);
	const start = await mf.dispatchFetch(`${ORIGIN}/auth/signin?return_to=/`, { redirect: "manual" });
	const callback = new URL(github.authorize(start.headers.get("location") ?? "", who));
	const jar = cookies(start);
	const done = await mf.dispatchFetch(`${ORIGIN}${callback.pathname}${callback.search}`, {
		headers: {
			cookie: Object.entries(jar)
				.map(([k, v]) => `${k}=${v}`)
				.join("; "),
		},
		redirect: "manual",
	});
	expect(done.status).toBe(302);
	return `tack_session=${cookies(done).tack_session ?? ""}`;
}

async function createBoard(mf: Miniflare, cookie: string): Promise<string> {
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ title: "Widgets", visibility: "public" }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

async function open(mf: Miniflare, board: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, board, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return result.client;
}

function widgetMessages(client: BoardClient, id: string): WidgetMessage[] {
	return client.messages.filter(
		(message): message is WidgetMessage =>
			(message as WidgetMessage).type === "widget-data" && (message as WidgetMessage).id === id,
	);
}

/** The latest results for a widget, once some arrive (and `check` passes). */
async function latest(
	client: BoardClient,
	id: string,
	check: (message: WidgetMessage) => boolean = () => true,
): Promise<WidgetMessage> {
	let found: WidgetMessage | undefined;
	await eventually(() => {
		found = widgetMessages(client, id).at(-1);
		return Boolean(found && check(found));
	}, 5000);
	return found as WidgetMessage;
}

const titles = (message: WidgetMessage) =>
	((message.results.items as SearchResult | undefined)?.items ?? []).map((card) => card.title);

const searches = (github: FakeGitHub) =>
	github.count(
		(request) => request.operation === "TackSearch" || request.path === "/search/issues",
	);

async function deliver(mf: Miniflare, github: FakeGitHub, event: string, payload: unknown) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign(github.app.webhook_secret, body),
		},
	});
	expect(response.status).toBe(202);
}

async function setup() {
	const github = fakeGitHub();
	const mf = await configured(github);
	const alice = await signInWithGitHub(mf, github, ALICE);
	const board = await createBoard(mf, alice);
	const owner = await open(mf, board, alice);
	const widget = transactLocal(owner.doc, () =>
		addWidget(owner.doc, "list", { x: 0, y: 0 }, { q: "org:acme is:open label:bug" }),
	);
	await owner.roundTrip();
	return { github, mf, alice, board, owner, widget };
}

describe("widget queries", () => {
	it("run with each viewer's own permissions", async () => {
		const { github, mf, board, owner, widget } = await setup();
		const bobCookie = await signInWithGitHub(mf, github, BOB);
		const bob = await open(mf, board, bobCookie);
		const anonymous = await open(mf, board);

		for (const client of [owner, bob, anonymous])
			client.send({ type: "widget-watch", ids: [widget] });

		// Alice can read the private repository; Bob and the public can't.
		expect(titles(await latest(owner, widget))).toEqual(
			expect.arrayContaining(["Widgets wobble", SECRET_TITLE]),
		);
		expect(titles(await latest(bob, widget))).toEqual(["Widgets wobble"]);
		expect(titles(await latest(anonymous, widget))).toEqual(["Widgets wobble"]);
		// Nothing of the private item reaches them, anywhere in any message.
		for (const client of [bob, anonymous]) {
			expect(JSON.stringify(client.messages)).not.toContain(SECRET_TITLE);
			expect(JSON.stringify(client.messages)).not.toContain("acme/secret");
		}
		// Public searches are limited to public repositories at the forge, too.
		expect(
			github.requests.some(
				(request) =>
					request.path === "/search/issues" ||
					JSON.stringify(request.variables ?? {}).includes("is:public"),
			),
		).toBe(true);
	});

	it("say @me means nobody when signed out, and the viewer when signed in", async () => {
		const { mf, board, owner, widget } = await setup();
		transactLocal(owner.doc, () =>
			updateWidgetConfig(owner.doc, widget, { q: "repo:acme/widgets assignee:@me" }),
		);
		await owner.roundTrip();
		const anonymous = await open(mf, board);
		owner.send({ type: "widget-watch", ids: [widget] });
		anonymous.send({ type: "widget-watch", ids: [widget] });
		expect(titles(await latest(owner, widget))).toEqual(["Widgets wobble"]);
		expect((await latest(anonymous, widget)).results.items).toMatchObject({
			kind: "error",
			reason: "signed_out",
		});
	});

	it("cache results per query and access level", async () => {
		const { github, mf, alice, board, owner, widget } = await setup();
		owner.send({ type: "widget-watch", ids: [widget] });
		await latest(owner, widget);
		const before = searches(github);
		// Alice again, in another tab: served from the cache.
		const again = await open(mf, board, alice);
		again.send({ type: "widget-watch", ids: [widget] });
		expect(titles(await latest(again, widget))).toContain(SECRET_TITLE);
		expect(searches(github)).toBe(before);
		// Someone else is another access level: their own search.
		const anonymous = await open(mf, board);
		anonymous.send({ type: "widget-watch", ids: [widget] });
		await latest(anonymous, widget);
		expect(searches(github)).toBe(before + 1);
		expect((await (await boardStub(mf, board)).widgetCache()).map((e) => e.access).sort()).toEqual([
			"public",
			`user:${ALICE.id}`,
		]);
	});

	it("run again when the config changes", async () => {
		const { owner, widget } = await setup();
		owner.send({ type: "widget-watch", ids: [widget] });
		await latest(owner, widget);
		transactLocal(owner.doc, () =>
			updateWidgetConfig(owner.doc, widget, { q: "repo:acme/widgets is:open" }),
		);
		await owner.roundTrip();
		const next = await latest(owner, widget, (message) => titles(message).includes("Docs typo"));
		expect(titles(next).sort()).toEqual(["Docs typo", "Widgets wobble"]);
	});

	it("refresh when a webhook changes a repository they read", async () => {
		const { github, mf, board, owner, widget } = await setup();
		await (await boardStub(mf, board)).widgetTiming({ debounceMs: 50, minIntervalMs: 0 });
		owner.send({ type: "widget-watch", ids: [widget] });
		await latest(owner, widget);
		// The board asked the repository to tell it about its webhooks.
		await eventually(async () =>
			(await (await repoStub(mf, `github.com/@${WIDGETS}`)).watchers()).includes(board),
		);

		github.setItem(WIDGETS, {
			number: 3,
			kind: "issue",
			title: "Gears grind",
			updatedAt: T1,
			labels: [BUG],
		});
		await deliver(mf, github, "issues", {
			action: "opened",
			repository: { id: WIDGETS, full_name: "acme/widgets", private: false },
			issue: {
				number: 3,
				title: "Gears grind",
				state: "open",
				html_url: "https://github.com/acme/widgets/issues/3",
				updated_at: T1,
				labels: [BUG],
			},
		});
		// Debounced, then run: no need to wait for the refresh schedule.
		const next = await latest(owner, widget, (message) => titles(message).includes("Gears grind"));
		expect(titles(next)).toContain("Gears grind");
	});

	it("keep the last results when a refresh is rate limited, and say when to retry", async () => {
		const { github, mf, board, owner, widget } = await setup();
		await (await boardStub(mf, board)).widgetTiming({ throttleMs: 0, freshMs: 0 });
		owner.send({ type: "widget-watch", ids: [widget] });
		const first = await latest(owner, widget);
		expect(titles(first)).toContain(SECRET_TITLE);

		github.failSearches({
			status: 403,
			headers: {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
			},
			message: "API rate limit exceeded",
		});
		const count = widgetMessages(owner, widget).length;
		owner.send({ type: "widget-refresh", id: widget });
		await eventually(() => widgetMessages(owner, widget).length > count);
		// The last good results stand, from when they were fetched: they go stale.
		const kept = await latest(owner, widget);
		expect(titles(kept)).toContain(SECRET_TITLE);
		expect(kept.at).toBe(first.at);

		// Until GitHub says to try again, nobody searches with that token, and
		// someone new is told when it'll be.
		const before = searches(github);
		const anonymous = await open(mf, board);
		anonymous.send({ type: "widget-watch", ids: [widget] });
		const limited = await latest(anonymous, widget);
		expect(limited.results.items).toMatchObject({ kind: "error", reason: "rate_limited" });
		expect((limited.results.items as { retryAt?: number }).retryAt).toBeGreaterThan(Date.now());
		expect(searches(github)).toBe(before);
	});

	it("stop sending once unwatched", async () => {
		const { owner, widget } = await setup();
		owner.send({ type: "widget-watch", ids: [widget] });
		await latest(owner, widget);
		owner.send({ type: "widget-unwatch", ids: [widget] });
		const count = widgetMessages(owner, widget).length;
		transactLocal(owner.doc, () => updateWidgetConfig(owner.doc, widget, { q: "is:open" }));
		await owner.roundTrip();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(widgetMessages(owner, widget)).toHaveLength(count);
	});
});

describe("inbox frames on the same runner", () => {
	it("search GitHub as each viewer, and confirm what they find", async () => {
		const { github, mf, board, owner } = await setup();
		const section = transactLocal(owner.doc, () => {
			const id = addSection(owner.doc, { x: 2000, y: 0, w: 640, h: 440 }, { title: "Bugs" });
			setInbox(owner.doc, id, inboxQuery("org:acme is:open label:bug"));
			return id;
		});
		await owner.roundTrip();
		const bob = await open(mf, board, await signInWithGitHub(mf, github, BOB));
		for (const client of [owner, bob]) client.send({ type: "widget-watch", ids: [section] });
		const inbox = (message: WidgetMessage) =>
			((message.results.inbox as SearchResult | undefined)?.items ?? []).map((card) => card.title);
		expect(inbox(await latest(owner, section, (m) => inbox(m).length > 0))).toEqual(
			expect.arrayContaining(["Widgets wobble", SECRET_TITLE]),
		);
		expect(inbox(await latest(bob, section, (m) => inbox(m).length > 0))).toEqual([
			"Widgets wobble",
		]);
		expect(JSON.stringify(bob.messages)).not.toContain(SECRET_TITLE);
	});
});

describe("fake forge searches", () => {
	it("search synthetic repositories without a network", async () => {
		const mf = startWorker({ devAuth: true });
		cleanups.push(() => mf.dispose());
		const cookie = await signIn(mf, "octocat");
		const board = await createBoard(mf, cookie);
		const client = await open(mf, board, cookie);
		const widget = transactLocal(client.doc, () =>
			addWidget(
				client.doc,
				"list",
				{ x: 0, y: 0 },
				{
					host: "fake.tack",
					q: "repo:stress/cards is:open label:docs",
					limit: 5,
				},
			),
		);
		await client.roundTrip();
		client.send({ type: "widget-watch", ids: [widget] });
		const message = await latest(client, widget);
		const result = message.results.items as SearchResult;
		expect(result.kind).toBe("search");
		expect(result.items).toHaveLength(5);
		expect(result.total).toBeGreaterThan(5);
		for (const card of result.items) {
			expect(["open", "draft"]).toContain(card.state);
			expect(card.labels.map((label) => label.name)).toContain("docs");
		}
	});
});

describe("follow-up queries", () => {
	async function fakeBoard() {
		const mf = startWorker({ devAuth: true });
		cleanups.push(() => mf.dispose());
		const cookie = await signIn(mf, "octocat");
		const board = await createBoard(mf, cookie);
		const client = await open(mf, board, cookie);
		return { mf, client };
	}

	it("ask what's related to each of a dependency map's search results, in the same message", async () => {
		const { client } = await fakeBoard();
		const widget = transactLocal(client.doc, () =>
			addWidget(
				client.doc,
				"dependencies",
				{ x: 0, y: 0 },
				{ host: "fake.tack", q: "repo:stress/cards is:issue is:open", limit: 5 },
			),
		);
		await client.roundTrip();
		client.send({ type: "widget-watch", ids: [widget] });
		const message = await latest(client, widget, (m) => Object.keys(m.results).length > 1);
		const items = message.results.items as SearchResult;
		expect(items.items).toHaveLength(5);
		const names = Object.keys(message.results).filter((name) => name.startsWith("related:"));
		expect(names.sort()).toEqual(items.items.map((card) => `related:${card.key}`).sort());
		for (const name of names) {
			const result = message.results[name] as RelatedResult;
			expect(result.kind).toBe("related");
			// The fake forge's issues are each blocked by the one five after.
			const n = Number(result.key.split("#")[1]);
			expect(result.blockedBy).toEqual([`fake.tack/stress/cards#${n + 5}`]);
		}
	});

	it("follow the cards in a section as they come and go", async () => {
		const { client } = await fakeBoard();
		const card = (n: number, parent: string | null) =>
			addShape(client.doc, `card-${n}`, {
				type: "card",
				ref: `fake.tack/stress/cards#${n}`,
				x: 40 + n * 10,
				y: 60,
				z: `a${n}`,
				parent,
			});
		const { section, widget } = transactLocal(client.doc, () => {
			const section = addSection(client.doc, { x: 0, y: 0, w: 800, h: 400 }, { title: "Launch" });
			card(1, section);
			card(6, section);
			card(11, null);
			const widget = addWidget(
				client.doc,
				"dependencies",
				{ x: 900, y: 0 },
				{ source: "section", section },
			);
			return { section, widget };
		});
		await client.roundTrip();
		client.send({ type: "widget-watch", ids: [widget] });
		const related = (m: WidgetMessage) => Object.keys(m.results).sort();
		expect(related(await latest(client, widget))).toEqual([
			"related:fake.tack/stress/cards#1",
			"related:fake.tack/stress/cards#6",
		]);
		// Moving a card into the section maps it too.
		transactLocal(client.doc, () => shapesMap(client.doc).get("card-11")?.set("parent", section));
		await client.roundTrip();
		const next = await latest(client, widget, (m) => related(m).length === 3);
		expect(related(next)).toContain("related:fake.tack/stress/cards#11");
	});
});

describe("dependency maps on GitHub", () => {
	it("show each viewer only the blockers they can read", async () => {
		const github = fakeGitHub();
		// #1 is blocked by #2, and by the private repository's #5.
		github.blockedBy.set(`${WIDGETS}#1`, [
			github.databaseId(WIDGETS, 2),
			github.databaseId(SECRET, 5),
		]);
		const mf = await configured(github);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const board = await createBoard(mf, alice);
		const owner = await open(mf, board, alice);
		const widget = transactLocal(owner.doc, () =>
			addWidget(owner.doc, "dependencies", { x: 0, y: 0 }, { q: "repo:acme/widgets is:open" }),
		);
		await owner.roundTrip();
		const anonymous = await open(mf, board);
		for (const client of [owner, anonymous]) client.send({ type: "widget-watch", ids: [widget] });

		const name = "related:github.com/acme/widgets#1";
		const blockers = async (client: BoardClient) => {
			const message = await latest(client, widget, (m) => m.results[name]?.kind === "related");
			return (message.results[name] as RelatedResult).blockedBy.sort();
		};
		expect(await blockers(owner)).toEqual([
			"github.com/acme/secret#5",
			"github.com/acme/widgets#2",
		]);
		expect(await blockers(anonymous)).toEqual(["github.com/acme/widgets#2"]);
		expect(JSON.stringify(anonymous.messages)).not.toContain("acme/secret");
	});
});

// The review queue, milestone and stale finder (#43) run like lists, with
// the card fields they need: when items were opened and closed, their
// milestone, and pull requests' size.
describe("milestone and stale finder queries", () => {
	it("bring their items with milestones and dates", async () => {
		const { github, owner: client } = await setup();
		github.setItem(WIDGETS, {
			number: 3,
			kind: "issue",
			title: "Ship the beta",
			updatedAt: "2026-01-05T00:00:00Z",
			createdAt: "2025-12-01T00:00:00Z",
			milestone: "v1",
			labels: [BUG],
		});
		github.setItem(WIDGETS, {
			number: 4,
			kind: "pull",
			title: "Beta flag",
			state: "merged",
			updatedAt: T1,
			createdAt: T0,
			mergedAt: T1,
			milestone: "v1",
			additions: 120,
			deletions: 8,
			changedFiles: 3,
		});
		const [milestone, stale] = transactLocal(client.doc, () => [
			addWidget(client.doc, "milestone", { x: 0, y: 0 }, { repo: "acme/widgets", milestone: "v1" }),
			addWidget(
				client.doc,
				"stale",
				{ x: 500, y: 0 },
				{ q: "repo:acme/widgets is:open", days: 30 },
			),
		]);
		await client.roundTrip();
		client.send({ type: "widget-watch", ids: [milestone, stale] as string[] });

		const progress = await latest(client, milestone as string, (m) => Boolean(m.results.closed));
		const opened = progress.results.open as SearchResult;
		const closed = progress.results.closed as SearchResult;
		expect(opened.items.map((card) => card.title)).toEqual(["Ship the beta"]);
		expect(opened.items[0]).toMatchObject({
			createdAt: "2025-12-01T00:00:00Z",
			closedAt: null,
			milestone: { title: "v1", dueOn: null },
		});
		expect(closed.items[0]).toMatchObject({ state: "merged", closedAt: T1 });
		expect(closed.items[0]?.pull).toMatchObject({ additions: 120, deletions: 8, changedFiles: 3 });

		// Only what's been quiet for a month: not the issues updated this October.
		expect(titles(await latest(client, stale as string))).toEqual(["Ship the beta"]);
	});
});
