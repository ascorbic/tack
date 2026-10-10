// Since you were here (#46) on the board's server: what's needed to say
// what changed between someone's visits, kept cheap for big boards and long
// absences.
//
// - `ChangeLog` watches the document and remembers, for each shape and kind
//   of change (added, moved, changed, removed), only the latest: when and by
//   whom. So it holds at most a few rows per shape, whatever happens, and
//   "since Tuesday" is one indexed query. Writes are buffered and flushed
//   with the document's own saves. Rows for shapes removed long ago are
//   pruned.
// - `CardHistory` keeps a few snapshots of each card on the board (state,
//   comment count, CI, review), added only when one of those changes, so a
//   digest can compare what a card was then with what it is now.
// - `Visits` remembers, per signed-in person, when they first came, when
//   they were last here, and the visit their digest is since. A new visit
//   starts after `VISIT_GAP_MS` away, so reloading doesn't empty the digest.
//   Signed-out people keep their last visit in their browser and say when.

import type * as Y from "yjs";
import type { Card } from "../shared/cards.ts";
import {
	type Actor,
	type CardActivity,
	type CardSnapshot,
	type EditEntry,
	type EditKind,
	MAX_DIGEST_EDITS,
	VISIT_GAP_MS,
	cardActivity,
	isNews,
	sameSnapshot,
	shapeChanges,
	snapshotOf,
} from "../shared/since.ts";
import { shapesMap } from "../shared/shapes.ts";

/** Removed shapes are forgotten after this long. */
const REMOVED_TTL_MS = 90 * 24 * 60 * 60_000;
/** Snapshots kept per card. */
const CARD_HISTORY = 12;

export interface ChangeLogDeps {
	sql: SqlStorage;
	doc: Y.Doc;
	/** Who made a transaction, from its origin; null to leave it out (repairs). */
	actorOf: (origin: unknown) => Actor | null;
	/** A shape moved (its new x and y), or was removed. */
	onMoved?: (shape: string, at: { x: number; y: number }) => void;
	onRemoved?: (shape: string) => void;
}

interface Pending {
	shape: string;
	kind: EditKind;
	type: string;
	at: number;
	by: Actor;
}

export class ChangeLog {
	private pending = new Map<string, Pending>();
	/** Shape types, so removals can say what was removed. */
	private types = new Map<string, string>();

	constructor(private deps: ChangeLogDeps) {
		deps.sql.exec(`
			CREATE TABLE IF NOT EXISTS since_edits (
				shape TEXT NOT NULL,
				kind TEXT NOT NULL,
				type TEXT NOT NULL,
				at INTEGER NOT NULL,
				actor TEXT NOT NULL,
				actor_id INTEGER,
				PRIMARY KEY (shape, kind)
			);
			CREATE INDEX IF NOT EXISTS since_edits_at ON since_edits (at);
		`);
		deps.sql.exec(
			"DELETE FROM since_edits WHERE kind = 'removed' AND at < ?",
			Date.now() - REMOVED_TTL_MS,
		);
		const shapes = shapesMap(deps.doc);
		for (const [id, shape] of shapes) this.types.set(id, typeOf(shape));
		shapes.observeDeep((events, transaction) => this.observe(events, transaction));
	}

	private observe(events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction): void {
		const shapes = shapesMap(this.deps.doc);
		const by = this.deps.actorOf(transaction.origin);
		const now = Date.now();
		const { changes, moved } = shapeChanges(events, shapes);
		for (const { shape, kind } of changes) {
			if (kind === "removed") {
				if (by) this.note(shape, kind, now, by);
				this.types.delete(shape);
				this.deps.onRemoved?.(shape);
				continue;
			}
			if (kind === "added" || !this.types.has(shape))
				this.types.set(shape, typeOf(shapes.get(shape)));
			if (by) this.note(shape, kind, now, by);
		}
		for (const id of moved) {
			const shape = shapes.get(id);
			const x = shape?.get("x");
			const y = shape?.get("y");
			if (typeof x === "number" && typeof y === "number") this.deps.onMoved?.(id, { x, y });
		}
	}

	private note(shape: string, kind: EditKind, at: number, by: Actor): void {
		const type = this.types.get(shape) ?? "shape";
		if (!isNews(type, kind)) return;
		this.pending.set(`${shape}\u0000${kind}`, { shape, kind, type, at, by });
	}

	/** Write buffered changes to storage: with every save, and before reading. */
	flush(): void {
		if (this.pending.size === 0) return;
		const { sql } = this.deps;
		for (const entry of this.pending.values()) {
			if (entry.kind === "removed") {
				// Only the removal is worth remembering about a removed shape.
				sql.exec("DELETE FROM since_edits WHERE shape = ?", entry.shape);
			} else if (entry.kind === "added") {
				sql.exec("DELETE FROM since_edits WHERE shape = ? AND kind = 'removed'", entry.shape);
			}
			sql.exec(
				`INSERT OR REPLACE INTO since_edits (shape, kind, type, at, actor, actor_id)
				VALUES (?, ?, ?, ?, ?, ?)`,
				entry.shape,
				entry.kind,
				entry.type,
				entry.at,
				JSON.stringify(entry.by),
				entry.by.id ?? null,
			);
		}
		this.pending.clear();
	}

	/** Edits since a time, by anyone but `except`, newest first. */
	since(at: number, except: number | null): { edits: EditEntry[]; more: number } {
		this.flush();
		const { sql } = this.deps;
		const others = except === null ? "" : "AND (actor_id IS NULL OR actor_id != ?)";
		const bind = except === null ? [at] : [at, except];
		const rows = sql
			.exec<{ shape: string; kind: string; type: string; at: number; actor: string }>(
				`SELECT shape, kind, type, at, actor FROM since_edits WHERE at > ? ${others}
				ORDER BY at DESC LIMIT ?`,
				...bind,
				MAX_DIGEST_EDITS,
			)
			.toArray();
		const total =
			rows.length < MAX_DIGEST_EDITS
				? rows.length
				: (sql
						.exec<{ n: number }>(
							`SELECT count(*) AS n FROM since_edits WHERE at > ? ${others}`,
							...bind,
						)
						.one().n ?? rows.length);
		// A shape added since then was new: its moves and edits since are part of that.
		const added = new Set(rows.filter((row) => row.kind === "added").map((row) => row.shape));
		const edits = rows
			.filter((row) => row.kind === "added" || row.kind === "removed" || !added.has(row.shape))
			.map((row) => ({
				shape: row.shape,
				kind: row.kind as EditKind,
				type: row.type,
				at: row.at,
				by: JSON.parse(row.actor) as Actor,
			}));
		return { edits, more: Math.max(0, total - rows.length) };
	}
}

function typeOf(shape: Y.Map<unknown> | undefined): string {
	const type = shape?.get("type");
	return typeof type === "string" ? type : "shape";
}

export class CardHistory {
	private latest = new Map<string, CardSnapshot>();

	constructor(private sql: SqlStorage) {
		sql.exec(`
			CREATE TABLE IF NOT EXISTS card_history (
				key TEXT NOT NULL,
				at INTEGER NOT NULL,
				snapshot TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS card_history_key ON card_history (key, at);
		`);
	}

	/** Cards arrived from their repositories: remember any that changed. */
	record(cards: Card[], at = Date.now()): void {
		for (const card of cards) {
			const snapshot = snapshotOf(card);
			const previous = this.latestOf(card.key);
			if (previous && sameSnapshot(previous, snapshot)) continue;
			this.latest.set(card.key, snapshot);
			this.sql.exec(
				"INSERT INTO card_history (key, at, snapshot) VALUES (?, ?, ?)",
				card.key,
				at,
				JSON.stringify(snapshot),
			);
			this.sql.exec(
				`DELETE FROM card_history WHERE key = ? AND rowid NOT IN
				(SELECT rowid FROM card_history WHERE key = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
				card.key,
				card.key,
				CARD_HISTORY,
			);
		}
	}

	private latestOf(key: string): CardSnapshot | undefined {
		const known = this.latest.get(key);
		if (known) return known;
		const row = this.sql
			.exec<{ snapshot: string }>(
				"SELECT snapshot FROM card_history WHERE key = ? ORDER BY at DESC, rowid DESC LIMIT 1",
				key,
			)
			.toArray()[0];
		if (!row) return undefined;
		const snapshot = JSON.parse(row.snapshot) as CardSnapshot;
		this.latest.set(key, snapshot);
		return snapshot;
	}

	/** What happened to these cards since a time. Cards first seen since then aren't news. */
	since(at: number, keys: Set<string>): CardActivity[] {
		const changed = new Map<string, { at: number; snapshot: CardSnapshot }[]>();
		for (const row of this.sql.exec<{ key: string; at: number; snapshot: string }>(
			"SELECT key, at, snapshot FROM card_history WHERE at > ? ORDER BY at, rowid",
			at,
		)) {
			if (!keys.has(row.key)) continue;
			let list = changed.get(row.key);
			if (!list) changed.set(row.key, (list = []));
			list.push({ at: row.at, snapshot: JSON.parse(row.snapshot) as CardSnapshot });
		}
		const out: CardActivity[] = [];
		for (const [key, history] of changed) {
			const before = this.sql
				.exec<{ snapshot: string }>(
					`SELECT snapshot FROM card_history WHERE key = ? AND at <= ?
					ORDER BY at DESC, rowid DESC LIMIT 1`,
					key,
					at,
				)
				.toArray()[0];
			if (!before) continue;
			out.push(...cardActivity(key, JSON.parse(before.snapshot) as CardSnapshot, history));
		}
		return out.sort((a, b) => b.at - a.at);
	}
}

export interface Visit {
	firstAt: number;
	seenAt: number;
	/** When the visit this digest is since ended; null on a first visit. */
	baseline: number | null;
}

export class Visits {
	constructor(private sql: SqlStorage) {
		sql.exec(`
			CREATE TABLE IF NOT EXISTS since_visits (
				user_id INTEGER PRIMARY KEY,
				first_at INTEGER NOT NULL,
				seen_at INTEGER NOT NULL,
				baseline INTEGER
			);
		`);
	}

	get(userId: number): Visit | null {
		const row = this.sql
			.exec<{ first_at: number; seen_at: number; baseline: number | null }>(
				"SELECT first_at, seen_at, baseline FROM since_visits WHERE user_id = ?",
				userId,
			)
			.toArray()[0];
		return row ? { firstAt: row.first_at, seenAt: row.seen_at, baseline: row.baseline } : null;
	}

	/** Someone's here: a new visit if they've been away a while. */
	arrive(userId: number, now = Date.now()): Visit {
		const known = this.get(userId);
		const visit: Visit = !known
			? { firstAt: now, seenAt: now, baseline: null }
			: {
					firstAt: known.firstAt,
					seenAt: now,
					baseline: now - known.seenAt > VISIT_GAP_MS ? known.seenAt : known.baseline,
				};
		this.write(userId, visit);
		return visit;
	}

	/** Still here (or just left): they've seen the board up to now. */
	touch(userId: number, now = Date.now()): void {
		this.sql.exec("UPDATE since_visits SET seen_at = ? WHERE user_id = ?", now, userId);
	}

	/** "Mark all as seen": the digest starts again from now. */
	seen(userId: number, now = Date.now()): Visit | null {
		const known = this.get(userId);
		if (!known) return null;
		const visit = { ...known, seenAt: now, baseline: now };
		this.write(userId, visit);
		return visit;
	}

	private write(userId: number, visit: Visit): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO since_visits (user_id, first_at, seen_at, baseline) VALUES (?, ?, ?, ?)",
			userId,
			visit.firstAt,
			visit.seenAt,
			visit.baseline,
		);
	}
}
