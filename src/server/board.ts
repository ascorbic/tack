import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { type Card, type CardMessage, type MissingCard, repoKey } from "../shared/cards.ts";
import { cardRefs } from "../shared/shapes.ts";
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
			void this.syncSubscriptions();
		});
		await this.syncSubscriptions();
	}

	override async onLoad(): Promise<Y.Doc | void> {
		const rows = this.ctx.storage.sql
			.exec<{ chunk: ArrayBuffer }>("SELECT chunk FROM snapshot ORDER BY seq")
			.toArray();
		if (rows.length === 0) return;
		const total = rows.reduce((n, row) => n + row.chunk.byteLength, 0);
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
	for (const key of keys) (groups[repoKey(key)] ??= []).push(key);
	return groups;
}
