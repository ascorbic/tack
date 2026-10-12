// The M3 exit (#45), end to end: a triage board that fills itself, and a
// release board that tracks a milestone, both made from the built-in
// templates through `POST /api/boards`, watched by someone signed in
// through (fake) GitHub, so every widget and inbox query runs with her own
// token through the real GitHub adapter, and kept current by webhook
// deliveries alone. Time is controlled (`setClock`): the boards are followed
// over days, as they'd really be used, with GitHub's clock in step.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { blockEnds, stageBlockedBy } from "../src/shared/actions.ts";
import type { CardMessage } from "../src/shared/cards.ts";
import { listChanges, type Stager } from "../src/shared/changes.ts";
import { relatedName } from "../src/shared/dependencyMap.ts";
import {
	dismissFromInbox,
	dismissedKeys,
	inboxResult,
	inboxTray,
	sortFromInbox,
} from "../src/shared/inbox.ts";
import { burnUp, progress } from "../src/shared/milestone.ts";
import { keepCard } from "../src/shared/provenance.ts";
import type { PushResponse } from "../src/shared/push.ts";
import { draftRelease } from "../src/shared/releaseDraft.ts";
import { listRules, readRuleLog } from "../src/shared/rules.ts";
import {
	addShape,
	cardRefs,
	readShape,
	type ShapeProps,
	shapesMap,
	transactLocal,
} from "../src/shared/shapes.ts";
import { updateWidgetConfig, widgetQueries } from "../src/shared/widgetRegistry.ts";
import type {
	RelatedResult,
	ReleaseResult,
	SearchResult,
	WidgetMessage,
} from "../src/shared/widgets.ts";
import { type BoardClient, eventually } from "./board-client.ts";
import type { FakeItem, FakeUser } from "./fake-github.ts";
import { boardStub, signInWithGitHub } from "./harness.ts";
import { DAY, HOUR, World } from "./world.ts";

const WIDGETS = 1;
const REPO = "github.com/acme/widgets";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const STAGER: Stager = { id: 501, login: "alice", name: "Alice", color: "#f97316" };

const LABELS = {
	bug: { name: "bug", color: "d73a4a" },
	security: { name: "security", color: "b60205" },
	feature: { name: "feature", color: "a2eeef" },
	docs: { name: "docs", color: "0075ca" },
};

let world: World;
afterEach(() => world?.dispose());

const key = (n: number) => `${REPO}#${n}`;

/** A board made from a template with the repository, opened by whoever made it, its widgets ticking. */
async function templateBoard(cookie: string, title: string, template: string) {
	const created = await world.api("/api/boards", cookie, {
		method: "POST",
		body: JSON.stringify({ title, template, repos: [REPO] }),
	});
	expect(created.status).toBe(201);
	const { id, seeded } = (await created.json()) as { id: string; seeded?: boolean };
	expect(seeded).toBe(true);
	const client = await world.connect(id, cookie);
	const stub = await world.tick(id);
	return { id, client, stub };
}

function shapes(client: BoardClient): Map<string, ShapeProps> {
	return new Map([...shapesMap(client.doc)].map(([id, shape]) => [id, readShape(shape)]));
}

function shapeId(client: BoardClient, test: (shape: ShapeProps) => boolean): string {
	const found = [...shapes(client)].find(([, shape]) => test(shape));
	if (!found) throw new Error("no such shape");
	return found[0];
}

const titled = (client: BoardClient, title: string) =>
	shapeId(client, (shape) => shape.type === "section" && shape.title === title);
const widget = (client: BoardClient, kind: string) =>
	shapeId(client, (shape) => shape.type === "widget" && shape.widget === kind);
const cardsFor = (client: BoardClient, n: number) =>
	[...shapes(client)].filter(([, shape]) => shape.type === "card" && shape.ref === key(n));

function widgetData(client: BoardClient, id: string): WidgetMessage | undefined {
	return (client.messages as WidgetMessage[])
		.filter((message) => message.type === "widget-data" && message.id === id)
		.at(-1);
}

/** The latest results for a shape once `check` passes on them. */
async function results(
	client: BoardClient,
	id: string,
	check: (message: WidgetMessage) => boolean,
	timeout = 8000,
): Promise<WidgetMessage> {
	await eventually(() => {
		const message = widgetData(client, id);
		return Boolean(message && check(message));
	}, timeout);
	return widgetData(client, id)!;
}

/** An item's number, from its key. */
const number = (card: { key: string }) => Number(card.key.split(/[#!]/).at(-1));

const numbers = (result: SearchResult | undefined) =>
	(result?.items ?? []).map(number).sort((a, b) => a - b);

/** What waits in an inbox's tray: its latest results, less what's on the board or dismissed. */
function tray(client: BoardClient, inbox: string): number[] {
	const message = widgetData(client, inbox);
	const result = message ? inboxResult(message) : null;
	if (!result) return [];
	const section = shapes(client).get(inbox)!;
	return numbers({
		kind: "search",
		total: 0,
		items: inboxTray(result, cardRefs(client.doc), dismissedKeys(section)),
	});
}

function cardState(client: BoardClient, k: string): string | undefined {
	for (const message of [...(client.messages as CardMessage[])].reverse()) {
		if (message.type !== "cards") continue;
		const card = message.cards.find((entry) => entry.key === k);
		if (card && !("missing" in card)) return card.state;
	}
	return undefined;
}

describe("the M3 exit", () => {
	it("a triage board fills itself as issues are opened and labelled", async () => {
		world = new World(WIDGETS);
		const start = world.monday + 9 * HOUR;
		const { github } = world;
		github.addRepo(WIDGETS, "acme/widgets", {
			writers: ["alice"],
			labels: Object.values(LABELS),
		});
		github.install(7, "acme", ["acme/widgets"]);
		// Before the board: one issue waiting for triage, one already labelled.
		const old = start - 90 * DAY;
		github.setItem(WIDGETS, {
			number: 1,
			kind: "issue",
			title: "Crash on start",
			updatedAt: new Date(old).toISOString(),
			createdAt: new Date(old).toISOString(),
		});
		github.setItem(WIDGETS, {
			number: 2,
			kind: "issue",
			title: "Typo in the docs",
			updatedAt: new Date(old).toISOString(),
			labels: [LABELS.docs],
		});
		await world.boot(start);
		const alice = await signInWithGitHub(world.mf, github, ALICE);

		// Monday: Alice makes a triage board for the repository.
		const { client } = await templateBoard(alice, "Widgets triage", "tack:triage");
		const incoming = titled(client, "Incoming");
		const p0 = titled(client, "P0 · Drop everything");
		const p1 = titled(client, "P1 · This cycle");
		const info = titled(client, "Needs more info");
		const quiet = widget(client, "stale");
		expect(shapes(client).get(incoming)?.inbox?.query.q).toBe(
			"repo:acme/widgets is:issue is:open no:label",
		);
		const [security, pulls] = listRules(client.doc);
		expect(security).toMatchObject({ name: "Security issues go to P0", enabled: true });
		expect(pulls).toMatchObject({ trigger: { kind: "pull-links" } });

		// Looking at the board watches its inbox and widgets, as the client does.
		client.send({ type: "widget-watch", ids: [incoming, quiet] });
		await results(client, incoming, (m) => inboxResult(m) !== null);
		expect(tray(client, incoming)).toEqual([1]);

		// Monday afternoon: two issues are opened, and the tray collects them,
		// newest first, with nobody touching the board.
		await world.at(start + 5 * HOUR);
		await world.open({ number: 3, kind: "issue", title: "Widgets wobble on resize" });
		await world.open({ number: 4, kind: "issue", title: "How do I configure it?" });
		await eventually(() => tray(client, incoming).length === 3, 8000);
		expect(tray(client, incoming)).toEqual([1, 3, 4]);
		const newest = inboxResult(widgetData(client, incoming)!)!.items.map((card) => card.title);
		expect(newest.slice(0, 2)).toEqual(["How do I configure it?", "Widgets wobble on resize"]);

		// Alice sorts: #3 into P1, #4 needs more info, #1 dismissed (a dupe).
		const box = (id: string) => shapes(client).get(id)!;
		const into = (id: string) => ({ x: box(id).x + 40, y: box(id).y + 120 });
		// Needs more info is a list, as tall as what's in it: dropped onto its empty well.
		const onto = (id: string) => ({ x: box(id).x + 40, y: box(id).y - 20 });
		const sorted3 = sortFromInbox(client.doc, incoming, key(3), into(p1));
		const sorted4 = sortFromInbox(client.doc, incoming, key(4), onto(info));
		dismissFromInbox(client.doc, incoming, [key(1)], "alice");
		await client.roundTrip();
		expect(tray(client, incoming)).toEqual([]);
		expect(shapes(client).get(sorted3)).toMatchObject({
			ref: key(3),
			parent: p1,
			provenance: { via: "inbox", source: incoming },
		});
		expect(shapes(client).get(sorted4)).toMatchObject({ parent: info });

		// Tuesday: a security report arrives. The rule puts it in P0 by itself,
		// and says so; no tray, no sorting.
		await world.at(start + DAY + 2 * HOUR);
		await world.open({
			number: 5,
			kind: "issue",
			title: "Tokens logged in plain text",
			labels: [LABELS.security],
		});
		await eventually(() => cardsFor(client, 5).length === 1, 8000);
		const [placed5, card5] = cardsFor(client, 5)[0]!;
		expect(card5).toMatchObject({ parent: p0, provenance: { via: "rule", source: security!.id } });
		expect(readRuleLog(client.doc).at(-1)).toMatchObject({
			rule: security!.id,
			outcome: "placed",
			key: key(5),
			section: p0,
		});
		expect(listRules(client.doc)[0]?.fired).toBe(1);
		expect(Date.parse(listRules(client.doc)[0]?.lastAt ?? "")).toBeGreaterThan(start + DAY);
		// It's labelled, so it never waited in the inbox.
		expect(tray(client, incoming)).toEqual([]);

		// A fix for #3 is opened: the pull request lands beside its issue.
		await world.open({
			number: 6,
			kind: "pull",
			title: "Stop the wobble",
			body: "Fixes #3",
			headRef: "fix-wobble",
		});
		await eventually(() => cardsFor(client, 6).length === 1, 8000);
		const [, card6] = cardsFor(client, 6)[0]!;
		expect(card6.provenance).toEqual({ via: "rule", source: pulls!.id });
		const card3 = shapes(client).get(sorted3)!;
		// As near as there's room: priority sections only fit one column.
		expect(Math.hypot(card6.x - card3.x, card6.y - card3.y)).toBeLessThan(600);
		expect(readRuleLog(client.doc).at(-1)).toMatchObject({
			rule: pulls!.id,
			key: key(6),
			near: key(3),
		});

		// Wednesday: #3 gets its label on GitHub. It no longer matches the
		// inbox that brought it: marked, never moved. #4 is answered and
		// closed: no longer matching either. The security issue turns out to
		// be a plain bug: it no longer matches its rule.
		await world.at(start + 2 * DAY + 3 * HOUR);
		await world.change(3, { labels: [LABELS.bug] }, "labeled");
		await world.change(4, { state: "closed" }, "closed");
		await world.change(5, { labels: [LABELS.bug] }, "unlabeled");
		await eventually(
			() =>
				[sorted3, sorted4, placed5].every(
					(id) => typeof shapes(client).get(id)?.unmatched === "string",
				),
			8000,
		);
		expect(shapes(client).get(sorted3)).toMatchObject({ x: card3.x, y: card3.y, parent: p1 });
		expect(shapes(client).get(placed5)).toMatchObject({ x: card5.x, y: card5.y, parent: p0 });
		expect(Date.parse(shapes(client).get(sorted3)!.unmatched!)).toBeGreaterThanOrEqual(
			start + 2 * DAY,
		);
		// Alice keeps #5 where it is: it's hers now, and never marked again.
		keepCard(client.doc, placed5);
		await client.roundTrip();
		await world.change(5, { labels: [] }, "unlabeled");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await client.roundTrip();
		expect(shapes(client).get(placed5)?.unmatched).toBeUndefined();
		expect(shapes(client).get(placed5)?.provenance).toBeUndefined();

		// Something new still lands in the tray, days later.
		await world.open({ number: 7, kind: "issue", title: "Widgets are slow" });
		await eventually(() => tray(client, incoming).includes(7), 8000);
		expect(tray(client, incoming)).toEqual([7]);

		// The stale finder: what's been quiet for 60 days by the board's clock,
		// the dismissed #1 and the docs issue, and nothing that moved this week.
		const stale = await results(client, quiet, (m) => Boolean(m.results.items));
		expect(numbers(stale.results.items as SearchResult)).toEqual([1, 2]);
	}, 60_000);

	it("a release board tracks a milestone, drafts its notes and maps what blocks what", async () => {
		world = new World(WIDGETS);
		const start = world.monday + 9 * HOUR;
		const { github } = world;
		github.addRepo(WIDGETS, "acme/widgets", {
			writers: ["alice"],
			labels: Object.values(LABELS),
			milestones: ["v1.2"],
		});
		github.install(7, "acme", ["acme/widgets"]);
		const before = (days: number) => new Date(start - days * DAY).toISOString();
		// The last release, and what's been merged around it.
		github.releases.set(WIDGETS, [{ tagName: "v1.1.0", name: "v1.1.0", publishedAt: before(10) }]);
		const merged = (number: number, title: string, days: number, labels: FakeItem["labels"]) =>
			github.setItem(WIDGETS, {
				number,
				kind: "pull",
				title,
				state: "merged",
				updatedAt: before(days),
				createdAt: before(days + 2),
				mergedAt: before(days),
				labels,
			});
		merged(20, "Shipped in v1.1", 12, [LABELS.feature]);
		merged(21, "Widgets can be nested", 5, [LABELS.feature]);
		merged(22, "Fix a leak", 2, [LABELS.bug]);
		// The milestone: three issues, opened over the last weeks, one closed.
		const issue = (number: number, title: string, opened: number, state: FakeItem["state"]) =>
			github.setItem(WIDGETS, {
				number,
				kind: "issue",
				title,
				state,
				milestone: "v1.2",
				createdAt: before(opened),
				updatedAt: before(state === "closed" ? 3 : opened),
			});
		issue(30, "Nested widgets", 20, "closed");
		issue(31, "Widget registry", 18, "open");
		issue(32, "Plugin API", 15, "open");
		issue(33, "Docs for plugins", 14, "open");
		await world.boot(start);
		const alice = await signInWithGitHub(world.mf, github, ALICE);

		// Monday: a release board for the repository. Alice picks the
		// milestone on its widget, and puts the release's issues in Now.
		const { id: board, client } = await templateBoard(alice, "Widgets 1.2", "tack:release");
		const now = titled(client, "Now · this release");
		const milestone = widget(client, "milestone");
		const draft = widget(client, "release");
		const deps = widget(client, "dependencies");
		const review = widget(client, "review");
		expect(shapes(client).get(deps)?.config).toMatchObject({ source: "section", section: now });
		expect(shapes(client).get(draft)?.config).toMatchObject({ repo: "acme/widgets" });
		transactLocal(client.doc, () =>
			updateWidgetConfig(client.doc, milestone, { milestone: "v1.2" }),
		);
		const nowBox = shapes(client).get(now)!;
		const place = (n: number, i: number) =>
			addShape(client.doc, `card-${n}`, {
				type: "card",
				ref: key(n),
				x: nowBox.x + 40 + (i % 2) * 320,
				y: nowBox.y + 120 + Math.floor(i / 2) * 180,
				z: `c${i}`,
				parent: now,
			});
		transactLocal(client.doc, () => [31, 32, 33].forEach(place));
		await client.roundTrip();
		client.send({ type: "widget-watch", ids: [milestone, draft, deps, review] });

		// The milestone: one of four done, and the ones still open.
		const progressOf = (message: WidgetMessage) => {
			const open = message.results.open as SearchResult | undefined;
			const closed = message.results.closed as SearchResult | undefined;
			return open && closed ? progress(open.total, closed.total) : null;
		};
		const first = await results(client, milestone, (m) => progressOf(m) !== null);
		expect(progressOf(first)).toMatchObject({ open: 3, closed: 1, total: 4 });
		expect(numbers(first.results.open as SearchResult)).toEqual([31, 32, 33]);

		// The release draft: what's merged since v1.1.0, sorted into notes.
		const release = (message: WidgetMessage) => message.results.release as ReleaseResult;
		const drafted = await results(client, draft, (m) => m.results.release?.kind === "release");
		expect(release(drafted).latest?.tag).toBe("v1.1.0");
		expect(
			release(drafted)
				.mergedSince.map(number)
				.sort((a, b) => a - b),
		).toEqual([21, 22]);
		const notes = draftRelease(release(drafted), { sections: [], skip: [] });
		expect(notes.count).toBe(2);
		expect(
			draftRelease(release(drafted), {
				sections: [
					{ title: "Features", labels: ["feature"] },
					{ title: "Fixes", labels: ["bug"] },
				],
				skip: [],
			}),
		).toMatchObject({
			sections: [
				{ title: "Features", items: [expect.objectContaining({ key: key(21) })] },
				{ title: "Fixes", items: [expect.objectContaining({ key: key(22) })] },
			],
			bump: "minor",
			next: "v1.2.0",
		});

		// The dependency map: the cards in Now, nothing blocking anything yet.
		const related = (message: WidgetMessage, n: number) =>
			message.results[relatedName(key(n))] as RelatedResult | undefined;
		const mapped = await results(client, deps, (m) =>
			[31, 32, 33].every((n) => related(m, n)?.kind === "related"),
		);
		expect([31, 32, 33].map((n) => related(mapped, n)?.blockedBy)).toEqual([[], [], []]);

		// Alice connects the registry to the plugin API (X), and stages it as
		// blocked-by; pushing writes it to GitHub, and the map follows.
		await eventually(() => cardState(client, key(31)) === "open", 8000);
		await eventually(() => cardState(client, key(32)) === "open", 8000);
		addShape(client.doc, "blocks", {
			type: "connector",
			x: 0,
			y: 0,
			z: "d0",
			from: { x: 0, y: 0, shape: "card-31" },
			to: { x: 0, y: 0, shape: "card-32" },
		});
		const ends = blockEnds(client.doc, "blocks", () => "issue")!;
		const blocked = stageBlockedBy(
			client.doc,
			{
				blocked: ends.to.target!,
				blocker: ends.from.target!,
				connector: "blocks",
				shapes: ["card-32", "card-31"],
			},
			STAGER,
		);
		await client.roundTrip();
		const stub = await boardStub(world.mf, board);
		await stub.pushTiming({ spacingMs: 10, confirmMs: 60_000, backoffMs: 50 });
		const pushed = await world.api(`/api/boards/${board}/push`, alice, {
			method: "POST",
			body: JSON.stringify({ ids: [blocked], as: "user" }),
		});
		expect(pushed.status).toBe(202);
		expect(((await pushed.json()) as PushResponse).ok).toBe(true);
		await eventually(
			() => listChanges(client.doc).find((change) => change.id === blocked)?.status === "applied",
			15_000,
		);
		expect(github.blockedBy.get(`${WIDGETS}#32`)).toEqual([github.databaseId(WIDGETS, 31)]);
		const followed = await results(client, deps, (m) => related(m, 32)?.blockedBy.length === 1);
		expect(related(followed, 32)?.blockedBy).toEqual([key(31)]);
		expect(related(followed, 31)?.blocking).toEqual([key(32)]);

		// Wednesday: a pull request for the registry is opened; the board's
		// rule puts it beside its issue, and it waits in the review queue.
		await world.at(start + 2 * DAY);
		await world.open({
			number: 40,
			kind: "pull",
			title: "A registry for widgets",
			body: "Closes #31",
			headRef: "registry",
			labels: [LABELS.feature],
			milestone: "v1.2",
		});
		await eventually(() => cardsFor(client, 40).length === 1, 8000);
		expect(cardsFor(client, 40)[0]![1].provenance?.via).toBe("rule");
		// (The fake's search can't tell reviews apart, so it's the queue's search that's checked.)
		expect(widgetQueries(shapes(client).get(review)!)).toMatchObject({
			pulls: { q: "repo:acme/widgets is:pr is:open -review:approved draft:false" },
		});
		await results(client, review, (m) => m.results.pulls?.kind === "search");

		// Thursday: it's merged, and closes #31. The milestone moves on, the
		// draft has it as a feature, and the map shows the plugin API's
		// blocker done.
		await world.at(start + 3 * DAY);
		await world.deliver(github.mergePull(WIDGETS, 40));
		await world.change(31, { state: "closed", stateReason: "completed" }, "closed");
		const moved = await results(client, milestone, (m) => progressOf(m)?.closed === 3);
		expect(progressOf(moved)).toMatchObject({ open: 2, closed: 3, total: 5 });
		expect(numbers(moved.results.open as SearchResult)).toEqual([32, 33]);
		const nextDraft = await results(client, draft, (m) =>
			release(m).mergedSince.some((card) => number(card) === 40),
		);
		expect(
			release(nextDraft)
				.mergedSince.map(number)
				.sort((a, b) => a - b),
		).toEqual([21, 22, 40]);
		const dependency = await results(
			client,
			deps,
			(m) =>
				related(m, 32)?.cards.some(
					(card) => card.key === key(31) && "state" in card && card.state === "closed",
				) ?? false,
		);
		expect(related(dependency, 32)?.blockedBy).toEqual([key(31)]);

		// The burn-up, as the widget draws it: scope over the weeks, and a pace
		// from what closed lately, with a forecast for what's left.
		const open = moved.results.open as SearchResult;
		const closed = moved.results.closed as SearchResult;
		const burn = burnUp(open.items, closed.items, { now: world.now() });
		expect(burn.points.at(-1)).toMatchObject({ scope: 5, done: 3 });
		expect(burn.points[0]!.scope).toBeLessThan(5);
		expect(burn.pace).toBeGreaterThan(0);
		expect(burn.forecast).toBeGreaterThan(world.now());
	}, 60_000);
});
