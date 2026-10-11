// Compacting very old boards' documents (#60).
//
// A Yjs document never forgets: every deleted entry leaves a tombstone, so
// it can merge with copies that saw the entry. Saves already re-encode the
// whole state (garbage-collecting deleted content), but the tombstones
// themselves stay: every moved shape, retyped title and deleted sticky over
// a board's life (docs/spike.md measured ~10 bytes per position write). On
// a board used for years they can come to outweigh what's on it.
//
// The only way to drop them is to rebuild the document: a fresh one with
// the same content and none of the history (`rebuildDoc`). That changes
// every item's identity, so the rebuilt document can't merge with copies
// of the old one: a browser holding one would put everything in it back,
// twice. So the board only compacts when nobody's connected and nobody has
// edited for a while (`shouldCompact`), and from then on refuses anything
// from the old document: its client ids are retired, and a connection whose
// state vector or updates name one is told to start again with what's
// saved (`namesRetired`). Its history gets a fresh keyframe at the rebuild
// (see `HistoryLog.start`), so replays never mix the two.

import * as Y from "yjs";

/** What a document holds, and how much of it is tombstones. */
export interface DocStats {
	/** The encoded state, in bytes (what a save writes). */
	bytes: number;
	/** Live items (entries, characters, array elements). */
	live: number;
	/** Deleted items still kept as tombstones, and garbage-collected ranges. */
	deleted: number;
	/** Clients that have ever written to it (a client per page load). */
	clients: number;
}

export function measureDoc(doc: Y.Doc, encoded?: Uint8Array): DocStats {
	let live = 0;
	let deleted = 0;
	for (const structs of doc.store.clients.values()) {
		for (const struct of structs) {
			if (struct instanceof Y.Item && !struct.deleted) live += struct.length;
			else deleted += struct.length;
		}
	}
	return {
		bytes: (encoded ?? Y.encodeStateAsUpdate(doc)).byteLength,
		live,
		deleted,
		clients: doc.store.clients.size,
	};
}

/** When a board is worth compacting. Tests (and `Board.compactionLimits`) change them. */
export interface CompactionLimits {
	/** Smaller documents aren't worth it: they load in no time anyway. */
	minBytes: number;
	/** At least this share of items must be tombstones. */
	minDeleted: number;
	/** And the rebuild must save at least this share of the bytes. */
	minSaving: number;
	/** Nobody may have edited for this long (edits kept offline are older than this, or lost). */
	idleMs: number;
	/** At most once in this long. */
	everyMs: number;
}

export const COMPACTION_LIMITS: CompactionLimits = {
	minBytes: 256 * 1024,
	minDeleted: 0.5,
	minSaving: 0.3,
	idleMs: 6 * 60 * 60_000,
	everyMs: 7 * 24 * 60 * 60_000,
};

/** Whether a document's tombstones are worth rebuilding it for, now. */
export function shouldCompact(
	stats: DocStats,
	limits: CompactionLimits,
	when: { now: number; lastSavedAt: number | null; compactedAt: number | null },
): boolean {
	if (stats.bytes < limits.minBytes) return false;
	const total = stats.live + stats.deleted;
	if (total === 0 || stats.deleted / total < limits.minDeleted) return false;
	// Unknown (saved before this was kept) counts as just now: wait for a save.
	if (when.lastSavedAt === null || when.now - when.lastSavedAt < limits.idleMs) return false;
	if (when.compactedAt !== null && when.now - when.compactedAt < limits.everyMs) return false;
	return true;
}

type RootKind = "map" | "array" | "text";

/** What a root type is, from its contents (roots read from an update are untyped). */
function rootKind(type: Y.AbstractType<Y.YEvent<any>>): RootKind | null {
	if (type instanceof Y.Map) return "map";
	if (type instanceof Y.Text) return "text";
	if (type instanceof Y.Array) return "array";
	if (type._map.size > 0) return "map";
	for (let item = type._start; item !== null; item = item.right) {
		if (item.deleted) continue;
		const content = item.content;
		return content instanceof Y.ContentString ||
			content instanceof Y.ContentFormat ||
			content instanceof Y.ContentEmbed
			? "text"
			: "array";
	}
	return null;
}

function copyValue(value: unknown): unknown {
	return value instanceof Y.AbstractType ? value.clone() : value;
}

/** Every root's content as plain JSON, keyed by root: what a rebuild must keep. */
export function contentOf(doc: Y.Doc): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, type] of doc.share) {
		const kind = rootKind(type);
		if (kind === "map") out[name] = doc.getMap(name).toJSON();
		else if (kind === "array") out[name] = doc.getArray(name).toJSON();
		else if (kind === "text") out[name] = doc.getText(name).toDelta();
	}
	return out;
}

/**
 * A fresh document with the same content and no tombstones, or null if
 * its content wouldn't be exactly the same (then nothing is changed).
 */
export function rebuildDoc(doc: Y.Doc): Y.Doc | null {
	const fresh = new Y.Doc();
	fresh.transact(() => {
		for (const [name, type] of doc.share) {
			const kind = rootKind(type);
			if (kind === "map") {
				const target = fresh.getMap(name);
				for (const [key, value] of doc.getMap(name)) target.set(key, copyValue(value));
			} else if (kind === "array") {
				fresh.getArray(name).push(doc.getArray(name).toArray().map(copyValue));
			} else if (kind === "text") {
				fresh.getText(name).applyDelta(doc.getText(name).toDelta());
			}
		}
	});
	return stableJson(contentOf(fresh)) === stableJson(contentOf(doc)) ? fresh : null;
}

/** JSON with object keys sorted, for comparing content whatever order maps were filled in. */
export function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) => {
		if (inner instanceof Uint8Array) return { bytes: [...inner] };
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			return Object.fromEntries(
				Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
			);
		}
		return inner;
	});
}

/** Client ids that ever wrote to a document: retired when it's rebuilt. */
export function clientsOf(doc: Y.Doc): number[] {
	return [...doc.store.clients.keys()];
}

/** Whether a state vector (sync step 1) says its sender holds an old document. */
export function stateVectorNamesRetired(
	stateVector: Uint8Array,
	retired: ReadonlySet<number>,
): boolean {
	for (const [client, clock] of Y.decodeStateVector(stateVector)) {
		if (clock > 0 && retired.has(client)) return true;
	}
	return false;
}

/**
 * Whether an update was made on an old document: anything in it written by,
 * placed next to, inside or deleting something from a retired client.
 * Throws for updates that can't be read.
 */
export function updateNamesRetired(update: Uint8Array, retired: ReadonlySet<number>): boolean {
	const { structs, ds } = Y.decodeUpdate(update);
	const named = (id: Y.ID | null | undefined) => id != null && retired.has(id.client);
	for (const struct of structs) {
		if (named(struct.id)) return true;
		if (struct instanceof Y.Item) {
			if (named(struct.origin) || named(struct.rightOrigin)) return true;
			if (struct.parent instanceof Y.ID && named(struct.parent)) return true;
		}
	}
	for (const client of ds.clients.keys()) if (retired.has(client)) return true;
	return false;
}
