import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { matchSearch, parseSearch } from "../../shared/search.ts";
import { addShape, nextZ, shapesMap } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { boardQueryContext } from "../../shared/widgetContext.ts";
import { addWidget, widgetFollowUps, widgetQueries } from "../../shared/widgetRegistry.ts";
import type {
	QueryError,
	QueryResult,
	SearchQuery,
	SearchResult,
	WidgetMessage,
	WidgetQuery,
} from "../../shared/widgets.ts";
import { cardStore } from "../cardStore.ts";
import { type WidgetTransport, widgetStore } from "../widgets/store.ts";
import { PEOPLE, makeChecks, pullDetails } from "./ci.ts";
import { LABELS, fixture } from "./fixtures.ts";
import { MILESTONE, TEAM, VIEWER_REVIEWER, kindCards } from "./kindFixtures.ts";
import { RELEASE_PULLS, relatedOf, releaseOf, stampTimes } from "./roadmap.ts";

// Widgets in the playground (#37, #38, #39): a repository's worth of fake
// issues and pull requests, searched in the browser with the same matcher
// the fake forge uses, standing in for the board's server. Forge events and
// pushes change the fake items and lists refresh, as webhooks would make
// them. Modes slow every answer down, or fail them, to show each state.

export const REPO = "acme/imagekit";

const T = (days: number) => new Date(Date.UTC(2026, 9, 9) - days * 86_400_000).toISOString();

/** Everything in the fake repository: some on the board, most only in lists. */
export const WIDGET_CARDS: Card[] = [
	fixture({
		item: "#431",
		title: "Cloudinary URLs lose the format when resized twice",
		labels: [LABELS.bug, LABELS.provider],
		assignees: [PEOPLE.kai],
		comments: 6,
		updatedAt: T(0.1),
	}),
	fixture({
		item: "#430",
		title: "Netlify provider ignores quality=auto",
		labels: [LABELS.bug],
		comments: 2,
		updatedAt: T(0.3),
	}),
	fixture({
		item: "#429",
		title: "Add a Vercel OG image recipe to the docs",
		labels: [LABELS.docs, LABELS.goodFirst],
		comments: 1,
		updatedAt: T(0.5),
	}),
	fixture({
		item: "#428",
		kind: "pull",
		title: "Detect custom domains from the CDN response headers",
		labels: [LABELS.bug, LABELS.provider],
		assignees: [PEOPLE.priya],
		comments: 11,
		updatedAt: T(0.6),
		pull: pullDetails({ checks: makeChecks({ passed: 9, failed: 1, failing: ["e2e (webkit)"] }) }),
	}),
	fixture({
		item: "#427",
		title: "srcset widths skip 1080 on some CDNs",
		labels: [LABELS.bug],
		comments: 4,
		updatedAt: T(0.9),
	}),
	fixture({
		item: "#426",
		title: "Explain why each default was chosen",
		labels: [LABELS.docs],
		assignees: [PEOPLE.jo],
		comments: 3,
		updatedAt: T(1.2),
	}),
	fixture({
		item: "#425",
		title: "Benchmarks in CI",
		labels: [LABELS.enhancement],
		comments: 8,
		updatedAt: T(1.4),
	}),
	fixture({
		item: "#424",
		kind: "pull",
		state: "draft",
		title: "Add ImageKit transformations",
		labels: [LABELS.provider, LABELS.goodFirst],
		updatedAt: T(1.6),
		pull: pullDetails({ checks: makeChecks({ passed: 4, pending: 3 }) }),
	}),
	fixture({
		item: "#422",
		title: "Bunny CDN: support the optimizer class",
		labels: [LABELS.provider, LABELS.enhancement],
		comments: 5,
		updatedAt: T(2),
	}),
	fixture({
		item: "#421",
		title: "Typo in the Astro guide",
		labels: [LABELS.docs, LABELS.goodFirst],
		updatedAt: T(2.5),
	}),
	fixture({ item: "#420", title: "Dark mode screenshots in the README", updatedAt: T(3) }),
	fixture({
		item: "#419",
		title: "AVIF output falls back to WebP on Safari 16",
		labels: [LABELS.bug],
		assignees: [PEOPLE.tom],
		comments: 13,
		reactions: 9,
		updatedAt: T(3.4),
	}),
	fixture({
		item: "#417",
		kind: "pull",
		title: "Cache provider detection per hostname",
		labels: [LABELS.enhancement],
		assignees: [PEOPLE.kai],
		comments: 7,
		updatedAt: T(4),
		pull: pullDetails({ checks: makeChecks({ passed: 12 }), review: "approved" }),
	}),
	fixture({
		item: "#416",
		title: "Contentful provider double-encodes spaces",
		labels: [LABELS.bug, LABELS.provider],
		comments: 2,
		updatedAt: T(4.5),
	}),
	fixture({
		item: "#415",
		state: "closed",
		stateReason: "completed",
		title: "Shopify provider ignores crop",
		labels: [LABELS.bug, LABELS.provider],
		comments: 9,
		updatedAt: T(5),
	}),
	fixture({
		item: "#414",
		title: "Show the generated URL in devtools",
		labels: [LABELS.enhancement, LABELS.goodFirst],
		updatedAt: T(5.5),
	}),
	fixture({
		item: "#413",
		title: "Fewer options, better defaults",
		labels: [LABELS.enhancement],
		comments: 21,
		reactions: 14,
		updatedAt: T(6),
	}),
	fixture({
		item: "#411",
		kind: "pull",
		state: "merged",
		title: "Document the Bunny provider",
		labels: [LABELS.docs],
		updatedAt: T(7),
		pull: pullDetails({ checks: makeChecks({ passed: 9 }), review: "approved" }),
	}),
	fixture({
		item: "#410",
		title: "Sanity provider: respect hotspot",
		labels: [LABELS.provider],
		updatedAt: T(8),
	}),
	fixture({ item: "#408", title: "Video walkthrough for 5.0", updatedAt: T(9) }),
];

stampTimes(WIDGET_CARDS);

/** A new item in the fake repository, as when someone opens an issue. */
export function addWidgetCard(card: Card): void {
	WIDGET_CARDS.unshift(card);
	cardStore.set(card);
}

/**
 * Pull requests waiting for review, a milestone's issues and items gone
 * quiet, for the review queue, milestone and stale finder (#43). None of
 * them match the lists the "Widgets" board starts with.
 */
export const KIND_CARDS: Card[] = kindCards(Date.now());

/** Everything the fake repository has to search. */
const searchable = () => [...WIDGET_CARDS, ...RELEASE_PULLS, ...KIND_CARDS];

export interface SimulatedWidgetOptions {
	/** What `@me` means. Without one, searches about `@me` say to sign in. */
	viewer?: string | null;
}

export type WidgetMode = "live" | "slow" | "rate_limited" | "error";

/**
 * Stands in for the board's server: runs lists' searches over the fake
 * repository's items (as they are in the card store), and keeps them live.
 */
export class SimulatedWidgets implements WidgetTransport {
	mode: WidgetMode = "live";
	private watched = new Set<string>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private pending: ReturnType<typeof setTimeout> | undefined;
	private unobserve: () => void;
	private configs = new Map<string, string>();

	constructor(
		private doc: Y.Doc,
		private options: SimulatedWidgetOptions = {},
	) {
		for (const card of searchable()) if (!cardStore.get(card.key)) cardStore.set(card);
		const shapes = shapesMap(doc);
		// A widget's queries changed (its config, or the cards in a section it maps): run them again.
		const observer = () => {
			for (const id of this.watched) {
				const queries = this.queriesOf(id);
				if (this.configs.get(id) !== queries) {
					this.configs.set(id, queries);
					this.answer(id);
				}
			}
		};
		shapes.observeDeep(observer);
		// An item changed (a forge event, a push): lists refresh, as a webhook would make them.
		const keys = () => new Set(searchable().map((card) => card.key));
		const stop = cardStore.subscribeAll((key) => {
			if (keys().has(key)) this.changed();
		});
		this.unobserve = () => {
			shapes.unobserveDeep(observer);
			stop();
		};
	}

	/** Every item there is: the fake repository's, and any other card the board has data for. */
	private items(): Card[] {
		const viewer = this.options.viewer;
		return searchable().map((card) => {
			const live = cardStore.get(card.key);
			const item = live && !("missing" in live) ? live : card;
			// Reviews asked of whoever's looking are asked of you.
			if (!viewer || !item.pull?.reviewers.some((r) => r.login === VIEWER_REVIEWER)) return item;
			const reviewers = item.pull.reviewers.map((r) =>
				r.login === VIEWER_REVIEWER ? { ...r, login: viewer } : r,
			);
			return { ...item, pull: { ...item.pull, reviewers } };
		});
	}

	/** Who `@me` is now: the playground's person, while they're signed in. */
	setViewer(viewer: string | null): void {
		if (this.options.viewer === viewer) return;
		this.options = { ...this.options, viewer };
		for (const id of this.watched) this.answer(id);
	}

	watch(ids: string[]): void {
		for (const id of ids) {
			this.watched.add(id);
			this.configs.set(id, this.queriesOf(id));
			this.answer(id);
		}
	}

	unwatch(ids: string[]): void {
		for (const id of ids) this.watched.delete(id);
	}

	refresh(id: string): void {
		this.answer(id);
	}

	/** Items changed (a forge event, a push): lists refresh shortly, as a webhook would make them. */
	changed(): void {
		clearTimeout(this.pending);
		this.pending = setTimeout(() => {
			for (const id of this.watched) this.answer(id);
		}, 450);
	}

	setMode(mode: WidgetMode): void {
		this.mode = mode;
		for (const id of this.watched) this.answer(id);
	}

	destroy(): void {
		this.unobserve();
		clearTimeout(this.pending);
		for (const timer of this.timers) clearTimeout(timer);
	}

	private answer(id: string): void {
		const delay = this.mode === "slow" ? 2400 : 160 + Math.random() * 220;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (!this.watched.has(id)) return;
			widgetStore.apply(this.results(id));
		}, delay);
		this.timers.add(timer);
	}

	/** What a widget runs, as JSON, to tell when it changes. */
	private queriesOf(id: string): string {
		const shape = shapesMap(this.doc).get(id);
		if (!shape) return "";
		const widget = { widget: shape.get("widget") as string, config: shape.get("config") };
		return JSON.stringify(widgetQueries(widget, boardQueryContext(this.doc)));
	}

	/** A widget's results, as the board's server would send them: its queries, then their follow-ups. */
	private results(id: string): WidgetMessage {
		const shape = shapesMap(this.doc).get(id);
		const at = new Date().toISOString();
		if (!shape) return { type: "widget-data", id, results: {}, at };
		const widget = { widget: shape.get("widget") as string, config: shape.get("config") };
		const results: WidgetMessage["results"] = {};
		for (const [name, query] of Object.entries(
			widgetQueries(widget, boardQueryContext(this.doc)),
		)) {
			results[name] = this.run(query);
		}
		for (const [name, query] of Object.entries(widgetFollowUps(widget, results))) {
			results[name] = this.run(query);
		}
		return { type: "widget-data", id, results, at };
	}

	private run(query: WidgetQuery): QueryResult | QueryError {
		const failed = this.failure();
		if (failed) return failed;
		const items = this.items();
		switch (query.kind) {
			case "search":
				return this.search(query);
			case "related":
				return relatedOf(query.key, (key) => items.find((card) => card.key === key));
			case "release":
				return releaseOf(query.repo);
		}
	}

	private failure(): QueryError | null {
		if (this.mode === "rate_limited") {
			return {
				kind: "error",
				reason: "rate_limited",
				message: "API rate limit exceeded.",
				retryAt: Date.now() + 90_000,
			};
		}
		if (this.mode === "error") {
			return { kind: "error", reason: "error", message: "GitHub answered 502." };
		}
		return null;
	}

	private search(query: SearchQuery): SearchResult | QueryError {
		const limit = query.limit ?? 50;
		// The same matcher as the fake forges, dates and all.
		const q = query.q;
		const parsed = parseSearch(q);
		const viewer = this.options.viewer ?? null;
		if (/@me\b/i.test(q) && !viewer) {
			return {
				kind: "error",
				reason: "signed_out",
				message: "Sign in to see what “@me” means for you.",
			};
		}
		// Items without a milestone on their card have none.
		const milestoneOf = (card: Card) =>
			card.milestone === undefined ? null : (card.milestone?.title ?? null);
		const sortKey = (card: Card): string | number =>
			query.sort === "created"
				? (card.createdAt ?? card.updatedAt)
				: query.sort === "comments"
					? card.comments
					: query.sort === "reactions"
						? card.reactions
						: card.updatedAt;
		const direction = query.order === "asc" ? 1 : -1;
		const items = this.items()
			.filter((card) => matchSearch(card, parsed, { viewer, milestoneOf }) === "yes")
			.sort((a, b) => {
				const x = sortKey(a);
				const y = sortKey(b);
				return x === y ? 0 : (x < y ? -1 : 1) * direction;
			});
		return { kind: "search", total: items.length, items: items.slice(0, limit) };
	}
}

/** Lists, and cards to drop on them: a triage board. */
export function seedWidgets(doc: Y.Doc): void {
	for (const card of WIDGET_CARDS) cardStore.set(card);
	const host = "fake.tack";
	const list = (x: number, y: number, title: string, q: string, h = 460) => {
		const id = addWidget(doc, "list", { x, y }, { title, host, q, sort: "updated", limit: 30 });
		shapesMap(doc).get(id)?.set("h", h);
		return id;
	};
	list(40, 40, "Open bugs", `repo:${REPO} is:open label:bug`);
	list(440, 40, "Good first issues", `repo:${REPO} is:open label:"good first issue"`, 360);
	list(840, 40, "Needs triage", `repo:${REPO} is:issue is:open no:label`, 260);
	list(840, 320, "Mentions flaky", `repo:${REPO} flaky`, 200);
	const triage = addSection(
		doc,
		{ x: 440, y: 540, w: 800, h: 190 },
		{ title: "Drop these on a list", color: "yellow" },
	);
	const cards = ["#425", "#420", "#413"];
	cards.forEach((item, i) => {
		addShape(doc, crypto.randomUUID(), {
			type: "card",
			ref: `fake.tack/${REPO}${item}`.toLowerCase(),
			x: 470 + i * 260,
			y: 586,
			z: nextZ(doc),
			parent: triage,
		});
	});
	// One that's already on the board, so its rows show the marker.
	addShape(doc, crypto.randomUUID(), {
		type: "card",
		ref: `fake.tack/${REPO}#431`,
		x: 40,
		y: 540,
		z: nextZ(doc),
		parent: null,
	});
}

/** A review queue, a milestone and a stale finder over the fake repository (#43). */
export function seedTracking(doc: Y.Doc): void {
	for (const card of searchable()) cardStore.set(card);
	const host = "fake.tack";
	const widget = (
		kind: string,
		x: number,
		y: number,
		h: number,
		config: Record<string, unknown>,
	) => {
		const id = addWidget(doc, kind, { x, y }, { host, ...config });
		shapesMap(doc).get(id)?.set("h", h);
		return id;
	};
	widget("review", 40, 40, 500, { scope: "me" });
	widget("review", 40, 580, 380, { scope: "team", team: TEAM });
	widget("milestone", 480, 40, 640, { repo: REPO, milestone: MILESTONE });
	widget("stale", 940, 40, 600, { q: `repo:${REPO} is:open`, days: 30 });
	// One that's on the board already, so its row shows the pin.
	addShape(doc, crypto.randomUUID(), {
		type: "card",
		ref: `fake.tack/${REPO}#385`,
		x: 500,
		y: 720,
		z: nextZ(doc),
		parent: null,
	});
}
