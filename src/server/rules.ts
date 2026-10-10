import type * as Y from "yjs";
import {
	type RepoActivity,
	RULE_ORIGIN,
	type RuleMemory,
	listRules,
	refreshMatches,
	runRules,
} from "../shared/rules.ts";
import { log } from "./log.ts";

// The rules engine (#44): runs a board's rules (src/shared/rules.ts) on each
// webhook delivery the board hears about, from its `Repo` objects. Rules run
// with the app's access (the data is the delivery's), and only place items
// from repositories already on the board. What they did goes into the
// document with `RULE_ORIGIN`, which nobody can undo, and into the log.
//
// Which items each rule has placed is kept in the board's SQLite storage, so
// a rule never places the same item twice, even after someone removes it,
// and even if the document's log has moved on.

export interface RulesHost {
	board: string;
	doc: Y.Doc;
	sql: SqlStorage;
	/** Save the document now, rather than after the usual debounce. */
	persist(): void;
}

export class RulesEngine {
	private readonly memory: RuleMemory;

	constructor(private readonly host: RulesHost) {
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS rule_placed (
				rule TEXT NOT NULL,
				key TEXT NOT NULL,
				at INTEGER NOT NULL,
				PRIMARY KEY (rule, key)
			);
		`);
		this.memory = {
			placed: (rule, key) =>
				host.sql.exec("SELECT 1 FROM rule_placed WHERE rule = ? AND key = ?", rule, key).toArray()
					.length > 0,
			remember: (rule, key) =>
				void host.sql.exec(
					"INSERT OR IGNORE INTO rule_placed (rule, key, at) VALUES (?, ?, ?)",
					rule,
					key,
					Date.now(),
				),
		};
	}

	/**
	 * Run the board's rules on a delivery, and mark (or unmark) the cards an
	 * inbox or rule brought that it shows no longer match. Returns how many
	 * cards the rules placed.
	 */
	run(activity: RepoActivity): number {
		const logger = log.with({ board: this.host.board, delivery: activity.delivery });
		const marks = refreshMatches(this.host.doc, activity, RULE_ORIGIN);
		if (marks > 0) logger.info("board.matches", { changed: marks });
		if (!listRules(this.host.doc).some((rule) => rule.enabled)) return 0;
		const entries = runRules(this.host.doc, activity, this.memory, { origin: RULE_ORIGIN });
		for (const entry of entries) {
			(entry.outcome === "placed" ? logger.info : logger.warn)(`rule.${entry.outcome}`, {
				rule: entry.rule,
				item: entry.key,
				near: entry.near ?? null,
				section: entry.section ?? null,
				reason: entry.reason ?? null,
			});
		}
		const placed = entries.filter((entry) => entry.outcome === "placed").length;
		if (placed > 0 || marks > 0) this.host.persist();
		return placed;
	}
}
