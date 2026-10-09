import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { type BoardMessage, type Role, canEdit } from "../shared/boards.ts";
import { type Card, type CardMessage, type MissingCard, isMissing } from "../shared/cards.ts";
import { repoKeyOf } from "../shared/refs.ts";
import { REPAIR_ORIGIN, repairBoard } from "../shared/repair.ts";
import { cardRefs, shapesMap } from "../shared/shapes.ts";
import { type Policy, type VisitorKey, roleFor } from "./boards/access.ts";
import { boardThumbnail } from "./boards/thumbnail.ts";
import { watchCardRefs } from "./card-refs.ts";
import type { MissingReason, RepoIdentity } from "./forges/index.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";
import { repoObject, resolveRepo } from "./routing.ts";

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

type Entry = Card | MissingCard;

/**
 * One per board. Holds the Yjs document (layout and freeform content) and
 * relays live card data to clients as custom messages, outside the document.
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
		watchCardRefs(this.document, () => void this.syncSubscriptions(), {
			wait: SYNC_WAIT_MS,
			maxWait: SYNC_MAX_WAIT_MS,
		});
		this.watchForRepairs();
		await this.syncSubscriptions();
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
		const fixed = result.parents + result.ends + result.removed;
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
		await this.updateIndex();
	}

	/** Keep the board's thumbnail and last activity current on the home page. */
	private async updateIndex(): Promise<void> {
		try {
			const thumbnail = boardThumbnail(this.document, (ref) => {
				const card = this.cards.get(ref);
				return card && !isMissing(card) ? card.state : "";
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
		if (this.cards.size > 0) this.sendCards(connection, [...this.cards.values()]);
	}

	/** Viewers (and the public) can watch and be seen, but not change the document. */
	override isReadOnly(connection: Connection<ConnectionAccess>): boolean {
		return !canEdit(connection.state?.role ?? null);
	}

	/**
	 * Called by the Directory when a board's members or visibility change:
	 * live connections pick up their new role straight away, and anyone who
	 * lost access is disconnected.
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

	/** Snapshot size in bytes, for measuring growth. */
	snapshotSize(): number {
		return Y.encodeStateAsUpdate(this.document).byteLength;
	}

	/** Cards this board is showing, for tests and debugging. */
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
			const news = keys.filter((key) => {
				const card = this.cards.get(key);
				return !card || !("missing" in card) || card.reason !== repo;
			});
			this.publish(news.map((key) => ({ key, missing: true, reason: repo })));
			return;
		}
		for (const key of keys) this.subscribed.add(key);
		const cards = await repoObject(this.env, repo).subscribe(this.name, keys, repo);
		this.publish(cards.filter((card) => this.subscribed.has(card.key)));
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
		for (const connection of this.getConnections()) this.sendCards(connection, cards);
	}

	private sendCards(connection: Connection, cards: Entry[]): void {
		const visible = this.visibleCards(connection, cards);
		if (visible.length > 0) {
			this.sendCustomMessage(connection, encode({ type: "cards", cards: visible }));
		}
	}

	/**
	 * The hook for per-viewer filtering (#10): which of these cards this
	 * connection may see. Board roles never grant access to repo data, so
	 * cards from private repos must be checked against the viewer's own
	 * forge access here (and swapped for a "private reference" placeholder).
	 * `connection.state` says who they are. Until then, everyone who can
	 * open the board sees every card on it.
	 */
	private visibleCards(_connection: Connection, cards: Entry[]): Entry[] {
		return cards;
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
