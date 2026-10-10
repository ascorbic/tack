import type * as Y from "yjs";
import { type Author, shapesMap } from "./shapes.ts";
import {
	SILENT_MAX_TEXT,
	SILENT_ORIGIN,
	type SilentMessage,
	type SilentRefusal,
	type SilentRequest,
	type SilentSession,
	parseSession,
} from "./silent.ts";

// The server side of silent mode (see silent.ts for the design), written
// once for the board's Durable Object (SQLite storage, real connections) and
// the playground's pretend server (memory, simulated people). Hidden text
// only ever goes out through `send` to the connections of the person who
// wrote it, and into the document at the reveal.

/** Someone connected: who they are as an author, and what they may do. */
export interface SilentPeer {
	/** Their connection. */
	id: string;
	/**
	 * Who they are, for owning hidden text: a GitHub user id, a guest's
	 * secret (hashed), or failing both just this connection.
	 */
	author: string;
	canEdit: boolean;
	/** Board owners can always reveal. */
	owner: boolean;
}

export interface SessionRow {
	id: string;
	section: string;
	/** The author key of whoever started it. */
	starter: string;
	by: Author;
	startedAt: number;
}

export interface TextRow {
	shape: string;
	session: string;
	owner: string;
	text: string;
	updatedAt: number;
}

/** Where sessions and hidden text are kept. */
export interface SilentStore {
	sessions(): SessionRow[];
	addSession(row: SessionRow): void;
	removeSession(id: string): void;
	texts(): TextRow[];
	text(shape: string): TextRow | null;
	putText(row: TextRow): void;
	removeTexts(session: string): void;
}

export interface SilentHost {
	doc: Y.Doc;
	store: SilentStore;
	/** Who's connected now. */
	peers(): SilentPeer[];
	send(peer: string, message: SilentMessage): void;
	log?(level: "info" | "warn", event: string, context: Record<string, unknown>): void;
	/** Save the document now (after a reveal, say). */
	persist?(): void;
	now?(): number;
}

export class SilentHub {
	private reconciling = false;

	constructor(private readonly host: SilentHost) {
		const shapes = shapesMap(host.doc);
		shapes.observeDeep((events, transaction) => {
			if (transaction.origin === SILENT_ORIGIN) return;
			// A mark changed, or shapes came and went (a section's undo can bring
			// its mark back) while there are sessions to keep marked.
			const touched =
				events.some((event) => event.changes.keys.has("silent")) ||
				(events.some((event) => event.target === shapes) && host.store.sessions().length > 0);
			if (touched) this.scheduleReconcile();
		});
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	/** A connection said who it is: send it its own hidden text. */
	hello(peer: SilentPeer): void {
		const texts: Record<string, string> = {};
		const live = new Set(this.host.store.sessions().map((s) => s.id));
		for (const row of this.host.store.texts()) {
			if (row.owner === peer.author && live.has(row.session)) texts[row.shape] = row.text;
		}
		this.host.send(peer.id, { type: "silent-texts", texts, replace: true });
	}

	request(peer: SilentPeer, request: SilentRequest): void {
		switch (request.type) {
			case "silent-start":
				if (typeof request.section === "string") this.start(peer, request.section, request.by);
				return;
			case "silent-text":
				if (typeof request.shape === "string" && typeof request.text === "string") {
					this.text(peer, request.shape, request.text);
				}
				return;
			case "silent-reveal":
				if (typeof request.session === "string") this.reveal(peer, request.session);
				return;
		}
	}

	private refuse(
		peer: SilentPeer,
		request: SilentRequest["type"],
		reason: SilentRefusal,
		shape?: string,
	): false {
		this.host.log?.("warn", "silent.refused", { request, reason });
		this.host.send(peer.id, {
			type: "silent-refused",
			request,
			reason,
			...(shape ? { shape } : {}),
		});
		return false;
	}

	start(peer: SilentPeer, section: string, by: Author | undefined): boolean {
		if (!peer.canEdit) return this.refuse(peer, "silent-start", "not_editor");
		const shape = shapesMap(this.host.doc).get(section);
		if (!shape || shape.get("type") !== "section") {
			return this.refuse(peer, "silent-start", "not_section");
		}
		if (this.host.store.sessions().some((s) => s.section === section)) {
			return this.refuse(peer, "silent-start", "already_silent");
		}
		const now = this.now();
		const row: SessionRow = {
			id: crypto.randomUUID(),
			section,
			starter: peer.author,
			by: cleanAuthor(by),
			startedAt: now,
		};
		this.host.store.addSession(row);
		this.host.doc.transact(() => shape.set("silent", markOf(row)), SILENT_ORIGIN);
		this.host.log?.("info", "silent.started", { session: row.id, section });
		return true;
	}

	text(peer: SilentPeer, id: string, text: string): boolean {
		if (!peer.canEdit) return this.refuse(peer, "silent-text", "not_editor", id);
		const shape = shapesMap(this.host.doc).get(id);
		const session = shape?.get("silent");
		if (!shape || shape.get("type") !== "sticky" || typeof session !== "string") {
			return this.refuse(peer, "silent-text", "not_silent", id);
		}
		if (!this.host.store.sessions().some((s) => s.id === session)) {
			return this.refuse(peer, "silent-text", "not_silent", id);
		}
		const existing = this.host.store.text(id);
		if (existing && existing.owner !== peer.author) {
			return this.refuse(peer, "silent-text", "not_yours", id);
		}
		const clean = text.slice(0, SILENT_MAX_TEXT);
		this.host.store.putText({
			shape: id,
			session,
			owner: peer.author,
			text: clean,
			updatedAt: this.now(),
		});
		// Their other tabs: never anyone else's.
		for (const other of this.host.peers()) {
			if (other.author === peer.author && other.id !== peer.id) {
				this.host.send(other.id, { type: "silent-texts", texts: { [id]: clean } });
			}
		}
		return true;
	}

	/**
	 * Whether someone may reveal a session: whoever started it, the board's
	 * owner, or, once the facilitator has left, any editor, so a session is
	 * never stuck face down.
	 */
	canReveal(peer: SilentPeer, session: SessionRow): boolean {
		if (!peer.canEdit) return false;
		if (peer.author === session.starter || peer.owner) return true;
		return !this.host.peers().some((p) => p.author === session.starter);
	}

	reveal(peer: SilentPeer, id: string): boolean {
		const session = this.host.store.sessions().find((s) => s.id === id);
		if (!session) return this.refuse(peer, "silent-reveal", "not_silent");
		if (!peer.canEdit) return this.refuse(peer, "silent-reveal", "not_editor");
		if (!this.canReveal(peer, session)) {
			return this.refuse(peer, "silent-reveal", "not_facilitator");
		}
		const texts = this.host.store.texts().filter((row) => row.session === id);
		const shapes = shapesMap(this.host.doc);
		let turned = 0;
		this.host.doc.transact(() => {
			for (const row of texts) {
				const shape = shapes.get(row.shape);
				if (shape?.get("silent") !== id) continue;
				shape.set("text", row.text);
				shape.delete("silent");
				turned++;
			}
			// Stickies nobody wrote in turn over empty.
			for (const shape of shapes.values()) {
				if (shape.get("silent") === id) {
					shape.delete("silent");
					if (!shape.has("text")) shape.set("text", "");
					turned++;
				}
			}
			const section = shapes.get(session.section);
			if (parseSession(section?.get("silent"))?.id === id) section?.delete("silent");
		}, SILENT_ORIGIN);
		this.host.store.removeTexts(id);
		this.host.store.removeSession(id);
		this.host.log?.("info", "silent.revealed", {
			session: id,
			section: session.section,
			stickies: turned,
		});
		this.host.persist?.();
		return true;
	}

	private scheduleReconcile(): void {
		if (this.reconciling) return;
		this.reconciling = true;
		queueMicrotask(() => {
			this.reconciling = false;
			this.reconcile();
		});
	}

	/**
	 * Keep sections' marks in step with the sessions this server holds:
	 * marks nobody started here are removed, and sessions whose mark was
	 * lost are marked again. (Clients can write to the document, but only
	 * the server starts and ends silent mode.)
	 */
	reconcile(): number {
		const sessions = new Map(this.host.store.sessions().map((s) => [s.section, s]));
		const fixes: (() => void)[] = [];
		for (const [id, shape] of shapesMap(this.host.doc)) {
			if (shape.get("type") !== "section") continue;
			const marked = parseSession(shape.get("silent"));
			const session = sessions.get(id);
			if (session && (marked?.id !== session.id || marked.starter !== session.starter))
				fixes.push(() => shape.set("silent", markOf(session)));
			else if (!session && shape.has("silent")) fixes.push(() => shape.delete("silent"));
		}
		if (fixes.length === 0) return 0;
		this.host.doc.transact(() => {
			for (const fix of fixes) fix();
		}, SILENT_ORIGIN);
		this.host.log?.("warn", "silent.reconciled", { fixed: fixes.length });
		return fixes.length;
	}
}

function markOf(row: SessionRow): SilentSession {
	return {
		id: row.id,
		by: row.by,
		starter: row.starter,
		at: new Date(row.startedAt).toISOString(),
	};
}

function cleanAuthor(by: Author | undefined): Author {
	const name = typeof by?.name === "string" ? by.name.slice(0, 80) : "";
	const color = typeof by?.color === "string" ? by.color.slice(0, 32) : "";
	return { name: name || "Someone", color };
}

/** An in-memory store, for the playground and unit tests. */
export class MemorySilentStore implements SilentStore {
	private rows = new Map<string, SessionRow>();
	private textRows = new Map<string, TextRow>();
	sessions = () => [...this.rows.values()];
	addSession = (row: SessionRow) => void this.rows.set(row.id, row);
	removeSession = (id: string) => void this.rows.delete(id);
	texts = () => [...this.textRows.values()];
	text = (shape: string) => this.textRows.get(shape) ?? null;
	putText = (row: TextRow) => void this.textRows.set(row.shape, row);
	removeTexts = (session: string) => {
		for (const [shape, row] of this.textRows)
			if (row.session === session) this.textRows.delete(shape);
	};
}
