import type * as Y from "yjs";
import { type Author, readShape, shapesMap } from "./shapes.ts";

// Silent mode (#49): a section where everyone writes stickies on their own,
// each person seeing only theirs (others' lie face down) until it's revealed.
//
// The guarantee is that hidden text never reaches anyone but its author, and
// a shared Yjs document can't keep a secret: every update goes to everyone,
// and filtering updates per viewer isn't something Yjs can do. So silent
// stickies' text never goes into the document at all:
//
// - Starting silent mode is a request to the board's server, which records a
//   session (in its SQLite storage) and marks the section with it (`silent`,
//   a `SilentSession`).
// - A sticky made inside a silent section is marked with the session's id
//   (`silent` on the sticky) and has no `text` in the document. Its author's
//   client sends what they type to the server (`silent-text`), which keeps it
//   per author, and sends it back only to that author's connections (their
//   other tabs, and when they reconnect). Everyone else sees the shape (a
//   face-down sticky, with its author's name and colour) and nothing more.
// - Revealing (`silent-reveal`) is the server writing every kept text into
//   the document and clearing the marks, in one transaction, so every sticky
//   turns over at once.
//
// What decides whether a sticky is silent is its own `silent` key, set when
// it's made, never where it is: a silent sticky dragged out of the section
// stays face down until the reveal, and stickies that were in the section
// before silent mode began (or are dragged in) stay face up, since everyone
// has already seen them. A sticky a client makes before it hears that the
// section has gone silent is an ordinary sticky.
//
// Clients only ever learn others' hidden text from the document, at the
// reveal. Writing text into the document is always the client's own choice,
// so no client can expose anyone else's hidden text: it never has it.

/** The transaction origin for the server's silent-mode writes (never undoable). */
export const SILENT_ORIGIN = "silent";

/** A section's silent session, as written on the section by the server. */
export interface SilentSession {
	id: string;
	/** Who started it (the facilitator). */
	by: Author;
	/** When, ISO 8601. */
	at: string;
}

/** The most text a silent sticky keeps. */
export const SILENT_MAX_TEXT = 4000;

/** Requests from clients. */
export type SilentRequest =
	/**
	 * Say who you are, for a guest without sign-in: a random secret kept in
	 * the browser, so your hidden text finds you again after a reload.
	 */
	| { type: "silent-hello"; secret?: string }
	| { type: "silent-start"; section: string; by: Author }
	/** Your text for one of your silent stickies (the first message claims it). */
	| { type: "silent-text"; shape: string; text: string }
	| { type: "silent-reveal"; session: string };

/** Messages from the server, to one connection only. */
export type SilentMessage =
	/** Your own hidden texts, by shape. `replace` means this is all of them. */
	| { type: "silent-texts"; texts: Record<string, string>; replace?: boolean }
	| {
			type: "silent-refused";
			request: SilentRequest["type"];
			shape?: string;
			reason: SilentRefusal;
	  };

export type SilentRefusal =
	| "not_editor"
	| "not_section"
	| "already_silent"
	| "not_silent"
	| "not_yours"
	| "not_facilitator"
	| "invalid";

export function parseSession(value: unknown): SilentSession | null {
	if (typeof value !== "object" || value === null) return null;
	const session = value as Partial<SilentSession>;
	return typeof session.id === "string" && typeof session.by === "object" && session.by !== null
		? (session as SilentSession)
		: null;
}

/** The silent session a sticky belongs to, if it's face down. */
export function silentOf(shape: { type?: unknown; silent?: unknown } | undefined): string | null {
	return shape?.type === "sticky" && typeof shape.silent === "string" ? shape.silent : null;
}

/**
 * The silent session a new sticky inside `parent` joins: the nearest silent
 * section around it, if any.
 */
export function sessionAt(doc: Y.Doc, parent: string | null | undefined): SilentSession | null {
	const shapes = shapesMap(doc);
	const seen = new Set<string>();
	let id = parent ?? null;
	while (id && !seen.has(id)) {
		seen.add(id);
		const section = shapes.get(id);
		if (!section || section.get("type") !== "section") return null;
		const session = parseSession(section.get("silent"));
		if (session) return session;
		const next = section.get("parent");
		id = typeof next === "string" ? next : null;
	}
	return null;
}

/**
 * Mark a sticky just made as silent if it landed in a silent section, and
 * keep its text out of the document. Call in the transaction that makes it,
 * after placing it in sections. Returns the session, if it joined one.
 */
export function joinSilentSession(doc: Y.Doc, id: string): string | null {
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("type") !== "sticky") return null;
	const session = sessionAt(doc, shape.get("parent") as string | null | undefined);
	if (!session) return null;
	shape.set("silent", session.id);
	if (shape.has("text")) shape.delete("text");
	return session.id;
}

/** One person's face-down stickies in a session. */
export interface FaceDownCount {
	name: string;
	color: string;
	count: number;
}

/** How many face-down stickies each person has in a session, most first. */
export function faceDownCounts(doc: Y.Doc, session: string): FaceDownCount[] {
	const counts = new Map<string, FaceDownCount>();
	for (const shape of shapesMap(doc).values()) {
		if (shape.get("silent") !== session || shape.get("type") !== "sticky") continue;
		const author = readShape(shape).author;
		const name = author?.name || "Someone";
		const key = `${name}\n${author?.color ?? ""}`;
		const count = counts.get(key) ?? { name, color: author?.color ?? "", count: 0 };
		count.count++;
		counts.set(key, count);
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Every silent session marked on a section, by session id → section id. */
export function silentSections(doc: Y.Doc): Map<string, string> {
	const sections = new Map<string, string>();
	for (const [id, shape] of shapesMap(doc)) {
		if (shape.get("type") !== "section") continue;
		const session = parseSession(shape.get("silent"));
		if (session) sections.set(session.id, id);
	}
	return sections;
}
