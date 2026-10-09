import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import type { Card, CardMessage, MissingCard } from "../shared/cards.ts";
import { repoKeyOf } from "../shared/refs.ts";
import { cardRefs } from "../shared/shapes.ts";
import { log } from "./log.ts";
import { repos } from "./namespaces.ts";

// Durable Object storage rows max out at 2 MB, so snapshots are chunked.
const CHUNK_SIZE = 512 * 1024;

/**
 * One per board. Holds the Yjs document (layout and freeform content) and
 * relays live card data to clients as custom messages, outside the document.
 */
export class Board extends YServer<Env> {
	static override callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000 };

	private cards = new Map<string, Card | MissingCard>();
	private subscribed = new Set<string>();

	override async onStart(): Promise<void> {
		this.ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS snapshot (seq INTEGER PRIMARY KEY, chunk BLOB NOT NULL)",
		);
		await super.onStart();
		this.document.on("update", () => {
			this.syncSubscriptions().catch((error: unknown) =>
				log.error("board.subscriptions.failed", { board: this.name, error }),
			);
		});
		await this.syncSubscriptions().catch((error: unknown) =>
			log.error("board.subscriptions.failed", { board: this.name, error }),
		);
	}

	override async onLoad(): Promise<Y.Doc | void> {
		const rows = this.ctx.storage.sql
			.exec<{ chunk: ArrayBuffer }>("SELECT chunk FROM snapshot ORDER BY seq")
			.toArray();
		if (rows.length === 0) {
			log.info("board.load", { board: this.name, bytes: 0, chunks: 0 });
			return;
		}
		const total = rows.reduce((n, row) => n + row.chunk.byteLength, 0);
		log.info("board.load", { board: this.name, bytes: total, chunks: rows.length });
		const update = new Uint8Array(total);
		let offset = 0;
		for (const row of rows) {
			update.set(new Uint8Array(row.chunk), offset);
			offset += row.chunk.byteLength;
		}
		const doc = new Y.Doc();
		Y.applyUpdate(doc, update);
		return doc;
	}

	override async onSave(): Promise<void> {
		// Re-encoding the full state compacts the update history each save.
		const update = Y.encodeStateAsUpdate(this.document);
		const context = {
			board: this.name,
			bytes: update.byteLength,
			chunks: Math.ceil(update.byteLength / CHUNK_SIZE),
		};
		try {
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.sql.exec("DELETE FROM snapshot");
				for (let i = 0; i * CHUNK_SIZE < update.byteLength; i++) {
					this.ctx.storage.sql.exec(
						"INSERT INTO snapshot (seq, chunk) VALUES (?, ?)",
						i,
						update.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
					);
				}
			});
		} catch (error) {
			log.error("board.save.failed", { ...context, error });
			throw error;
		}
		log.info("board.save", context);
	}

	override onConnect(connection: Connection, ctx: ConnectionContext): void {
		void super.onConnect(connection, ctx);
		if (this.cards.size > 0) {
			this.sendCustomMessage(
				connection,
				encode({ type: "cards", cards: [...this.cards.values()] }),
			);
		}
	}

	override onError(connection: Connection, error: unknown): void {
		log.error("board.connection.error", { board: this.name, connection: connection.id, error });
	}

	override onException(error: unknown): void {
		log.error("board.exception", { board: this.name, error });
	}

	/** Called by Repo when a subscribed card changes. */
	async cardUpdated(card: Card): Promise<void> {
		if (!this.subscribed.has(card.key)) return;
		this.cards.set(card.key, card);
		this.broadcastCustomMessage(encode({ type: "card", card }));
	}

	/** Snapshot size in bytes, for measuring growth. */
	snapshotSize(): number {
		return Y.encodeStateAsUpdate(this.document).byteLength;
	}

	private async syncSubscriptions(): Promise<void> {
		const refs = cardRefs(this.document);
		const added = [...refs].filter((key) => !this.subscribed.has(key));
		const removed = [...this.subscribed].filter((key) => !refs.has(key));
		if (added.length === 0 && removed.length === 0) return;

		for (const key of added) this.subscribed.add(key);
		for (const key of removed) {
			this.subscribed.delete(key);
			this.cards.delete(key);
		}

		await Promise.all([
			...Object.entries(groupByRepo(removed)).map(([repo, keys]) =>
				this.repo(repo).unsubscribe(this.name, keys),
			),
			...Object.entries(groupByRepo(added)).map(async ([repo, keys]) => {
				const cards = await this.repo(repo).subscribe(this.name, keys);
				const live = cards.filter((card) => this.subscribed.has(card.key));
				for (const card of live) this.cards.set(card.key, card);
				if (live.length > 0) this.broadcastCustomMessage(encode({ type: "cards", cards: live }));
			}),
		]);
	}

	private repo(name: string) {
		return repos(this.env).getByName(name);
	}
}

function encode(message: CardMessage): string {
	return JSON.stringify(message);
}

function groupByRepo(keys: string[]): Record<string, string[]> {
	const groups: Record<string, string[]> = {};
	for (const key of keys) (groups[repoKeyOf(key)] ??= []).push(key);
	return groups;
}
