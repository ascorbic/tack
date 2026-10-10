import { DurableObject } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { type Card, isMissing, type MissingCard } from "../shared/cards.ts";
import type { ItemMention } from "../shared/mentions.ts";
import { itemKey, itemOf, parseKey, repoKeyOf } from "../shared/refs.ts";
import type { RepoActivity } from "../shared/rules.ts";
import type { Board } from "./board.ts";
import {
	type Delivery,
	type FetchRef,
	forge,
	type ReadAuth,
	type RepoIdentity,
} from "./forges/index.ts";
import { userToken } from "./identity.ts";
import { type Logger, log } from "./log.ts";
import { boards } from "./namespaces.ts";

/** CI and review events for an item are coalesced for this long... */
const REFETCH_WAIT_MS = 2_000;
/** ...but never delayed by more than this, however busy CI is. */
const REFETCH_MAX_WAIT_MS = 8_000;
/** GitHub works out mergeability after a push, so unknown is worth asking again. */
const MERGEABLE_RETRY_MS = 5_000;
const MERGEABLE_RETRIES = 3;
/** How often a Repo that's in use reconciles its cards with the forge. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Delivery ids are kept this long for dedupe: GitHub redelivers for three days. */
const EVENT_RETENTION_MS = 3 * 24 * 60 * 60_000;
/**
 * A board's interest in a repository (someone has it open) lasts this long
 * unless renewed. Boards renew every minute while anyone's connected.
 */
const WATCH_LEASE_MS = 3 * 60_000;
/**
 * Repositories that aren't live are polled this often while watched. With
 * a token, a 304 costs no rate limit; anonymously, every poll counts against
 * a small hourly budget, so it's much slower.
 */
const POLL_INTERVAL_MS = { token: 60_000, anonymous: 5 * 60_000 };
/** When someone opens a board, poll at once if the last poll is older than this. */
const POLL_ON_VIEW_MS = { token: 15_000, anonymous: 60_000 };
/** How long to believe whether the app is installed, between notifications. */
const INSTALLED_TTL_MS = 10 * 60_000;
/** How long to reuse a viewer's token for reading, before asking for it again. */
const READER_TOKEN_TTL_MS = 60_000;

/** What a repository's cards say about where their data comes from (#9). */
export interface RepoStatus {
	live: boolean;
	writable: boolean;
	visibility: "public" | "private";
}

export type IngestResult =
	| { status: "duplicate" }
	| {
			status: "processed";
			/** Cards that changed, by canonical key. */
			updated: string[];
			/** Cards the delivery was older than, so ignored. */
			stale: string[];
			/** Boards notified. */
			boards: number;
			/** Watched items queued for a debounced refetch. */
			refetching: string[];
	  };

type Entry = Card | MissingCard;

/**
 * One per repository, keyed by its stable id (see `routing.ts`), on any
 * forge. Caches normalised cards, records which boards reference which
 * cards, keeps a log of webhook deliveries, and fans card updates out to
 * subscribed boards.
 *
 * Boards subscribe with whatever key their document uses, which may name
 * the repository as it was called before a rename. Cards are cached by item
 * (`#123`) and sent to each board under the key it subscribed with.
 */
export class Repo extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;
	/** When this instance last reconciled. Null until it has since waking. */
	private reconciledAt: number | null = null;
	private reconciling: Promise<unknown> | null = null;
	/** When this instance last polled (repositories that aren't live). Null since waking. */
	private polledAt: number | null = null;
	private polling: Promise<void> | null = null;
	/** Don't poll before this, after the forge pushed back (rate limits). */
	private pollRetryAt = 0;
	/** Someone looking at a board with this repository, whose token can read public data. */
	private reader: { userId: number; until: number } | null = null;
	private readerToken: { id: number; token: string | null; until: number } | null = null;
	/** Whether this instance has asked to hear about installation changes. */
	private watchingInstall = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			DROP TABLE IF EXISTS cards;
			DROP TABLE IF EXISTS subscriptions;
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS items (
				item TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				head TEXT
			);
			CREATE INDEX IF NOT EXISTS items_head ON items (head);
			CREATE TABLE IF NOT EXISTS subscribers (
				key TEXT NOT NULL,
				item TEXT NOT NULL,
				board TEXT NOT NULL,
				PRIMARY KEY (key, board)
			);
			CREATE INDEX IF NOT EXISTS subscribers_item ON subscribers (item);
			CREATE TABLE IF NOT EXISTS events (
				delivery_id TEXT PRIMARY KEY,
				event TEXT NOT NULL,
				action TEXT,
				payload TEXT NOT NULL,
				received_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
			CREATE TABLE IF NOT EXISTS refetch (
				item TEXT PRIMARY KEY,
				first_at INTEGER NOT NULL,
				due_at INTEGER NOT NULL,
				attempts INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS watchers (
				board TEXT PRIMARY KEY,
				until INTEGER NOT NULL
			);
		`);
	}

	/** The repository this object holds, once it has been told. */
	identity(): RepoIdentity | null {
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'identity'")
			.toArray()[0];
		return row ? (JSON.parse(row.value) as RepoIdentity) : null;
	}

	/**
	 * Register a board's interest in cards and return their current data.
	 * `repo` is the board's idea of the repository's identity, which only
	 * seeds an object that has none yet: the board's name for it may be old.
	 */
	async subscribe(
		board: string,
		keys: string[],
		repo?: RepoIdentity,
		watcher?: { reader: number | null },
	): Promise<Entry[]> {
		if (watcher) {
			// Someone's looking: this is the fetch on view, so no poll is due yet.
			this.lease(board, watcher.reader);
			this.polledAt ??= Date.now();
		}
		const known = this.identity();
		if (repo && !known) this.saveIdentity(repo);
		// Objects from before visibility was recorded learn it from the board.
		else if (repo && known && known.private === undefined && repo.private !== undefined) {
			if (repo.id === known.id) this.saveIdentity({ ...known, private: repo.private });
		}
		if (await this.checkStatus()) this.ctx.waitUntil(this.fanOutAll({ reason: "status" }));

		const results = new Map<string, Entry>();
		const misses: { key: string; ref: FetchRef }[] = [];
		let hits = 0;
		for (const key of keys) {
			const ref = parseKey(key);
			if (!ref) {
				results.set(key, { key, missing: true, reason: "unsupported" });
				continue;
			}
			this.sql.exec(
				"INSERT OR IGNORE INTO subscribers (key, item, board) VALUES (?, ?, ?)",
				key,
				ref.item,
				board,
			);
			const cached = this.cached(ref.item);
			if (cached) {
				results.set(key, cached);
				hits++;
			} else {
				misses.push({ key, ref });
			}
		}

		// Cached cards may have changed while nobody was looking.
		if (hits > 0) this.reconcileIfIdle();

		if (misses.length > 0) {
			const fetched = await this.fetchFresh(misses.map(({ ref }) => ref));
			const changed = this.apply([...fetched.values()]);
			for (const { key, ref } of misses) {
				const card = fetched.get(ref.item);
				if (card) results.set(key, card);
			}
			// A fetch can reveal a rename, which other boards need to hear about.
			const others = changed.filter(
				(card) => !misses.some(({ ref }) => ref.item === itemOfEntry(card)),
			);
			if (others.length > 0) await this.fanOut(others);
		}

		// Not live: poll while it's watched.
		if (watcher) await this.armAlarm();
		const status = this.status();
		return keys.map((key) =>
			this.present(results.get(key) ?? { key, missing: true, reason: "error" }, key, status),
		);
	}

	unsubscribe(board: string, keys: string[]): void {
		for (const key of keys) {
			this.sql.exec("DELETE FROM subscribers WHERE key = ? AND board = ?", key, board);
		}
	}

	/** The cached card for a key, under that key, whatever the repository is called now. */
	getCard(key: string): Card | null {
		const item = itemOf(key);
		const card = item ? this.cached(item) : null;
		return card ? this.present(card, key) : null;
	}

	/**
	 * Where this repository's data comes from: live (the app is installed,
	 * so webhooks arrive), writable, and whether it's public. Unknown
	 * visibility counts as private, so its cards only reach people who can
	 * read it.
	 */
	status(): RepoStatus {
		const identity = this.identity();
		if (!identity) return { live: false, writable: false, visibility: "private" };
		const adapter = forge(identity.forge);
		// Forges that can't say whether the app is installed are live (no webhooks to miss),
		// and writable if they can write at all: that's the fake forge, whose writes go
		// nowhere, so the whole push flow can be tried locally. GitHub needs the app.
		const installed = adapter.installed ? (this.installedState()?.installed ?? false) : true;
		return {
			live: installed,
			writable: installed && adapter.apply !== undefined,
			visibility: !adapter.canRead || identity.private === false ? "public" : "private",
		};
	}

	/**
	 * A board has this repository open (someone's connected), for the next
	 * few minutes. Repositories that aren't live are fetched on view and
	 * polled while watched, and never otherwise. `reader` is someone looking,
	 * whose own token reads public data with a better rate limit than none.
	 */
	async watch(board: string, reader: number | null = null): Promise<void> {
		this.lease(board, reader);
		if (await this.checkStatus()) this.ctx.waitUntil(this.fanOutAll({ reason: "status" }));
		if (this.status().live) return;
		if (this.pollDue(POLL_ON_VIEW_MS)) this.ctx.waitUntil(this.poll());
		await this.armAlarm();
	}

	/** Boards whose lease hasn't lapsed, for tests and debugging. */
	watchers(): string[] {
		return this.sql
			.exec<{ board: string }>("SELECT board FROM watchers WHERE until > ?", Date.now())
			.toArray()
			.map((row) => row.board);
	}

	/**
	 * The app was installed on this repository, or removed from it (called by
	 * `Instance`). Re-checks, and if it's now live, refetches every watched
	 * card with the installation's token (fuller data, and private items),
	 * then sends them all out so cards upgrade in place.
	 */
	async installationChanged(): Promise<RepoStatus> {
		const before = this.status();
		await this.checkStatus({ fresh: true });
		const after = this.status();
		this.logger().info("repo.installation", {
			live: after.live,
			changed: before.live !== after.live,
		});
		if (before.live === after.live && before.writable === after.writable) return after;
		const identity = this.identity();
		if (after.live && identity) {
			const items = this.watchedCards().map((card) => card.item);
			if (items.length > 0) {
				const refs = items.map((item) => ({
					forge: identity.forge,
					host: identity.host,
					repo: identity.name,
					item,
					nodeId: this.cached(item)?.nodeId,
				}));
				this.apply([...(await this.fetchFresh(refs)).values()]);
			}
		}
		await this.fanOutAll({ reason: "installation" });
		return after;
	}

	/** Poll now, if this repository isn't live and someone's watching, for tests and debugging. */
	async pollNow(): Promise<void> {
		if (!this.status().live && this.watched()) await this.poll();
	}

	subscribers(key: string): string[] {
		return this.sql
			.exec<{ board: string }>("SELECT board FROM subscribers WHERE key = ?", key)
			.toArray()
			.map((row) => row.board);
	}

	/** Items waiting for a debounced refetch, for tests and debugging. */
	pendingRefetches(): { item: string; dueAt: number; attempts: number }[] {
		return this.sql
			.exec<{ item: string; due_at: number; attempts: number }>(
				"SELECT item, due_at, attempts FROM refetch ORDER BY due_at",
			)
			.toArray()
			.map((row) => ({ item: row.item, dueAt: row.due_at, attempts: row.attempts }));
	}

	async ingest(delivery: Delivery): Promise<IngestResult> {
		const seen = this.sql
			.exec("SELECT 1 FROM events WHERE delivery_id = ?", delivery.id)
			.toArray().length;
		if (seen) {
			this.logger().info("repo.ingest", { delivery: delivery.id, status: "duplicate" });
			return { status: "duplicate" };
		}

		// Deliveries know the repository's current name.
		const renamed = this.noticeIdentity(delivery.repo);

		const fresh: Card[] = [];
		const stale: string[] = [];
		for (const card of delivery.cards) {
			const existing = this.cached(card.item);
			// Deliveries can arrive out of order: never let an older payload win.
			if (existing && existing.updatedAt > card.updatedAt) stale.push(card.key);
			else fresh.push(card);
		}
		const updated = this.apply(fresh);
		const refetching = await this.scheduleRefetch(delivery.refetch);

		const now = Date.now();
		this.sql.exec(
			"INSERT INTO events (delivery_id, event, action, payload, received_at) VALUES (?, ?, ?, ?, ?)",
			delivery.id,
			delivery.event,
			delivery.action,
			// Raw payloads only for item changes: CI events are many and large.
			delivery.cards.length > 0 ? delivery.payload : "",
			new Date(now).toISOString(),
		);
		this.sql.exec(
			"DELETE FROM events WHERE received_at < ?",
			new Date(now - EVENT_RETENTION_MS).toISOString(),
		);

		this.logger().info("repo.ingest", {
			delivery: delivery.id,
			event: delivery.event,
			action: delivery.action,
			status: "processed",
			updated: updated.length,
			stale: stale.length,
			refetching: refetching.length,
		});
		const notified = await this.fanOut(dedupe([...renamed, ...updated]), {
			delivery: delivery.id,
		});
		// Rules and inboxes hear about every item a delivery touched, on the board or not.
		await this.fanOutActivity(delivery, fresh);
		return {
			status: "processed",
			updated: updated.map(keyOf),
			stale,
			boards: notified,
			refetching,
		};
	}

	/**
	 * Check every watched card against the forge, in one batched query where
	 * the forge allows, and correct the ones that went stale.
	 */
	async reconcile(): Promise<{ checked: number; updated: string[] }> {
		const identity = this.identity();
		const adapter = identity && forge(identity.forge);
		this.reconciledAt = Date.now();
		if (!identity || !adapter?.reconcile) return { checked: 0, updated: [] };
		const cards = this.watchedCards();
		if (cards.length === 0) return { checked: 0, updated: [] };

		const started = Date.now();
		const changed = this.apply(
			await adapter.reconcile(identity, cards, this.env, await this.readAuth()),
		);
		this.logger().info("repo.reconcile", {
			checked: cards.length,
			updated: changed.length,
			ms: Date.now() - started,
		});
		await this.fanOut(changed, { reason: "reconcile" });
		return { checked: cards.length, updated: changed.map(keyOf) };
	}

	/** Debounced refetches: CI and review changes, coalesced per item. */
	override async alarm(): Promise<void> {
		const now = Date.now();
		const due = this.sql
			.exec<{ item: string; attempts: number }>(
				"SELECT item, attempts FROM refetch WHERE due_at <= ?",
				now,
			)
			.toArray();
		const identity = this.identity();
		if (due.length > 0 && identity) {
			const refs = due.map(({ item }) => ({
				forge: identity.forge,
				host: identity.host,
				repo: identity.name,
				item,
				nodeId: this.cached(item)?.nodeId,
			}));
			const fresh = await this.fetchFresh(refs);
			const changed = this.apply([...fresh.values()]);
			for (const { item } of due) {
				this.sql.exec("DELETE FROM refetch WHERE item = ? AND due_at <= ?", item, now);
			}
			// Mergeability is computed lazily after a push: ask again shortly.
			for (const { item, attempts } of due) {
				const card = fresh.get(item);
				if (
					card &&
					!isMissing(card) &&
					(card.state === "open" || card.state === "draft") &&
					card.pull?.detail === "full" &&
					card.pull.mergeable === "unknown" &&
					attempts < MERGEABLE_RETRIES
				) {
					this.queueRefetch(item, attempts + 1, MERGEABLE_RETRY_MS);
				}
			}
			this.logger().info("repo.refetch", {
				items: due.length,
				updated: changed.length,
				retrying: this.pendingRefetches().length,
			});
			await this.fanOut(changed, { reason: "refetch" });
		}
		// Not live, and someone's looking: poll, and reconcile now and then
		// (which, with a token, also catches CI changes).
		if (!this.status().live && this.watched() && this.pollDue(POLL_INTERVAL_MS)) {
			await this.poll();
			this.reconcileIfIdle();
		}
		await this.armAlarm();
	}

	// --- Internals ---------------------------------------------------------------

	private logger(): Logger {
		return log.with({ repo: this.identity()?.name, repoObject: this.ctx.id.name });
	}

	private lease(board: string, reader: number | null): void {
		const now = Date.now();
		this.sql.exec(
			"INSERT OR REPLACE INTO watchers (board, until) VALUES (?, ?)",
			board,
			now + WATCH_LEASE_MS,
		);
		this.sql.exec("DELETE FROM watchers WHERE until < ?", now - WATCH_LEASE_MS);
		if (reader !== null && reader > 0)
			this.reader = { userId: reader, until: now + WATCH_LEASE_MS };
	}

	/** An entry as a board sees it: under the board's key, with the repository's status. */
	private present<T extends Entry>(entry: T, key: string, status = this.status()): T {
		const keyed = withKey(entry, key);
		return isMissing(keyed) ? keyed : { ...keyed, ...status };
	}

	private installedState(): { installed: boolean; checkedAt: number } | null {
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'installed'")
			.toArray()[0];
		return row ? (JSON.parse(row.value) as { installed: boolean; checkedAt: number }) : null;
	}

	/**
	 * Make sure the status is current: whether the app is installed (asked
	 * at most every ten minutes, or now if `fresh`), and the repository's
	 * visibility if it isn't known. Also asks, once per wake, to hear about
	 * installation changes. Returns whether the status changed.
	 */
	private async checkStatus({ fresh = false } = {}): Promise<boolean> {
		const identity = this.identity();
		if (!identity) return false;
		const adapter = forge(identity.forge);
		const before = this.status();

		if (!this.watchingInstall && adapter.watchInstallation) {
			this.watchingInstall = true;
			this.ctx.waitUntil(
				adapter
					.watchInstallation(identity.name, this.env, {
						kind: "repo",
						name: this.ctx.id.name ?? "",
					})
					.catch((error: unknown) => {
						this.watchingInstall = false;
						this.logger().warn("repo.installation.watch.failed", { error });
					}),
			);
		}

		if (identity.private === undefined && adapter.canRead && adapter.resolveRepo) {
			const resolved = await adapter
				.resolveRepo(identity.host, identity.name, this.env)
				.catch(() => "error" as const);
			if (typeof resolved !== "string" && resolved.id === identity.id) {
				this.saveIdentity({ ...identity, private: resolved.private });
			}
		}

		if (adapter.installed) {
			const state = this.installedState();
			if (fresh || !state || Date.now() - state.checkedAt > INSTALLED_TTL_MS) {
				const installed = await adapter
					.installed(identity, this.env, { fresh })
					.catch(() => state?.installed ?? false);
				this.sql.exec(
					"INSERT OR REPLACE INTO meta (key, value) VALUES ('installed', ?)",
					JSON.stringify({ installed, checkedAt: Date.now() }),
				);
			}
		}

		const after = this.status();
		return (
			before.live !== after.live ||
			before.writable !== after.writable ||
			before.visibility !== after.visibility
		);
	}

	/** Whether any board has this repository open right now. */
	private watched(): boolean {
		return (
			this.sql.exec("SELECT 1 FROM watchers WHERE until > ? LIMIT 1", Date.now()).toArray().length >
			0
		);
	}

	/** Cached cards some board is subscribed to. */
	private watchedCards(): Card[] {
		return this.sql
			.exec<{ data: string }>(
				"SELECT data FROM items WHERE item IN (SELECT DISTINCT item FROM subscribers)",
			)
			.toArray()
			.map((row) => JSON.parse(row.data) as Card);
	}

	/** Send every watched card out again, e.g. because the repository's status changed. */
	private async fanOutAll(context: Record<string, unknown>): Promise<number> {
		return this.fanOut(this.watchedCards(), context);
	}

	/** Whether there's someone whose token can be used to read. */
	private hasReader(): boolean {
		return Boolean(this.env.GITHUB_TOKEN) || (this.reader?.until ?? 0) > Date.now();
	}

	private pollDue(intervals: { token: number; anonymous: number }): boolean {
		const now = Date.now();
		if (now < this.pollRetryAt) return false;
		const interval = this.hasReader() ? intervals.token : intervals.anonymous;
		return this.polledAt === null || now - this.polledAt >= interval;
	}

	/** When the next poll is due, if this repository should be polled at all. */
	private nextPollAt(): number | null {
		if (this.status().live || !this.watched()) return null;
		const interval = this.hasReader() ? POLL_INTERVAL_MS.token : POLL_INTERVAL_MS.anonymous;
		return Math.max((this.polledAt ?? 0) + interval, this.pollRetryAt, Date.now());
	}

	/**
	 * Ask the forge whether anything changed, in one conditional request,
	 * and fan out the cards that did. One poll at a time.
	 */
	private poll(): Promise<void> {
		this.polling ??= this.pollOnce()
			.catch((error: unknown) => this.logger().error("repo.poll.failed", { error }))
			.finally(() => {
				this.polling = null;
			});
		return this.polling;
	}

	private async pollOnce(): Promise<void> {
		const identity = this.identity();
		const adapter = identity && forge(identity.forge);
		this.polledAt = Date.now();
		if (!identity || !adapter?.poll) return;
		const cards = this.watchedCards();
		if (cards.length === 0) return;

		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'poll'")
			.toArray()[0];
		const state = row
			? (JSON.parse(row.value) as { etag: string | null; since: string | null })
			: { etag: null, since: null };
		const started = Date.now();
		const result = await adapter.poll(identity, cards, this.env, {
			...(await this.readAuth()),
			...state,
		});
		if (result.status === "error") {
			if (result.retryAt) this.pollRetryAt = result.retryAt;
			this.logger().warn("repo.poll", { status: "error", retryAt: result.retryAt ?? null });
			return;
		}
		if (result.status === "unchanged") {
			this.logger().info("repo.poll", { status: "unchanged", ms: Date.now() - started });
			return;
		}
		this.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('poll', ?)",
			JSON.stringify({ etag: result.etag, since: new Date(started).toISOString() }),
		);
		const changed = this.apply(result.cards);
		this.logger().info("repo.poll", {
			status: "changed",
			checked: cards.length,
			updated: changed.length,
			ms: Date.now() - started,
		});
		await this.fanOut(changed, { reason: "poll" });
	}

	/**
	 * A watching viewer's own token, to read with where there's no
	 * installation (the forge adapter prefers an installation's token).
	 */
	private async readAuth(): Promise<ReadAuth> {
		const reader = this.reader;
		if (!reader || reader.until <= Date.now()) return {};
		const cached = this.readerToken;
		if (cached && cached.id === reader.userId && cached.until > Date.now()) {
			return { token: cached.token };
		}
		const token = await userToken(this.env, reader.userId).catch(() => null);
		this.readerToken = { id: reader.userId, token, until: Date.now() + READER_TOKEN_TTL_MS };
		return { token };
	}

	private cached(item: string): Card | null {
		const row = this.sql
			.exec<{ data: string }>("SELECT data FROM items WHERE item = ?", item)
			.toArray()[0];
		return row ? (JSON.parse(row.data) as Card) : null;
	}

	private store(card: Card): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO items (item, data, head) VALUES (?, ?, ?)",
			card.item,
			JSON.stringify(card),
			card.pull?.head ?? null,
		);
	}

	private saveIdentity(repo: RepoIdentity): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('identity', ?)",
			JSON.stringify(repo),
		);
	}

	/**
	 * Record what the forge says the repository is called now. A new name
	 * means it was renamed or transferred: cached cards take the new name,
	 * and the changed cards are returned to fan out. Their URLs are refreshed
	 * by a refetch (the forge redirects old ones meanwhile).
	 */
	private noticeIdentity(repo: Pick<RepoIdentity, "name"> & Partial<RepoIdentity>): Card[] {
		const current = this.identity();
		if (!current) {
			if (repo.forge && repo.host && repo.id) this.saveIdentity(repo as RepoIdentity);
			return [];
		}
		const next = {
			...current,
			...repo,
			nodeId: repo.nodeId ?? current.nodeId,
			private: repo.private ?? current.private,
		};
		if (
			next.name === current.name &&
			next.nodeId === current.nodeId &&
			next.private === current.private
		) {
			return [];
		}
		this.saveIdentity(next);
		// Made public or private: every card goes out again, so boards filter
		// them for each viewer afresh.
		const resend = next.private !== current.private ? this.watchedCards() : [];
		if (next.private !== current.private) {
			this.logger().info("repo.visibility", { private: next.private ?? null });
		}
		if (next.name === current.name) return resend;
		this.logger().info("repo.renamed", { from: current.name, to: next.name, id: next.id });
		// Installation watches are by name.
		this.watchingInstall = false;

		const renamed: Card[] = [];
		for (const row of this.sql.exec<{ data: string }>("SELECT data FROM items").toArray()) {
			const card = JSON.parse(row.data) as Card;
			const moved = {
				...card,
				repo: next.name,
				key: itemKey({ host: card.host, repo: next.name, item: card.item }),
			};
			this.store(moved);
			renamed.push(moved);
		}
		void this.scheduleRefetch({ items: renamed.map((card) => card.item), commits: [] });
		return renamed;
	}

	/** Store fresh results, returning the ones that changed anything. */
	private apply(entries: Entry[]): Entry[] {
		const changed: Entry[] = [];
		for (const entry of entries) {
			if (isMissing(entry)) {
				// A failed fetch says nothing: keep what we have.
				if (entry.reason === "error") continue;
				const item = itemOf(entry.key);
				if (item && this.cached(item)) {
					this.sql.exec("DELETE FROM items WHERE item = ?", item);
					changed.push(entry);
				}
				continue;
			}
			if (entry.repo !== this.identity()?.name)
				changed.push(...this.noticeIdentity({ name: entry.repo }));
			const existing = this.cached(entry.item);
			// A fetch that raced a newer webhook mustn't undo it.
			if (existing && existing.updatedAt > entry.updatedAt) continue;
			const card = existing ? keepDetails(existing, entry) : entry;
			if (existing && JSON.stringify(existing) === JSON.stringify(card)) continue;
			this.store(card);
			changed.push(card);
		}
		return dedupe(changed);
	}

	private async fetchFresh(refs: FetchRef[]): Promise<Map<string, Entry>> {
		const identity = this.identity();
		const first = refs[0];
		if (!first) return new Map();
		const adapter = forge(identity?.forge ?? first.forge);
		const results = await adapter.fetchItems(
			refs,
			this.env,
			identity ?? undefined,
			await this.readAuth(),
		);
		const unavailable = results.filter(isMissing);
		const errors = unavailable.filter((card) => card.reason === "error").length;
		(errors > 0 ? this.logger().warn : this.logger().info)("repo.fetch", {
			requested: refs.length,
			missing: unavailable.length,
			errors,
		});
		return new Map(refs.map((ref, i) => [ref.item, results[i] ?? missing(ref, "error")]));
	}

	private reconcileIfIdle(): void {
		const now = Date.now();
		if (this.reconciling) return;
		if (this.reconciledAt !== null && now - this.reconciledAt < RECONCILE_INTERVAL_MS) return;
		this.reconciledAt = now;
		this.reconciling = this.reconcile()
			.catch((error: unknown) => this.logger().error("repo.reconcile.failed", { error }))
			.finally(() => {
				this.reconciling = null;
			});
		this.ctx.waitUntil(this.reconciling);
	}

	/** Queue watched items whose CI or reviews changed, returning them. */
	private async scheduleRefetch(refetch: Delivery["refetch"]): Promise<string[]> {
		if (!refetch) return [];
		const items = new Set(refetch.items);
		for (const commit of refetch.commits) {
			for (const row of this.sql.exec<{ item: string }>(
				"SELECT item FROM items WHERE head = ?",
				commit,
			)) {
				items.add(row.item);
			}
		}
		// Nobody's looking at the rest, and they'll be reconciled when someone does.
		const watched = [...items].filter(
			(item) =>
				this.sql.exec("SELECT 1 FROM subscribers WHERE item = ? LIMIT 1", item).toArray().length,
		);
		for (const item of watched) this.queueRefetch(item, 0, REFETCH_WAIT_MS);
		await this.armAlarm();
		return watched;
	}

	/** Trailing debounce per item, with a maximum wait from the first event. */
	private queueRefetch(item: string, attempts: number, delay: number): void {
		const now = Date.now();
		const first =
			this.sql
				.exec<{ first_at: number }>("SELECT first_at FROM refetch WHERE item = ?", item)
				.toArray()[0]?.first_at ?? now;
		this.sql.exec(
			"INSERT OR REPLACE INTO refetch (item, first_at, due_at, attempts) VALUES (?, ?, ?, ?)",
			item,
			first,
			Math.min(first + REFETCH_MAX_WAIT_MS, now + delay),
			attempts,
		);
	}

	private async armAlarm(): Promise<void> {
		const refetch = this.sql
			.exec<{ due: number | null }>("SELECT MIN(due_at) AS due FROM refetch")
			.toArray()[0]?.due;
		const poll = this.nextPollAt();
		const next = refetch == null ? poll : poll == null ? refetch : Math.min(refetch, poll);
		if (next == null) return;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || next < current) await this.ctx.storage.setAlarm(next);
	}

	/**
	 * Tell every board with this repository on it (subscribed to any of its
	 * items, or watching it for an inbox) what a delivery changed, for its
	 * rules and inboxes (#44, #40). Cards and same-repository mentions go
	 * under the keys each board uses.
	 */
	private async fanOutActivity(delivery: Delivery, cards: Card[]): Promise<number> {
		const identity = this.identity();
		if (cards.length === 0 || !identity) return 0;
		const boardNames = this.sql
			.exec<{ board: string }>(
				"SELECT DISTINCT board FROM subscribers UNION SELECT board FROM watchers WHERE until > ?",
				Date.now(),
			)
			.toArray()
			.map((row) => row.board);
		if (boardNames.length === 0) return 0;
		const status = this.status();
		const canonical = `${identity.host}/${identity.name}`;
		const results = await Promise.allSettled(
			boardNames.map(async (name) => {
				const keys = new Map(
					this.sql
						.exec<{ key: string; item: string }>(
							"SELECT key, item FROM subscribers WHERE board = ?",
							name,
						)
						.toArray()
						.map((row) => [row.item, row.key]),
				);
				const keyFor = (key: string) => {
					const item = itemOf(key);
					return (repoKeyOf(key) === canonical && item && keys.get(item)) || key;
				};
				const mentions: Record<string, ItemMention[]> = {};
				for (const [key, list] of Object.entries(delivery.mentions ?? {})) {
					mentions[keyFor(key)] = list.map((m) => ({ ...m, key: keyFor(m.key) }));
				}
				const [anyKey] = keys.values();
				const activity: RepoActivity = {
					delivery: delivery.id,
					event: delivery.event,
					action: delivery.action,
					repo: anyKey ? repoKeyOf(anyKey) : canonical,
					cards: cards.map((card) => this.present(card, keyFor(card.key), status)),
					mentions,
				};
				const board = await getServerByName<Env, Board>(boards(this.env), name);
				await board.repoActivity(activity);
			}),
		);
		const failed = results.filter((r) => r.status === "rejected");
		for (const result of failed) {
			this.logger().error("repo.activity.failed", {
				delivery: delivery.id,
				error: (result as PromiseRejectedResult).reason,
			});
		}
		this.logger().info("repo.activity", {
			delivery: delivery.id,
			boards: boardNames.length,
			failed: failed.length,
		});
		return boardNames.length;
	}

	/** Send changed cards to every board watching them, under each board's key. */
	private async fanOut(entries: Entry[], context: Record<string, unknown> = {}): Promise<number> {
		const byBoard = new Map<string, Entry[]>();
		const status = this.status();
		for (const entry of entries) {
			const rows = this.sql
				.exec<{ key: string; board: string }>(
					"SELECT key, board FROM subscribers WHERE item = ?",
					itemOfEntry(entry),
				)
				.toArray();
			for (const { key, board } of rows) {
				let list = byBoard.get(board);
				if (!list) byBoard.set(board, (list = []));
				list.push(this.present(entry, key, status));
			}
		}
		if (byBoard.size === 0) return 0;
		const results = await Promise.allSettled(
			[...byBoard].map(async ([name, cards]) => {
				try {
					const board = await getServerByName<Env, Board>(boards(this.env), name);
					await board.cardsUpdated(cards);
				} catch (error) {
					this.logger().error("repo.fanout.failed", {
						...context,
						board: name,
						cards: cards.length,
						error,
					});
					throw error;
				}
			}),
		);
		this.logger().info("repo.fanout", {
			...context,
			boards: byBoard.size,
			sent: results.filter((r) => r.status === "fulfilled").length,
			failed: results.filter((r) => r.status === "rejected").length,
		});
		return byBoard.size;
	}
}

function keyOf(entry: Entry): string {
	return entry.key;
}

function itemOfEntry(entry: Entry): string {
	return isMissing(entry) ? (itemOf(entry.key) ?? entry.key) : entry.item;
}

function missing(ref: FetchRef, reason: MissingCard["reason"]): MissingCard {
	return { key: itemKey(ref), missing: true, reason };
}

/** The same card under another key: a board's, which may use an old repository name. */
function withKey<T extends Entry>(entry: T, key: string): T {
	return entry.key === key ? entry : { ...entry, key };
}

/** The last entry for each item wins. */
function dedupe(entries: Entry[]): Entry[] {
	return [...new Map(entries.map((entry) => [itemOfEntry(entry), entry])).values()];
}

/**
 * Webhook payloads describe pull requests less fully than a full fetch (no
 * CI rollup, review decision or linked issues). Keep the fuller details
 * until the debounced refetch replaces them, rather than flickering.
 */
function keepDetails(existing: Card, incoming: Card): Card {
	let card =
		incoming.nodeId || !existing.nodeId ? incoming : { ...incoming, nodeId: existing.nodeId };
	// Webhooks count 👍 without saying who: keep who, from the last full fetch.
	if (incoming.thumbsUp && !incoming.thumbsUp.logins && existing.thumbsUp?.logins) {
		const logins = existing.thumbsUp.logins.slice(0, incoming.thumbsUp.count);
		card = { ...card, thumbsUp: { count: incoming.thumbsUp.count, logins } };
	}
	const before = existing.pull;
	const after = incoming.pull;
	if (!before || !after || after.detail !== "basic" || before.detail !== "full") return card;
	return {
		...card,
		pull: {
			...before,
			head: after.head ?? before.head,
			mergeable: after.mergeable === "unknown" ? before.mergeable : after.mergeable,
		},
	};
}
