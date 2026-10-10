import { clock } from "../clock.ts";
import { useSyncExternalStore } from "react";
import {
	type CommentAnchor,
	type CommentAuthor,
	type CommentEvent,
	type CommentFilter,
	type CommentMessage,
	type CommentRefusal,
	type CommentRequest,
	type CommentThread,
	type CommentsYou,
	cleanBody,
	isUnread,
	isVisible,
	starter,
} from "../../shared/comments.ts";

// Comment threads (#51), fed by the board's `comment*` messages and kept
// outside the document like card data (see src/shared/comments.ts for why).
// Writes are requests to the server: they show at once (optimistically, as
// `pending`), and the server's copy of the thread replaces them when it
// answers. A refusal puts things back as they were.
//
// The live board wires `channel` to its connection; the playground and the
// gallery swap in a simulated server.

export interface CommentChannel {
	send(request: CommentRequest): void;
}

/** A message this browser sent that the server hasn't confirmed yet. */
export interface PendingMessage extends CommentMessage {
	pending?: boolean;
}

export interface CommentsState {
	threads: ReadonlyMap<string, CommentThread>;
	you: CommentsYou;
	/** Whether the server has sent its threads yet. */
	ready: boolean;
}

/** What the comment UI is doing: which thread is open, a new one being placed. */
export interface CommentUI {
	/** The thread open on the canvas. */
	open: string | null;
	/** A new comment being written, where it'll go. */
	draft: CommentAnchor | null;
	panel: boolean;
	filter: CommentFilter;
	/** Whether resolved threads' pins show on the canvas. */
	showResolved: boolean;
	/** A thread to pulse once (just jumped to it). */
	flash: { id: string; at: number } | null;
	/** The open thread was unread from here when it opened: newer messages are marked new. */
	unreadSince: number | null;
}

export const NO_ONE: CommentsYou = {
	id: null,
	canComment: false,
	canTriage: false,
	canModerate: false,
	since: null,
	reads: {},
};

const REFUSALS: Record<CommentRefusal, string> = {
	signed_out: "Sign in to comment",
	archived: "This board is archived, so it’s read-only",
	forbidden: "You can’t do that to this comment",
	not_found: "That comment’s gone",
	invalid: "Couldn’t save that comment",
	limit: "That’s as many comments as this board can hold",
	busy: "Slow down a little, then try again",
};

let counter = 0;
/** An id for a new thread or message: random, so two people never pick the same one. */
export function newCommentId(): string {
	counter = (counter + 1) % 1296;
	const random = crypto.getRandomValues(new Uint8Array(9));
	return (
		Array.from(random, (byte) => (byte % 36).toString(36)).join("") + counter.toString(36)
	).padEnd(10, "0");
}

export class CommentStore {
	channel: CommentChannel = { send: () => {} };
	/** Who you are, for messages shown before the server answers. Set by the board. */
	user: { name: string; login?: string; avatarUrl?: string } | null = null;
	/** Called with a refusal, in words, e.g. to show a toast. */
	onRefused: ((message: string) => void) | null = null;

	private threads = new Map<string, CommentThread>();
	private you: CommentsYou = NO_ONE;
	private ready = false;
	/** Before optimistic changes: what to put back if the server refuses. */
	private rollback = new Map<string, CommentThread | null>();
	private state: CommentsState = { threads: this.threads, you: this.you, ready: false };
	private ui: CommentUI = {
		open: null,
		draft: null,
		panel: false,
		filter: "open",
		showResolved: false,
		flash: null,
		unreadSince: null,
	};
	private listeners = new Set<() => void>();
	private uiListeners = new Set<() => void>();

	/** You, as an author: once the server has said who you are. */
	get author(): CommentAuthor | null {
		const id = this.you.id;
		if (id === null || !this.user?.login) return null;
		return {
			id,
			login: this.user.login,
			name: this.user.name,
			avatarUrl: this.user.avatarUrl ?? "",
		};
	}

	// --- From the server ----------------------------------------------------------

	apply(event: CommentEvent): void {
		switch (event.type) {
			case "comments":
				if (event.first) {
					this.threads = new Map();
					this.rollback.clear();
				}
				for (const thread of event.threads) this.threads.set(thread.id, thread);
				this.you = event.you;
				this.ready = true;
				break;
			case "comments-you":
				this.you = event.you;
				break;
			case "comment-thread":
				this.threads.set(event.thread.id, event.thread);
				this.rollback.delete(event.thread.id);
				break;
			case "comment-removed":
				this.threads.delete(event.thread);
				this.rollback.delete(event.thread);
				if (this.ui.open === event.thread) this.setUI({ open: null });
				break;
			case "comment-reads":
				this.you = { ...this.you, reads: { ...this.you.reads, ...event.reads } };
				break;
			case "comment-refused": {
				if (event.request === "comment-read") return;
				const previous = this.rollback.get(event.thread);
				if (previous !== undefined) {
					if (previous) this.threads.set(event.thread, previous);
					else this.threads.delete(event.thread);
					this.rollback.delete(event.thread);
				}
				this.onRefused?.(REFUSALS[event.reason]);
				break;
			}
		}
		this.emit();
	}

	// --- Reading ----------------------------------------------------------------

	getState = (): CommentsState => this.state;
	getUI = (): CommentUI => this.ui;

	get(id: string): CommentThread | undefined {
		return this.threads.get(id);
	}

	isUnread(thread: CommentThread): boolean {
		return isUnread(thread, this.you);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	subscribeUI = (listener: () => void): (() => void) => {
		this.uiListeners.add(listener);
		return () => this.uiListeners.delete(listener);
	};

	setUI(change: Partial<CommentUI>): void {
		this.ui = { ...this.ui, ...change };
		for (const listener of this.uiListeners) listener();
	}

	/** Open a thread (marking it read), and pulse its pin. */
	openThread(id: string | null, options: { flash?: boolean } = {}): void {
		const thread = id ? this.threads.get(id) : undefined;
		const unreadSince =
			thread && isUnread(thread, this.you) ? (this.you.reads[thread.id] ?? this.you.since) : null;
		this.setUI({
			open: id,
			unreadSince,
			draft: null,
			...(id && options.flash ? { flash: { id, at: performance.now() } } : {}),
		});
		if (id) this.markRead(id);
	}

	// --- Writing ----------------------------------------------------------------

	/** Start a thread. Returns its id. */
	start(anchor: CommentAnchor, body: string): string | null {
		const text = cleanBody(body);
		if (!text || !this.author) return null;
		const id = newCommentId();
		const message = newCommentId();
		const now = clock.now();
		this.optimistic(id, {
			id,
			anchor,
			createdAt: now,
			updatedAt: now,
			resolved: null,
			messages: [this.draftMessage(message, text, now)],
		});
		this.channel.send({ type: "comment-start", thread: id, message, anchor, body: text });
		return id;
	}

	reply(threadId: string, body: string): void {
		const thread = this.threads.get(threadId);
		const text = cleanBody(body);
		if (!thread || !text || !this.author) return;
		const message = newCommentId();
		const now = clock.now();
		this.optimistic(threadId, {
			...thread,
			resolved: null,
			updatedAt: now,
			messages: [...thread.messages, this.draftMessage(message, text, now)],
		});
		this.channel.send({ type: "comment-reply", thread: threadId, message, body: text });
	}

	edit(threadId: string, messageId: string, body: string): void {
		const thread = this.threads.get(threadId);
		const text = cleanBody(body);
		if (!thread || !text) return;
		this.optimistic(threadId, {
			...thread,
			messages: thread.messages.map((m) =>
				m.id === messageId ? { ...m, body: text, editedAt: clock.now() } : m,
			),
		});
		this.channel.send({ type: "comment-edit", thread: threadId, message: messageId, body: text });
	}

	/** Delete a message. Returns whether that was the thread's last message. */
	delete(threadId: string, messageId: string): boolean {
		const thread = this.threads.get(threadId);
		if (!thread) return false;
		const next = {
			...thread,
			messages: thread.messages.map((m) =>
				m.id === messageId ? { ...m, deleted: true, body: "" } : m,
			),
		};
		const last = !isVisible(next);
		this.optimistic(threadId, next);
		if (last && this.ui.open === threadId) this.setUI({ open: null });
		this.channel.send({ type: "comment-delete", thread: threadId, message: messageId });
		return last;
	}

	/** Bring a deleted message back (Undo). The server has its words. */
	restore(threadId: string, messageId: string): void {
		this.channel.send({ type: "comment-restore", thread: threadId, message: messageId });
	}

	resolve(threadId: string, resolved: boolean): void {
		const thread = this.threads.get(threadId);
		if (!thread || !this.author) return;
		this.optimistic(threadId, {
			...thread,
			resolved: resolved ? { by: this.author, at: clock.now() } : null,
		});
		this.channel.send({ type: "comment-resolve", thread: threadId, resolved });
	}

	move(threadId: string, anchor: CommentAnchor): void {
		const thread = this.threads.get(threadId);
		if (!thread) return;
		this.optimistic(threadId, { ...thread, anchor });
		this.channel.send({ type: "comment-move", thread: threadId, anchor });
	}

	markRead(threadId: string): void {
		const thread = this.threads.get(threadId);
		if (!thread || this.you.id === null || !isUnread(thread, this.you)) return;
		// Read straight away here; the server remembers it for next time.
		this.you = { ...this.you, reads: { ...this.you.reads, [threadId]: clock.now() } };
		this.emit();
		this.channel.send({ type: "comment-read", thread: threadId });
	}

	/** Whether you can resolve or move a thread: yours, or you're an editor. */
	canTriage(thread: CommentThread): boolean {
		return this.you.canComment && (this.you.canTriage || starter(thread)?.id === this.you.id);
	}

	/** Forget everything, for a new board (the playground switching scenario). */
	reset(): void {
		this.threads = new Map();
		this.rollback.clear();
		this.you = NO_ONE;
		this.ready = false;
		this.ui = { ...this.ui, open: null, draft: null, flash: null };
		this.emit();
		for (const listener of this.uiListeners) listener();
	}

	private draftMessage(id: string, body: string, at: number): PendingMessage {
		return { id, author: this.author as CommentAuthor, body, at, pending: true };
	}

	private optimistic(id: string, next: CommentThread): void {
		if (!this.rollback.has(id)) this.rollback.set(id, this.threads.get(id) ?? null);
		if (isVisible(next)) this.threads.set(id, next);
		else this.threads.delete(id);
		this.emit();
	}

	private emit(): void {
		this.state = { threads: new Map(this.threads), you: this.you, ready: this.ready };
		for (const listener of this.listeners) listener();
	}
}

export const commentStore = new CommentStore();

export function useComments(store: CommentStore = commentStore): CommentsState {
	return useSyncExternalStore(store.subscribe, store.getState);
}

export function useCommentUI(store: CommentStore = commentStore): CommentUI {
	return useSyncExternalStore(store.subscribeUI, store.getUI);
}
