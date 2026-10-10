import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { changesMap, listChanges } from "../../shared/changes.ts";
import { matchSearch, parseSearch } from "../../shared/search.ts";
import { addShape, nextZ, shapesMap, transactLocal } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { addWidget, listConfig } from "../../shared/widgetRegistry.ts";
import type { QueryError, SearchResult, WidgetMessage } from "../../shared/widgets.ts";
import { cardStore } from "../cardStore.ts";
import { type WidgetTransport, widgetStore } from "../widgets/store.ts";
import { PEOPLE, makeChecks, pullDetails } from "./ci.ts";
import { LABELS, fixture } from "./fixtures.ts";

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

/** A new item in the fake repository, as when someone opens an issue. */
export function addWidgetCard(card: Card): void {
	WIDGET_CARDS.unshift(card);
	cardStore.set(card);
}

/** Milestones, which cards don't carry, by key. */
const milestones = new Map<string, string | null>();

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
		for (const card of WIDGET_CARDS) if (!cardStore.get(card.key)) cardStore.set(card);
		const shapes = shapesMap(doc);
		// A list's search changed: run it again.
		const observer = () => {
			for (const id of this.watched) {
				const shape = shapes.get(id);
				const config = shape ? JSON.stringify(shape.get("config")) : "";
				if (this.configs.get(id) !== config) {
					this.configs.set(id, config);
					this.answer(id);
				}
			}
		};
		shapes.observeDeep(observer);
		// An item changed (a forge event, a push): lists refresh, as a webhook would make them.
		const keys = () => new Set(WIDGET_CARDS.map((card) => card.key));
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
		return WIDGET_CARDS.map((card) => {
			const live = cardStore.get(card.key);
			return live && !("missing" in live) ? live : card;
		});
	}

	watch(ids: string[]): void {
		for (const id of ids) {
			this.watched.add(id);
			this.configs.set(id, JSON.stringify(shapesMap(this.doc).get(id)?.get("config")));
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

	private results(id: string): WidgetMessage {
		const shape = shapesMap(this.doc).get(id);
		const config = listConfig({ config: shape?.get("config") });
		const at = new Date().toISOString();
		if (!config.q.trim()) return { type: "widget-data", id, results: {}, at };
		return { type: "widget-data", id, results: { items: this.search(config.q, config.limit) }, at };
	}

	private search(q: string, limit: number): SearchResult | QueryError {
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
		const parsed = parseSearch(q);
		const viewer = this.options.viewer ?? null;
		if (/@me\b/i.test(q) && !viewer) {
			return {
				kind: "error",
				reason: "signed_out",
				message: "Sign in to see what “@me” means for you.",
			};
		}
		const items = this.items()
			.filter(
				(card) =>
					matchSearch(card, parsed, {
						viewer,
						milestoneOf: (c) => milestones.get(c.key) ?? null,
					}) === "yes",
			)
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		return { kind: "search", total: items.length, items: items.slice(0, limit) };
	}
}

/**
 * Push staged triage changes to the fake repository: labels, assignees,
 * milestones and state change on its items, and the changes are applied.
 * Returns how many were pushed.
 */
export function pushTriage(doc: Y.Doc): number {
	let pushed = 0;
	transactLocal(doc, () => {
		for (const change of listChanges(doc)) {
			if (change.status !== "staged" || change.included === false) continue;
			const op = change.op;
			if (!("target" in op) || !("key" in op.target)) continue;
			const key = op.target.key;
			const entry = cardStore.get(key);
			if (!entry || "missing" in entry) continue;
			let card: Card = entry;
			switch (op.kind) {
				case "item.labels": {
					const names = new Set(card.labels.map((label) => label.name));
					const known = Object.values(LABELS);
					card = {
						...card,
						labels: [
							...card.labels.filter((label) => !op.remove?.includes(label.name)),
							...(op.add ?? [])
								.filter((name) => !names.has(name))
								.map(
									(name) => known.find((label) => label.name === name) ?? { name, color: "8b949e" },
								),
						],
					};
					break;
				}
				case "item.assignees": {
					const people = Object.values(PEOPLE);
					card = {
						...card,
						assignees: [
							...card.assignees.filter((a) => !op.remove?.includes(a.login)),
							...(op.add ?? [])
								.filter((login) => !card.assignees.some((a) => a.login === login))
								.map((login) => people.find((p) => p.login === login) ?? { login, avatarUrl: "" }),
						],
					};
					break;
				}
				case "item.milestone":
					milestones.set(key, op.milestone);
					break;
				case "item.state":
					card = {
						...card,
						state: op.state,
						stateReason: op.state === "closed" ? (op.reason ?? "completed") : null,
					};
					break;
				default:
					continue;
			}
			cardStore.set({ ...card, updatedAt: new Date().toISOString() });
			const stored = changesMap(doc).get(change.id);
			stored?.set("status", "applied");
			stored?.set("updatedAt", new Date().toISOString());
			pushed++;
		}
	});
	return pushed;
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
