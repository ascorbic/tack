import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { type BoardMessage, type Role, canEdit } from "../shared/boards.ts";
import {
	type CompactResult,
	type HistoryLimits,
	HistoryLog,
	type Timeline,
	encodeSegment,
} from "../shared/history.ts";
import type { BoardRequest, Card, CardMessage, MissingCard } from "../shared/cards.ts";
import type { AuditEntry, PushResponse } from "../shared/push.ts";
import {
	type CommentEvent,
	type CommentRequest,
	type CommentThread,
	isCommentRequest,
} from "../shared/comments.ts";
import {
	type CommandOrigin,
	type PlaceRequest,
	type PlaceResult,
	isCommandOrigin,
	placeCommandCard,
} from "../shared/commands.ts";
import { INBOX_ORIGIN, type InboxPreviewRequest } from "../shared/inbox.ts";
import { parseRepoKey, repoKeyOf } from "../shared/refs.ts";
import { RULE_ORIGIN, type RepoActivity } from "../shared/rules.ts";
import {
	type Actor,
	type Digest,
	type SinceEvent,
	type SinceRequest,
	isSinceRequest,
} from "../shared/since.ts";
import {
	type CarriedItem,
	type CarryResult,
	actionState,
	carryable,
	placeCarried,
} from "../shared/actionItems.ts";
import { REPAIR_ORIGIN, repairBoard, repairCount } from "../shared/repair.ts";
import {
	type Extracted,
	type InstantiateResult,
	type TemplateContent,
	extractTemplate,
	instantiateTemplate,
} from "../shared/templates.ts";
import { readShapes } from "../shared/structure.ts";
import { cardRefs, shapesMap } from "../shared/shapes.ts";
import type { WidgetRequest } from "../shared/widgets.ts";
import { type Policy, type VisitorKey, roleFor } from "./boards/access.ts";
import { boardThumbnail } from "../shared/thumbnail.ts";
import { watchCardRefs } from "./card-refs.ts";
import { forge, type MissingReason, type RepoIdentity } from "./forges/index.ts";
import { Facilitation } from "./facilitation.ts";
import { type Commenter, CommentsService } from "./comments.ts";
import { attributeOrigin, sqlHistoryStore } from "./history.ts";
import { userToken } from "./identity.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";
import { PUSH_ORIGIN, PushEngine, type PushCommand, type PushTiming } from "./push/engine.ts";
import { repoObject, resolveRepo } from "./routing.ts";
import { RulesEngine } from "./rules.ts";
import { CardHistory, ChangeLog, Visits } from "./since.ts";
import { loadSnapshot, storeSnapshot } from "./snapshots.ts";
import { realTime } from "./testClock.ts";
import { isPublic, visibleCard } from "./visibility.ts";
import { type RunnerTiming, WidgetRunner } from "./widgets/runner.ts";

/**
 * The Worker checks access before a connection reaches the board (see
 * `authorizeBoardConnection`) and passes who connected, and their role, in
 * this header. Clients can't set it: the Worker always replaces it.
 */
export const ACCESS_HEADER = "x-tack-access";

/** Who a live connection belongs to, and what they may do. */
export interface ConnectionAccess extends VisitorKey {
	role: Role;
	/** Their GitHub login, when signed in: what `@me` means in widget searches. */
	login?: string;
	/** Archived boards are read-only for everyone, comments included. */
	archived?: boolean;
	/** Signed-in people: who they are, for attributing comments and edits. */
	person?: { login: string; name: string | null; avatarUrl: string };
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
/** Comment requests a connection may make per window. */
const COMMENT_BUDGET = 60;
const COMMENT_WINDOW_MS = 10_000;
/** Threads go out in messages of about this size (WebSocket messages max out at 1 MiB). */
const COMMENT_CHUNK_BYTES = 256 * 1024;
/** A signed-out digest goes back at most this far. */
const SINCE_MAX_AGE_MS = 180 * 24 * 60 * 60_000;

/** Transaction origin for action items carried over from another board: never undoable. */
export const CARRY_ORIGIN = "carry";
/** Most action items carried over at once. */
const CARRY_MAX = 100;

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
	/** Runs the board's rules on webhook deliveries (#44). */
	private rules: RulesEngine | null = null;
	/**
	 * Runs widgets' and inbox frames' queries for the people watching them
	 * (#37, #40). Ready once the document has loaded.
	 */
	private widgets: WidgetRunner | null = null;
	/** When each repository was last asked to tell us about its webhooks, for widgets. */
	private queryWatches = new Map<string, number>();
	/** The timer, spotlight and silent mode (#50, #49). */
	private facilitation: Facilitation | null = null;
	/** Comment threads (#51). */
	private comments: CommentsService | null = null;
	/** Since you were here (#46): what changed, card history and visits. */
	private changeLog: ChangeLog | null = null;
	private cardHistory: CardHistory | null = null;
	private visits: Visits | null = null;
	/** Comment requests per connection in the current window, to stop floods. */
	private commentBudget = new Map<string, { count: number; until: number }>();
	/** The document kept over time, with who changed what (#47). */
	private history: HistoryLog | null = null;

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
		// Before anything else writes to the document, so every write is recorded.
		this.history = this.startHistory();
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
			wrote: (repos) => {
				for (const repo of repos) this.widgets?.repoChanged(repo);
			},
			alarmAt: async (at) => {
				const current = await this.ctx.storage.getAlarm();
				const real = realTime(at);
				// An alarm in the past is the one running now (or about to).
				if (current === null || real < current || current <= realTime(Date.now())) {
					await this.ctx.storage.setAlarm(real);
				}
			},
		});
		await this.pushes.init();
		this.rules = new RulesEngine({
			board: this.name,
			doc: this.document,
			sql: this.ctx.storage.sql,
			persist: () => {
				try {
					this.writeSnapshot();
				} catch {
					// Logged as board.save.failed; the debounced save tries again.
				}
			},
		});
		this.facilitation = new Facilitation({
			board: this.name,
			doc: this.document,
			sql: this.ctx.storage.sql,
			connections: () => this.getConnections<ConnectionAccess>(),
			connection: (id) => this.getConnection<ConnectionAccess>(id),
			send: (connection, message) => this.sendCustomMessage(connection, message),
			persist: () => {
				try {
					this.writeSnapshot();
				} catch {
					// Logged as board.save.failed; the debounced save tries again.
				}
			},
		});
		const sql = this.ctx.storage.sql;
		this.comments = new CommentsService({
			board: this.name,
			sql,
			transaction: (fn) => this.ctx.storage.transactionSync(fn),
			mentionable: () => directory(this.env).mentionable(this.name),
			notify: (notices) =>
				this.ctx.waitUntil(
					directory(this.env)
						.notify(this.name, notices)
						.catch((error: unknown) =>
							log.warn("comment.notify.failed", { board: this.name, error }),
						),
				),
			shapeAt: (id) => {
				const shape = shapesMap(this.document).get(id);
				const x = shape?.get("x");
				const y = shape?.get("y");
				return typeof x === "number" && typeof y === "number" ? { x, y } : null;
			},
		});
		this.changeLog = new ChangeLog({
			sql,
			doc: this.document,
			actorOf: (origin) => actorOf(origin),
			onMoved: (id, at) => {
				if (this.comments?.pinnedTo(id)) this.comments.shapeMoved(id, at);
			},
			onRemoved: (id) => {
				for (const event of this.comments?.shapeRemoved(id) ?? []) this.broadcastJSON(event);
			},
		});
		this.cardHistory = new CardHistory(sql);
		this.visits = new Visits(sql);
		watchCardRefs(this.document, () => void this.syncSubscriptions(), {
			wait: SYNC_WAIT_MS,
			maxWait: SYNC_MAX_WAIT_MS,
		});
		this.widgets = this.startWidgets();
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

	// --- History (M4, #47) ---------------------------------------------------------

	private startHistory(): HistoryLog | null {
		try {
			const history = new HistoryLog({
				doc: this.document,
				store: sqlHistoryStore(this.ctx.storage),
				attribute: (origin) => attributeOrigin(origin, this.document.awareness),
				log: (level, event, context) => log[level](event, { board: this.name, ...context }),
			});
			history.start();
			return history;
		} catch (error) {
			// The board works without history.
			log.error("history.failed", { board: this.name, during: "start", error });
			return null;
		}
	}

	private flushHistory(): void {
		try {
			this.history?.flush();
		} catch (error) {
			log.error("history.failed", { board: this.name, during: "flush", error });
		}
	}

	/** The board's history: every step, and who made them (`GET /api/boards/:id/history`). */
	historyTimeline(): Timeline | null {
		// Save with it, so history is never ahead of what's saved.
		if (this.history?.dirty) {
			try {
				this.writeSnapshot();
			} catch {
				// Logged as board.save.failed; the debounced save tries again.
			}
		}
		return this.history?.timeline() ?? null;
	}

	/** The segment of history holding `step`, as bytes (see `encodeSegment`). */
	historySegment(step: number): Uint8Array | null {
		const segment = this.history?.segment(step);
		return segment ? encodeSegment(segment) : null;
	}

	/** For tests: thin history out now, as if it were `now`. */
	async historyCompact(now?: number): Promise<CompactResult | null> {
		this.historyTimeline();
		return this.history?.compact(now) ?? null;
	}

	/** For tests: change history's limits (its budget, how often keyframes are written). */
	async historyLimits(limits: Partial<HistoryLimits>): Promise<void> {
		if (this.history) Object.assign(this.history.limits, limits);
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
		this.changeLog?.flush();
		this.writeSnapshot();
		await this.updateIndex();
	}

	/** Write the document to storage now. */
	private writeSnapshot(): void {
		// History first, so it's never behind what was saved (see `HistoryLog.start`).
		this.flushHistory();
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
		this.facilitation?.connected(connection);
		// Since you were here: a new visit, if they've been away a while.
		const visit = access.userId !== null ? (this.visits?.arrive(access.userId) ?? null) : null;
		this.sendComments(connection, visit?.firstAt ?? null);
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
			} else if (role !== access.role || policy.archived !== (access.archived ?? false)) {
				const changedRole = role !== access.role;
				const next = { ...access, role, archived: policy.archived };
				connection.setState(next);
				if (changedRole) {
					this.sendCustomMessage(
						connection,
						JSON.stringify({ type: "access", role } satisfies BoardMessage),
					);
				}
				// What they can do with comments may have changed too.
				if (this.comments) {
					const since =
						next.userId !== null ? (this.visits?.get(next.userId)?.firstAt ?? null) : null;
					this.sendJSON(connection, {
						type: "comments-you",
						you: this.comments.you(commenter(next), since),
					});
				}
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
		const leaving = this.viewing.get(connection.id);
		if (leaving?.userId != null) this.visits?.touch(leaving.userId);
		this.viewing.delete(connection.id);
		this.commentBudget.delete(connection.id);
		this.widgets?.disconnect(connection.id);
		this.facilitation?.closed(connection.id);
		if (this.viewing.size === 0) this.stopHeartbeat();
		return super.onClose(connection, code, reason, wasClean);
	}

	override onCustomMessage(connection: Connection, message: string): void {
		let request: BoardRequest | WidgetRequest | InboxPreviewRequest | null = null;
		try {
			request = JSON.parse(message) as BoardRequest | WidgetRequest | InboxPreviewRequest;
		} catch {
			return;
		}
		if (this.facilitation?.handles(request?.type)) {
			void this.facilitation.receive(connection as Connection<ConnectionAccess>, request as never);
			return;
		}
		// Widgets and inbox frames: viewers can watch them too, as watching
		// never changes the document.
		if (!this.viewing.has(connection.id)) return;
		// Comments and "since you were here": viewers can comment (see comments.ts).
		if (isCommentRequest(request)) {
			this.onCommentRequest(connection as Connection<ConnectionAccess>, request);
			return;
		}
		if (isSinceRequest(request)) {
			void this.onSinceRequest(connection as Connection<ConnectionAccess>, request);
			return;
		}
		if (this.widgets?.request(connection.id, request)) return;
		if (request?.type !== "recheck") return;
		const viewing = this.viewing.get(connection.id);
		const now = Date.now();
		if (!viewing || now - viewing.recheckedAt < RECHECK_THROTTLE_MS) return;
		viewing.recheckedAt = now;
		// Check every private repository again now, and resend what changed.
		const cards = [...this.cards.values()].filter((entry) => !isPublic(entry));
		if (cards.length > 0) this.send(connection, cards, { maxAge: 0 });
	}

	// --- Comments (#51) -----------------------------------------------------------

	/** Every thread, and what this connection can do, in chunks that fit a message. */
	private sendComments(connection: Connection<ConnectionAccess>, since: number | null): void {
		const comments = this.comments;
		const access = connection.state;
		if (!comments || !access) return;
		const you = comments.you(commenter(access), since);
		const threads = comments.all();
		let chunk: CommentThread[] = [];
		let bytes = 0;
		let first = true;
		const flush = () => {
			this.sendJSON(connection, { type: "comments", threads: chunk, you, first });
			first = false;
			chunk = [];
			bytes = 0;
		};
		for (const thread of threads) {
			const size = JSON.stringify(thread).length;
			if (chunk.length > 0 && bytes + size > COMMENT_CHUNK_BYTES) flush();
			chunk.push(thread);
			bytes += size;
		}
		if (chunk.length > 0 || first) flush();
	}

	private onCommentRequest(
		connection: Connection<ConnectionAccess>,
		request: CommentRequest,
	): void {
		const comments = this.comments;
		const access = connection.state;
		if (!comments || !access) return;
		const now = Date.now();
		const budget = this.commentBudget.get(connection.id);
		if (!budget || budget.until <= now) {
			this.commentBudget.set(connection.id, { count: 1, until: now + COMMENT_WINDOW_MS });
		} else if (++budget.count > COMMENT_BUDGET) {
			this.sendJSON(connection, {
				type: "comment-refused",
				request: request.type,
				thread: typeof request.thread === "string" ? request.thread : "",
				reason: "busy",
			});
			return;
		}
		void comments.handle(commenter(access), request).then((outcome) => {
			if (outcome.reply) this.sendJSON(connection, outcome.reply);
			if (outcome.broadcast) this.broadcastJSON(outcome.broadcast);
			if (outcome.reads && access.userId !== null) {
				// Read state is yours alone: only your own connections hear it.
				for (const other of this.getConnections<ConnectionAccess>()) {
					if (other.state?.userId === access.userId) {
						this.sendJSON(other, { type: "comment-reads", reads: outcome.reads });
					}
				}
			}
		});
	}

	/** For tests: every thread, as clients see them. */
	commentThreads(): CommentThread[] {
		return this.comments?.all() ?? [];
	}

	// --- Since you were here (#46) ---------------------------------------------------

	private async onSinceRequest(
		connection: Connection<ConnectionAccess>,
		request: SinceRequest,
	): Promise<void> {
		const access = connection.state;
		if (!access) return;
		const now = Date.now();
		let since: number | null;
		if (request.type === "since-seen") {
			since =
				access.userId !== null ? (this.visits?.seen(access.userId, now)?.baseline ?? now) : now;
		} else if (access.userId !== null) {
			since = this.visits?.get(access.userId)?.baseline ?? null;
		} else {
			// Signed out: the browser remembers the last visit.
			const asked = typeof request.since === "number" ? request.since : null;
			since = asked !== null && asked < now ? Math.max(asked, now - SINCE_MAX_AGE_MS) : null;
		}
		try {
			const digest = await this.digest(access, since, now);
			// Your other tabs start again from now too.
			const targets =
				request.type === "since-seen" && access.userId !== null
					? [...this.getConnections<ConnectionAccess>()].filter(
							(other) => other.state?.userId === access.userId,
						)
					: [connection];
			for (const target of targets) this.sendJSON(target, { type: "since", digest });
		} catch (error) {
			log.error("since.failed", { board: this.name, error });
		}
	}

	/** What changed since a time, as this viewer may see it. */
	private async digest(
		access: ConnectionAccess,
		since: number | null,
		now: number,
	): Promise<Digest> {
		const empty: Digest = { since, at: now, edits: [], more: 0, cards: [], pushes: [] };
		if (since === null || !this.changeLog || !this.cardHistory) return empty;
		// Cards fetched on waking (after a long sleep) belong in the digest: give them a moment.
		if (this.syncing) {
			await Promise.race([this.syncing, new Promise((resolve) => setTimeout(resolve, 1_500))]);
		}
		const { edits, more } = this.changeLog.since(since, access.userId);
		const activity = this.cardHistory.since(since, cardRefs(this.document));
		// Cards from private repositories only for people who can read them.
		const readable = new Map<string, boolean>();
		for (const repoKey of new Set(activity.map((entry) => repoKeyOf(entry.key)))) {
			const sample = [...this.cards.values()].find((card) => repoKeyOf(card.key) === repoKey);
			readable.set(
				repoKey,
				sample !== undefined && isPublic(sample)
					? true
					: await this.canRead(access.userId, repoKey),
			);
		}
		const cards = activity.filter((entry) => readable.get(repoKeyOf(entry.key)));
		const login = access.person?.login.toLowerCase();
		const pushes = (this.pushes?.audit() ?? [])
			.filter((entry) => Date.parse(entry.at) > since && entry.by.login.toLowerCase() !== login)
			.slice(0, 20)
			.map((entry) => ({
				pushId: entry.pushId,
				at: Date.parse(entry.at),
				by: entry.by,
				applied: entry.changes.filter((change) => change.status !== "failed").length,
				failed: entry.changes.filter((change) => change.status === "failed").length,
				summaries: entry.changes.slice(0, 3).map((change) => change.summary),
			}));
		log.info("since.digest", {
			board: this.name,
			user: access.userId,
			away: now - since,
			edits: edits.length + more,
			cards: cards.length,
			pushes: pushes.length,
		});
		return { since, at: now, edits, more, cards, pushes };
	}

	private sendJSON(connection: Connection, message: CommentEvent | SinceEvent): void {
		this.sendCustomMessage(connection, JSON.stringify(message));
	}

	private broadcastJSON(message: CommentEvent): void {
		this.broadcastCustomMessage(JSON.stringify(message));
	}

	// --- Rules and inboxes (M3) ----------------------------------------------------

	/**
	 * Called by a `Repo` with every webhook delivery from a repository on this
	 * board (or one a widget or inbox reads): rules run on it, and widgets and
	 * inboxes that could include its items search again.
	 */
	async repoActivity(activity: RepoActivity): Promise<void> {
		try {
			this.rules?.run(activity);
		} catch (error) {
			log.error("rule.failed", { board: this.name, delivery: activity.delivery, error });
		}
		const due = this.widgets?.repoChanged(activity.repo) ?? 0;
		if (due > 0)
			log.info("widget.refresh", { board: this.name, repo: activity.repo, queries: due });
	}

	// --- Comment commands (#58) ------------------------------------------------------

	/**
	 * Called by a `Repo` for a comment command that has passed its checks
	 * (src/server/commands.ts): put the item on this board, in free space,
	 * credited to whoever asked. Never moves anything, and never adds an item
	 * that's already here.
	 */
	async addFromCommand(
		request: PlaceRequest & { by: { id: number; login: string } },
	): Promise<PlaceResult> {
		const origin: CommandOrigin = { kind: "command", by: request.by };
		const result = placeCommandCard(
			this.document,
			{
				key: request.key,
				provenance: request.provenance,
				...(request.section ? { section: request.section } : {}),
			},
			origin,
		);
		if (result.status === "added") {
			try {
				this.writeSnapshot();
			} catch {
				// Logged as board.save.failed; the debounced save tries again.
			}
			log.info("command.placed", {
				board: this.name,
				item: request.key,
				by: request.by.login,
				section: result.section?.id ?? null,
				full: result.full,
			});
		}
		return result;
	}

	/** For tests: how long away starts a new visit, for "since you were here". */
	async sinceTiming(timing: { gapMs: number }): Promise<void> {
		if (this.visits) this.visits.gapMs = timing.gapMs;
	}

	/** For tests: shorten the inbox timings (inboxes run on the widget runner). */
	async inboxTiming(timing: {
		cacheMs?: number;
		refreshMs?: number;
		activityMs?: number;
	}): Promise<void> {
		if (!this.widgets) return;
		const next = this.widgets.timing;
		if (timing.cacheMs !== undefined) next.freshMs = timing.cacheMs;
		if (timing.refreshMs !== undefined) next.inboxRefreshMs = timing.refreshMs;
		if (timing.activityMs !== undefined) {
			next.debounceMs = timing.activityMs;
			next.minIntervalMs = 0;
		}
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

	// --- Widgets (M3, #37) ---------------------------------------------------------

	private startWidgets(): WidgetRunner {
		return new WidgetRunner({
			doc: this.document,
			env: this.env,
			log: log.with({ board: this.name }),
			send: (id, message) => {
				const connection = this.getConnection(id);
				if (!connection) return;
				try {
					this.sendCustomMessage(connection, JSON.stringify(message));
				} catch (error) {
					log.warn("board.send.failed", { board: this.name, connection: id, error });
				}
			},
			access: async (id) => {
				const state = this.getConnection<ConnectionAccess>(id)?.state;
				const userId = state?.userId ?? null;
				// Only people with their own token search as themselves.
				const token = userId !== null && userId > 0 ? await userToken(this.env, userId) : null;
				return token && userId !== null
					? { key: `user:${userId}`, userId, login: state?.login ?? null, token }
					: { key: "public", userId, login: null, token: null };
			},
			readerToken: async () =>
				this.reader === null ? null : userToken(this.env, this.reader).catch(() => null),
			watchRepos: (repos) => this.watchQueryRepos(repos),
			route: (repoKey) => this.route(repoKey),
		});
	}

	/**
	 * Watch the repositories widgets and inboxes read, so their deliveries
	 * reach this board (`repoActivity`) while anyone's looking, even with none
	 * of their items on it yet.
	 */
	private watchQueryRepos(repoKeys: string[]): Promise<void> {
		const now = Date.now();
		const due = repoKeys.filter(
			(key) => now - (this.queryWatches.get(key) ?? 0) >= WATCH_THROTTLE_MS,
		);
		if (due.length === 0) return Promise.resolve();
		for (const key of due) this.queryWatches.set(key, now);
		const reader = this.reader;
		const watched = Promise.allSettled(
			due.map(async (key) => {
				const repo = await this.route(key);
				if (typeof repo !== "string") await repoObject(this.env, repo).watch(this.name, reader);
			}),
		).then((results) => {
			const failed = results.filter((result) => result.status === "rejected").length;
			if (failed > 0) log.warn("widget.watch.failed", { board: this.name, failed });
		});
		this.ctx.waitUntil(watched);
		return watched;
	}

	/** For tests: shorten the widget runner's pauses. */
	async widgetTiming(timing: Partial<RunnerTiming>): Promise<void> {
		if (this.widgets) Object.assign(this.widgets.timing, timing);
	}

	/**
	 * For tests: what the widget runner does every tick, now (whatever's due
	 * runs, and the repositories it reads are watched again), and wait for it.
	 */
	async runWidgets(): Promise<void> {
		await this.widgets?.beat();
	}

	/** For tests and debugging over RPC only: the widget results cache, without results. */
	widgetCache(): ReturnType<WidgetRunner["cached"]> {
		return this.widgets?.cached() ?? [];
	}

	// --- Templates and carrying over (#53, #52) --------------------------------------

	/**
	 * Start a new board from a template (called by the Worker as the board is
	 * made). Only an empty board is seeded, so a retried request can't lay a
	 * template out twice. Returns what was written, or null if the board
	 * already had shapes.
	 */
	async seed(input: {
		template: string;
		content: TemplateContent;
		repos: string[];
		by: { name: string; login?: string };
	}): Promise<InstantiateResult | null> {
		if (shapesMap(this.document).size > 0) return null;
		const result = instantiateTemplate(this.document, input.content, {
			repos: input.repos,
			by: input.by,
		});
		this.writeSnapshot();
		await this.updateIndex();
		log.info("board.seeded", {
			board: this.name,
			template: input.template,
			repos: input.repos.length,
			...result,
		});
		return result;
	}

	/**
	 * This board as a template (see `extractTemplate`), for saving it as one:
	 * its content as JSON, and the repositories it reads.
	 */
	async templateContent(options: {
		keepContent: boolean;
	}): Promise<{ json: string; repos: Extracted["repos"] }> {
		const { content, repos } = extractTemplate(this.document, options);
		return { json: JSON.stringify(content), repos };
	}

	/**
	 * The action items to carry over to another board: the open ones, or just
	 * `only` of them. Linked items are open unless their issue is closed, as
	 * this viewer may see it: an issue they can't read counts as open, so its
	 * state never leaks to them.
	 */
	async carryOut(input: { userId: number | null; only?: string[] }): Promise<CarriedItem[]> {
		const shapes = readShapes(this.document);
		const linked = [...shapes.values()]
			.flatMap((shape) => (shape.type === "action" && shape.ref ? [shape.ref] : []))
			.flatMap((ref) => {
				const card = this.cards.get(ref);
				return card ? [card] : [];
			});
		const visible = new Map(
			(await this.visibleTo(input.userId, linked)).map((card) => [card.key, card] as const),
		);
		const only = input.only ? new Set(input.only) : undefined;
		return carryable(
			shapes,
			(shape) => actionState(shape, visible.get(shape.ref ?? "")),
			only,
		).slice(0, CARRY_MAX);
	}

	/** Put action items carried over from another board on this one (see `placeCarried`). */
	async carryIn(input: {
		items: CarriedItem[];
		from: { board: string; title: string };
		by?: string;
	}): Promise<CarryResult> {
		let result: CarryResult = { added: [], skipped: 0, section: null };
		this.document.transact(() => {
			result = placeCarried(this.document, input.items.slice(0, CARRY_MAX), input.from);
		}, CARRY_ORIGIN);
		if (result.added.length > 0) this.writeSnapshot();
		log.info("actions.carried", {
			board: this.name,
			from: input.from.board,
			by: input.by,
			added: result.added.length,
			skipped: result.skipped,
		});
		return result;
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
		// Remember how cards changed, for "since you were here" (never sent as is).
		try {
			this.cardHistory?.record(cards.filter((card): card is Card => !("missing" in card)));
		} catch (error) {
			log.warn("since.history.failed", { board: this.name, error });
		}
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
			// Everyone signed in who's here has seen the board up to now.
			const now = Date.now();
			for (const viewing of new Set([...this.viewing.values()].map((v) => v.userId))) {
				if (viewing !== null) this.visits?.touch(viewing, now);
			}
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

/** Who made a document change, from its transaction's origin. */
function actorOf(origin: unknown): Actor | null {
	if (origin === RULE_ORIGIN || origin === INBOX_ORIGIN) return { kind: "rule" };
	if (origin === PUSH_ORIGIN) return { kind: "push" };
	// Someone asked for it in a comment on the forge (#58): it's their edit.
	if (isCommandOrigin(origin)) return { kind: "person", id: origin.by.id, login: origin.by.login };
	// A client's update: its origin is its connection.
	if (origin && typeof origin === "object" && "state" in origin) {
		let access: ConnectionAccess | null | undefined;
		try {
			access = (origin as Connection<ConnectionAccess>).state;
		} catch {
			access = null;
		}
		if (access?.userId != null && access.person) {
			return {
				kind: "person",
				id: access.userId,
				login: access.person.login,
				name: access.person.name,
				avatarUrl: access.person.avatarUrl,
			};
		}
		return { kind: "guest" };
	}
	// Repairs, write-back links and seeding aren't anyone's edits.
	return null;
}

function commenter(access: ConnectionAccess): Commenter {
	return {
		userId: access.userId,
		role: access.role,
		archived: access.archived ?? false,
		person:
			access.userId !== null && access.person ? { id: access.userId, ...access.person } : null,
	};
}

function readAccess(request: Request): ConnectionAccess | null {
	const header = request.headers.get(ACCESS_HEADER);
	if (!header) return null;
	try {
		return JSON.parse(decodeURIComponent(header)) as ConnectionAccess;
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
