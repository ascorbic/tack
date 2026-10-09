import { DurableObject } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import type { Card, MissingCard } from "../shared/cards.ts";
import { type ItemRef, parseKey } from "../shared/refs.ts";
import type { Board } from "./board.ts";
import { type Delivery, forge } from "./forges/index.ts";
import { boards } from "./namespaces.ts";

export type IngestResult =
	| { status: "duplicate" }
	| { status: "processed"; updated: string[]; stale: string[]; boards: number };

/**
 * One per repository, on any forge. Caches normalised cards, records which
 * boards reference which cards, keeps a raw log of webhook deliveries, and
 * fans card updates out to subscribed boards.
 */
export class Repo extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS cards (
				key TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS subscriptions (
				key TEXT NOT NULL,
				board TEXT NOT NULL,
				PRIMARY KEY (key, board)
			);
			CREATE TABLE IF NOT EXISTS events (
				delivery_id TEXT PRIMARY KEY,
				event TEXT NOT NULL,
				action TEXT,
				payload TEXT NOT NULL,
				received_at TEXT NOT NULL
			);
		`);
	}

	/** Register a board's interest in cards and return their current data. */
	async subscribe(board: string, keys: string[]): Promise<(Card | MissingCard)[]> {
		for (const key of keys) {
			this.sql.exec("INSERT OR IGNORE INTO subscriptions (key, board) VALUES (?, ?)", key, board);
		}
		return this.cardsOrFetch(keys);
	}

	unsubscribe(board: string, keys: string[]): void {
		for (const key of keys) {
			this.sql.exec("DELETE FROM subscriptions WHERE key = ? AND board = ?", key, board);
		}
	}

	getCard(key: string): Card | null {
		const row = this.sql
			.exec<{ data: string }>("SELECT data FROM cards WHERE key = ?", key)
			.toArray()[0];
		return row ? (JSON.parse(row.data) as Card) : null;
	}

	subscribers(key: string): string[] {
		return this.sql
			.exec<{ board: string }>("SELECT board FROM subscriptions WHERE key = ?", key)
			.toArray()
			.map((row) => row.board);
	}

	async ingest(delivery: Delivery): Promise<IngestResult> {
		const seen = this.sql
			.exec("SELECT 1 FROM events WHERE delivery_id = ?", delivery.id)
			.toArray().length;
		if (seen) return { status: "duplicate" };

		this.sql.exec(
			"INSERT INTO events (delivery_id, event, action, payload, received_at) VALUES (?, ?, ?, ?, ?)",
			delivery.id,
			delivery.event,
			delivery.action,
			delivery.payload,
			new Date().toISOString(),
		);

		const updated: Card[] = [];
		const stale: string[] = [];
		for (const card of delivery.cards) {
			const existing = this.getCard(card.key);
			// Deliveries can arrive out of order: never let an older payload win.
			if (existing && existing.updatedAt > card.updatedAt) {
				stale.push(card.key);
				continue;
			}
			this.store(card);
			updated.push(card);
		}

		const notified = new Set<string>();
		await Promise.allSettled(
			updated.flatMap((card) =>
				this.subscribers(card.key).map(async (name) => {
					notified.add(name);
					const board = await getServerByName<Env, Board>(boards(this.env), name);
					await board.cardUpdated(card);
				}),
			),
		);
		return {
			status: "processed",
			updated: updated.map((card) => card.key),
			stale,
			boards: notified.size,
		};
	}

	private store(card: Card): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO cards (key, data, updated_at) VALUES (?, ?, ?)",
			card.key,
			JSON.stringify(card),
			card.updatedAt,
		);
	}

	private async cardsOrFetch(keys: string[]): Promise<(Card | MissingCard)[]> {
		const result = new Map<string, Card | MissingCard>();
		const toFetch: ItemRef[] = [];
		for (const key of keys) {
			const cached = this.getCard(key);
			const ref = cached ? null : parseKey(key);
			if (cached) result.set(key, cached);
			else if (ref) toFetch.push(ref);
			else result.set(key, { key, missing: true, reason: "unsupported" });
		}
		// Every key in one Repo shares a host, so one adapter fetches them all.
		const first = toFetch[0];
		if (first) {
			for (const card of await forge(first.forge).fetchItems(toFetch, this.env)) {
				if (!("missing" in card)) this.store(card);
				result.set(card.key, card);
			}
		}
		return keys.map((key) => result.get(key) ?? { key, missing: true, reason: "error" });
	}
}
