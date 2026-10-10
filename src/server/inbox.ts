import type * as Y from "yjs";
import {
	INBOX_LIMIT,
	INBOX_ORIGIN,
	INBOX_QUERY,
	confirmMatches,
	inboxSections,
	previewId,
} from "../shared/inbox.ts";
import { queryRepos } from "../shared/query.ts";
import { forgeForHost } from "../shared/refs.ts";
import { shapesMap } from "../shared/shapes.ts";
import type { QueryError, SearchQuery, SearchResult, WidgetMessage } from "../shared/widgets.ts";
import { log } from "./log.ts";

// Inbox frames on the server (#40). Each person looking at a board asks for
// the inboxes in view (`widget-watch` with the sections' ids); the runner
// runs each inbox's query as them, through the board's `search` (their own
// token, so private items only reach people who can read them), and sends
// the results as `widget-data` keyed by the section's id, under the query
// name `inbox`. Results are shared between connections of the same person
// for a few seconds, so a reload doesn't search again.
//
// Inboxes stay current three ways: when a webhook delivery reaches the board
// from a repository an inbox searches (`activity`), every minute while
// anyone's watching, and when someone asks (`widget-refresh`). Editing a
// query runs it again for everyone watching.
//
// This is deliberately a small runner of its own: it only needs a "search as
// this viewer" function, so the widget framework's query runner can take it
// over by treating inbox sections as widgets with one query (`inboxSections`).

export type SearchAs = (
	query: SearchQuery,
	viewer: number | null,
) => Promise<SearchResult | QueryError>;

export interface InboxHost {
	board: string;
	doc: Y.Doc;
	search: SearchAs;
	send(connection: string, message: WidgetMessage): void;
}

export interface InboxTiming {
	/** How long a person's results are reused. */
	cacheMs: number;
	/** How often watched inboxes are searched again with no webhook to say so. */
	refreshMs: number;
	/** Webhooks in a burst wait this long, so a burst costs one search. */
	activityMs: number;
}

const DEFAULT_TIMING: InboxTiming = { cacheMs: 15_000, refreshMs: 60_000, activityMs: 1_500 };
/** How often one connection may ask for a fresh search of one inbox. */
const REFRESH_THROTTLE_MS = 5_000;
const MAX_QUERY = 256;

interface Watching {
	viewer: number | null;
	ids: Set<string>;
	refreshedAt: Map<string, number>;
}

type Outcome = SearchResult | QueryError;

export class InboxRunner {
	private watching = new Map<string, Watching>();
	private cache = new Map<string, { at: number; result: Promise<Outcome> }>();
	private due = new Set<string>();
	private activityTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private timing = DEFAULT_TIMING;
	private queries = new Map<string, string>();
	private readonly unobserve: () => void;

	constructor(private readonly host: InboxHost) {
		this.queries = this.readQueries();
		// Someone edited an inbox's query (or made a section an inbox): run it
		// again for everyone watching it.
		const shapes = shapesMap(host.doc);
		const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
			const relevant = events.some(
				(event) => event.target === shapes || event.changes.keys.has("inbox"),
			);
			if (!relevant) return;
			const next = this.readQueries();
			const changed = [...next].filter(([id, q]) => this.queries.get(id) !== q).map(([id]) => id);
			const removed = [...this.queries.keys()].filter((id) => !next.has(id));
			this.queries = next;
			for (const id of [...changed, ...removed]) this.runForWatchers(id, false);
		};
		shapes.observeDeep(observer);
		this.unobserve = () => shapes.unobserveDeep(observer);
	}

	setTiming(timing: Partial<InboxTiming>): void {
		this.timing = { ...this.timing, ...timing };
		this.cache.clear();
		if (this.refreshTimer) {
			this.stopRefreshing();
			this.startRefreshing();
		}
	}

	dispose(): void {
		this.unobserve();
		clearTimeout(this.activityTimer);
		this.stopRefreshing();
	}

	/** Inbox section ids, from ids a connection asked to watch. */
	watch(connection: string, viewer: number | null, ids: string[]): string[] {
		const inboxes = ids.filter((id) => this.queries.has(id));
		if (inboxes.length === 0) return [];
		let watching = this.watching.get(connection);
		if (!watching) {
			watching = { viewer, ids: new Set(), refreshedAt: new Map() };
			this.watching.set(connection, watching);
		}
		for (const id of inboxes) {
			watching.ids.add(id);
			void this.run(connection, id, false);
		}
		this.startRefreshing();
		return inboxes;
	}

	unwatch(connection: string, ids: string[]): void {
		const watching = this.watching.get(connection);
		if (!watching) return;
		for (const id of ids) watching.ids.delete(id);
		if (watching.ids.size === 0) this.closed(connection);
	}

	closed(connection: string): void {
		this.watching.delete(connection);
		if (this.watching.size === 0) this.stopRefreshing();
	}

	/** Someone asked for an inbox's results again now. */
	refresh(connection: string, id: string): boolean {
		const watching = this.watching.get(connection);
		if (!watching?.ids.has(id)) return false;
		const now = Date.now();
		if (now - (watching.refreshedAt.get(id) ?? 0) < REFRESH_THROTTLE_MS) return true;
		watching.refreshedAt.set(id, now);
		void this.run(connection, id, true);
		return true;
	}

	/** Run a query someone is writing, for its live count. */
	async preview(
		connection: string,
		viewer: number | null,
		id: string,
		query: SearchQuery,
	): Promise<void> {
		const checked = checkQuery(query);
		const result = checked.kind === "error" ? checked : await this.search(checked, viewer, false);
		this.host.send(connection, message(previewId(id), result));
	}

	/**
	 * A webhook delivery reached the board from a repository: search again,
	 * shortly, every inbox that could include its items.
	 */
	activity(repoKey: string): void {
		const repo = repoKey.toLowerCase();
		for (const [id, query] of inboxSections(this.host.doc)) {
			const repos = queryRepos(query);
			if (repos.length === 0 || repos.includes(repo)) this.due.add(id);
		}
		if (this.due.size === 0) return;
		clearTimeout(this.activityTimer);
		this.activityTimer = setTimeout(() => {
			const due = [...this.due];
			this.due.clear();
			for (const id of due) this.runForWatchers(id, true);
		}, this.timing.activityMs);
	}

	/** Repositories the watched inboxes search, as repository keys. */
	watchedRepos(): string[] {
		const ids = new Set([...this.watching.values()].flatMap((w) => [...w.ids]));
		const repos = new Set<string>();
		for (const [id, query] of inboxSections(this.host.doc)) {
			if (ids.has(id)) for (const repo of queryRepos(query)) repos.add(repo);
		}
		return [...repos];
	}

	/** Search every watched inbox again now, for tests. */
	async refreshAll(): Promise<void> {
		this.cache.clear();
		const runs: Promise<void>[] = [];
		for (const [connection, watching] of this.watching) {
			for (const id of watching.ids) runs.push(this.run(connection, id, true));
		}
		await Promise.all(runs);
	}

	private readQueries(): Map<string, string> {
		return new Map(
			[...inboxSections(this.host.doc)].map(([id, query]) => [id, JSON.stringify(query)]),
		);
	}

	private runForWatchers(id: string, fresh: boolean): void {
		for (const [connection, watching] of this.watching) {
			if (watching.ids.has(id)) void this.run(connection, id, fresh);
		}
	}

	private async run(connection: string, id: string, fresh: boolean): Promise<void> {
		const watching = this.watching.get(connection);
		if (!watching) return;
		const query = inboxSections(this.host.doc).get(id);
		let result: Outcome;
		if (!query) {
			result = {
				kind: "error",
				reason: "invalid",
				message: "This section isn't an inbox any more.",
			};
		} else {
			const checked = checkQuery(query);
			result =
				checked.kind === "error" ? checked : await this.search(checked, watching.viewer, fresh);
		}
		// Still watching, and the query hasn't changed meanwhile.
		if (!this.watching.get(connection)?.ids.has(id)) return;
		const current = inboxSections(this.host.doc).get(id);
		if (current && query && JSON.stringify(current) !== JSON.stringify(query)) return;
		// Anything in anyone's results matches. (Being left out of one person's
		// results says nothing: they may not be able to read it.)
		if (result.kind === "search") confirmMatches(this.host.doc, id, result, INBOX_ORIGIN);
		this.host.send(connection, message(id, result));
	}

	private search(query: SearchQuery, viewer: number | null, fresh: boolean): Promise<Outcome> {
		const key = `${viewer ?? "anon"} ${JSON.stringify(query)}`;
		const now = Date.now();
		const cached = this.cache.get(key);
		if (cached && !fresh && now - cached.at < this.timing.cacheMs) return cached.result;
		const started = Date.now();
		const result = this.host.search(query, viewer).then(
			(outcome) => {
				log.info("inbox.search", {
					board: this.host.board,
					status: outcome.kind === "error" ? outcome.reason : "ok",
					total: outcome.kind === "search" ? outcome.total : null,
					ms: Date.now() - started,
				});
				// Errors aren't worth keeping: the next ask tries again.
				if (outcome.kind === "error") this.cache.delete(key);
				return outcome;
			},
			(error: unknown): Outcome => {
				log.warn("inbox.search.failed", { board: this.host.board, error });
				this.cache.delete(key);
				return { kind: "error", reason: "error", message: "The search didn't work. Try again." };
			},
		);
		this.cache.set(key, { at: now, result });
		for (const [k, v] of this.cache) if (now - v.at > this.timing.cacheMs * 4) this.cache.delete(k);
		return result;
	}

	private startRefreshing(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			for (const id of this.queries.keys()) this.runForWatchers(id, true);
		}, this.timing.refreshMs);
	}

	private stopRefreshing(): void {
		clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}

/** A query as the runner will run it, or why it can't be. */
function checkQuery(query: SearchQuery): SearchQuery | QueryError {
	if (query?.kind !== "search" || typeof query.q !== "string" || typeof query.host !== "string") {
		return { kind: "error", reason: "invalid", message: "That isn't a search." };
	}
	const q = query.q.trim();
	if (!q) return { kind: "error", reason: "invalid", message: "Write a query to fill this inbox." };
	if (q.length > MAX_QUERY)
		return { kind: "error", reason: "invalid", message: "That query is too long." };
	if (!forgeForHost(query.host)) {
		return { kind: "error", reason: "unsupported", message: `Tack can't search ${query.host}.` };
	}
	return {
		kind: "search",
		host: query.host.toLowerCase(),
		q,
		sort: query.sort ?? "created",
		order: query.order ?? "desc",
		limit: Math.min(Math.max(1, query.limit ?? INBOX_LIMIT), 100),
	};
}

function message(id: string, result: Outcome): WidgetMessage {
	return {
		type: "widget-data",
		id,
		results: { [INBOX_QUERY]: result },
		at: new Date().toISOString(),
	};
}
