// Comments (#51): threads anchored to a shape (a section is a shape too) or
// a free point on the board, with @mentions, resolving, and per-person read
// state. Pure types and helpers, shared by the board's server and clients.
//
// Comments live in the board object's SQLite storage, not in the Yjs
// document. Three reasons:
// - Viewers can comment (as in FigJam: a comment isn't an edit), but their
//   connections can't write the document (`isReadOnly`).
// - Authorship has to be trustworthy: anyone who can edit the document can
//   rewrite any key in it, so comments in it could be forged or edited by
//   anyone. The server stamps every message with who sent it.
// - Read state and notifications are per person and must stay private.
// Every write is a request over the board's connection (`CommentRequest`);
// the server checks it, stores it, and sends the whole thread to everyone
// connected (`CommentEvent`). Concurrent replies are simply appended in the
// order they arrive, so nothing is ever lost.

/** Who wrote a message: always a signed-in person. */
export interface CommentAuthor {
	/** GitHub user id (negative for dev sign-in). */
	id: number;
	login: string;
	name: string | null;
	avatarUrl: string;
}

/**
 * Where a thread is pinned. A free pin is just a point. A pin on a shape
 * follows it: `dx`, `dy` are the offset from the shape's top-left corner,
 * and `x`, `y` are where it was last, which is where it stays if the shape
 * is deleted (and it re-attaches if that's undone).
 */
export interface CommentAnchor {
	x: number;
	y: number;
	shape?: string;
	dx?: number;
	dy?: number;
}

export interface CommentMessage {
	id: string;
	author: CommentAuthor;
	/** Plain text, with `@login` mentions. Empty once deleted. */
	body: string;
	/** When it was posted, ms since the epoch. */
	at: number;
	editedAt?: number;
	deleted?: boolean;
	/** Lowercase logins of the people it mentions, as the server checked them. */
	mentions?: string[];
}

export interface CommentThread {
	id: string;
	anchor: CommentAnchor;
	createdAt: number;
	/** The last message, edit or resolution. */
	updatedAt: number;
	resolved: { by: CommentAuthor; at: number } | null;
	messages: CommentMessage[];
}

export const MAX_BODY = 5000;
export const MAX_THREADS = 2000;
export const MAX_MESSAGES = 300;
/** How long after deleting a message its author can bring it back (Undo). */
export const RESTORE_MS = 10 * 60_000;

/** Requests from a client, over the board's connection. Ids are made by the client. */
export type CommentRequest =
	| {
			type: "comment-start";
			thread: string;
			message: string;
			anchor: CommentAnchor;
			body: string;
	  }
	| { type: "comment-reply"; thread: string; message: string; body: string }
	| { type: "comment-edit"; thread: string; message: string; body: string }
	| { type: "comment-delete"; thread: string; message: string }
	| { type: "comment-restore"; thread: string; message: string }
	| { type: "comment-resolve"; thread: string; resolved: boolean }
	| { type: "comment-move"; thread: string; anchor: CommentAnchor }
	| { type: "comment-read"; thread: string };

export type CommentRequestType = CommentRequest["type"];

/** Why a request was refused. */
export type CommentRefusal =
	| "signed_out"
	| "archived"
	| "forbidden"
	| "not_found"
	| "invalid"
	| "limit"
	| "busy";

/** What you can do with comments here, and your read state. Sent only to you. */
export interface CommentsYou {
	/** Your user id, if signed in. */
	id: number | null;
	canComment: boolean;
	/** Why not, when you can't. */
	reason?: "signed_out" | "archived" | "no_access";
	/** Whether you can resolve anyone's threads, move anyone's pins (editors and owners). */
	canTriage: boolean;
	/** Whether you can delete anyone's messages (owners). */
	canModerate: boolean;
	/** When you first opened the board: older threads count as read. */
	since: number | null;
	/** When you last read each thread. */
	reads: Record<string, number>;
}

/** Messages from the server about comments. */
export type CommentEvent =
	/** Every thread, in chunks: the first replaces what the client had. */
	| { type: "comments"; threads: CommentThread[]; you: CommentsYou; first: boolean }
	| { type: "comment-thread"; thread: CommentThread }
	| { type: "comment-removed"; thread: string }
	| { type: "comment-reads"; reads: Record<string, number> }
	/** What you can do changed (your role, or the board was archived). */
	| { type: "comments-you"; you: CommentsYou }
	| {
			type: "comment-refused";
			request: CommentRequestType;
			thread: string;
			reason: CommentRefusal;
	  };

export function isCommentRequest(value: unknown): value is CommentRequest {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" && type.startsWith("comment-");
}

// --- Mentions ---------------------------------------------------------------

// A GitHub login after an `@` that isn't part of an email address or path.
const MENTION = /(^|[^\w@/.-])@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})/gi;

/** Every `@login` in a body, lowercase, in order and without repeats. */
export function mentionedLogins(body: string): string[] {
	const found: string[] = [];
	for (const match of body.matchAll(MENTION)) {
		const login = match[2]?.toLowerCase();
		if (login && !found.includes(login)) found.push(login);
	}
	return found;
}

/** The logins a body mentions that are among `people` (lowercase logins). */
export function validMentions(body: string, people: Iterable<string>): string[] {
	const known = new Set([...people].map((login) => login.toLowerCase()));
	return mentionedLogins(body).filter((login) => known.has(login));
}

export type BodyPart = { text: string } | { mention: string; text: string };

/** Split a body into text and the mentions the server checked, for rendering. */
export function bodyParts(body: string, mentions: readonly string[] = []): BodyPart[] {
	if (mentions.length === 0) return [{ text: body }];
	const valid = new Set(mentions);
	const parts: BodyPart[] = [];
	let last = 0;
	for (const match of body.matchAll(MENTION)) {
		const login = match[2]?.toLowerCase() ?? "";
		if (!valid.has(login)) continue;
		const start = (match.index ?? 0) + (match[1]?.length ?? 0);
		if (start > last) parts.push({ text: body.slice(last, start) });
		const text = body.slice(start, start + 1 + (match[2]?.length ?? 0));
		parts.push({ mention: login, text });
		last = start + text.length;
	}
	if (last < body.length) parts.push({ text: body.slice(last) });
	return parts;
}

/**
 * The partial mention being typed at the caret, if any: the query after the
 * `@` and where the `@` is, for the composer's suggestions.
 */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
	const before = text.slice(0, caret);
	const match = /(^|[^\w@/.-])@([a-z\d-]{0,39})$/i.exec(before);
	if (!match) return null;
	const query = match[2] ?? "";
	return { query, start: caret - query.length - 1 };
}

/** Replace the mention being typed with `@login `. Returns the new text and caret. */
export function completeMention(
	text: string,
	caret: number,
	login: string,
): { text: string; caret: number } {
	const at = mentionAt(text, caret);
	if (!at) return { text, caret };
	const insert = `@${login} `;
	const after = text.slice(caret).replace(/^[a-z\d-]*\s?/i, "");
	return { text: text.slice(0, at.start) + insert + after, caret: at.start + insert.length };
}

// --- Reading threads ----------------------------------------------------------

/** Messages that haven't been deleted. */
export function liveMessages(thread: CommentThread): CommentMessage[] {
	return thread.messages.filter((message) => !message.deleted);
}

/** A thread shows while any of its messages is left. */
export function isVisible(thread: CommentThread): boolean {
	return thread.messages.some((message) => !message.deleted);
}

/** Who started a thread: the author of its first message. */
export function starter(thread: CommentThread): CommentAuthor | undefined {
	return thread.messages[0]?.author;
}

/**
 * Whether a thread has something you haven't read: a message from someone
 * else since you last read it (or since you first came to the board).
 */
export function isUnread(
	thread: CommentThread,
	you: Pick<CommentsYou, "id" | "reads" | "since">,
): boolean {
	if (you.id === null) return false;
	const read = you.reads[thread.id] ?? you.since ?? Number.POSITIVE_INFINITY;
	return thread.messages.some(
		(message) => !message.deleted && message.author.id !== you.id && message.at > read,
	);
}

/** Whether a thread mentions a login (in any message still there). */
export function mentions(thread: CommentThread, login: string | undefined): boolean {
	if (!login) return false;
	const lower = login.toLowerCase();
	return liveMessages(thread).some((message) => message.mentions?.includes(lower));
}

/** Whether someone took part: started it or replied. */
export function participated(thread: CommentThread, id: number | null): boolean {
	return id !== null && liveMessages(thread).some((message) => message.author.id === id);
}

export type CommentFilter = "open" | "resolved" | "mentions";

/** Threads for the panel, newest activity first. */
export function filterThreads(
	threads: Iterable<CommentThread>,
	filter: CommentFilter,
	login?: string,
): CommentThread[] {
	return [...threads]
		.filter(isVisible)
		.filter((thread) =>
			filter === "open"
				? !thread.resolved
				: filter === "resolved"
					? !!thread.resolved
					: mentions(thread, login),
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

// --- Pins ---------------------------------------------------------------------

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Where a thread's pin is: on its shape (kept inside it if it shrank), or its point. */
export function pinPosition(anchor: CommentAnchor, box: Box | undefined): { x: number; y: number } {
	if (!anchor.shape || !box) return { x: anchor.x, y: anchor.y };
	const dx = Math.min(Math.max(anchor.dx ?? 0, 0), box.w);
	const dy = Math.min(Math.max(anchor.dy ?? 0, 0), box.h);
	return { x: box.x + dx, y: box.y + dy };
}

/** An anchor for a point: on the shape there, if any. */
export function anchorAt(
	point: { x: number; y: number },
	shape?: { id: string; box: Box },
): CommentAnchor {
	const x = Math.round(point.x);
	const y = Math.round(point.y);
	if (!shape) return { x, y };
	return {
		x,
		y,
		shape: shape.id,
		dx: Math.round(point.x - shape.box.x),
		dy: Math.round(point.y - shape.box.y),
	};
}

/** A body tidied for storing: trimmed, newlines normalised, not too long. */
export function cleanBody(body: string): string {
	return body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_BODY);
}

/** A short excerpt, for notifications and lists. */
export function excerpt(body: string, length = 140): string {
	const flat = body.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
}

export function isAnchor(value: unknown): value is CommentAnchor {
	if (!value || typeof value !== "object") return false;
	const anchor = value as Record<string, unknown>;
	const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e7;
	if (!finite(anchor.x) || !finite(anchor.y)) return false;
	if (anchor.shape === undefined) return true;
	return (
		typeof anchor.shape === "string" &&
		anchor.shape.length > 0 &&
		anchor.shape.length <= 128 &&
		finite(anchor.dx ?? 0) &&
		finite(anchor.dy ?? 0)
	);
}

/** Only the parts of an anchor that mean something. */
export function tidyAnchor(anchor: CommentAnchor): CommentAnchor {
	const x = Math.round(anchor.x);
	const y = Math.round(anchor.y);
	if (!anchor.shape) return { x, y };
	return {
		x,
		y,
		shape: anchor.shape,
		dx: Math.round(anchor.dx ?? 0),
		dy: Math.round(anchor.dy ?? 0),
	};
}

// --- Notifications --------------------------------------------------------------

/** A notification in someone's inbox: a mention, or a reply in a thread they're in. */
export interface Notification {
	id: string;
	kind: "mention" | "reply";
	board: { id: string; slug: string; title: string };
	thread: string;
	by: CommentAuthor;
	excerpt: string;
	at: number;
	read: boolean;
}

/** `GET /api/notifications` */
export interface NotificationList {
	notifications: Notification[];
	unread: number;
}

/** Someone who can be mentioned on a board: `GET /api/boards/:id/people`. */
export interface Mentionable {
	id: number;
	login: string;
	name: string | null;
	avatarUrl: string;
	/** Members have a role; people who've visited a board open to them don't. */
	role: "owner" | "editor" | "viewer" | null;
}
