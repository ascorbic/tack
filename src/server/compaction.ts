// Compacting a board's document on load, and keeping old copies out (#60).
// The pure half (measuring, rebuilding, recognising old copies) is in
// src/shared/compaction.ts; this is the board object's: its SQLite, when
// it last saved, the retired client ids, and the check on every sync
// message once there are any.

import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import {
	COMPACTION_LIMITS,
	type CompactionLimits,
	type DocStats,
	clientsOf,
	measureDoc,
	rebuildDoc,
	shouldCompact,
	stateVectorNamesRetired,
	updateNamesRetired,
} from "../shared/compaction.ts";
import type { Logger } from "./log.ts";

/** WebSocket close code for a connection holding a copy of the document from before it was rebuilt. */
export const DOCUMENT_REBUILT = 4410;

const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;

export interface DocumentInfo extends DocStats {
	/** Which build of the document this is ("" until the first rebuild). */
	epoch: string;
	compactedAt: number | null;
	lastSavedAt: number | null;
	retired: number;
}

export class BoardCompaction {
	/** Client ids of every document before a rebuild: nothing from them is taken any more. */
	readonly retired = new Set<number>();

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly logger: Logger,
	) {
		storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS doc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS retired_clients (client INTEGER PRIMARY KEY);
		`);
		for (const row of storage.sql.exec<{ client: number }>("SELECT client FROM retired_clients")) {
			this.retired.add(row.client);
		}
	}

	private meta(key: string): string | null {
		return (
			this.storage.sql
				.exec<{ value: string }>("SELECT value FROM doc_meta WHERE key = ?", key)
				.toArray()[0]?.value ?? null
		);
	}

	private putMeta(key: string, value: string): void {
		this.storage.sql.exec("INSERT OR REPLACE INTO doc_meta (key, value) VALUES (?, ?)", key, value);
	}

	private time(key: string): number | null {
		const value = Number(this.meta(key));
		return Number.isFinite(value) && value > 0 ? value : null;
	}

	/** Which build of the document is saved ("" for the original). */
	epoch(): string {
		return this.meta("epoch") ?? "";
	}

	limits(): CompactionLimits {
		const saved = this.meta("limits");
		return saved
			? { ...COMPACTION_LIMITS, ...(JSON.parse(saved) as Partial<CompactionLimits>) }
			: COMPACTION_LIMITS;
	}

	/** For tests: change when a board compacts, until changed again. */
	setLimits(limits: Partial<CompactionLimits>): void {
		this.putMeta("limits", JSON.stringify(limits));
	}

	/** Call inside the save's transaction. */
	saved(now = Date.now()): void {
		this.putMeta("saved_at", String(now));
	}

	info(doc: Y.Doc): DocumentInfo {
		return {
			...measureDoc(doc),
			epoch: this.epoch(),
			compactedAt: this.time("compacted_at"),
			lastSavedAt: this.time("saved_at"),
			retired: this.retired.size,
		};
	}

	/**
	 * The document to start with: the saved one, or, if it's due, a rebuild
	 * of it, saved (with its client ids retired and a new epoch) before
	 * anyone can sync with it. `write` saves an update as the snapshot.
	 */
	load(doc: Y.Doc, encoded: Uint8Array, write: (update: Uint8Array) => void): Y.Doc {
		const now = Date.now();
		const stats = measureDoc(doc, encoded);
		const limits = this.limits();
		const due = shouldCompact(stats, limits, {
			now,
			lastSavedAt: this.time("saved_at"),
			compactedAt: this.time("compacted_at"),
		});
		this.logger.info("board.document", { ...stats, due });
		if (!due) return doc;

		const started = Date.now();
		const rebuilt = rebuildDoc(doc);
		if (!rebuilt) {
			// Something didn't copy exactly: keep the board as it is.
			this.logger.error("board.compact.failed", { reason: "mismatch", bytes: stats.bytes });
			this.putMeta("compacted_at", String(now));
			return doc;
		}
		const update = Y.encodeStateAsUpdate(rebuilt);
		if (update.byteLength > stats.bytes * (1 - limits.minSaving)) {
			// Not worth it after all; look again in a while.
			this.logger.info("board.compact.skipped", { bytes: stats.bytes, after: update.byteLength });
			this.putMeta("compacted_at", String(now));
			return doc;
		}
		const clients = clientsOf(doc);
		const epoch = crypto.randomUUID();
		this.storage.transactionSync(() => {
			write(update);
			for (const client of clients) {
				this.storage.sql.exec("INSERT OR IGNORE INTO retired_clients (client) VALUES (?)", client);
			}
			this.putMeta("epoch", epoch);
			this.putMeta("compacted_at", String(now));
		});
		for (const client of clients) this.retired.add(client);
		this.logger.info("board.compacted", {
			before: stats.bytes,
			after: update.byteLength,
			deleted: stats.deleted,
			live: stats.live,
			retired: clients.length,
			ms: Date.now() - started,
		});
		return rebuilt;
	}

	/**
	 * Whether a binary message comes from a copy of the document from before
	 * a rebuild: a sync step 1 whose state vector, or an update, that names
	 * a retired client. Such a connection must start again (`DOCUMENT_REBUILT`).
	 */
	stale(message: Uint8Array): boolean {
		if (this.retired.size === 0) return false;
		try {
			const decoder = decoding.createDecoder(message);
			if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;
			const step = decoding.readVarUint(decoder);
			const payload = decoding.readVarUint8Array(decoder);
			return step === SYNC_STEP_1
				? stateVectorNamesRetired(payload, this.retired)
				: updateNamesRetired(payload, this.retired);
		} catch {
			// Unreadable: y-partyserver will refuse it, as before.
			return false;
		}
	}
}
