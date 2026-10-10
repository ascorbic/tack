import type * as Y from "yjs";
import { type Card, isMissing } from "../../shared/cards.ts";
import {
	INBOX_LIMIT,
	INBOX_ORIGIN,
	INBOX_QUERY,
	type InboxPreviewRequest,
	confirmMatches,
	previewId,
} from "../../shared/inbox.ts";
import { forgeForHost, parseRepoKey } from "../../shared/refs.ts";
import { mentionsMe } from "../../shared/search.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { boardQueryContext } from "../../shared/widgetContext.ts";
import {
	queryScope,
	widgetDefinition,
	widgetFollowUps,
	widgetQueries,
} from "../../shared/widgetRegistry.ts";
import type {
	QueryContext,
	QueryError,
	QueryResult,
	RelatedQuery,
	ReleaseQuery,
	SearchQuery,
	WidgetMessage,
	WidgetQuery,
	WidgetRequest,
} from "../../shared/widgets.ts";
import { type MissingReason, type RepoIdentity, forge } from "../forges/index.ts";
import type { Logger } from "../log.ts";

// Running widgets' queries (#37), for one board. Each connection watches the
// widgets it can see; this runs their queries with the permissions of the
// person on that connection, caches results by query and access level, and
// sends `widget-data` messages.
//
// Inbox frames (#40) are widgets with one query: a section with an `inbox`
// runs its search under the name `inbox`, and the cards it brought that
// show up in anyone's results are confirmed as still matching. Someone
// writing an inbox's query can preview it (`inbox-preview`), answered under
// `previewId(section)`.
//
// Access levels:
// - `user:{id}`: a signed-in person with their own token. Their searches run
//   with it, so they see exactly what they could see on the forge, and their
//   results are only ever sent to their own connections.
// - `public`: everyone else (signed out, or without a token). Searches are
//   limited to public repositories (`is:public`), run with any token that's
//   to hand (someone else's, for the rate limit), and any result that isn't
//   known to be public is dropped. `@me` means nobody, so it's an error.
//
// Results are refreshed when a webhook says a repository a query reads has
// changed (debounced, and at most every `minIntervalMs`), on the widget
// definition's `refresh` schedule while anyone's watching, and when someone
// asks. A refresh that fails keeps the last good result, which goes stale.
//
// Webhooks only reach the board from repositories it asked to hear from:
// the ones a query names (`repo:`), and the ones its results came from (so
// `org:` searches refresh too, until a new repository appears in them).

export interface RunnerTiming {
	/** A result this young is reused as is for someone new watching. */
	freshMs: number;
	/** A webhook's refresh waits this long for others to arrive... */
	debounceMs: number;
	/** ...and never runs a query more often than this. */
	minIntervalMs: number;
	/** Asking for a refresh does nothing if the result is younger than this. */
	throttleMs: number;
	/** How often inboxes search again while watched, with no webhook to say so. */
	inboxRefreshMs: number;
}

export const DEFAULT_TIMING: RunnerTiming = {
	freshMs: 30_000,
	debounceMs: 2_000,
	minIntervalMs: 10_000,
	throttleMs: 5_000,
	inboxRefreshMs: 60_000,
};

/** GitHub rejects longer searches. */
const MAX_QUERY = 256;

/** What a shape asks the runner to run: a widget's queries, or an inbox's one. */
interface Source {
	queries: Record<string, WidgetQuery>;
	/** Queries that can't run as written, answered with these instead. */
	errors: Record<string, QueryError>;
	/** How often its results go stale, in ms, when no webhook says sooner. */
	refreshMs: number | null;
	inbox: boolean;
	/** Whether its queries depend on what's on the board (the cards in a section). */
	readsBoard: boolean;
}

/**
 * Queries per access level per minute, well inside the forge's limits:
 * searches have a much smaller budget on GitHub than other reads (related
 * items, releases), which dependency maps run one per item.
 */
const RUNS_PER_MINUTE = { search: 20, read: 60 };
/** At most this many of one widget's follow-up queries run at once. */
const FOLLOW_UP_CONCURRENCY = 6;
/** Cached results nobody's watched for this long are dropped. */
const EVICT_MS = 5 * 60_000;
/** How often the runner checks what's due. */
export const TICK_MS = 15_000;

export interface Access {
	/** `user:{id}` or `public`. */
	key: string;
	userId: number | null;
	login: string | null;
	/** Their own token, for `user:` access. */
	token: string | null;
}

/** What the runner needs from the board around it. */
export interface RunnerHost {
	doc: Y.Doc;
	env: Env;
	log: Logger;
	send(connection: string, message: WidgetMessage): void;
	/** Who's on a connection, and the token to search with. */
	access(connection: string): Promise<Access>;
	/** A signed-in person's token, to search public data with (better rate limits). */
	readerToken(): Promise<string | null>;
	/** Ask to hear about webhooks for these repositories (`{host}/{owner}/{name}`). */
	watchRepos(repos: string[]): void | Promise<void>;
	/** A repository's identity, for queries about one (releases). */
	route(repoKey: string): Promise<RepoIdentity | MissingReason>;
	now?(): number;
}

interface Entry {
	query: WidgetQuery;
	access: Access;
	result?: QueryResult | QueryError;
	/** When `result` was fetched. */
	at?: number;
	running?: Promise<void>;
	/** When it last ran (successfully or not). */
	ranAt: number;
	/** Run again at this time (a webhook, a refresh schedule or a rate limit). */
	dueAt: number | null;
	/** When anyone last watched it. */
	usedAt: number;
}

interface Watching {
	access: Promise<Access>;
	/** The access level, once known. */
	level: string | null;
	widgets: Set<string>;
	/** Inbox queries it's previewing (as JSON), kept warm while it writes. */
	previews: Set<string>;
}

export class WidgetRunner {
	private connections = new Map<string, Watching>();
	private entries = new Map<string, Entry>();
	/** What each shape runs, as last read from the document. */
	private sources = new Map<string, Source>();
	/** What each widget runs after its first queries answer (see `followUps`), as last worked out. */
	private followUps = new Map<string, Record<string, WidgetQuery>>();
	/** Runs per access level in the current minute. */
	private budget = new Map<string, { minute: number; runs: number }>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private unobserve: (() => void) | null = null;
	timing: RunnerTiming = { ...DEFAULT_TIMING };

	constructor(private host: RunnerHost) {
		const shapes = shapesMap(host.doc);
		const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
			const changed = new Set<string>();
			// Shapes added or removed, or moved between sections: what's in a
			// section may have changed (moving within one doesn't change that).
			let structural = false;
			for (const event of events) {
				if (event.target === shapes) {
					for (const key of event.keys.keys()) changed.add(key);
					structural = true;
				} else if (typeof event.path[0] === "string") {
					changed.add(event.path[0]);
					for (const key of event.keys.keys()) {
						if (key === "parent" || key === "ref" || key === "type") structural = true;
					}
				}
			}
			this.widgetsChanged(changed, structural);
		};
		shapes.observeDeep(observer);
		this.unobserve = () => shapes.unobserveDeep(observer);
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	destroy(): void {
		this.unobserve?.();
		clearTimeout(this.timer);
		clearInterval(this.ticker);
	}

	// --- Connections ------------------------------------------------------------

	/** Handle a request from a connection. Returns false if it wasn't a widget request. */
	request(connection: string, message: unknown): boolean {
		const request = message as WidgetRequest | InboxPreviewRequest | null;
		switch (request?.type) {
			case "inbox-preview":
				if (typeof request.id === "string" && request.query) {
					void this.preview(connection, request.id, request.query);
				}
				return true;
			case "widget-watch":
				this.watch(connection, strings(request.ids));
				return true;
			case "widget-unwatch":
				this.unwatch(connection, strings(request.ids));
				return true;
			case "widget-refresh":
				if (typeof request.id === "string") this.refresh(connection, request.id);
				return true;
			default:
				return false;
		}
	}

	watch(connection: string, ids: string[]): void {
		let watching = this.connections.get(connection);
		if (!watching) {
			watching = this.watching(connection);
			this.connections.set(connection, watching);
		}
		const added = ids.filter((id) => !watching.widgets.has(id)).slice(0, 200);
		for (const id of added) {
			watching.widgets.add(id);
			// Read now, so the repositories it reads are watched straight away.
			this.sourceOf(id);
		}
		this.startTicking();
		for (const id of added) void this.deliver(connection, id, { maxAge: this.timing.freshMs });
		void this.renewRepoWatches();
	}

	private watching(connection: string, widgets = new Set<string>()): Watching {
		const watching: Watching = {
			access: this.host.access(connection),
			level: null,
			widgets,
			previews: new Set(),
		};
		watching.access.then(
			(access) => {
				watching.level = access.key;
			},
			() => {},
		);
		return watching;
	}

	unwatch(connection: string, ids: string[]): void {
		const watching = this.connections.get(connection);
		if (!watching) return;
		for (const id of ids) watching.widgets.delete(id);
	}

	/** A connection closed: forget what it watched. */
	disconnect(connection: string): void {
		this.connections.delete(connection);
		if (this.connections.size === 0) this.stopTicking();
	}

	/** Someone asked for fresh results now. */
	refresh(connection: string, id: string): void {
		const watching = this.connections.get(connection);
		if (!watching?.widgets.has(id)) return;
		void this.deliver(connection, id, { maxAge: this.timing.throttleMs });
	}

	/** Run an inbox query someone is writing, for its live count, answered under `previewId(id)`. */
	async preview(connection: string, id: string, raw: SearchQuery): Promise<void> {
		let watching = this.connections.get(connection);
		if (!watching) {
			watching = this.watching(connection);
			this.connections.set(connection, watching);
		}
		const query = inboxQueryOf({ query: raw });
		let result: QueryResult | QueryError = query.kind === "error" ? query : unavailable();
		if (query.kind === "search") {
			const access = await watching.access;
			// Keep the last few previews warm, so typing back and forth is instant.
			watching.previews.add(JSON.stringify(query));
			if (watching.previews.size > 5) {
				watching.previews.delete(watching.previews.values().next().value as string);
			}
			result = (await this.resolve(query, access, this.timing.freshMs)).result ?? unavailable();
		}
		if (!this.connections.has(connection)) return;
		this.host.send(connection, {
			type: "widget-data",
			id: previewId(id),
			results: { [INBOX_QUERY]: result },
			at: new Date().toISOString(),
		});
	}

	/** A connection's access changed (say, they signed in elsewhere): look again. */
	reaccess(connection: string): void {
		const before = this.connections.get(connection);
		if (!before) return;
		const watching = this.watching(connection, before.widgets);
		this.connections.set(connection, watching);
		for (const id of watching.widgets)
			void this.deliver(connection, id, { maxAge: this.timing.freshMs });
	}

	// --- Webhooks and schedules --------------------------------------------------------

	/**
	 * A repository changed (a webhook for one of its items arrived): queries
	 * that read it or its owner, or that search everywhere, run again shortly.
	 */
	repoChanged(repoKey: string): number {
		const repo = repoKey.toLowerCase();
		const owner = repo.split("/").slice(0, 2).join("/");
		let due = 0;
		for (const entry of this.entries.values()) {
			if (!this.inUse(entry)) continue;
			const scope = queryScope(entry.query);
			const everywhere = scope.repos.length === 0 && scope.owners.length === 0;
			if (!everywhere && !scope.repos.includes(repo) && !scope.owners.includes(owner)) continue;
			this.schedule(
				entry,
				Math.max(this.now() + this.timing.debounceMs, entry.ranAt + this.timing.minIntervalMs),
			);
			due++;
		}
		return due;
	}

	/** Run whatever is due: webhooks' refreshes, schedules, and the end of rate limits. */
	async tick(): Promise<void> {
		// Relative ranges ("the last two weeks") move on with the clock.
		this.widgetsChanged(this.watchedIds(), false);
		const now = this.now();
		const running: Promise<void>[] = [];
		for (const [key, entry] of this.entries) {
			if (!this.inUse(entry)) {
				if (!entry.running && now - entry.usedAt > EVICT_MS) this.entries.delete(key);
				continue;
			}
			entry.usedAt = now;
			const period = this.refreshPeriod(entry);
			const scheduled = period !== null && entry.at !== undefined && now - entry.at >= period;
			if ((entry.dueAt !== null && entry.dueAt <= now) || scheduled) {
				running.push(this.rerun(key, entry));
			}
		}
		await Promise.all(running);
		this.armTimer();
	}

	/** Every cached result, for tests and debugging over RPC only. */
	cached(): { key: string; access: string; at: number | null; error: string | null }[] {
		return [...this.entries].map(([key, entry]) => ({
			key,
			access: entry.access.key,
			at: entry.at ?? null,
			error: entry.result?.kind === "error" ? entry.result.reason : null,
		}));
	}

	// --- Internals --------------------------------------------------------------------

	/** What a shape runs, read from the document: a widget's queries, or an inbox's. */
	private readSource(
		id: string,
		context: QueryContext = boardQueryContext(this.host.doc, this.now()),
	): Source | null {
		const shape = shapesMap(this.host.doc).get(id);
		if (!shape) return null;
		const type = shape.get("type");
		if (type === "widget") {
			const kind = shape.get("widget");
			const definition = widgetDefinition(kind);
			const refresh = definition?.refresh;
			return {
				queries: widgetQueries({ widget: kind as string, config: shape.get("config") }, context),
				errors: {},
				refreshMs: refresh ? refresh * 1000 : null,
				inbox: false,
				readsBoard: definition?.readsBoard === true,
			};
		}
		if (type !== "section" || shape.get("inbox") === undefined) return null;
		const query = inboxQueryOf(shape.get("inbox"));
		return query.kind === "error"
			? {
					queries: {},
					errors: { [INBOX_QUERY]: query },
					refreshMs: null,
					inbox: true,
					readsBoard: false,
				}
			: {
					queries: { [INBOX_QUERY]: query },
					errors: {},
					refreshMs: this.timing.inboxRefreshMs,
					inbox: true,
					readsBoard: false,
				};
	}

	private widgetsChanged(ids: Set<string>, structural = true): void {
		// Widgets that read the board (a section's cards) may run something
		// else when what's in sections changes.
		if (structural) {
			for (const id of this.watchedIds()) {
				if (this.sources.get(id)?.readsBoard) ids.add(id);
			}
		}
		const context = boardQueryContext(this.host.doc, this.now());
		for (const id of ids) {
			const before = this.sources.get(id);
			const after = this.readSource(id, context);
			if (after) this.sources.set(id, after);
			else {
				this.sources.delete(id);
				this.followUps.delete(id);
			}
			if (JSON.stringify(before ?? null) === JSON.stringify(after)) continue;
			if (!this.watched(id)) continue;
			// Its config (or an inbox's query) changed: everyone watching gets new results.
			for (const [connection, watching] of this.connections) {
				if (watching.widgets.has(id)) {
					void this.deliver(connection, id, { maxAge: this.timing.freshMs });
				}
			}
			void this.renewRepoWatches();
		}
	}

	private watchedIds(): Set<string> {
		const ids = new Set<string>();
		for (const watching of this.connections.values())
			for (const id of watching.widgets) ids.add(id);
		return ids;
	}

	private watched(id: string): boolean {
		for (const watching of this.connections.values()) if (watching.widgets.has(id)) return true;
		return false;
	}

	private sourceOf(id: string): Source | null {
		const known = this.sources.get(id);
		if (known) return known;
		const source = this.readSource(id);
		if (source) this.sources.set(id, source);
		return source;
	}

	/** Whether a shape runs this query (as JSON), first or as a follow-up. */
	private uses(id: string, query: string): boolean {
		const runs = (queries: Record<string, WidgetQuery> | undefined) =>
			Object.values(queries ?? {}).some((q) => JSON.stringify(q) === query);
		return runs(this.sources.get(id)?.queries) || runs(this.followUps.get(id));
	}

	/** The refresh period for a cached query: the shortest of the watched shapes using it. */
	private refreshPeriod(entry: Entry): number | null {
		let period: number | null = null;
		const query = JSON.stringify(entry.query);
		for (const [id, source] of this.sources) {
			if (!this.watched(id) || !this.uses(id, query)) continue;
			if (source.refreshMs !== null && (period === null || source.refreshMs < period)) {
				period = source.refreshMs;
			}
		}
		return period;
	}

	/** Whether any connection with this entry's access watches a shape that runs its query. */
	private inUse(entry: Entry): boolean {
		const query = JSON.stringify(entry.query);
		for (const watching of this.connections.values()) {
			if (watching.level !== entry.access.key) continue;
			for (const id of watching.widgets) {
				if (this.uses(id, query)) return true;
			}
			if (watching.previews.has(query)) return true;
		}
		return false;
	}

	/** Send a shape's results to a connection, running its queries if they're older than `maxAge`. */
	private async deliver(connection: string, id: string, { maxAge }: { maxAge: number }) {
		const watching = this.connections.get(connection);
		if (!watching) return;
		try {
			const access = await watching.access;
			const source = this.sourceOf(id);
			// A section that stopped being an inbox while someone watched it.
			const shape = shapesMap(this.host.doc).get(id);
			if (!source && shape?.get("type") !== "section") return;
			const results: WidgetMessage["results"] = source
				? { ...source.errors }
				: {
						[INBOX_QUERY]: {
							kind: "error",
							reason: "invalid",
							message: "This section isn't an inbox any more.",
						},
					};
			let oldest = this.now();
			await Promise.all(
				Object.entries(source?.queries ?? {}).map(async ([name, query]) => {
					const entry = await this.resolve(query, access, maxAge);
					results[name] = entry.result ?? unavailable();
					if (entry.at !== undefined && entry.at < oldest) oldest = entry.at;
				}),
			);
			// Then what depends on those answers (a dependency map's items' relations).
			if (source && !source.inbox && shape) {
				const followUps = widgetFollowUps(
					{ widget: shape.get("widget") as string, config: shape.get("config") },
					results,
				);
				const before = JSON.stringify(this.followUps.get(id) ?? {});
				this.followUps.set(id, followUps);
				if (JSON.stringify(followUps) !== before) void this.renewRepoWatches();
				await pool(Object.entries(followUps), FOLLOW_UP_CONCURRENCY, async ([name, query]) => {
					const entry = await this.resolve(query, access, maxAge);
					results[name] = entry.result ?? unavailable();
					if (entry.at !== undefined && entry.at < oldest) oldest = entry.at;
				});
			}
			// It may have stopped watching while the queries ran.
			if (!this.connections.get(connection)?.widgets.has(id)) return;
			// Cards an inbox brought that are in anyone's results do match. (Being
			// left out of one person's says nothing: they may not be able to read it.)
			const found = results[INBOX_QUERY];
			if (source?.inbox && found?.kind === "search") {
				confirmMatches(this.host.doc, id, found, INBOX_ORIGIN);
			}
			this.host.send(connection, {
				type: "widget-data",
				id,
				results,
				at: new Date(oldest).toISOString(),
			});
		} catch (error) {
			this.host.log.error("widget.send.failed", { connection, widget: id, error });
		}
	}

	/** A query's cached entry, run first if it's older than `maxAge` (or has never run). */
	private async resolve(query: WidgetQuery, access: Access, maxAge: number): Promise<Entry> {
		const key = `${access.key}\n${JSON.stringify(query)}`;
		let entry = this.entries.get(key);
		const now = this.now();
		if (!entry) {
			entry = { query, access, ranAt: 0, dueAt: null, usedAt: now };
			this.entries.set(key, entry);
		}
		entry.access = access;
		entry.usedAt = now;
		if (entry.running) {
			await entry.running;
		} else if (entry.at === undefined || now - entry.at > maxAge) {
			if (entry.result === undefined || now - entry.ranAt >= this.timing.throttleMs) {
				await this.run(entry);
			}
		}
		return entry;
	}

	/** Run a cached query again, then send its new results to everyone watching it. */
	private async rerun(key: string, entry: Entry): Promise<void> {
		const before = JSON.stringify(entry.result);
		await this.run(entry);
		if (JSON.stringify(entry.result) === before) return;
		const query = JSON.stringify(entry.query);
		for (const [connection, watching] of this.connections) {
			if (watching.level !== entry.access.key) continue;
			for (const id of watching.widgets) {
				if (this.uses(id, query)) {
					void this.deliver(connection, id, { maxAge: Number.POSITIVE_INFINITY });
				}
			}
		}
	}

	private run(entry: Entry): Promise<void> {
		entry.running ??= this.execute(entry).finally(() => {
			entry.running = undefined;
		});
		return entry.running;
	}

	private async execute(entry: Entry): Promise<void> {
		const now = this.now();
		// Spend this access level's budget, or wait for the next minute.
		const minute = Math.floor(now / 60_000);
		const kind = entry.query.kind === "search" ? "search" : "read";
		const budgetKey = `${entry.access.key}\n${kind}`;
		const spent = this.budget.get(budgetKey);
		const runs = spent?.minute === minute ? spent.runs : 0;
		if (runs >= RUNS_PER_MINUTE[kind]) {
			this.schedule(entry, (minute + 1) * 60_000);
			if (entry.result === undefined) {
				entry.result = {
					kind: "error",
					reason: "rate_limited",
					message: "Lots of searches on this board just now: trying again in a moment.",
					retryAt: (minute + 1) * 60_000,
				};
			}
			return;
		}
		this.budget.set(budgetKey, { minute, runs: runs + 1 });
		entry.ranAt = now;
		entry.dueAt = null;
		const started = Date.now();
		const result = await this.runQuery(entry.query, entry.access).catch(
			(error: unknown): QueryError => {
				this.host.log.error("widget.query.failed", { access: entry.access.key, error });
				return { kind: "error", reason: "error", message: "Something went wrong running this." };
			},
		);
		const failed = result.kind === "error";
		this.host.log[failed ? "warn" : "info"]("widget.query", {
			kind: entry.query.kind,
			access: entry.access.key === "public" ? "public" : "user",
			status: failed ? result.reason : "ok",
			results: result.kind === "search" ? result.items.length : null,
			ms: Date.now() - started,
		});
		if (failed && result.retryAt) this.schedule(entry, result.retryAt);
		// A failed refresh keeps the last good result, which goes stale.
		if (failed && entry.result && entry.result.kind !== "error") return;
		entry.result = result;
		if (failed) return;
		entry.at = now;
		void this.renewRepoWatches();
	}

	/** Run one query as `access` may: their own token, or limited to public data. */
	private async runQuery(query: WidgetQuery, access: Access): Promise<QueryResult | QueryError> {
		switch (query.kind) {
			case "search":
				return this.search(query, access);
			case "related":
				return this.related(query, access);
			case "release":
				return this.release(query, access);
		}
	}

	/**
	 * What's related to an item. With the viewer's token, the forge leaves out
	 * what they can't see; for everyone else only public items are kept,
	 * everywhere they're named.
	 */
	private async related(query: RelatedQuery, access: Access): Promise<QueryResult | QueryError> {
		const parsed = parseRepoKey(query.key.replace(/[#!]\d+$/, ""));
		const adapter = parsed ? forge(parsed.forge) : null;
		if (!adapter?.related) return unsupported("This forge can't say what's related.");
		if (access.key === "public" && adapter.canRead) {
			// The item's own repository must be public: its card isn't among the results.
			const repo = await this.host.route(query.key.replace(/[#!]\d+$/, ""));
			if (typeof repo === "string" || repo.private !== false) return noAccess();
		}
		const result = await adapter.related(query.key, this.host.env, { token: access.token });
		if (result.kind === "error" || access.key !== "public") return result;
		const cards = result.cards.filter(
			(entry): entry is Card =>
				!isMissing(entry) && (entry.visibility === "public" || !adapter.canRead),
		);
		const keep = new Set(cards.map((card) => card.key));
		const only = (keys: string[]) => keys.filter((key) => keep.has(key));
		return {
			...result,
			...(result.parent && keep.has(result.parent) ? {} : { parent: undefined }),
			subIssues: only(result.subIssues),
			blockedBy: only(result.blockedBy),
			blocking: only(result.blocking),
			linkedPulls: only(result.linkedPulls),
			cards,
		};
	}

	/** A repository's latest release; for everyone but its readers, only if it's public. */
	private async release(query: ReleaseQuery, access: Access): Promise<QueryResult | QueryError> {
		const repo = await this.host.route(query.repo);
		if (typeof repo === "string") return noAccess();
		const adapter = forge(repo.forge);
		if (!adapter.release) return unsupported("This forge has no releases.");
		if (access.key === "public" && adapter.canRead && repo.private !== false) return noAccess();
		const result = await adapter.release(repo, this.host.env, { token: access.token });
		if (result.kind === "error" || access.key !== "public") return result;
		return {
			...result,
			mergedSince: result.mergedSince.filter(
				(card) => card.visibility === "public" || !adapter.canRead,
			),
		};
	}

	private async search(query: SearchQuery, access: Access): Promise<QueryResult | QueryError> {
		const forgeId = forgeForHost(query.host);
		const adapter = forgeId ? forge(forgeId) : null;
		if (!adapter?.search) {
			return { kind: "error", reason: "unsupported", message: `Tack can't search ${query.host}.` };
		}
		const env = this.host.env;
		if (access.key !== "public") {
			return adapter.search(query, env, {
				token: access.token,
				...(access.login ? { viewer: access.login } : {}),
			});
		}
		if (mentionsMe(query.q)) {
			return {
				kind: "error",
				reason: "signed_out",
				message: "Sign in to see what “@me” means for you.",
			};
		}
		// Forges without private repositories (no `canRead`) need no limiting.
		const limited = adapter.canRead !== undefined;
		const result = await adapter.search(
			limited ? { ...query, q: `${query.q} is:public` } : query,
			env,
			{ token: limited ? await this.host.readerToken() : null },
		);
		if (result.kind !== "search" || !limited) return result;
		const items = result.items.filter((card) => card.visibility === "public");
		return {
			...result,
			items,
			total: Math.max(0, result.total - (result.items.length - items.length)),
		};
	}

	private schedule(entry: Entry, at: number): void {
		entry.dueAt = entry.dueAt === null ? at : Math.min(entry.dueAt, at);
		this.armTimer();
	}

	private armTimer(): void {
		clearTimeout(this.timer);
		let next: number | null = null;
		for (const entry of this.entries.values()) {
			if (entry.dueAt !== null && (next === null || entry.dueAt < next)) next = entry.dueAt;
		}
		if (next === null) return;
		this.timer = setTimeout(() => void this.tick(), Math.max(0, next - this.now()));
	}

	private startTicking(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => void this.beat(), TICK_MS);
	}

	private stopTicking(): void {
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	/**
	 * What happens every `TICK_MS` while anyone's watching: whatever's due
	 * runs, and the repositories queries read are asked again to tell this
	 * board about their webhooks. Resolves once both are done.
	 */
	async beat(): Promise<void> {
		await Promise.all([this.tick(), this.renewRepoWatches()]);
	}

	/** Ask the repositories watched widgets read to tell this board about their webhooks. */
	private async renewRepoWatches(): Promise<void> {
		const repos = new Set<string>();
		for (const watching of this.connections.values()) {
			for (const id of watching.widgets) {
				const queries = [
					...Object.values(this.sources.get(id)?.queries ?? {}),
					...Object.values(this.followUps.get(id) ?? {}),
				];
				for (const query of queries) {
					for (const repo of queryScope(query).repos) repos.add(repo);
				}
			}
		}
		// And wherever results came from, so searches across owners refresh too.
		for (const entry of this.entries.values()) {
			if (entry.result?.kind !== "search" || !this.inUse(entry)) continue;
			for (const card of entry.result.items) repos.add(`${card.host}/${card.repo}`.toLowerCase());
		}
		if (repos.size > 0) await this.host.watchRepos([...repos]);
	}
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await work(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function unavailable(): QueryError {
	return { kind: "error", reason: "error", message: "No results yet." };
}

function unsupported(message: string): QueryError {
	return { kind: "error", reason: "unsupported", message };
}

function noAccess(): QueryError {
	return { kind: "error", reason: "no_access", message: "It doesn't exist, or you can't see it." };
}

/** An inbox's query as it runs, with an inbox's defaults, or why it can't run. */
export function inboxQueryOf(inbox: unknown): SearchQuery | QueryError {
	const query = (inbox as { query?: Partial<SearchQuery> } | null)?.query;
	if (query?.kind !== "search" || typeof query.q !== "string" || typeof query.host !== "string") {
		return { kind: "error", reason: "invalid", message: "That isn't a search." };
	}
	const q = query.q.trim();
	if (!q) return { kind: "error", reason: "invalid", message: "Write a query to fill this inbox." };
	if (q.length > MAX_QUERY) {
		return { kind: "error", reason: "invalid", message: "That query is too long." };
	}
	if (!forgeForHost(query.host)) {
		return unsupported(`Tack can't search ${query.host}.`);
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
