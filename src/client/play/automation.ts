import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import {
	INBOX_ORIGIN,
	INBOX_QUERY,
	confirmMatches,
	inboxSections,
	previewId,
} from "../../shared/inbox.ts";
import type { ItemMention } from "../../shared/mentions.ts";
import { matchesQuery, queryRepos } from "../../shared/query.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { RULE_ORIGIN, memoryOfRules, refreshMatches, runRules } from "../../shared/rules.ts";
import { cardRefs, shapesMap } from "../../shared/shapes.ts";
import type {
	SearchQuery,
	SearchResult,
	WidgetMessage,
	WidgetRequest,
} from "../../shared/widgets.ts";
import type { InboxPreviewRequest } from "../../shared/inbox.ts";
import { cardStore } from "../cardStore.ts";
import { inboxStore } from "../inbox/store.ts";
import { LABELS, fixture } from "./fixtures.ts";

// Inbox frames and rules, simulated in the browser: a pretend forge whose
// items the playground's inboxes search, and webhooks that run the board's
// rules exactly as the server does (the same `runRules`, with the server's
// non-undoable origin). Scenarios seed the forge with `seedForge`.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Items on the pretend forge, shared by the scenario that seeds them and the board. */
let forgeItems: Card[] = [];

export function seedForge(items: Card[]): void {
	forgeItems = [...items];
	for (const card of items) cardStore.set(card);
}

const NEW_ISSUES = [
	"Blurry thumbnails on retina screens",
	"Support AVIF in the Netlify provider",
	"Docs: explain the `layout` prop",
	"Imgix crop is ignored with fit=fill",
	"Breakpoints are off by one at 640px",
	"TypeScript: `priority` missing from types",
	"Lazy loading fires too early in Safari",
	"Add a Bunny CDN provider",
];

let nextNumber = 520;

export class SimulatedAutomation {
	/** Inboxes this browser is watching, by section id. */
	private watched = new Set<string>();
	private memory = memoryOfRules();
	private queries = new Map<string, string>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	/** How long searches take, in ms, so loading states show. */
	latency = 380;

	constructor(private readonly doc: Y.Doc) {}

	/**
	 * Answer the inbox store's requests, as the board's server would, and
	 * search again when someone edits a query. Returns the way to stop.
	 */
	install(): () => void {
		inboxStore.reset();
		const previous = inboxStore.channel;
		inboxStore.channel = { send: (request) => this.receive(request) };
		const stop = this.start();
		// Trays that mounted first asked before anyone was listening.
		inboxStore.rewatch();
		return () => {
			stop();
			inboxStore.channel = previous;
		};
	}

	/**
	 * Search again when someone edits a query, without taking over the inbox
	 * store's channel (for a page with several boards, which routes requests
	 * to each with `receive`).
	 */
	start(): () => void {
		this.queries = this.readQueries();
		const shapes = shapesMap(this.doc);
		const observer = () => {
			const next = this.readQueries();
			for (const [id, q] of next) if (this.queries.get(id) !== q) this.respondLater(id);
			this.queries = next;
		};
		shapes.observeDeep(observer);
		return () => {
			shapes.unobserveDeep(observer);
			for (const timer of this.timers) clearTimeout(timer);
			this.timers.clear();
		};
	}

	/** Items the pretend forge has. */
	items(): Card[] {
		return forgeItems;
	}

	search(query: SearchQuery): SearchResult {
		const repos = queryRepos(query);
		const matches = forgeItems
			.filter((card) => repos.length === 0 || repos.includes(repoKeyOf(card.key)))
			.filter((card) => matchesQuery(card, query) !== false)
			.sort((a, b) => Number(b.item.slice(1)) - Number(a.item.slice(1)));
		const limit = query.limit ?? 50;
		return { kind: "search", total: matches.length, items: matches.slice(0, limit) };
	}

	/** A request from the inbox store. Only this board's inboxes are answered. */
	receive(request: WidgetRequest | InboxPreviewRequest): void {
		switch (request.type) {
			case "widget-watch":
				for (const id of request.ids) {
					if (!shapesMap(this.doc).has(id)) continue;
					this.watched.add(id);
					this.respondLater(id);
				}
				return;
			case "widget-unwatch":
				for (const id of request.ids) this.watched.delete(id);
				return;
			case "widget-refresh":
				this.respondLater(request.id, this.latency * 1.6);
				return;
			case "inbox-preview": {
				const { id, query } = request;
				if (!shapesMap(this.doc).has(id)) return;
				this.later(() => {
					const result = queryRepos(query).length
						? this.search(query)
						: {
								kind: "error" as const,
								reason: "invalid" as const,
								message: "Add repo:owner/name to search.",
							};
					this.send({
						type: "widget-data",
						id: previewId(id),
						results: { [INBOX_QUERY]: result },
						at: new Date().toISOString(),
					});
				}, this.latency * 0.7);
			}
		}
	}

	private readQueries(): Map<string, string> {
		return new Map([...inboxSections(this.doc)].map(([id, query]) => [id, JSON.stringify(query)]));
	}

	private respondLater(id: string, ms = this.latency): void {
		this.later(() => this.respond(id), ms);
	}

	/** Inboxes never answered, to show them loading (the gallery). */
	readonly held = new Set<string>();

	private respond(id: string): void {
		if (!this.watched.has(id) || this.held.has(id)) return;
		const query = inboxSections(this.doc).get(id);
		if (!query) return;
		const result =
			queryRepos(query).length > 0
				? this.search(query)
				: ({
						kind: "error",
						reason: "invalid",
						message: "Add repo:owner/name to search, so Tack knows where to look.",
					} as const);
		if (result.kind === "search") confirmMatches(this.doc, id, result, INBOX_ORIGIN);
		this.send({
			type: "widget-data",
			id,
			results: { [INBOX_QUERY]: result },
			at: new Date().toISOString(),
		});
	}

	private send(message: WidgetMessage): void {
		inboxStore.apply(message);
	}

	private later(run: () => void, ms: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			run();
		}, ms);
		this.timers.add(timer);
	}

	/**
	 * A webhook: an item was opened or changed on the forge. Rules run on it,
	 * and every watched inbox searches again.
	 */
	deliver(
		card: Card,
		{
			event = card.kind === "pull" ? "pull_request" : "issues",
			action = "opened",
			mentions = [],
		}: { event?: string; action?: string; mentions?: ItemMention[] } = {},
	): number {
		const at = forgeItems.findIndex((item) => item.key === card.key);
		if (at >= 0) forgeItems[at] = card;
		else forgeItems.push(card);
		cardStore.set(card);
		// As the server does: marks for cards that stop (or start) matching first.
		refreshMatches(this.doc, { cards: [card] }, RULE_ORIGIN);
		const entries = runRules(
			this.doc,
			{
				delivery: crypto.randomUUID(),
				event,
				action,
				repo: repoKeyOf(card.key),
				cards: [card],
				mentions: mentions.length > 0 ? { [card.key]: mentions } : {},
			},
			this.memory,
			{ origin: RULE_ORIGIN },
		);
		for (const id of this.watched) this.respondLater(id, this.latency * 1.4);
		return entries.filter((entry) => entry.outcome === "placed").length;
	}

	/** A new issue, unlabelled unless asked, in the forge's main repository. */
	openIssue(labels: Card["labels"] = []): { card: Card; placed: number } {
		const title = NEW_ISSUES[nextNumber % NEW_ISSUES.length] ?? "Something new";
		const card = fixture({ item: `#${nextNumber++}`, title, labels, comments: 0 });
		return { card, placed: this.deliver(card) };
	}

	/** A burst of new issues, a moment apart. */
	async burst(count = 4): Promise<void> {
		for (let i = 0; i < count; i++) {
			this.openIssue();
			await sleep(260);
		}
	}

	/** Someone labels an open, unlabelled issue on the forge (one on the board, if any). */
	labelSomething(): Card | null {
		const onBoard = cardRefs(this.doc);
		const unlabelled = forgeItems.filter(
			(card) => card.kind === "issue" && card.state === "open" && card.labels.length === 0,
		);
		const target = unlabelled.find((card) => onBoard.has(card.key)) ?? unlabelled[0];
		if (!target) return null;
		const card = { ...target, labels: [LABELS.bug], updatedAt: new Date().toISOString() };
		this.deliver(card, { action: "labeled" });
		return card;
	}

	/** A pull request that closes an issue on the board. */
	openPull(): { pull: Card; closes: string } | null {
		const onBoard = [...cardRefs(this.doc)].filter((key) => {
			const card = cardStore.get(key);
			return card && !("missing" in card) && card.kind === "issue";
		});
		const closes = onBoard[Math.floor(Math.random() * onBoard.length)];
		if (!closes) return null;
		const issue = cardStore.get(closes);
		const title = issue && !("missing" in issue) ? issue.title : "it";
		const pull = fixture({
			item: `#${nextNumber++}`,
			kind: "pull",
			title: `Fix: ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
			repo: closes
				.split("/")
				.slice(1)
				.join("/")
				.replace(/[#!]\d+$/, ""),
		});
		this.deliver(pull, { mentions: [{ key: closes, closes: true }] });
		return { pull, closes };
	}
}
