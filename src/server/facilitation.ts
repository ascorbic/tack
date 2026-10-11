import type { Connection } from "partyserver";
import type * as Y from "yjs";
import { canEdit } from "../shared/boards.ts";
import {
	type FacilitationMessage,
	type FacilitationRefusal,
	type FacilitationRequest,
	type Spotlight,
	type TimerAction,
	applyTimer,
	readTimer,
} from "../shared/facilitation.ts";
import {
	type FacilitationYou,
	VoteGuard,
	isFacilitator,
	mayChangeTimer,
} from "../shared/facilitator.ts";
import type { Author } from "../shared/shapes.ts";
import type { SilentMessage, SilentRequest } from "../shared/silent.ts";
import { type SilentPeer, SilentHub, type SilentStore, type TextRow } from "../shared/silentHub.ts";
import type { ConnectionAccess } from "./board.ts";
import { log } from "./log.ts";

// Facilitation on the board's server (#50, #49): the clock everyone's timer
// counts against, the timer itself (written into the document with the
// server's time), spotlight (held here, tied to the spotlighter's
// connection), and silent mode's sessions and hidden text, kept in the
// board's SQLite storage and only ever sent to their author (see
// src/shared/silent.ts).

type Request = FacilitationRequest | SilentRequest;
type Message = FacilitationMessage | SilentMessage;

const TYPES = new Set<string>([
	"clock",
	"timer",
	"spotlight",
	"silent-hello",
	"silent-start",
	"silent-text",
	"silent-reveal",
]);

/** A guest's secret is only worth trusting if it's long enough not to guess. */
const MIN_SECRET = 16;

export interface FacilitationHost {
	board: string;
	doc: Y.Doc;
	sql: SqlStorage;
	connections(): Iterable<Connection<ConnectionAccess>>;
	connection(id: string): Connection<ConnectionAccess> | undefined;
	send(connection: Connection, message: string): void;
	persist(): void;
}

export class Facilitation {
	private spotlight: (Spotlight & { connection: string }) | null = null;
	/** Each connection's author key for silent mode, once it's said hello (or is signed in). */
	private authors = new Map<string, string>();
	/** Each connection's requests are handled in order, even those that wait (hashing a secret). */
	private queues = new Map<string, Promise<void>>();
	readonly silent: SilentHub;
	readonly votes: VoteGuard;

	constructor(private readonly host: FacilitationHost) {
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS silent_sessions (
				id TEXT PRIMARY KEY,
				section TEXT NOT NULL,
				starter TEXT NOT NULL,
				started_by TEXT NOT NULL,
				started_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS silent_texts (
				shape TEXT PRIMARY KEY,
				session TEXT NOT NULL,
				owner TEXT NOT NULL,
				text TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		this.silent = new SilentHub({
			doc: host.doc,
			store: sqlSilentStore(host.sql),
			peers: () => this.peers(),
			send: (id, message) => this.sendTo(id, message),
			log: (level, event, context) => log[level](event, { board: host.board, ...context }),
			persist: () => host.persist(),
		});
		// Marks on sections must match the sessions kept here, whatever the
		// document said when it was saved.
		this.silent.reconcile();
		this.votes = new VoteGuard({
			doc: host.doc,
			actor: (origin) => (isConnection(origin) ? this.youOf(origin) : null),
			present: () => this.present(),
			log: (level, event, context) => log[level](event, { board: host.board, ...context }),
		});
	}

	/** Whether a custom message is ours. */
	handles(type: unknown): boolean {
		return typeof type === "string" && TYPES.has(type);
	}

	connected(connection: Connection<ConnectionAccess>): void {
		if (this.spotlight) {
			this.sendTo(connection.id, { type: "spotlight", spotlight: publicSpotlight(this.spotlight) });
		}
		// Signed-in people are known at once; guests say hello with their secret.
		if (connection.state?.userId != null) {
			this.authors.set(connection.id, `u:${connection.state.userId}`);
			this.introduce(connection);
		}
	}

	closed(id: string): void {
		this.authors.delete(id);
		this.queues.delete(id);
		if (this.spotlight?.connection === id) {
			log.info("spotlight.stopped", { board: this.host.board, reason: "left" });
			this.setSpotlight(null);
		}
		this.broadcastPresent();
	}

	/** Someone's role changed: tell them what they may do now. */
	roleChanged(connection: Connection<ConnectionAccess>): void {
		this.sendTo(connection.id, { type: "facilitation-you", ...this.youOf(connection) });
	}

	/** Tell a connection who it is, and everyone who's here. */
	private introduce(connection: Connection<ConnectionAccess>): void {
		this.sendTo(connection.id, { type: "facilitation-you", ...this.youOf(connection) });
		this.broadcastPresent();
	}

	private broadcastPresent(): void {
		const message = JSON.stringify({
			type: "facilitation-present",
			authors: [...this.present()],
		} satisfies Message);
		for (const connection of this.host.connections()) this.host.send(connection, message);
	}

	/** Everyone on the board, by author key. */
	private present(): Set<string> {
		const authors = new Set<string>();
		for (const connection of this.host.connections()) authors.add(this.authorOf(connection));
		return authors;
	}

	private youOf(connection: Connection<ConnectionAccess>): FacilitationYou {
		const role = connection.state?.role ?? null;
		return { author: this.authorOf(connection), editor: canEdit(role), owner: role === "owner" };
	}

	/** Handle a request, after any this connection sent before it. */
	receive(connection: Connection<ConnectionAccess>, request: Request): Promise<void> {
		const queue = (this.queues.get(connection.id) ?? Promise.resolve())
			.then(() => this.handle(connection, request))
			.catch((error: unknown) =>
				log.error("facilitation.failed", { board: this.host.board, request: request.type, error }),
			);
		this.queues.set(connection.id, queue);
		return queue;
	}

	private async handle(connection: Connection<ConnectionAccess>, request: Request): Promise<void> {
		const access = connection.state;
		if (!access) return;
		const editor = canEdit(access.role);
		switch (request.type) {
			case "clock":
				if (typeof request.t === "number") {
					this.sendTo(connection.id, { type: "clock", t: request.t, now: Date.now() });
				}
				return;
			case "timer": {
				if (!editor) return this.refuse(connection, "timer", "not_editor");
				const { type: _type, by, ...command } = request;
				const now = Date.now();
				const you = this.youOf(connection);
				const action = (command as TimerAction).action;
				if (!mayChangeTimer(you, action, readTimer(this.host.doc), this.present(), now)) {
					return this.refuse(connection, "timer", "not_facilitator");
				}
				const author = cleanAuthor(by, access);
				// Their own edit, as far as history goes: "Olive set the timer".
				const changed = applyTimer(
					this.host.doc,
					command as TimerAction,
					now,
					author,
					connection,
					you.author,
				);
				if (!changed) return this.refuse(connection, "timer", "invalid");
				log.info("timer.changed", { board: this.host.board, action });
				const message = JSON.stringify({
					type: "timer-changed",
					action,
					by: author,
					author: you.author,
				} satisfies Message);
				for (const other of this.host.connections()) this.host.send(other, message);
				return;
			}
			case "spotlight": {
				if (!editor) return this.refuse(connection, "spotlight", "not_editor");
				const current = this.spotlight;
				const theirs = current !== null && current.connection !== connection.id;
				// Taking over or ending someone else's is for whoever's running the session.
				const facilitator = () => isFacilitator(this.youOf(connection), this.host.doc, Date.now());
				if (!request.on) {
					if (!current || (theirs && !request.end)) return;
					if (theirs && !facilitator()) {
						return this.refuse(connection, "spotlight", "not_facilitator");
					}
					log.info("spotlight.stopped", {
						board: this.host.board,
						reason: theirs ? "ended" : "stopped",
					});
					this.setSpotlight(null);
					return;
				}
				if (typeof request.clientId !== "number")
					return this.refuse(connection, "spotlight", "invalid");
				if (theirs && !facilitator()) {
					return this.refuse(connection, "spotlight", "not_facilitator");
				}
				log.info("spotlight.started", { board: this.host.board, takeover: theirs });
				this.setSpotlight({
					connection: connection.id,
					clientId: request.clientId,
					user: cleanAuthor(request.user, access),
					since: Date.now(),
				});
				return;
			}
			case "silent-hello": {
				if (access.userId === null) {
					const secret = typeof request.secret === "string" ? request.secret : "";
					this.authors.set(
						connection.id,
						secret.length >= MIN_SECRET ? `a:${await sha256(secret)}` : `c:${connection.id}`,
					);
				}
				this.introduce(connection);
				this.silent.hello(this.peer(connection));
				return;
			}
			case "silent-start":
			case "silent-text":
			case "silent-reveal":
				this.silent.request(this.peer(connection), request);
				return;
		}
	}

	private refuse(connection: Connection, request: string, reason: FacilitationRefusal): void {
		log.warn("facilitation.refused", { board: this.host.board, request, reason });
		this.sendTo(connection.id, { type: "facilitation-refused", request, reason });
	}

	private setSpotlight(spotlight: (Spotlight & { connection: string }) | null): void {
		this.spotlight = spotlight;
		const message = JSON.stringify({
			type: "spotlight",
			spotlight: spotlight && publicSpotlight(spotlight),
		} satisfies Message);
		for (const connection of this.host.connections()) this.host.send(connection, message);
	}

	private peer(connection: Connection<ConnectionAccess>): SilentPeer {
		const access = connection.state;
		return {
			id: connection.id,
			author: this.authorOf(connection),
			canEdit: canEdit(access?.role ?? null),
			owner: access?.role === "owner",
		};
	}

	private authorOf(connection: Connection<ConnectionAccess>): string {
		const known = this.authors.get(connection.id);
		if (known) return known;
		const userId = connection.state?.userId;
		return userId != null ? `u:${userId}` : `c:${connection.id}`;
	}

	private peers(): SilentPeer[] {
		return [...this.host.connections()].map((connection) => this.peer(connection));
	}

	private sendTo(id: string, message: Message): void {
		const connection = this.host.connection(id);
		if (connection) this.host.send(connection, JSON.stringify(message));
	}
}

function isConnection(origin: unknown): origin is Connection<ConnectionAccess> {
	return (
		typeof origin === "object" &&
		origin !== null &&
		typeof (origin as { id?: unknown }).id === "string" &&
		"state" in origin &&
		typeof (origin as { send?: unknown }).send === "function"
	);
}

function publicSpotlight({
	connection: _connection,
	...spotlight
}: Spotlight & { connection: string }) {
	return spotlight;
}

/**
 * Who did something, for "Kai stopped the timer". Signed-in people are who
 * the Worker's access check says, whatever their client claims (#60); only
 * a guest's colour and made-up name come from the client.
 */
function cleanAuthor(by: Author | undefined, access: ConnectionAccess): Author {
	const person = access.person;
	const claimed = typeof by?.name === "string" ? by.name : "";
	const name = (person ? person.name || person.login : claimed).slice(0, 80);
	const color = typeof by?.color === "string" ? by.color.slice(0, 32) : "";
	return { name: name || "Someone", color };
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Silent mode's sessions and hidden text in the board's SQLite storage. */
function sqlSilentStore(sql: SqlStorage): SilentStore {
	type SessionSql = {
		id: string;
		section: string;
		starter: string;
		started_by: string;
		started_at: number;
	};
	type TextSql = {
		shape: string;
		session: string;
		owner: string;
		text: string;
		updated_at: number;
	};
	const text = (row: TextSql): TextRow => ({
		shape: row.shape,
		session: row.session,
		owner: row.owner,
		text: row.text,
		updatedAt: row.updated_at,
	});
	return {
		sessions: () =>
			sql
				.exec<SessionSql>("SELECT * FROM silent_sessions")
				.toArray()
				.map((row) => ({
					id: row.id,
					section: row.section,
					starter: row.starter,
					by: JSON.parse(row.started_by) as Author,
					startedAt: row.started_at,
				})),
		addSession: (row) =>
			void sql.exec(
				"INSERT INTO silent_sessions (id, section, starter, started_by, started_at) VALUES (?, ?, ?, ?, ?)",
				row.id,
				row.section,
				row.starter,
				JSON.stringify(row.by),
				row.startedAt,
			),
		removeSession: (id) => void sql.exec("DELETE FROM silent_sessions WHERE id = ?", id),
		texts: () => sql.exec<TextSql>("SELECT * FROM silent_texts").toArray().map(text),
		text: (shape) => {
			const row = sql
				.exec<TextSql>("SELECT * FROM silent_texts WHERE shape = ?", shape)
				.toArray()[0];
			return row ? text(row) : null;
		},
		putText: (row) =>
			void sql.exec(
				"INSERT OR REPLACE INTO silent_texts (shape, session, owner, text, updated_at) VALUES (?, ?, ?, ?, ?)",
				row.shape,
				row.session,
				row.owner,
				row.text,
				row.updatedAt,
			),
		removeTexts: (session) => void sql.exec("DELETE FROM silent_texts WHERE session = ?", session),
	};
}
