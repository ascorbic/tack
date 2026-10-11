import { type SqlMigration, addColumn } from "../migrations.ts";

/**
 * Changes to the push tables boards already have (see ../migrations.ts).
 * New columns go in the engine's `CREATE TABLE` too.
 */
export const PUSH_MIGRATIONS: readonly SqlMigration[] = [
	{
		// Boards from before failures kept what the forge said.
		version: 1,
		name: "error-detail",
		up: (sql) => addColumn(sql, "push_changes", "error_detail", "TEXT"),
	},
	{
		// And before they kept what kind of refusal it was (`ChangeProblem`).
		version: 2,
		name: "problem",
		up: (sql) => addColumn(sql, "push_changes", "problem", "TEXT"),
	},
];
