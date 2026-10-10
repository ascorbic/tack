// Comments on the board's server (#51): threads and messages in the board
// object's SQLite storage, read state per person, and the checks on every
// request. The board (board.ts) routes `comment-*` requests here and sends
// what comes back. See src/shared/comments.ts for why comments aren't in the
// Yjs document.
//
// Who may do what:
// - comment (start a thread, reply): anyone signed in who can open the
//   board, viewers included, unless it's archived. Signed-out visitors to
//   public boards can read comments, but not write them: there's nobody to
//   attribute them to.
// - edit, delete and restore a message: its author; owners can also delete
//   anyone's (moderation).
// - resolve, reopen and move a thread: whoever started it, and editors.

import { type Role, canEdit } from "../shared/boards.ts";
import {
	type CommentAnchor,
	type CommentAuthor,
	type CommentEvent,
	type CommentMessage,
	type CommentRefusal,
	type CommentRequest,
	type CommentThread,
	type CommentsYou,
	MAX_MESSAGES,
	MAX_THREADS,
	RESTORE_MS,
	cleanBody,
	excerpt,
	isAnchor,
	starter,
	tidyAnchor,
	validMentions,
} from "../shared/comments.ts";
import { log } from "./log.ts";

/** Who's asking, as the board's connection knows them. */
export interface Commenter {
	userId: number | null;
	role: Role | null;
	archived: boolean;
	person: CommentAuthor | null;
}

/** A notification to deliver through the Directory. */
export interface CommentNotice {
	userId: number;
	kind: "mention" | "reply";
	thread: string;
	message: string;
	by: CommentAuthor;
	excerpt: string;
	at: number;
}

export interface CommentsDeps {
	board: string;
	sql: SqlStorage;
	transaction: (fn: () => void) => void;
	/** Logins (lowercase) of people who can be mentioned, with their ids. */
	mentionable: () => Promise<Map<string, number>>;
	notify: (notices: CommentNotice[]) => void;
	/** Where a shape is now, for pins that follow it. */
	shapeAt: (id: string) => { x: number; y: number } | null;
}

/** What a request did: a thread to send everyone, or a refusal for the asker, or new reads. */
export interface CommentOutcome {
	broadcast?: CommentEvent;
	reply?: CommentEvent;
	/** The asker's read state changed. */
	reads?: Record<string, number>;
}

interface StoredMessage extends CommentMessage {
	deletedAt?: number;
}

interface StoredThread extends Omit<CommentThread, "messages"> {
	messages: StoredMessage[];
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Mentionable people are looked up at most this often. */
const PEOPLE_TTL_MS = 30_000;

export class CommentsService {
	private threads = new Map<string, StoredThread>();
	/** Threads by the shape they're pinned to. */
	private byShape = new Map<string, Set<string>>();
	private people: { at: number; logins: Map<string, number> } | null = null;
	/** Requests run one at a time, in the order they arrived. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private deps: CommentsDeps) {
		deps.sql.exec(`
			CREATE TABLE IF NOT EXISTS comment_threads (
				id TEXT PRIMARY KEY,
				anchor TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				resolved TEXT
			);
			CREATE TABLE IF NOT EXISTS comment_messages (
				id TEXT PRIMARY KEY,
				thread TEXT NOT NULL,
				seq INTEGER NOT NULL,
				author TEXT NOT NULL,
				author_id INTEGER NOT NULL,
				body TEXT NOT NULL,
				mentions TEXT,
				at INTEGER NOT NULL,
				edited_at INTEGER,
				deleted_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS comment_messages_thread ON comment_messages (thread, seq);
			CREATE TABLE IF NOT EXISTS comment_reads (
				user_id INTEGER NOT NULL,
				thread TEXT NOT NULL,
				at INTEGER NOT NULL,
				PRIMARY KEY (user_id, thread)
			);
		`);
		this.load();
	}

	private load(): void {
		const { sql } = this.deps;
		for (const row of sql.exec<{
			id: string;
			anchor: string;
			created_at: number;
			updated_at: number;
			resolved: string | null;
		}>("SELECT * FROM comment_threads")) {
			const thread: StoredThread = {
				id: row.id,
				anchor: JSON.parse(row.anchor) as CommentAnchor,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				resolved: row.resolved ? (JSON.parse(row.resolved) as StoredThread["resolved"]) : null,
				messages: [],
			};
			this.threads.set(thread.id, thread);
			this.index(thread);
		}
		for (const row of sql.exec<{
			id: string;
			thread: string;
			author: string;
			body: string;
			mentions: string | null;
			at: number;
			edited_at: number | null;
			deleted_at: number | null;
		}>("SELECT * FROM comment_messages ORDER BY thread, seq")) {
			const thread = this.threads.get(row.thread);
			if (!thread) continue;
			thread.messages.push({
				id: row.id,
				author: JSON.parse(row.author) as CommentAuthor,
				body: row.body,
				at: row.at,
				...(row.mentions ? { mentions: JSON.parse(row.mentions) as string[] } : {}),
				...(row.edited_at ? { editedAt: row.edited_at } : {}),
				...(row.deleted_at ? { deleted: true, deletedAt: row.deleted_at } : {}),
			});
		}
	}

	/** Every thread, as clients see them. */
	all(): CommentThread[] {
		return [...this.threads.values()].map(publicThread);
	}

	/** Threads in a list, as clients see them (for tests and the digest). */
	get(id: string): CommentThread | undefined {
		const thread = this.threads.get(id);
		return thread && publicThread(thread);
	}

	/** What a connection can do, and its person's read state. */
	you(who: Commenter, since: number | null): CommentsYou {
		const reason = refusalFor(who);
		const reads: Record<string, number> = {};
		if (who.userId !== null) {
			for (const row of this.deps.sql.exec<{ thread: string; at: number }>(
				"SELECT thread, at FROM comment_reads WHERE user_id = ?",
				who.userId,
			)) {
				reads[row.thread] = row.at;
			}
		}
		return {
			id: who.userId,
			canComment: reason === null,
			...(reason === "signed_out" || reason === "archived" ? { reason } : {}),
			...(reason === "forbidden" ? { reason: "no_access" as const } : {}),
			canTriage: reason === null && canEdit(who.role),
			canModerate: reason === null && who.role === "owner",
			since,
			reads,
		};
	}

	/** Handle a request, after every request before it. */
	handle(who: Commenter, request: CommentRequest): Promise<CommentOutcome> {
		const run = this.queue.then(() => this.run(who, request));
		this.queue = run.catch(() => {});
		return run.catch((error: unknown) => {
			log.error("comment.failed", { board: this.deps.board, request: request.type, error });
			return this.refuse(request, "invalid");
		});
	}

	private async run(who: Commenter, request: CommentRequest): Promise<CommentOutcome> {
		const thread = typeof request.thread === "string" ? request.thread : "";
		if (!ID.test(thread)) return this.refuse(request, "invalid");

		if (request.type === "comment-read") {
			if (who.userId === null || !this.threads.has(thread)) return {};
			const at = Date.now();
			this.deps.sql.exec(
				"INSERT OR REPLACE INTO comment_reads (user_id, thread, at) VALUES (?, ?, ?)",
				who.userId,
				thread,
				at,
			);
			return { reads: { [thread]: at } };
		}

		const refusal = refusalFor(who);
		if (refusal) return this.refuse(request, refusal);
		const person = who.person as CommentAuthor;
		const now = Date.now();

		switch (request.type) {
			case "comment-start": {
				if (this.threads.has(thread) || !ID.test(request.message ?? "")) {
					return this.refuse(request, "invalid");
				}
				if (this.threads.size >= MAX_THREADS) return this.refuse(request, "limit");
				if (!isAnchor(request.anchor)) return this.refuse(request, "invalid");
				const body = cleanBody(String(request.body ?? ""));
				if (!body) return this.refuse(request, "invalid");
				const anchor = this.place(tidyAnchor(request.anchor));
				const mentions = await this.mentions(body);
				const created: StoredThread = {
					id: thread,
					anchor,
					createdAt: now,
					updatedAt: now,
					resolved: null,
					messages: [],
				};
				const message: StoredMessage = { id: request.message, author: person, body, at: now };
				if (mentions.length > 0) message.mentions = mentions;
				this.deps.transaction(() => {
					this.writeThread(created);
					this.writeMessage(created.id, 0, message);
				});
				created.messages.push(message);
				this.threads.set(thread, created);
				this.index(created);
				this.noticesFor(created, message);
				log.info("comment.started", {
					board: this.deps.board,
					thread,
					by: person.login,
					on: anchor.shape ? "shape" : "point",
					mentions: mentions.length,
				});
				return { broadcast: { type: "comment-thread", thread: publicThread(created) } };
			}

			case "comment-reply": {
				const existing = this.threads.get(thread);
				if (!existing) return this.refuse(request, "not_found");
				if (
					!ID.test(request.message ?? "") ||
					existing.messages.some((m) => m.id === request.message)
				) {
					return this.refuse(request, "invalid");
				}
				if (existing.messages.length >= MAX_MESSAGES) return this.refuse(request, "limit");
				const body = cleanBody(String(request.body ?? ""));
				if (!body) return this.refuse(request, "invalid");
				const mentions = await this.mentions(body);
				const message: StoredMessage = { id: request.message, author: person, body, at: now };
				if (mentions.length > 0) message.mentions = mentions;
				// Replying to a resolved thread reopens it, as in FigJam.
				const reopened = existing.resolved !== null;
				existing.resolved = null;
				existing.updatedAt = now;
				this.deps.transaction(() => {
					this.writeMessage(existing.id, existing.messages.length, message);
					this.writeThread(existing);
				});
				existing.messages.push(message);
				this.noticesFor(existing, message);
				log.info("comment.replied", {
					board: this.deps.board,
					thread,
					by: person.login,
					mentions: mentions.length,
					reopened,
				});
				return { broadcast: { type: "comment-thread", thread: publicThread(existing) } };
			}

			case "comment-edit": {
				const found = this.message(thread, request.message);
				if (!found) return this.refuse(request, "not_found");
				const { thread: existing, message } = found;
				if (message.author.id !== who.userId || message.deleted) {
					return this.refuse(request, "forbidden");
				}
				const body = cleanBody(String(request.body ?? ""));
				if (!body) return this.refuse(request, "invalid");
				if (body === message.body) return {};
				const before = new Set(message.mentions ?? []);
				const mentions = await this.mentions(body);
				message.body = body;
				message.editedAt = now;
				if (mentions.length > 0) message.mentions = mentions;
				else delete message.mentions;
				existing.updatedAt = now;
				this.deps.transaction(() => {
					this.updateMessage(message);
					this.writeThread(existing);
				});
				// Only people newly mentioned hear about an edit.
				this.noticesFor(existing, message, { onlyMentions: true, except: before });
				log.info("comment.edited", { board: this.deps.board, thread, by: person.login });
				return { broadcast: { type: "comment-thread", thread: publicThread(existing) } };
			}

			case "comment-delete": {
				const found = this.message(thread, request.message);
				if (!found) return this.refuse(request, "not_found");
				const { thread: existing, message } = found;
				const own = message.author.id === who.userId;
				if (!own && who.role !== "owner") return this.refuse(request, "forbidden");
				if (message.deleted) return {};
				message.deleted = true;
				message.deletedAt = now;
				this.deps.transaction(() => this.updateMessage(message));
				log.info("comment.deleted", {
					board: this.deps.board,
					thread,
					by: person.login,
					moderated: !own,
				});
				if (!existing.messages.some((m) => !m.deleted)) {
					return { broadcast: { type: "comment-removed", thread } };
				}
				return { broadcast: { type: "comment-thread", thread: publicThread(existing) } };
			}

			case "comment-restore": {
				const found = this.message(thread, request.message);
				if (!found) return this.refuse(request, "not_found");
				const { thread: existing, message } = found;
				if (message.author.id !== who.userId) return this.refuse(request, "forbidden");
				if (!message.deleted) return {};
				if (now - (message.deletedAt ?? 0) > RESTORE_MS) return this.refuse(request, "limit");
				delete message.deleted;
				delete message.deletedAt;
				this.deps.transaction(() => this.updateMessage(message));
				return { broadcast: { type: "comment-thread", thread: publicThread(existing) } };
			}

			case "comment-resolve": {
				const existing = this.threads.get(thread);
				if (!existing) return this.refuse(request, "not_found");
				if (!canEdit(who.role) && starter(existing)?.id !== who.userId) {
					return this.refuse(request, "forbidden");
				}
				const resolved = request.resolved === true;
				if (resolved === (existing.resolved !== null)) return {};
				existing.resolved = resolved ? { by: person, at: now } : null;
				existing.updatedAt = now;
				this.deps.transaction(() => this.writeThread(existing));
				log.info(resolved ? "comment.resolved" : "comment.reopened", {
					board: this.deps.board,
					thread,
					by: person.login,
				});
				return { broadcast: { type: "comment-thread", thread: publicThread(existing) } };
			}

			case "comment-move": {
				const existing = this.threads.get(thread);
				if (!existing) return this.refuse(request, "not_found");
				if (!canEdit(who.role) && starter(existing)?.id !== who.userId) {
					return this.refuse(request, "forbidden");
				}
				if (!isAnchor(request.anchor)) return this.refuse(request, "invalid");
				this.unindex(existing);
				existing.anchor = this.place(tidyAnchor(request.anchor));
				this.index(existing);
				this.deps.transaction(() => this.writeThread(existing));
				return { broadcast: { type: "comment-thread", thread: publicThread(existing) } };
			}
		}
		return this.refuse(request, "invalid");
	}

	// --- Pins that follow shapes ----------------------------------------------

	/** Whether any thread is pinned to a shape. */
	pinnedTo(shape: string): boolean {
		return (this.byShape.get(shape)?.size ?? 0) > 0;
	}

	/**
	 * A shape moved: its pins' resting points follow, so they stay where the
	 * shape was last if it's deleted. Clients place pins from the shape itself.
	 */
	shapeMoved(shape: string, at: { x: number; y: number }): void {
		for (const id of this.byShape.get(shape) ?? []) {
			const thread = this.threads.get(id);
			if (!thread) continue;
			const x = Math.round(at.x + (thread.anchor.dx ?? 0));
			const y = Math.round(at.y + (thread.anchor.dy ?? 0));
			if (x === thread.anchor.x && y === thread.anchor.y) continue;
			thread.anchor = { ...thread.anchor, x, y };
			this.deps.sql.exec(
				"UPDATE comment_threads SET anchor = ? WHERE id = ?",
				JSON.stringify(thread.anchor),
				id,
			);
		}
	}

	/** A shape was deleted: its threads stay where it was, and everyone hears where. */
	shapeRemoved(shape: string): CommentEvent[] {
		return [...(this.byShape.get(shape) ?? [])].flatMap((id) => {
			const thread = this.threads.get(id);
			return thread ? [{ type: "comment-thread" as const, thread: publicThread(thread) }] : [];
		});
	}

	// --- Internals ----------------------------------------------------------------

	/** A pin on a shape rests where the shape is now. */
	private place(anchor: CommentAnchor): CommentAnchor {
		if (!anchor.shape) return anchor;
		const at = this.deps.shapeAt(anchor.shape);
		if (!at) return { x: anchor.x, y: anchor.y };
		return {
			...anchor,
			x: Math.round(at.x + (anchor.dx ?? 0)),
			y: Math.round(at.y + (anchor.dy ?? 0)),
		};
	}

	private index(thread: StoredThread): void {
		const shape = thread.anchor.shape;
		if (!shape) return;
		let set = this.byShape.get(shape);
		if (!set) this.byShape.set(shape, (set = new Set()));
		set.add(thread.id);
	}

	private unindex(thread: StoredThread): void {
		const shape = thread.anchor.shape;
		if (shape) this.byShape.get(shape)?.delete(thread.id);
	}

	private message(
		threadId: string,
		messageId: unknown,
	): { thread: StoredThread; message: StoredMessage } | null {
		const thread = this.threads.get(threadId);
		const message = thread?.messages.find((m) => m.id === messageId);
		return thread && message ? { thread, message } : null;
	}

	private async mentions(body: string): Promise<string[]> {
		if (!body.includes("@")) return [];
		const logins = await this.mentionableLogins();
		return validMentions(body, logins.keys());
	}

	private async mentionableLogins(): Promise<Map<string, number>> {
		const now = Date.now();
		if (this.people && now - this.people.at < PEOPLE_TTL_MS) return this.people.logins;
		try {
			this.people = { at: now, logins: await this.deps.mentionable() };
		} catch (error) {
			log.warn("comment.people.failed", { board: this.deps.board, error });
			this.people = { at: now - PEOPLE_TTL_MS + 5_000, logins: this.people?.logins ?? new Map() };
		}
		return this.people.logins;
	}

	/** Mentions notify who they mention; replies notify everyone else in the thread. */
	private noticesFor(
		thread: StoredThread,
		message: StoredMessage,
		options: { onlyMentions?: boolean; except?: Set<string> } = {},
	): void {
		const logins = this.people?.logins ?? new Map<string, number>();
		const notices = new Map<number, CommentNotice>();
		const base = {
			thread: thread.id,
			message: message.id,
			by: message.author,
			excerpt: excerpt(message.body),
			at: message.at,
		};
		for (const login of message.mentions ?? []) {
			if (options.except?.has(login)) continue;
			const userId = logins.get(login);
			if (userId === undefined || userId === message.author.id) continue;
			notices.set(userId, { ...base, userId, kind: "mention" });
		}
		if (!options.onlyMentions) {
			for (const earlier of thread.messages) {
				const userId = earlier.author.id;
				if (earlier === message || earlier.deleted || userId === message.author.id) continue;
				if (!notices.has(userId)) notices.set(userId, { ...base, userId, kind: "reply" });
			}
		}
		if (notices.size > 0) this.deps.notify([...notices.values()]);
	}

	private refuse(request: CommentRequest, reason: CommentRefusal): CommentOutcome {
		return {
			reply: {
				type: "comment-refused",
				request: request.type,
				thread: typeof request.thread === "string" ? request.thread : "",
				reason,
			},
		};
	}

	private writeThread(thread: StoredThread): void {
		this.deps.sql.exec(
			`INSERT OR REPLACE INTO comment_threads (id, anchor, created_at, updated_at, resolved)
			VALUES (?, ?, ?, ?, ?)`,
			thread.id,
			JSON.stringify(thread.anchor),
			thread.createdAt,
			thread.updatedAt,
			thread.resolved ? JSON.stringify(thread.resolved) : null,
		);
	}

	private writeMessage(thread: string, seq: number, message: StoredMessage): void {
		this.deps.sql.exec(
			`INSERT INTO comment_messages (id, thread, seq, author, author_id, body, mentions, at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			message.id,
			thread,
			seq,
			JSON.stringify(message.author),
			message.author.id,
			message.body,
			message.mentions ? JSON.stringify(message.mentions) : null,
			message.at,
		);
	}

	private updateMessage(message: StoredMessage): void {
		this.deps.sql.exec(
			"UPDATE comment_messages SET body = ?, mentions = ?, edited_at = ?, deleted_at = ? WHERE id = ?",
			message.body,
			message.mentions ? JSON.stringify(message.mentions) : null,
			message.editedAt ?? null,
			message.deletedAt ?? null,
			message.id,
		);
	}
}

/** Why someone can't comment, or null if they can. */
export function refusalFor(who: Commenter): CommentRefusal | null {
	if (!who.role) return "forbidden";
	if (who.userId === null || !who.person) return "signed_out";
	if (who.archived) return "archived";
	return null;
}

/** A thread as clients see it: deleted messages keep their place, but not their words. */
function publicThread(thread: StoredThread): CommentThread {
	return {
		id: thread.id,
		anchor: thread.anchor,
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
		resolved: thread.resolved,
		messages: thread.messages.map(({ deletedAt: _deletedAt, ...message }) =>
			message.deleted
				? { id: message.id, author: message.author, body: "", at: message.at, deleted: true }
				: message,
		),
	};
}
