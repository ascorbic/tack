// Just enough of Durable Objects' `SqlStorage` over Node's own SQLite, for
// unit-testing storage code (migrations) without a Worker.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface MemorySql {
	sql: SqlStorage;
	/** Run `fn` in a transaction, rolled back if it throws (`transactionSync`). */
	transaction: (fn: () => void) => void;
	db: DatabaseSync;
}

export function memorySql(): MemorySql {
	const db = new DatabaseSync(":memory:");
	const exec = (query: string, ...bindings: unknown[]) => {
		const statements = query
			.split(";")
			.map((statement) => statement.trim())
			.filter(Boolean);
		let rows: Record<string, unknown>[] = [];
		for (const statement of statements) {
			const prepared = db.prepare(statement);
			rows = /^\s*(SELECT|PRAGMA)/i.test(statement)
				? (prepared.all(...(bindings as SQLInputValue[])) as Record<string, unknown>[])
				: (prepared.run(...(bindings as SQLInputValue[])), []);
		}
		return {
			toArray: () => rows,
			one: () => rows[0],
			[Symbol.iterator]: () => rows[Symbol.iterator](),
		};
	};
	return {
		sql: { exec } as unknown as SqlStorage,
		db,
		transaction: (fn) => {
			db.exec("BEGIN");
			try {
				fn();
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}
