import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { type BoardMessage, type Role, canEdit } from "../shared/boards.ts";
import type { BoardRequest, Card, CardMessage, MissingCard } from "../shared/cards.ts";
import type { AuditEntry, PushResponse } from "../shared/push.ts";
import { parseRepoKey, repoKeyOf } from "../shared/refs.ts";
import { REPAIR_ORIGIN, repairBoard, repairCount } from "../shared/repair.ts";
import { cardRefs, shapesMap } from "../shared/shapes.ts";
import { type Policy, type VisitorKey, roleFor } from "./boards/access.ts";
import { boardThumbnail } from "./boards/thumbnail.ts";
import { watchCardRefs } from "./card-refs.ts";
import { forge, type MissingReason, type RepoIdentity } from "./forges/index.ts";
import { userToken } from "./identity.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";
import { PushEngine, type PushCommand, type PushTiming } from "./push/engine.ts";
import { repoObject, resolveRepo } from "./routing.ts";
import { loadSnapshot, storeSnapshot } from "./snapshots.ts";
import { isPublic, visibleCard } from "./visibility.ts";

/**
 * The Worker checks access before a connection reaches the board (see
 * `authorizeBoardConnection`) and passes who connected, and their role, in
 * this header. Clients can't set it: the Worker always replaces it.
 */
export const ACCESS_HEADER = "x-tack-access";

/** Who a live connection belongs to, and what they may do. */
export interface ConnectionAccess extends VisitorKey {
	role: Role;
}

/** WebSocket close code for a connection whose access was taken away. */
export const ACCESS_REVOKED = 4403;

// Durable Object storage rows max out at 2 MB, so snapshots are chunked.
const CHUNK_SIZE = 512 * 1024;

/** Subscription syncs wait for card changes to settle, but not for long. */
const SYNC_WAIT_MS = 150;
const SYNC_MAX_WAIT_MS = 1_000;
/** How long to believe a repository couldn't be found or reached. */
const UNRESOLVED_TTL_MS = { error: 15_000, other: 60_000 };
/** How long to wait after an edit before checking for dangling references. */
const REPAIR_DELAY_MS = 250;

/**
 * How long to believe a viewer can, or can't, read a private repository.
 * Losing access shows within `yes` (the periodic recheck), gaining it within
 * `no`, or at once on reconnecting or asking to check again.
 */
const ACCESS_TTL_MS = { yes: 5 * 60_000, no: 2 * 60_000, error: 15_000 };
/** A new connection reuses access checks younger than this, so reloads don't storm the forge. */
const RECONNECT_GRACE_MS = 5_000;
/** While anyone's connected: renew repository watches, and recheck access, this often. */
const HEARTBEAT_MS = 60_000;
/** Don't renew watches more often than this as people connect. */
const WATCH_THROTTLE_MS = 20_000;
/** How often a connection may ask for its access to be checked again. */
const RECHECK_THROTTLE_MS = 5_000;

type Entry = Card | MissingCard;

/** Per connection: who it is (a GitHub user id, or null if signed out), and its queue of card messages. */
interface Viewing {
	userId: number | null;
	/** Card messages to this connection go out in order, each after its access checks. */
	queue: Promise<void>;
	recheckedAt: number;
}

/**
 * One per board. Holds the Yjs document (layout and freeform content) and
 * relays live card data to clients as custom messages, outside the document.
 *
 * Card data comes from `Repo` objects, whose caches are shared across every
 * board and viewer, so it's filtered per connection here (#10): cards from
 * private repositories only reach viewers who can read them, checked with
 * their own token, and everyone else gets a `private` placeholder carrying
 * nothing but the key. Nothing else may send card data to clients: always
 * go through `send`. Titles and other card fields never belong in logs, or
 * in anything derived from the board (thumbnails, summaries), either.
 */
export class Board extends YServer<Env> {
	static override callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000 };

	private cards = new Map<string, Entry>();
	private subscribed = new Set<string>();
	/** Repository identities by repository key, so each is resolved once. */
	private routes = new Map<string, RepoIdentity>();
	/** Repositories that couldn't be resolved, and until when to believe it. */
	private unresolved = new Map<string, { reason: MissingReason; until: number }>();
	private syncing: Promise<void> | null = null;
	private resync = false;
	private retry: ReturnType<typeof setTimeout> | undefined;

	/** Connections by id: who's viewing. */
	private viewing = new Map<string, Viewing>();
	private connecting = 0;
	/** The latest signed-in viewer (a user id), whose token can read public repositories. */
	private reader: number | null = null;
	/** Access checks, by viewer and repository. */
	private access = new Map<string, { readable: boolean; checkedAt: number; until: number }>();
	private checking = new Map<string, Promise<boolean>>();
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private watchedAt = 0;

	/** Pushes staged changes to forges (M2). Ready once the document has loaded. */
	private pushes: PushEngine | null = null;

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return super.fetch(request);
		}
		// Know who's connecting before the server starts, so its first fetches
		// can use their token.
		this.noteReader(readAccess(request)?.userId ?? null);
		this.connecting++;
		try {
			return await super.fetch(request);
		} finally {
			this.connecting--;
		}
	}

	override async onStart(): Promise<void> {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS snapshot (seq INTEGER PRIMARY KEY, chunk BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS repo_routes (repo_key TEXT PRIMARY KEY, identity TEXT NOT NULL);
		`);
		for (const row of this.ctx.storage.sql.exec<{ repo_key: string; identity: string }>(
			"SELECT repo_key, identity FROM repo_routes",
		)) {
			this.routes.set(row.repo_key, JSON.parse(row.identity) as RepoIdentity);
		}
		await super.onStart();
		this.pushes = new PushEngine({
			name: this.name,
			env: this.env,
			doc: this.document,
			sql: this.ctx.storage.sql,
			route: (repoKey) => this.route(repoKey),
			watch: () => void this.syncSubscriptions(),
			persist: () => {
				try {
					this.writeSnapshot();
				} catch {
					// Logged as board.save.failed; the debounced save tries again.
				}
			},
			alarmAt: async (at) => {
				const current = await this.ctx.storage.getAlarm();
				// An alarm in the past is the one running now (or about to).
				if (current === null || at < current || current <= Date.now()) {
					await this.ctx.storage.setAlarm(at);
				}
			},
		});
		await this.pushes.init();
		watchCardRefs(this.document, () => void this.syncSubscriptions(), {
			wait: SYNC_WAIT_MS,
			maxWait: SYNC_MAX_WAIT_MS,
		});
		this.watchForRepairs();
		await this.syncSubscriptions();
	}

	// Snapshot images for backlinks (see snapshots.ts). These only touch their
	// own table, so serving an image never loads the board's document.

	/** Keep a snapshot image; returns its public id, unless the board's allowance is used up. */
	async saveSnapshot(png: ArrayBuffer): Promise<{ ok: true; id: string } | { ok: false }> {
		const id = storeSnapshot(this.ctx.storage, this.ctx.id.toString(), png);
		return id ? { ok: true, id } : { ok: false };
	}

	/** A snapshot image, by the random part of its id. */
	async snapshotImage(token: string): Promise<ArrayBuffer | null> {
		return loadSnapshot(this.ctx.storage, token);
	}

	private repairTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Fix references left dangling by concurrent edits (see shared/repair.ts):
	 * once on load, then shortly after any edit that adds or deletes a shape
	 * or changes a reference, batching bursts of edits into one pass.
	 */
	private watchForRepairs(): void {
		const shapes = shapesMap(this.document);
		shapes.observeDeep((events, transaction) => {
			if (transaction.origin === REPAIR_ORIGIN) return;
			const relevant = events.some(
				(event) =>
					event.target === shapes ||
					[...event.changes.keys.keys()].some(
						(key) => key === "parent" || key === "from" || key === "to",
					),
			);
			if (relevant) this.scheduleRepair();
		});
		this.repair();
	}

	private scheduleRepair(): void {
		clearTimeout(this.repairTimer);
		this.repairTimer = setTimeout(() => this.repair(), REPAIR_DELAY_MS);
	}

	private repair(): void {
		const result = repairBoard(this.document);
		const fixed = repairCount(result);
		if (fixed > 0) log.info("board.repaired", { board: this.name, ...result });
	}

	override async onLoad(): Promise<Y.Doc | void> {
		const rows = this.ctx.storage.sql
			.exec<{ chunk: ArrayBuffer }>("SELECT chunk FROM snapshot ORDER BY seq")
			.toArray();
		if (rows.length === 0) {
			log.info("board.load", { board: this.name, bytes: 0, chunks: 0 });
			return;
		}
		const total = rows.reduce((n, row) => n + row.chunk.byteLength, 0);
		log.info("board.load", { board: this.name, bytes: total, chunks: rows.length });
		const update = new Uint8Array(total);
		let offset = 0;
		for (const row of rows) {
			update.set(new Uint8Array(row.chunk), offset);
			offset += row.chunk.byteLength;
		}
		const doc = new Y.Doc();
		Y.applyUpdate(doc, update);
		return doc;
	}

	override async onSave(): Promise<void> {
		this.writeSnapshot();
		await this.updateIndex();
	}

	/** Write the document to storage now. */
	private writeSnapshot(): void {
		// Re-encoding the full state compacts the update history each save.
		const update = Y.encodeStateAsUpdate(this.document);
		const context = {
			board: this.name,
			bytes: update.byteLength,
			chunks: Math.ceil(update.byteLength / CHUNK_SIZE),
		};
		try {
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.sql.exec("DELETE FROM snapshot");
				for (let i = 0; i * CHUNK_SIZE < update.byteLength; i++) {
					this.ctx.storage.sql.exec(
						"INSERT INTO snapshot (seq, chunk) VALUES (?, ?)",
						i,
						update.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
					);
				}
			});
		} catch (error) {
			log.error("board.save.failed", { ...context, error });
			throw error;
		}
		log.info("board.save", context);
	}

	/**
	 * Keep the board's thumbnail and last activity current on the home page.
	 * The thumbnail is shapes and colours only, never card data, and only
	 * public cards lend it their state's colour: anyone who can see the board
	 * in the index sees it, whatever repositories they can read.
	 */
	private async updateIndex(): Promise<void> {
		try {
			const thumbnail = boardThumbnail(this.document, (ref) => {
				const card = this.cards.get(ref);
				return card && isPublic(card) && !("missing" in card) ? card.state : "";
			});
			await directory(this.env).saved(this.name, thumbnail);
		} catch (error) {
			log.error("board.index.failed", { board: this.name, error });
		}
	}

	override onConnect(connection: Connection<ConnectionAccess>, ctx: ConnectionContext): void {
		const access = readAccess(ctx.request);
		if (!access) {
			connection.close(ACCESS_REVOKED, "forbidden");
			return;
		}
		connection.setState(access);
		void super.onConnect(connection, ctx);
		this.viewing.set(connection.id, {
			userId: access.userId,
			queue: Promise.resolve(),
			recheckedAt: 0,
		});
		this.noteReader(access.userId);
		this.startHeartbeat();
		// A reconnect re-checks access, unless it was checked moments ago.
		if (this.cards.size > 0) {
			this.send(connection, [...this.cards.values()], { maxAge: RECONNECT_GRACE_MS });
		}
		this.watchRepos();
	}

	/** Viewers (and the public) can watch and be seen, but not change the document. */
	override isReadOnly(connection: Connection<ConnectionAccess>): boolean {
		return !canEdit(connection.state?.role ?? null);
	}

	/**
	 * Called by the Directory when a board's members or visibility change:
	 * live connections pick up their new role straight away, and anyone who
	 * lost access is disconnected. (Board roles never grant access to repo
	 * data: that's checked per repository, whatever the role.)
	 */
	accessChanged(policy: Policy): void {
		for (const connection of this.getConnections<ConnectionAccess>()) {
			const access = connection.state;
			if (!access) continue;
			const role = roleFor(policy, access);
			if (!role) {
				connection.close(ACCESS_REVOKED, "access_revoked");
			} else if (role !== access.role) {
				connection.setState({ ...access, role });
				this.sendCustomMessage(
					connection,
					JSON.stringify({ type: "access", role } satisfies BoardMessage),
				);
			}
		}
	}

	/** Called by the Directory when the board is renamed, so everyone's title updates. */
	renamed(title: string, slug: string): void {
		this.broadcastCustomMessage(
			JSON.stringify({ type: "renamed", title, slug } satisfies BoardMessage),
		);
	}

	/** Signed-in viewers (not dev sign-in users, who have no token) can lend theirs for reads. */
	private noteReader(userId: number | null): void {
		if (userId !== null && userId > 0) this.reader = userId;
	}

	override onClose(
		connection: Connection,
		code: number,
		reason: string,
		wasClean: boolean,
	): void | Promise<void> {
		this.viewing.delete(connection.id);
		if (this.viewing.size === 0) this.stopHeartbeat();
		return super.onClose(connection, code, reason, wasClean);
	}

	override onCustomMessage(connection: Connection, message: string): void {
		let request: BoardRequest | null = null;
		try {
			request = JSON.parse(message) as BoardRequest;
		} catch {
			return;
		}
		if (request?.type !== "recheck") return;
		const viewing = this.viewing.get(connection.id);
		const now = Date.now();
		if (!viewing || now - viewing.recheckedAt < RECHECK_THROTTLE_MS) return;
		viewing.recheckedAt = now;
		// Check every private repository again now, and resend what changed.
		const cards = [...this.cards.values()].filter((entry) => !isPublic(entry));
		if (cards.length > 0) this.send(connection, cards, { maxAge: 0 });
	}

	override onError(connection: Connection, error: unknown): void {
		log.error("board.connection.error", { board: this.name, connection: connection.id, error });
	}

	override onException(error: unknown): void {
		log.error("board.exception", { board: this.name, error });
	}

	/** Called by Repo when subscribed cards change. */
	async cardsUpdated(cards: Entry[]): Promise<void> {
		this.publish(cards.filter((card) => this.subscribed.has(card.key)));
	}

	/** Called by Repo when a subscribed card changes. */
	async cardUpdated(card: Card): Promise<void> {
		await this.cardsUpdated([card]);
	}

	/**
	 * Called by `Instance` when the app is installed on (or removed from) a
	 * repository this board couldn't read, so its cards appear without a reload.
	 */
	async repoInstallChanged(repoKey: string): Promise<void> {
		log.info("board.installation", { board: this.name, repo: repoKey });
		for (const key of this.unresolved.keys()) {
			if (key.toLowerCase() === repoKey.toLowerCase()) {
				this.unresolved.delete(key);
				await this.installedOn(key, { fresh: true });
			}
		}
		await this.syncSubscriptions();
	}

	// --- Pushing (M2) --------------------------------------------------------------

	/**
	 * Push staged changes, as checked by the Worker (`POST /api/boards/:id/push`):
	 * `by` is signed in and may edit the board. See `push/engine.ts`.
	 */
	async push(command: PushCommand): Promise<PushResponse> {
		return this.pushEngine().push(command);
	}

	/** The board's audit log of pushes, newest first. */
	pushLog(): AuditEntry[] {
		return this.pushEngine().audit();
	}

	/** For tests: shorten the push engine's pauses. */
	async pushTiming(timing: Partial<PushTiming>): Promise<void> {
		this.pushEngine().setTiming(timing);
	}

	/** For tests: run whatever pushes are due now, and wait for them. */
	async runPushes(): Promise<void> {
		await this.pushEngine().run();
	}

	override async onAlarm(): Promise<void> {
		await this.pushEngine().run();
	}

	private pushEngine(): PushEngine {
		if (!this.pushes) throw new Error("Board not started");
		return this.pushes;
	}

	/** Snapshot size in bytes, for measuring growth. */
	snapshotSize(): number {
		return Y.encodeStateAsUpdate(this.document).byteLength;
	}

	/**
	 * Cards this board is holding, unfiltered, for tests and debugging over
	 * RPC only. Never expose this over HTTP: it includes private cards.
	 */
	liveCards(): Entry[] {
		return [...this.cards.values()];
	}

	/**
	 * Subscribe to cards added to the document and unsubscribe from removed
	 * ones. Runs once at a time; changes made meanwhile get one more pass.
	 */
	private async syncSubscriptions(): Promise<void> {
		if (this.syncing) {
			this.resync = true;
			return this.syncing;
		}
		this.syncing = (async () => {
			do {
				this.resync = false;
				await this.syncOnce();
			} while (this.resync);
		})()
			.catch((error: unknown) =>
				log.error("board.subscriptions.failed", { board: this.name, error }),
			)
			.finally(() => {
				this.syncing = null;
			});
		return this.syncing;
	}

	private async syncOnce(): Promise<void> {
		const refs = cardRefs(this.document);
		// Items with pushed changes waiting to be confirmed, whether or not they're on the board.
		for (const key of this.pushes?.watchKeys() ?? []) refs.add(key);
		for (const key of this.cards.keys()) if (!refs.has(key)) this.cards.delete(key);
		const added = [...refs].filter((key) => !this.subscribed.has(key));
		const removed = [...this.subscribed].filter((key) => !refs.has(key));
		for (const key of removed) this.subscribed.delete(key);
		if (added.length === 0 && removed.length === 0) return;

		await Promise.all([
			...Object.entries(groupByRepo(removed)).map(async ([repoKey, keys]) => {
				const repo = this.routes.get(repoKey);
				if (repo) await repoObject(this.env, repo).unsubscribe(this.name, keys);
			}),
			...Object.entries(groupByRepo(added)).map(([repoKey, keys]) =>
				this.subscribeTo(repoKey, keys),
			),
		]);
	}

	private async subscribeTo(repoKey: string, keys: string[]): Promise<void> {
		const repo = await this.route(repoKey);
		if (typeof repo === "string") {
			// Not subscribed, so the next sync tries again (see `route`).
			const installed =
				repo === "not_found" || repo === "forbidden" ? await this.installedOn(repoKey) : undefined;
			const news = keys.filter((key) => {
				const card = this.cards.get(key);
				return (
					!card || !("missing" in card) || card.reason !== repo || card.installed !== installed
				);
			});
			this.publish(
				news.map((key) => ({
					key,
					missing: true,
					reason: repo,
					...(installed === undefined ? {} : { installed }),
				})),
			);
			return;
		}
		for (const key of keys) this.subscribed.add(key);
		// Someone's looking (or arriving), so the repository is being watched.
		const watcher = this.hasAudience() ? { reader: this.reader } : undefined;
		const cards = await repoObject(this.env, repo).subscribe(this.name, keys, repo, watcher);
		this.publish(cards.filter((card) => this.subscribed.has(card.key)));
	}

	/**
	 * For a repository that couldn't be read: whether the app is installed on
	 * it. If it isn't, it may be private, so ask to hear when it is.
	 */
	private async installedOn(
		repoKey: string,
		options: { fresh?: boolean } = {},
	): Promise<boolean | undefined> {
		const parsed = parseRepoKey(repoKey);
		const adapter = parsed && forge(parsed.forge);
		if (!parsed || !adapter?.installed) return undefined;
		const name = parsed.repo.toLowerCase();
		const identity = { forge: parsed.forge, host: parsed.host, id: "", name };
		const installed = await adapter.installed(identity, this.env, options).catch(() => undefined);
		if (installed === false && adapter.watchInstallation) {
			await adapter
				.watchInstallation(name, this.env, { kind: "board", name: this.name })
				.catch((error: unknown) =>
					log.warn("board.installation.watch.failed", { board: this.name, error }),
				);
		}
		return installed;
	}

	/**
	 * The repository behind a repository key. Resolved once and kept, so a
	 * board keeps reaching a renamed repository by its old name.
	 */
	private async route(repoKey: string): Promise<RepoIdentity | MissingReason> {
		const known = this.routes.get(repoKey);
		if (known) return known;
		const failed = this.unresolved.get(repoKey);
		if (failed && failed.until > Date.now()) return failed.reason;

		const result = await resolveRepo(this.env, repoKey);
		if (typeof result === "string") {
			const ttl = result === "error" ? UNRESOLVED_TTL_MS.error : UNRESOLVED_TTL_MS.other;
			(result === "error" ? log.warn : log.info)("board.route.unresolved", {
				board: this.name,
				repo: repoKey,
				reason: result,
			});
			this.unresolved.set(repoKey, { reason: result, until: Date.now() + ttl });
			this.retryIn(ttl);
			return result;
		}
		this.unresolved.delete(repoKey);
		this.routes.set(repoKey, result);
		log.info("board.route.resolved", { board: this.name, repo: repoKey, id: result.id });
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO repo_routes (repo_key, identity) VALUES (?, ?)",
			repoKey,
			JSON.stringify(result),
		);
		return result;
	}

	private retryIn(ms: number): void {
		clearTimeout(this.retry);
		this.retry = setTimeout(() => void this.syncSubscriptions(), ms);
	}

	private publish(cards: Entry[]): void {
		if (cards.length === 0) return;
		for (const card of cards) this.cards.set(card.key, card);
		for (const connection of this.getConnections()) this.send(connection, cards);
		this.pushes?.cardsArrived(cards);
	}

	// --- Per-viewer filtering (#10) ------------------------------------------------

	/**
	 * Send cards to one connection, as its viewer may see them. Messages to a
	 * connection go out in order, each after the access checks it needs.
	 * `maxAge` makes access checks older than it count as stale.
	 */
	private send(connection: Connection, entries: Entry[], options: { maxAge?: number } = {}): void {
		const viewing = this.viewing.get(connection.id);
		// Not ready yet: it gets every card once it is (see onConnect).
		if (!viewing || entries.length === 0) return;
		viewing.queue = viewing.queue
			.then(async () => {
				const cards = await this.visibleTo(viewing.userId, entries, options.maxAge);
				this.sendCustomMessage(connection, encode({ type: "cards", cards }));
			})
			.catch((error: unknown) =>
				log.error("board.send.failed", { board: this.name, connection: connection.id, error }),
			);
	}

	/** Entries as a viewer may see them: private cards they can't read become placeholders. */
	private async visibleTo(
		userId: number | null,
		entries: Entry[],
		maxAge?: number,
	): Promise<Entry[]> {
		const repoKeys = new Set(
			entries.filter((entry) => !isPublic(entry)).map((entry) => repoKeyOf(entry.key)),
		);
		const readable = new Map(
			await Promise.all(
				[...repoKeys].map(
					async (repoKey) => [repoKey, await this.canRead(userId, repoKey, maxAge)] as const,
				),
			),
		);
		return entries.map((entry) => visibleCard(entry, readable.get(repoKeyOf(entry.key)) ?? false));
	}

	/**
	 * Whether a viewer can read a repository, checked with their own token and
	 * cached briefly. Anonymous viewers, and anyone without a token, can't.
	 * Any doubt (no route, a failed check) means no.
	 */
	private async canRead(userId: number | null, repoKey: string, maxAge?: number): Promise<boolean> {
		if (userId === null) return false;
		const repo = this.routes.get(repoKey);
		if (!repo) return false;
		const adapter = forge(repo.forge);
		if (!adapter.canRead) return true;
		const id = `${userId}:${repo.host}/${repo.id}`;
		const now = Date.now();
		const cached = this.access.get(id);
		if (cached && cached.until > now && (maxAge === undefined || now - cached.checkedAt < maxAge)) {
			return cached.readable;
		}
		let pending = this.checking.get(id);
		if (!pending) {
			const started = Date.now();
			pending = (async () => {
				const token = await userToken(this.env, userId);
				// Without their own token, nobody can show they may read it.
				return token ? adapter.canRead!(repo, token, this.env) : false;
			})()
				.then(
					(readable) => {
						this.access.set(id, {
							readable,
							checkedAt: started,
							until: started + (readable ? ACCESS_TTL_MS.yes : ACCESS_TTL_MS.no),
						});
						if (cached?.readable !== readable) {
							log.info("board.readable", {
								board: this.name,
								user: userId,
								repo: repo.name,
								readable,
							});
						}
						return readable;
					},
					(error: unknown) => {
						log.warn("board.readable.failed", {
							board: this.name,
							user: userId,
							repo: repo.name,
							error,
						});
						this.access.set(id, {
							readable: false,
							checkedAt: started,
							until: started + ACCESS_TTL_MS.error,
						});
						return false;
					},
				)
				.finally(() => this.checking.delete(id));
			this.checking.set(id, pending);
		}
		return pending;
	}

	/**
	 * Recheck access that has gone stale for everyone connected, and resend
	 * the cards of any repository whose answer changed.
	 */
	private async recheckAccess(): Promise<void> {
		const privateRepos = new Map<string, Entry[]>();
		for (const entry of this.cards.values()) {
			if (isPublic(entry)) continue;
			const repoKey = repoKeyOf(entry.key);
			let list = privateRepos.get(repoKey);
			if (!list) privateRepos.set(repoKey, (list = []));
			list.push(entry);
		}
		if (privateRepos.size === 0) return;
		const now = Date.now();
		for (const connection of this.getConnections()) {
			const viewing = this.viewing.get(connection.id);
			if (viewing?.userId == null) continue;
			for (const [repoKey, entries] of privateRepos) {
				const repo = this.routes.get(repoKey);
				if (!repo) continue;
				const before = this.access.get(`${viewing.userId}:${repo.host}/${repo.id}`);
				if (before && before.until > now) continue;
				const readable = await this.canRead(viewing.userId, repoKey);
				if (before?.readable !== readable) this.send(connection, entries);
			}
		}
	}

	// --- Watching repositories (#9) ------------------------------------------------

	private hasAudience(): boolean {
		return this.connecting > 0 || this.viewing.size > 0;
	}

	/**
	 * Tell each repository on the board that someone's looking, so ones that
	 * aren't live are fetched on view and polled while watched.
	 */
	private watchRepos(force = false): void {
		const now = Date.now();
		if (!force && now - this.watchedAt < WATCH_THROTTLE_MS) return;
		this.watchedAt = now;
		const repos = new Map<string, RepoIdentity>();
		for (const key of this.subscribed) {
			const repo = this.routes.get(repoKeyOf(key));
			if (repo) repos.set(`${repo.host}/${repo.id}`, repo);
		}
		if (repos.size === 0) return;
		const reader = this.reader;
		this.ctx.waitUntil(
			Promise.allSettled(
				[...repos.values()].map((repo) => repoObject(this.env, repo).watch(this.name, reader)),
			).then((results) => {
				const failed = results.filter((result) => result.status === "rejected").length;
				if (failed > 0) log.warn("board.watch.failed", { board: this.name, failed });
			}),
		);
	}

	private startHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			this.watchRepos(true);
			void this.recheckAccess().catch((error: unknown) =>
				log.error("board.readable.failed", { board: this.name, error }),
			);
		}, HEARTBEAT_MS);
	}

	private stopHeartbeat(): void {
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}
}

function readAccess(request: Request): ConnectionAccess | null {
	const header = request.headers.get(ACCESS_HEADER);
	if (!header) return null;
	try {
		return JSON.parse(header) as ConnectionAccess;
	} catch {
		return null;
	}
}

function encode(message: CardMessage): string {
	return JSON.stringify(message);
}

function groupByRepo(keys: string[]): Record<string, string[]> {
	const groups: Record<string, string[]> = {};
	for (const key of keys) (groups[repoKeyOf(key)] ??= []).push(key);
	return groups;
}
