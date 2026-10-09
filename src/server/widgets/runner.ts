import type * as Y from "yjs";
import { forgeForHost } from "../../shared/refs.ts";
import { mentionsMe } from "../../shared/search.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { queryScope, widgetDefinition, widgetQueries } from "../../shared/widgetRegistry.ts";
import type {
	QueryError,
	QueryResult,
	SearchQuery,
	WidgetMessage,
	WidgetQuery,
	WidgetRequest,
} from "../../shared/widgets.ts";
import { forge } from "../forges/index.ts";
import type { Logger } from "../log.ts";

// Running widgets' queries (#37), for one board. Each connection watches the
// widgets it can see; this runs their queries with the permissions of the
// person on that connection, caches results by query and access level, and
// sends `widget-data` messages.
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
}

export const DEFAULT_TIMING: RunnerTiming = {
	freshMs: 30_000,
	debounceMs: 2_000,
	minIntervalMs: 10_000,
	throttleMs: 5_000,
};

/** Queries per access level per minute, well inside the forge's search limits. */
const RUNS_PER_MINUTE = 20;
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
	watchRepos(repos: string[]): void;
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
}

export class WidgetRunner {
	private connections = new Map<string, Watching>();
	private entries = new Map<string, Entry>();
	/** Each widget's queries as last read from the document. */
	private queries = new Map<string, Record<string, WidgetQuery>>();
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
			for (const event of events) {
				if (event.target === shapes) {
					for (const key of event.keys.keys()) changed.add(key);
				} else if (typeof event.path[0] === "string") {
					changed.add(event.path[0]);
				}
			}
			this.widgetsChanged(changed);
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
		const request = message as WidgetRequest | null;
		switch (request?.type) {
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
			this.queriesOf(id);
		}
		this.startTicking();
		for (const id of added) void this.deliver(connection, id, { maxAge: this.timing.freshMs });
		this.renewRepoWatches();
	}

	private watching(connection: string, widgets = new Set<string>()): Watching {
		const watching: Watching = { access: this.host.access(connection), level: null, widgets };
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
	 * that read it, or its owner, run again shortly.
	 */
	repoChanged(repoKey: string): number {
		const repo = repoKey.toLowerCase();
		const owner = repo.split("/").slice(0, 2).join("/");
		let due = 0;
		for (const entry of this.entries.values()) {
			if (!this.inUse(entry)) continue;
			const scope = queryScope(entry.query);
			if (!scope.repos.includes(repo) && !scope.owners.includes(owner)) continue;
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
		const now = this.now();
		const running: Promise<void>[] = [];
		for (const [key, entry] of this.entries) {
			if (!this.inUse(entry)) {
				if (!entry.running && now - entry.usedAt > EVICT_MS) this.entries.delete(key);
				continue;
			}
			entry.usedAt = now;
			const period = this.refreshPeriod(key);
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

	private widgetsChanged(ids: Set<string>): void {
		const shapes = shapesMap(this.host.doc);
		for (const id of ids) {
			const shape = shapes.get(id);
			const before = this.queries.get(id);
			if (!shape || shape.get("type") !== "widget") {
				this.queries.delete(id);
				continue;
			}
			const after = widgetQueries({
				widget: shape.get("widget") as string,
				config: shape.get("config"),
			});
			this.queries.set(id, after);
			if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
			if (!before && !this.watched(id)) continue;
			// Its config changed: everyone watching it gets its new results.
			for (const [connection, watching] of this.connections) {
				if (watching.widgets.has(id))
					void this.deliver(connection, id, { maxAge: this.timing.freshMs });
			}
			this.renewRepoWatches();
		}
	}

	private watched(id: string): boolean {
		for (const watching of this.connections.values()) if (watching.widgets.has(id)) return true;
		return false;
	}

	private queriesOf(id: string): Record<string, WidgetQuery> | null {
		const known = this.queries.get(id);
		if (known) return known;
		const shape = shapesMap(this.host.doc).get(id);
		if (!shape || shape.get("type") !== "widget") return null;
		const queries = widgetQueries({
			widget: shape.get("widget") as string,
			config: shape.get("config"),
		});
		this.queries.set(id, queries);
		return queries;
	}

	/** The definition's refresh period for a cached query, the shortest of the widgets using it. */
	private refreshPeriod(key: string): number | null {
		let period: number | null = null;
		const shapes = shapesMap(this.host.doc);
		for (const [id, queries] of this.queries) {
			if (!this.watched(id)) continue;
			for (const query of Object.values(queries)) {
				if (!key.endsWith(`\n${JSON.stringify(query)}`)) continue;
				const refresh = widgetDefinition(shapes.get(id)?.get("widget"))?.refresh;
				if (refresh && (period === null || refresh * 1000 < period)) period = refresh * 1000;
			}
		}
		return period;
	}

	/** Whether any connection with this entry's access watches a widget that runs its query. */
	private inUse(entry: Entry): boolean {
		const query = JSON.stringify(entry.query);
		for (const watching of this.connections.values()) {
			if (watching.level !== entry.access.key) continue;
			for (const id of watching.widgets) {
				const queries = this.queries.get(id);
				if (queries && Object.values(queries).some((q) => JSON.stringify(q) === query)) {
					return true;
				}
			}
		}
		return false;
	}

	/** Send a widget's results to a connection, running its queries if they're older than `maxAge`. */
	private async deliver(connection: string, id: string, { maxAge }: { maxAge: number }) {
		const watching = this.connections.get(connection);
		if (!watching) return;
		try {
			const access = await watching.access;
			const queries = this.queriesOf(id);
			if (!queries) return;
			const results: WidgetMessage["results"] = {};
			let oldest = this.now();
			await Promise.all(
				Object.entries(queries).map(async ([name, query]) => {
					const entry = await this.resolve(query, access, maxAge);
					results[name] = entry.result ?? unavailable();
					if (entry.at !== undefined && entry.at < oldest) oldest = entry.at;
				}),
			);
			// It may have stopped watching while the queries ran.
			if (!this.connections.get(connection)?.widgets.has(id)) return;
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
				const queries = this.queries.get(id);
				if (queries && Object.values(queries).some((q) => JSON.stringify(q) === query)) {
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
		const spent = this.budget.get(entry.access.key);
		const runs = spent?.minute === minute ? spent.runs : 0;
		if (runs >= RUNS_PER_MINUTE) {
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
		this.budget.set(entry.access.key, { minute, runs: runs + 1 });
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
		this.renewRepoWatches();
	}

	/** Run one query as `access` may: their own token, or limited to public data. */
	private async runQuery(query: WidgetQuery, access: Access): Promise<QueryResult | QueryError> {
		switch (query.kind) {
			case "search":
				return this.search(query, access);
			case "related":
			case "release":
				// Not yet run on boards (see src/server/forges/types.ts).
				return {
					kind: "error",
					reason: "unsupported",
					message: "This board can't run that kind of query yet.",
				};
		}
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
		this.ticker = setInterval(() => {
			void this.tick();
			this.renewRepoWatches();
		}, TICK_MS);
	}

	private stopTicking(): void {
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	/** Ask the repositories watched widgets read to tell this board about their webhooks. */
	private renewRepoWatches(): void {
		const repos = new Set<string>();
		for (const watching of this.connections.values()) {
			for (const id of watching.widgets) {
				for (const query of Object.values(this.queries.get(id) ?? {})) {
					for (const repo of queryScope(query).repos) repos.add(repo);
				}
			}
		}
		// And wherever results came from, so searches across owners refresh too.
		for (const entry of this.entries.values()) {
			if (entry.result?.kind !== "search" || !this.inUse(entry)) continue;
			for (const card of entry.result.items) repos.add(`${card.host}/${card.repo}`.toLowerCase());
		}
		if (repos.size > 0) this.host.watchRepos([...repos]);
	}
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function unavailable(): QueryError {
	return { kind: "error", reason: "error", message: "No results yet." };
}
