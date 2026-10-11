import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";
import { isValidZ, shapesMap } from "./shapes.ts";

// Board document versions and migrations (#55), so upgrading Tack never
// strands a board in an old format.
//
// Every board's document carries the version of its format, `schema` in the
// root `meta` map (absent, read as 0, on boards from before versioning). The
// `Board` object brings it up to `BOARD_SCHEMA` each time it loads the
// document, before anyone connects: it runs, in order, every migration
// newer than the document's version, each in its own transaction that also
// moves the stamp on. Only the server writes `meta`.
//
// Migrations are for changes readers can't simply tolerate (renaming a key,
// changing what a value means, re-keying), not for new optional keys: those
// stay absent on old shapes and readers default them, as they always have.
//
// Rules for writing one:
//
// - Append it with the next version; never edit or reorder a released one.
// - Make it idempotent: run on a document already in the new format, it
//   changes nothing (and returns 0). A client still running the old version
//   can write old-format data after a migration, and the stamp is in a
//   document editors can write to, so a migration may meet the same board
//   again.
// - Write only what needs changing: every write leaves a tombstone, and is
//   sent to everyone on the board.
// - Never throw for malformed data: skip what you can't read, as readers do.
//   A migration that does throw leaves the stamp where it was, logs, and
//   the board carries on; it's tried again on the next load.
//
// Migrations run with `MIGRATE_ORIGIN`, so they're never undoable, and the
// board's history shows them as Tack's ("Tack upgraded the board").

/** The transaction origin migrations write with (never undoable; history says Tack). */
export const MIGRATE_ORIGIN = "migrate";

export interface BoardMigration {
	/** The version this migration brings a document to: one more than the last. */
	version: number;
	/** A short name for logs, e.g. `z-keys`. */
	name: string;
	/** Bring a document from the previous version to this one; returns how many things it changed. */
	up(doc: Y.Doc): number;
}

/** The root map holding the document's own metadata: `schema`, its format's version. */
export function metaMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap("meta");
}

/** The version of a document's format: 0 for boards from before versioning. */
export function boardSchema(doc: Y.Doc): number {
	const schema = metaMap(doc).get("schema");
	return typeof schema === "number" && Number.isSafeInteger(schema) && schema > 0 ? schema : 0;
}

/**
 * Version 1, `z-keys`: every shape's stacking key (`z`) is one
 * fractional-indexing can build on. Boards from the spike seeded keys it
 * can't (`"1"`, numbers, none at all); readers skip them, so those shapes
 * could never be brought to the front or sent back. They get real keys, in
 * the order the canvas already draws them (by `z` as a string, anything
 * else first, then by id), slotted between the valid keys around them, so
 * nothing on the board changes places.
 */
export function zKeys(doc: Y.Doc): number {
	const shapes = shapesMap(doc);
	const valid = (z: unknown): z is string => typeof z === "string" && isValidZ(z);
	const entries: { id: string; z: unknown; sort: string }[] = [];
	let invalid = 0;
	for (const [id, shape] of shapes) {
		const z = shape.get("z");
		if (!valid(z)) invalid++;
		entries.push({ id, z, sort: typeof z === "string" ? z : "" });
	}
	if (invalid === 0) return 0;
	entries.sort((a, b) =>
		a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);

	let changed = 0;
	let below: string | null = null;
	for (let i = 0; i < entries.length;) {
		const entry = entries[i]!;
		if (valid(entry.z)) {
			below = entry.z;
			i++;
			continue;
		}
		// A run of invalid keys: slot them between the valid keys either side.
		let end = i;
		while (end < entries.length && !valid(entries[end]!.z)) end++;
		// Shapes can share a key (two people brought things to the front at
		// once), so look past any equal to the key below.
		let above: string | null = null;
		for (let j = end; j < entries.length; j++) {
			const z = entries[j]!.z;
			if (valid(z) && (below === null || z > below)) {
				above = z;
				break;
			}
		}
		const keys = generateNKeysBetween(below, above, end - i);
		for (let k = i; k < end; k++) {
			const key = keys[k - i]!;
			shapes.get(entries[k]!.id)?.set("z", key);
			changed++;
			below = key;
		}
		i = end;
	}
	return changed;
}

/** Every migration, oldest first. Append; never edit or reorder a released one. */
export const BOARD_MIGRATIONS: readonly BoardMigration[] = [
	{ version: 1, name: "z-keys", up: zKeys },
];

/** The version of the board format this build writes: the newest migration's. */
export const BOARD_SCHEMA = BOARD_MIGRATIONS.at(-1)?.version ?? 0;

export interface MigrationReport {
	/** The document's version before. */
	from: number;
	/** Its version now. */
	to: number;
	/** The migrations that ran, and how many things each changed. */
	applied: { version: number; name: string; changed: number }[];
	/** The document is from a newer Tack (say, after rolling back a deploy): left alone. */
	newer: boolean;
	/** A migration that threw: the stamp stays at the one before it. */
	failed?: { version: number; name: string; error: unknown };
}

/** A board's format and what loading it migrated, as `Board.schemaReport()` gives it. */
export interface SchemaReport {
	/** The document's version now. */
	schema: number;
	/** The newest version this build knows. */
	current: number;
	migration:
		| (Omit<MigrationReport, "failed"> & {
				failed?: { version: number; name: string; error: string };
		  })
		| null;
}

/** Throws unless migrations are numbered 1, 2, 3… in order. */
export function checkMigrations(migrations: readonly BoardMigration[]): void {
	migrations.forEach((migration, i) => {
		if (migration.version !== i + 1) {
			throw new Error(
				`Board migration ${migration.name} is version ${migration.version}, expected ${i + 1}`,
			);
		}
	});
}

/**
 * Bring a board's document up to the newest format: every migration newer
 * than its stamp, in order, each with the stamp moved on in the same
 * transaction. Safe to call on any document, any number of times.
 */
export function migrateBoard(
	doc: Y.Doc,
	{
		migrations = BOARD_MIGRATIONS,
		origin = MIGRATE_ORIGIN,
	}: { migrations?: readonly BoardMigration[]; origin?: unknown } = {},
): MigrationReport {
	checkMigrations(migrations);
	const latest = migrations.at(-1)?.version ?? 0;
	const from = boardSchema(doc);
	const report: MigrationReport = { from, to: from, applied: [], newer: from > latest };
	if (report.newer) return report;
	for (const migration of migrations) {
		if (migration.version <= from) continue;
		try {
			let changed = 0;
			doc.transact(() => {
				changed = migration.up(doc);
				metaMap(doc).set("schema", migration.version);
			}, origin);
			report.applied.push({ version: migration.version, name: migration.name, changed });
			report.to = migration.version;
		} catch (error) {
			report.failed = { version: migration.version, name: migration.name, error };
			break;
		}
	}
	return report;
}
