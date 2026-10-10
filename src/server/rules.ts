import type * as Y from "yjs";
import {
	type RepoActivity,
	RULE_ORIGIN,
	type RuleMemory,
	listRules,
	readRulesPause,
	refreshMatches,
	rulesPauseMap,
	runRules,
} from "../shared/rules.ts";
import { type Logger, log } from "./log.ts";

// The rules engine (#44): runs a board's rules (src/shared/rules.ts) on each
// webhook delivery the board hears about, from its `Repo` objects. Rules run
// with the app's access (the data is the delivery's), and only place items
// from repositories already on the board. What they did goes into the
// document with `RULE_ORIGIN`, which nobody can undo, and into the log.
//
// Which items each rule has placed is kept in the board's SQLite storage, so
// a rule never places the same item twice, even after someone removes it,
// and even if the document's log has moved on.
//
// While someone has paused rules for a session (`rulesPause`), deliveries
// are held in storage (the last `HELD_KEEP`), counted in the document, and
// run in order as soon as the rules resume.

/** Deliveries held while rules are paused: the most recent this many. */
export const HELD_KEEP = 200;

export interface RulesHost {
	board: string;
	doc: Y.Doc;
	sql: SqlStorage;
	/** Save the document now, rather than after the usual debounce. */
	persist(): void;
}

export class RulesEngine {
	private readonly memory: RuleMemory;
	private releasing = false;

	constructor(private readonly host: RulesHost) {
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS rule_placed (
				rule TEXT NOT NULL,
				key TEXT NOT NULL,
				at INTEGER NOT NULL,
				PRIMARY KEY (rule, key)
			);
			CREATE TABLE IF NOT EXISTS rule_held (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				activity TEXT NOT NULL
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
		// Resumed: place what was held, straight away.
		rulesPauseMap(host.doc).observe((event) => {
			if (!event.keysChanged.has("paused") || readRulesPause(host.doc)) return;
			queueMicrotask(() => this.resume());
		});
	}

	/**
	 * Run the board's rules on a delivery, and mark (or unmark) the cards an
	 * inbox or rule brought that it shows no longer match. Returns how many
	 * cards the rules placed. While rules are paused, the delivery is held
	 * for when they resume instead.
	 */
	run(activity: RepoActivity): number {
		const logger = log.with({ board: this.host.board, delivery: activity.delivery });
		const marks = refreshMatches(this.host.doc, activity, RULE_ORIGIN);
		if (marks > 0) logger.info("board.matches", { changed: marks });
		let placed = 0;
		if (listRules(this.host.doc).some((rule) => rule.enabled)) {
			if (readRulesPause(this.host.doc)) {
				const held = this.hold(activity);
				logger.info("rule.held", { held });
				this.host.persist();
				return 0;
			}
			// Anything still held from a pause goes first, in the order it came.
			placed = this.release() + this.apply(activity, logger);
		}
		if (placed > 0 || marks > 0) this.host.persist();
		return placed;
	}

	/** Rules resumed: run what was held. Returns how many cards they placed. */
	resume(): number {
		if (readRulesPause(this.host.doc)) return 0;
		const placed = this.release();
		if (placed > 0) this.host.persist();
		return placed;
	}

	/** How many deliveries are held. */
	heldCount(): number {
		return Number(
			this.host.sql.exec("SELECT COUNT(*) AS n FROM rule_held").one().n as number | bigint,
		);
	}

	private hold(activity: RepoActivity): number {
		const { sql, doc } = this.host;
		sql.exec("INSERT INTO rule_held (activity) VALUES (?)", JSON.stringify(activity));
		sql.exec(
			"DELETE FROM rule_held WHERE seq NOT IN (SELECT seq FROM rule_held ORDER BY seq DESC LIMIT ?)",
			HELD_KEEP,
		);
		const held = this.heldCount();
		doc.transact(() => rulesPauseMap(doc).set("held", held), RULE_ORIGIN);
		return held;
	}

	/** Run held deliveries, oldest first, and forget them. */
	private release(): number {
		if (this.releasing) return 0;
		const { sql, doc } = this.host;
		const rows = sql
			.exec<{ seq: number; activity: string }>("SELECT seq, activity FROM rule_held ORDER BY seq")
			.toArray();
		const counted = rulesPauseMap(doc).has("held");
		if (rows.length === 0 && !counted) return 0;
		this.releasing = true;
		let placed = 0;
		try {
			for (const row of rows) {
				sql.exec("DELETE FROM rule_held WHERE seq = ?", row.seq);
				let activity: RepoActivity;
				try {
					activity = JSON.parse(row.activity) as RepoActivity;
				} catch {
					continue;
				}
				const logger = log.with({ board: this.host.board, delivery: activity.delivery });
				placed += this.apply(activity, logger);
			}
			if (rulesPauseMap(doc).has("held")) {
				doc.transact(() => rulesPauseMap(doc).delete("held"), RULE_ORIGIN);
			}
		} finally {
			this.releasing = false;
		}
		if (rows.length > 0) {
			log.info("rule.released", { board: this.host.board, deliveries: rows.length, placed });
		}
		return placed;
	}

	private apply(activity: RepoActivity, logger: Logger): number {
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
		return entries.filter((entry) => entry.outcome === "placed").length;
	}
}
