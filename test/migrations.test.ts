import { describe, expect, it } from "vite-plus/test";
import { type SqlMigration, addColumn, migrateSql, sqlVersion } from "../src/server/migrations.ts";
import { PUSH_MIGRATIONS } from "../src/server/push/migrations.ts";
import { memorySql } from "./sqlite.ts";

const columns = (sql: SqlStorage, table: string) =>
	sql
		.exec<{ name: string }>(`PRAGMA table_info(${table})`)
		.toArray()
		.map((row) => row.name);

describe("SQLite migrations", () => {
	it("run in order, once each, and record where they got to per scope", () => {
		const { sql } = memorySql();
		const ran: string[] = [];
		const migrations: SqlMigration[] = [
			{ version: 1, name: "one", up: () => void ran.push("one") },
			{ version: 2, name: "two", up: () => void ran.push("two") },
		];
		expect(migrateSql(sql, "things", migrations)).toEqual({
			scope: "things",
			from: 0,
			to: 2,
			applied: ["one", "two"],
		});
		expect(migrateSql(sql, "things", migrations).applied).toEqual([]);
		expect(ran).toEqual(["one", "two"]);
		expect(sqlVersion(sql, "things")).toBe(2);
		expect(sqlVersion(sql, "others")).toBe(0);

		// A later version adds a third: only that one runs.
		const later = [...migrations, { version: 3, name: "three", up: () => void ran.push("three") }];
		expect(migrateSql(sql, "things", later)).toMatchObject({ from: 2, to: 3, applied: ["three"] });
		expect(ran).toEqual(["one", "two", "three"]);
	});

	it("refuse migrations that aren't numbered 1, 2, 3…", () => {
		const { sql } = memorySql();
		expect(() => migrateSql(sql, "x", [{ version: 2, name: "two", up: () => {} }])).toThrow(
			/expected 1/,
		);
	});

	it("leave storage from a newer Tack alone (a rolled-back deploy)", () => {
		const { sql } = memorySql();
		const migrations: SqlMigration[] = [
			{ version: 1, name: "one", up: () => {} },
			{ version: 2, name: "two", up: () => {} },
		];
		migrateSql(sql, "things", migrations);
		const older = migrations.slice(0, 1);
		expect(migrateSql(sql, "things", older)).toMatchObject({ from: 2, to: 2, applied: [] });
		expect(sqlVersion(sql, "things")).toBe(2);
	});

	it("stop at one that fails, rolled back, with the version before it kept", () => {
		const { sql, transaction } = memorySql();
		sql.exec("CREATE TABLE notes (id TEXT)");
		const migrations: SqlMigration[] = [
			{ version: 1, name: "fine", up: (db) => addColumn(db, "notes", "body", "TEXT") },
			{
				version: 2,
				name: "broken",
				up: (db) => {
					addColumn(db, "notes", "half", "TEXT");
					throw new Error("nope");
				},
			},
		];
		expect(() => migrateSql(sql, "notes", migrations, { transaction })).toThrow("nope");
		expect(sqlVersion(sql, "notes")).toBe(1);
		expect(columns(sql, "notes")).toEqual(["id", "body"]);
	});

	it("addColumn is idempotent", () => {
		const { sql } = memorySql();
		sql.exec("CREATE TABLE notes (id TEXT)");
		addColumn(sql, "notes", "body", "TEXT");
		addColumn(sql, "notes", "body", "TEXT");
		expect(columns(sql, "notes")).toEqual(["id", "body"]);
	});
});

describe("push table migrations", () => {
	it("add error_detail to boards from before failures kept what the forge said", () => {
		const { sql } = memorySql();
		// push_changes as it was before error_detail.
		sql.exec(`CREATE TABLE push_changes (
			push_id TEXT NOT NULL, change_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
			op TEXT NOT NULL, applied_op TEXT, effect TEXT, summary TEXT NOT NULL, repo TEXT,
			state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, first_attempt_at INTEGER,
			retry_at INTEGER, sent_at INTEGER, reconciled INTEGER NOT NULL DEFAULT 0, watch_key TEXT,
			result_key TEXT, result_url TEXT, error TEXT, updated_at INTEGER NOT NULL,
			PRIMARY KEY (push_id, change_id))`);
		sql.exec(
			"INSERT INTO push_changes (push_id, change_id, seq, kind, op, summary, state, updated_at) VALUES ('p', 'c', 0, 'issue.create', '{}', 'Create', 'failed', 1)",
		);
		migrateSql(sql, "push", PUSH_MIGRATIONS);
		expect(columns(sql, "push_changes")).toContain("error_detail");
		expect(columns(sql, "push_changes")).toContain("problem");
		expect(sql.exec("SELECT state, error_detail, problem FROM push_changes").toArray()).toEqual([
			{ state: "failed", error_detail: null, problem: null },
		]);
	});

	it("run harmlessly on boards whose tables already have everything", () => {
		const { sql } = memorySql();
		sql.exec("CREATE TABLE push_changes (push_id TEXT, error_detail TEXT, problem TEXT)");
		expect(migrateSql(sql, "push", PUSH_MIGRATIONS).applied).toEqual(["error-detail", "problem"]);
		expect(columns(sql, "push_changes")).toEqual(["push_id", "error_detail", "problem"]);
	});
});
