import { clock } from "../clock.ts";
import type * as Y from "yjs";
import {
	type CommentAnchor,
	type CommentAuthor,
	type CommentEvent,
	type CommentRequest,
	type CommentThread,
	type CommentsYou,
	type Mentionable,
	type Notification,
	type NotificationList,
	cleanBody,
	excerpt,
	isAnchor,
	starter,
	validMentions,
} from "../../shared/comments.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { type NotificationStore, notificationStore } from "../comments/Notifications.tsx";
import { peopleSource } from "../comments/people.ts";
import { type CommentStore, commentStore, newCommentId } from "../comments/store.ts";

// A pretend comments server for the playground and the gallery: the same
// rules as the board's (src/server/comments.ts), in memory, with a little
// latency, and simulated people who comment, reply, mention you and
// resolve things. Mentions of you land in a pretend notifications inbox.

export const PLAY_PEOPLE: CommentAuthor[] = [
	{ id: 101, login: "priya", name: "Priya Shah", avatarUrl: "" },
	{ id: 102, login: "kai", name: "Kai Andersen", avatarUrl: "" },
	{ id: 103, login: "tom", name: "Tom Okafor", avatarUrl: "" },
	{ id: 104, login: "jo", name: "Jo Rivera", avatarUrl: "" },
];

/** Your id in the playground. */
export const PLAY_YOU_ID = 100;

const LATENCY_MS = 140;

export interface PlayAccess {
	signedIn: boolean;
	role: "owner" | "editor" | "viewer";
	archived?: boolean;
}

export class SimulatedComments {
	threads = new Map<string, CommentThread>();
	reads = new Map<string, number>();
	notifications: Notification[] = [];
	/** When you first came, for unread: everything before is read. */
	since: number;
	access: PlayAccess = { signedIn: true, role: "owner" };
	private deleted = new Map<string, string>();

	constructor(
		private doc: Y.Doc | null,
		public me: CommentAuthor,
		private store: CommentStore = commentStore,
		/** What time it is: the playground can make time pass. */
		public now: () => number = () => clock.now(),
		private inbox: NotificationStore = notificationStore,
		/** The board's id, as notifications name it. */
		public board = "play",
	) {
		this.since = this.now() - 1;
	}

	/** Become the store's server: send everything, and answer its requests. */
	connect(): () => void {
		const previous = this.store.channel;
		this.store.channel = { send: (request) => this.receive(request) };
		peopleSource.reset(async () => this.people());
		this.inbox.api = {
			list: async () => this.inboxList(),
			read: async (which) => {
				for (const n of this.notifications) {
					if (
						which.all ||
						which.ids?.includes(n.id) ||
						(n.board.id === which.board && n.thread === which.thread)
					) {
						n.read = true;
					}
				}
				return this.inboxList();
			},
		};
		this.inbox.set(this.inboxList());
		this.store.apply({
			type: "comments",
			threads: [...this.threads.values()],
			you: this.you(),
			first: true,
		});
		return () => {
			this.store.channel = previous;
		};
	}

	setAccess(access: PlayAccess): void {
		this.access = access;
		this.emit({ type: "comments-you", you: this.you() });
	}

	people(): Mentionable[] {
		return [this.me, ...PLAY_PEOPLE].map((person, i) => ({
			...person,
			role: i === 0 ? "owner" : i < 3 ? "editor" : "viewer",
		}));
	}

	you(): CommentsYou {
		const { signedIn, role, archived } = this.access;
		const canComment = signedIn && !archived;
		const reads: Record<string, number> = {};
		for (const [id, at] of this.reads) reads[id] = at;
		return {
			id: signedIn ? this.me.id : null,
			canComment,
			...(!signedIn
				? { reason: "signed_out" as const }
				: archived
					? { reason: "archived" as const }
					: {}),
			canTriage: canComment && role !== "viewer",
			canModerate: canComment && role === "owner",
			since: signedIn ? this.since : null,
			reads: signedIn ? reads : {},
		};
	}

	// --- Requests from you ------------------------------------------------------

	receive(request: CommentRequest): void {
		setTimeout(() => this.handle(this.me, request, true), LATENCY_MS);
	}

	private handle(by: CommentAuthor, request: CommentRequest, fromYou: boolean): void {
		const refuse = (reason: "signed_out" | "archived" | "forbidden" | "not_found" | "invalid") =>
			fromYou &&
			this.emit({ type: "comment-refused", request: request.type, thread: request.thread, reason });
		const now = this.now();
		if (request.type === "comment-read") {
			if (fromYou && this.access.signedIn) {
				this.reads.set(request.thread, now);
				this.emit({ type: "comment-reads", reads: { [request.thread]: now } });
			}
			return;
		}
		if (fromYou && !this.access.signedIn) return void refuse("signed_out");
		if (fromYou && this.access.archived) return void refuse("archived");
		const thread = this.threads.get(request.thread);
		const triage =
			!fromYou ||
			this.access.role !== "viewer" ||
			(thread !== undefined && starter(thread)?.id === by.id);
		switch (request.type) {
			case "comment-start": {
				const body = cleanBody(request.body);
				if (thread || !body || !isAnchor(request.anchor)) return void refuse("invalid");
				const created: CommentThread = {
					id: request.thread,
					anchor: this.place(request.anchor),
					createdAt: now,
					updatedAt: now,
					resolved: null,
					messages: [this.message(request.message, by, body, now)],
				};
				this.threads.set(created.id, created);
				this.notify(created, by);
				return this.broadcast(created);
			}
			case "comment-reply": {
				if (!thread) return void refuse("not_found");
				const body = cleanBody(request.body);
				if (!body) return void refuse("invalid");
				const next: CommentThread = {
					...thread,
					resolved: null,
					updatedAt: now,
					messages: [...thread.messages, this.message(request.message, by, body, now)],
				};
				this.threads.set(next.id, next);
				this.notify(next, by);
				return this.broadcast(next);
			}
			case "comment-edit": {
				const message = thread?.messages.find((m) => m.id === request.message);
				if (!thread || !message) return void refuse("not_found");
				if (message.author.id !== by.id) return void refuse("forbidden");
				const body = cleanBody(request.body);
				const next = {
					...thread,
					updatedAt: now,
					messages: thread.messages.map((m) =>
						m.id === message.id ? { ...this.message(m.id, by, body, m.at), editedAt: now } : m,
					),
				};
				this.threads.set(next.id, next);
				return this.broadcast(next);
			}
			case "comment-delete": {
				const message = thread?.messages.find((m) => m.id === request.message);
				if (!thread || !message) return void refuse("not_found");
				if (message.author.id !== by.id && this.access.role !== "owner")
					return void refuse("forbidden");
				this.deleted.set(message.id, message.body);
				const next = {
					...thread,
					messages: thread.messages.map((m) =>
						m.id === message.id ? { ...m, body: "", deleted: true, mentions: undefined } : m,
					),
				};
				this.threads.set(next.id, next);
				if (!next.messages.some((m) => !m.deleted)) {
					return this.emit({ type: "comment-removed", thread: next.id });
				}
				return this.broadcast(next);
			}
			case "comment-restore": {
				const body = this.deleted.get(request.message);
				if (!thread || body === undefined) return void refuse("not_found");
				this.deleted.delete(request.message);
				const next = {
					...thread,
					messages: thread.messages.map((m) =>
						m.id === request.message ? this.message(m.id, m.author, body, m.at) : m,
					),
				};
				this.threads.set(next.id, next);
				return this.broadcast(next);
			}
			case "comment-resolve": {
				if (!thread) return void refuse("not_found");
				if (!triage) return void refuse("forbidden");
				const next = {
					...thread,
					updatedAt: now,
					resolved: request.resolved ? { by, at: now } : null,
				};
				this.threads.set(next.id, next);
				return this.broadcast(next);
			}
			case "comment-move": {
				if (!thread) return void refuse("not_found");
				if (!triage) return void refuse("forbidden");
				const next = { ...thread, anchor: this.place(request.anchor) };
				this.threads.set(next.id, next);
				return this.broadcast(next);
			}
		}
	}

	// --- Simulated people ----------------------------------------------------------

	/** Someone else starts a thread. Returns its id. */
	start(by: CommentAuthor, anchor: CommentAnchor, body: string, at?: number): string {
		const id = newCommentId();
		this.handle(
			by,
			{ type: "comment-start", thread: id, message: newCommentId(), anchor, body },
			false,
		);
		if (at !== undefined) this.backdate(id, at);
		return id;
	}

	reply(by: CommentAuthor, thread: string, body: string, at?: number): void {
		this.handle(by, { type: "comment-reply", thread, message: newCommentId(), body }, false);
		if (at !== undefined) this.backdate(thread, at, true);
	}

	resolve(by: CommentAuthor, thread: string, resolved = true): void {
		this.handle(by, { type: "comment-resolve", thread, resolved }, false);
	}

	/** Move a thread's (latest) message back in time, for seeding. */
	private backdate(id: string, at: number, lastOnly = false): void {
		const thread = this.threads.get(id);
		if (!thread) return;
		const messages = thread.messages.map((m, i) =>
			!lastOnly || i === thread.messages.length - 1 ? { ...m, at } : m,
		);
		const next = {
			...thread,
			createdAt: lastOnly ? thread.createdAt : at,
			updatedAt: at,
			messages,
		};
		this.threads.set(id, next);
		this.broadcast(next);
	}

	// --- Internals -------------------------------------------------------------------

	private message(id: string, author: CommentAuthor, body: string, at: number) {
		const mentions = validMentions(
			body,
			this.people().map((p) => p.login),
		);
		return { id, author, body, at, ...(mentions.length > 0 ? { mentions } : {}) };
	}

	/** Pins on a shape rest where the shape is. */
	private place(anchor: CommentAnchor): CommentAnchor {
		const shape = anchor.shape && this.doc ? shapesMap(this.doc).get(anchor.shape) : undefined;
		const x = shape?.get("x");
		const y = shape?.get("y");
		if (typeof x !== "number" || typeof y !== "number") return anchor;
		return { ...anchor, x: x + (anchor.dx ?? 0), y: y + (anchor.dy ?? 0) };
	}

	private notify(thread: CommentThread, by: CommentAuthor): void {
		if (by.id === this.me.id) return;
		const message = thread.messages.at(-1);
		if (!message) return;
		const mentioned = message.mentions?.includes(this.me.login.toLowerCase());
		const replied = thread.messages.some((m) => m !== message && m.author.id === this.me.id);
		if (!mentioned && !replied) return;
		this.notifications.unshift({
			id: `${message.id}:${this.me.id}`,
			kind: mentioned ? "mention" : "reply",
			board: { id: this.board, slug: "play", title: "Playground" },
			thread: thread.id,
			by,
			excerpt: excerpt(message.body),
			at: message.at,
			read: false,
		});
		void this.inbox.refresh();
	}

	private inboxList(): NotificationList {
		const notifications = this.notifications.map((n) => ({ ...n }));
		return { notifications, unread: notifications.filter((n) => !n.read).length };
	}

	private broadcast(thread: CommentThread): void {
		this.emit({ type: "comment-thread", thread });
	}

	private emit(event: CommentEvent): void {
		this.store.apply(event);
	}
}
