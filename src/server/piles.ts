import type { Connection } from "partyserver";
import type * as Y from "yjs";
import { canEdit } from "../shared/boards.ts";
import {
	type NameCache,
	type PileAi,
	PileNamer,
	type PileMessage,
	type PileRequest,
} from "../shared/pileNamer.ts";
import { hasAi, workersAi } from "./ai.ts";
import type { ConnectionAccess } from "./board.ts";
import { log } from "./log.ts";
import { instance } from "./namespaces.ts";

// Piles on the board's server (#73): names suggested from what's in them,
// and "Group these", asked of Workers AI (src/server/ai.ts) when an admin has
// turned AI suggestions on at /setup. The naming itself (what's sent, when,
// caching, the budget) is `PileNamer`, shared with the playground; here it
// gets its model, a cache in the board's SQLite, the instance's setting, and
// the board's connections: editors ask for groupings, and everyone's told
// whether suggestions are on.

/** How long to believe the instance's setting. */
const SETTING_TTL_MS = 30_000;
/** Names kept per board. */
const CACHE_ROWS = 1000;

export interface PilesOptions {
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
		"CREATE TABLE IF NOT EXISTS pile_names (hash TEXT PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)",
	);
	return {
		get: (hash) =>
			sql.exec<{ name: string }>("SELECT name FROM pile_names WHERE hash = ?", hash).toArray()[0]
				?.name ?? null,
		set: (hash, name) => {
			sql.exec(
				"INSERT OR REPLACE INTO pile_names (hash, name, at) VALUES (?, ?, ?)",
				hash,
				name,
				Date.now(),
			);
			sql.exec(
				"DELETE FROM pile_names WHERE hash NOT IN (SELECT hash FROM pile_names ORDER BY at DESC LIMIT ?)",
				CACHE_ROWS,
			);
		},
	};
}

export class Piles {
	readonly namer: PileNamer;
	private setting: { enabled: boolean; until: number } | null = null;
	/** A grouping in flight per connection: one at a time each. */
	private grouping = new Set<string>();

	constructor(private readonly options: PilesOptions) {
		const { board, doc, sql } = options;
		this.namer = new PileNamer({
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

	/** Whether suggestions are on: this Worker has Workers AI, and an admin's turned them on. */
	async enabled(fresh = false): Promise<boolean> {
		const now = Date.now();
		if (!fresh && this.setting && this.setting.until > now) return this.setting.enabled;
		let enabled = false;
		if (hasAi(this.options.env) && this.options.env.TACK_SECRET) {
			try {
				enabled = (await instance(this.options.env).aiSuggestions()).enabled;
			} catch (error) {
				log.warn("pile.setting.failed", { board: this.options.board, error });
				enabled = this.setting?.enabled ?? false;
			}
		}
		const was = this.setting?.enabled;
		this.setting = { enabled, until: now + SETTING_TTL_MS };
		if (was !== undefined && was !== enabled) {
			// Turned on or off since: tell everyone, and name what's waiting.
			for (const connection of this.options.connections()) this.tell(connection, enabled);
			if (enabled) this.namer.schedule(0);
		}
		return enabled;
	}

	private async ai(): Promise<PileAi | null> {
		return (await this.enabled()) ? workersAi(this.options.env) : null;
	}

	/** A new connection: whether suggestions are on. */
	connected(connection: Connection<ConnectionAccess>): void {
		void this.enabled().then((enabled) => this.tell(connection, enabled));
	}

	closed(id: string): void {
		this.grouping.delete(id);
	}

	private tell(connection: Connection, enabled: boolean): void {
		this.reply(connection, { type: "piles-ai", enabled });
	}

	private reply(connection: Connection, message: PileMessage): void {
		try {
			this.options.send(connection, JSON.stringify(message));
		} catch (error) {
			log.warn("board.send.failed", { board: this.options.board, error });
		}
	}

	/** "Group these": piles proposed for the stickies a connection selected, back to it alone. */
	async receive(connection: Connection<ConnectionAccess>, request: PileRequest): Promise<void> {
		const { board } = this.options;
		const access = connection.state;
		if (!canEdit(access?.role ?? null) || access?.archived) {
			log.warn("pile.group.refused", { board, reason: "not_editor" });
			this.reply(connection, {
				type: "pile-group-failed",
				request: request.request,
				reason: "not_editor",
			});
			return;
		}
		if (this.grouping.has(connection.id)) {
			this.reply(connection, {
				type: "pile-group-failed",
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
					? { type: "pile-groups", request: request.request, piles: outcome.piles }
					: { type: "pile-group-failed", request: request.request, reason: outcome.reason },
			);
		} finally {
			this.grouping.delete(connection.id);
		}
	}
}
