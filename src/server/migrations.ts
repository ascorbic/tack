// Durable Object SQLite migrations (#55): changes to tables that already
// exist in deployed objects.
//
// Each part of an object that keeps tables (the push engine, comments,
// history…) creates them with `CREATE TABLE IF NOT EXISTS` every time it
// starts, which is all a new table needs. What that can't do is change a
// table an object already has: add a column, add an index on one, rewrite
// rows. Those are migrations: an ordered list per part (its `scope`), run
// once each, in order, the first time an object starts on a version of Tack
// that has them. Which have run is kept in the object's own storage
// (`schema_versions`, a row per scope).
//
// Rules for writing one:
//
// - Append it with the next version; never edit or reorder a released one.
// - Make it idempotent (`addColumn`, `CREATE INDEX IF NOT EXISTS`, updates
//   that only touch rows still in the old shape): objects created before
//   migrations were recorded run every migration once, whatever their
//   tables already look like, and SQLite can't roll back a statement that
//   isn't inside `transactionSync`.
// - Add new columns to the `CREATE TABLE` too, so new objects have them from
//   the start; the migration is for objects that already had the table.
// - Only ever add: a rolled-back deploy must still read what a newer one
//   wrote. Keep old columns until no released version reads them.

import { log } from "./log.ts";

export interface SqlMigration {
	/** One more than the previous migration in its scope, starting at 1. */
	version: number;
	/** A short name for logs. */
	name: string;
	up(sql: SqlStorage): void;
}

export interface SqlMigrationResult {
	scope: string;
	from: number;
	to: number;
	applied: string[];
}

const TABLE = `
	CREATE TABLE IF NOT EXISTS schema_versions (
		scope TEXT PRIMARY KEY,
		version INTEGER NOT NULL,
		migrated_at INTEGER NOT NULL
	)
`;

/** Where this scope's migrations have got to (0 for none). */
export function sqlVersion(sql: SqlStorage, scope: string): number {
	sql.exec(TABLE);
	const row = sql
		.exec<{ version: number }>("SELECT version FROM schema_versions WHERE scope = ?", scope)
		.toArray()[0];
	return row?.version ?? 0;
}

/**
 * Run a scope's migrations that haven't run on this object yet, in order,
 * each with its version recorded (in one transaction, when `transaction` is
 * given: pass `ctx.storage.transactionSync`). Throws if one fails, after
 * logging it: the object's storage isn't in a state its code expects.
 */
export function migrateSql(
	sql: SqlStorage,
	scope: string,
	migrations: readonly SqlMigration[],
	{
		transaction = (fn) => fn(),
		context = {},
	}: {
		transaction?: (fn: () => void) => void;
		/** Logged with the outcome, e.g. `{ board }`. */
		context?: Record<string, unknown>;
	} = {},
): SqlMigrationResult {
	migrations.forEach((migration, i) => {
		if (migration.version !== i + 1) {
			throw new Error(
				`Migration ${scope}/${migration.name} is version ${migration.version}, expected ${i + 1}`,
			);
		}
	});
	const from = sqlVersion(sql, scope);
	const result: SqlMigrationResult = { scope, from, to: from, applied: [] };
	const latest = migrations.at(-1)?.version ?? 0;
	if (from > latest) {
		// A newer Tack ran here (a deploy was rolled back). Migrations only add,
		// so this one can carry on with what it knows.
		log.warn("storage.migrate.newer", { ...context, scope, version: from, current: latest });
		return result;
	}
	for (const migration of migrations) {
		if (migration.version <= from) continue;
		try {
			transaction(() => {
				migration.up(sql);
				sql.exec(
					"INSERT OR REPLACE INTO schema_versions (scope, version, migrated_at) VALUES (?, ?, ?)",
					scope,
					migration.version,
					Date.now(),
				);
			});
		} catch (error) {
			log.error("storage.migrate.failed", {
				...context,
				scope,
				version: migration.version,
				migration: migration.name,
				error,
			});
			throw error;
		}
		result.applied.push(migration.name);
		result.to = migration.version;
	}
	if (result.applied.length > 0) {
		log.info("storage.migrated", {
			...context,
			scope,
			from,
			to: result.to,
			applied: result.applied,
		});
	}
	return result;
}

/** Add a column unless the table already has it (for idempotent migrations). */
export function addColumn(
	sql: SqlStorage,
	table: string,
	column: string,
	definition: string,
): void {
	const columns = sql
		.exec<{ name: string }>(`PRAGMA table_info(${table})`)
		.toArray()
		.map((row) => row.name);
	if (!columns.includes(column)) {
		sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}
