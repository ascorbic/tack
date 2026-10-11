import type { Connection } from "partyserver";
import type * as Y from "yjs";
import { canEdit } from "../shared/boards.ts";
import {
	type NameCache,
	type StackAi,
	StackNamer,
	type StackMessage,
	type StackRequest,
} from "../shared/stackNamer.ts";
import { aiStatus, stackAi } from "./ai.ts";
import type { ConnectionAccess } from "./board.ts";
import { log } from "./log.ts";

// Stacks on the board's server (#73): names suggested from what's in them,
// and "Group these", asked of Workers AI (src/server/ai.ts) while AI
// suggestions are on (`TACK_AI`, on by default). The naming itself (what's
// sent, when, caching, the budget) is `StackNamer`, shared with the
// playground; here it gets its model, a cache in the board's SQLite, and the
// board's connections: editors ask for groupings, and everyone's told
// whether suggestions are on.

/** Names kept per board. */
const CACHE_ROWS = 1000;

export interface StacksOptions {
	board: string;
	env: Env;
	doc: Y.Doc;
	sql: SqlStorage;
	connections: () => Iterable<Connection<ConnectionAccess>>;
	send: (connection: Connection, message: string) => void;
}

/** Names already made, by the hash of the text they came from, in the board's SQLite. */
function sqlNameCache(sql: SqlStorage): NameCache {
	sql.exec(
		"CREATE TABLE IF NOT EXISTS stack_names (hash TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
	);
	return {
		get: (hash) =>
			sql.exec<{ name: string }>("SELECT name FROM stack_names WHERE hash = ?", hash).toArray()[0]
				?.name ?? null,
		set: (hash, name) => {
			sql.exec(
				"INSERT OR REPLACE INTO stack_names (hash, name, at) VALUES (?, ?, ?)",
				hash,
				name,
				Date.now(),
			);
			sql.exec(
				"DELETE FROM stack_names WHERE hash NOT IN (SELECT hash FROM stack_names ORDER BY at DESC LIMIT ?)",
				CACHE_ROWS,
			);
		},
	};
}

export class Stacks {
	readonly namer: StackNamer;
	/** A grouping in flight per connection: one at a time each. */
	private grouping = new Set<string>();

	constructor(private readonly options: StacksOptions) {
		const { board, doc, sql } = options;
		this.namer = new StackNamer({
			doc,
			ai: () => this.ai(),
			cache: sqlNameCache(sql),
			log: (level, event, context) => log[level](event, { board, ...context }),
		});
		this.namer.start();
	}

	stop(): void {
		this.namer.stop();
	}

	/** Whether suggestions are on (`TACK_AI`, and an AI binding to ask; see ai.ts). */
	enabled(): boolean {
		return aiStatus(this.options.env).state === "on";
	}

	private ai(): StackAi | null {
		return stackAi(this.options.env);
	}

	/** A new connection: whether suggestions are on. */
	connected(connection: Connection<ConnectionAccess>): void {
		this.tell(connection, this.enabled());
	}

	closed(id: string): void {
		this.grouping.delete(id);
	}

	private tell(connection: Connection, enabled: boolean): void {
		this.reply(connection, { type: "stacks-ai", enabled });
	}

	private reply(connection: Connection, message: StackMessage): void {
		try {
			this.options.send(connection, JSON.stringify(message));
		} catch (error) {
			log.warn("board.send.failed", { board: this.options.board, error });
		}
	}

	/** "Group these": stacks proposed for the stickies a connection selected, back to it alone. */
	async receive(connection: Connection<ConnectionAccess>, request: StackRequest): Promise<void> {
		const { board } = this.options;
		const access = connection.state;
		if (!canEdit(access?.role ?? null) || access?.archived) {
			log.warn("stack.group.refused", { board, reason: "not_editor" });
			this.reply(connection, {
				type: "stack-group-failed",
				request: request.request,
				reason: "not_editor",
			});
			return;
		}
		if (this.grouping.has(connection.id)) {
			this.reply(connection, {
				type: "stack-group-failed",
				request: request.request,
				reason: "limited",
			});
			return;
		}
		this.grouping.add(connection.id);
		try {
			const outcome = await this.namer.group(request.ids);
			this.reply(
				connection,
				outcome.ok
					? { type: "stack-groups", request: request.request, stacks: outcome.stacks }
					: { type: "stack-group-failed", request: request.request, reason: outcome.reason },
			);
		} finally {
			this.grouping.delete(connection.id);
		}
	}
}
