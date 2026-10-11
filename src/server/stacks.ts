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
import { fakeStackAi } from "../shared/fakeStackAi.ts";
import {
	GROUP_SCHEMA,
	GROUP_SYSTEM,
	NAME_SCHEMA,
	NAME_SYSTEM,
	groupMessage,
	nameMessage,
} from "../shared/stackNaming.ts";
import { stackMembers } from "../shared/stacks.ts";
import { readShapes } from "../shared/structure.ts";
import { aiStatus, askModel } from "./ai.ts";
import type { ConnectionAccess } from "./board.ts";
import { log } from "./log.ts";

// Stacks on the board's server (#73): names suggested from what's in them
// (stickies' visible text, and the titles of cards that everyone who can see
// the board can read: the name is everyone's, so it mustn't carry a title
// some of them can't see; the board decides, with `cardTitles`),
// and "Group these", asked of Workers AI (`askModel`, src/server/ai.ts) while AI
// suggestions are on (`TACK_AI`, on by default). The naming itself (what's
// sent, when, caching, the budget) is `StackNamer`, shared with the
// playground; here it gets its model, a cache in the board's SQLite, and the
// board's connections: editors ask for groupings, and everyone's told
// whether suggestions are on.

/** Most tokens an answer may take: a name is a few, a grouping of sixty stickies a few hundred. */
const MAX_TOKENS = { name: 48, group: 1500 } as const;

/** What names stacks here: Workers AI, local development's stand-in, or null when suggestions are off. */
export function stackAi(env: Env): StackAi | null {
	const status = aiStatus(env);
	if (status.provider === "fake") return fakeStackAi();
	if (status.provider !== "workers-ai") return null;
	return {
		name: (texts) =>
			askModel(env, {
				system: NAME_SYSTEM,
				user: nameMessage(texts),
				schema: NAME_SCHEMA,
				schemaName: "stack_name",
				maxTokens: MAX_TOKENS.name,
			}),
		group: (notes) =>
			askModel(env, {
				system: GROUP_SYSTEM,
				user: groupMessage(notes),
				schema: GROUP_SCHEMA,
				schemaName: "stack_groups",
				maxTokens: MAX_TOKENS.group,
			}),
	};
}

/** Names kept per board. */
const CACHE_ROWS = 1000;

export interface StacksOptions {
	board: string;
	env: Env;
	doc: Y.Doc;
	sql: SqlStorage;
	connections: () => Iterable<Connection<ConnectionAccess>>;
	send: (connection: Connection, message: string) => void;
	/**
	 * The titles of these cards that everyone who can see the board can read
	 * (`Board.sharedTitles`): only those go into names, which everyone sees.
	 */
	cardTitles?: (refs: readonly string[]) => Promise<ReadonlyMap<string, string>>;
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
			cardTitles: options.cardTitles,
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

	/** Cards' data changed: a stack with one of them in may read differently now. */
	cardsChanged(keys: readonly string[]): void {
		if (keys.length === 0) return;
		const changed = new Set(keys);
		const shapes = readShapes(this.options.doc);
		for (const members of stackMembers(shapes).values()) {
			for (const id of members) {
				const ref = shapes.get(id)?.ref;
				if (typeof ref === "string" && changed.has(ref)) {
					this.namer.schedule();
					return;
				}
			}
		}
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
					? {
							type: "stack-groups",
							request: request.request,
							stacks: outcome.stacks,
							...(outcome.withheld > 0 ? { withheld: outcome.withheld } : {}),
						}
					: { type: "stack-group-failed", request: request.request, reason: outcome.reason },
			);
		} finally {
			this.grouping.delete(connection.id);
		}
	}
}
