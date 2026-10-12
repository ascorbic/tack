import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	BOARD_MIGRATIONS,
	BOARD_SCHEMA,
	type BoardMigration,
	MIGRATE_ORIGIN,
	boardSchema,
	checkMigrations,
	metaMap,
	migrateBoard,
	zKeys,
} from "../src/shared/schema.ts";
import { isValidZ, nextZ, shapesMap } from "../src/shared/shapes.ts";

/** A board as the spike saved it: `z` keys fractional-indexing can't build on, and no stamp. */
function spikeBoard(): Y.Doc {
	const doc = new Y.Doc();
	const shapes = shapesMap(doc);
	const add = (id: string, z: unknown) => {
		const shape = new Y.Map<unknown>();
		shape.set("type", "sticky");
		shape.set("x", 0);
		shape.set("y", 0);
		if (z !== undefined) shape.set("z", z);
		shapes.set(id, shape);
	};
	add("a", "1");
	add("b", "2");
	add("c", "a0");
	add("d", 3);
	add("e", undefined);
	add("f", "a1");
	add("g", "zzz-not-a-key");
	return doc;
}

/** Shapes in the order the canvas draws them (by `z` as a string, then id). */
function drawOrder(doc: Y.Doc): string[] {
	const sort = (z: unknown) => (typeof z === "string" ? z : "");
	return [...shapesMap(doc)]
		.map(([id, shape]) => ({ id, z: sort(shape.get("z")) }))
		.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1))
		.map((entry) => entry.id);
}

describe("board migrations", () => {
	it("are numbered 1, 2, 3… and the current version is the newest", () => {
		expect(() => checkMigrations(BOARD_MIGRATIONS)).not.toThrow();
		expect(BOARD_SCHEMA).toBe(BOARD_MIGRATIONS.length);
		const gap: BoardMigration[] = [{ version: 2, name: "skips", up: () => 0 }];
		expect(() => checkMigrations(gap)).toThrow(/expected 1/);
	});

	it("reads boards from before versioning as version 0", () => {
		const doc = new Y.Doc();
		expect(boardSchema(doc)).toBe(0);
		metaMap(doc).set("schema", "2");
		expect(boardSchema(doc)).toBe(0);
		metaMap(doc).set("schema", 1);
		expect(boardSchema(doc)).toBe(1);
	});

	it("stamps a new, empty board without changing anything else", () => {
		const doc = new Y.Doc();
		const report = migrateBoard(doc);
		expect(report).toMatchObject({ from: 0, to: BOARD_SCHEMA, newer: false });
		expect(report.applied.every((step) => step.changed === 0)).toBe(true);
		expect(boardSchema(doc)).toBe(BOARD_SCHEMA);
		expect(shapesMap(doc).size).toBe(0);
	});

	it("loads an old-format board and brings it up to date, keeping its stacking order", () => {
		const doc = spikeBoard();
		const before = drawOrder(doc);
		const report = migrateBoard(doc);
		expect(report.from).toBe(0);
		expect(report.to).toBe(BOARD_SCHEMA);
		expect(report.applied[0]).toEqual({ version: 1, name: "z-keys", changed: 5 });
		for (const shape of shapesMap(doc).values()) {
			expect(isValidZ(shape.get("z") as string)).toBe(true);
		}
		// Valid keys stay as they were; nothing changes places.
		expect(shapesMap(doc).get("c")?.get("z")).toBe("a0");
		expect(shapesMap(doc).get("f")?.get("z")).toBe("a1");
		expect(drawOrder(doc)).toEqual(before);
		// Bringing something to the front works again.
		expect(() => nextZ(doc)).not.toThrow();
	});

	it("is idempotent: running again changes nothing, and writes nothing", () => {
		const doc = spikeBoard();
		migrateBoard(doc);
		const updates: Uint8Array[] = [];
		doc.on("update", (update: Uint8Array) => updates.push(update));
		expect(migrateBoard(doc).applied).toEqual([]);
		expect(updates).toEqual([]);

		// Even with the stamp gone (an editor's client can write it), the
		// migrations find nothing to do.
		metaMap(doc).delete("schema");
		const again = migrateBoard(doc);
		expect(again.applied.map((step) => step.changed)).toEqual([0]);
		expect(boardSchema(doc)).toBe(BOARD_SCHEMA);
	});

	it("migrates in its own origin, so it's never undone", () => {
		const doc = spikeBoard();
		const origins = new Set<unknown>();
		doc.on("afterTransaction", (tr: Y.Transaction) => origins.add(tr.origin));
		migrateBoard(doc);
		expect([...origins]).toEqual([MIGRATE_ORIGIN]);
		const undo = new Y.UndoManager(shapesMap(doc), { trackedOrigins: new Set(["local"]) });
		expect(undo.canUndo()).toBe(false);
	});

	it("runs only the migrations newer than the board, in order", () => {
		const ran: string[] = [];
		const migrations: BoardMigration[] = [
			{ version: 1, name: "one", up: () => (ran.push("one"), 0) },
			{ version: 2, name: "two", up: () => (ran.push("two"), 1) },
			{ version: 3, name: "three", up: () => (ran.push("three"), 0) },
		];
		const doc = new Y.Doc();
		metaMap(doc).set("schema", 1);
		const report = migrateBoard(doc, { migrations });
		expect(ran).toEqual(["two", "three"]);
		expect(report).toMatchObject({ from: 1, to: 3 });
	});

	it("leaves a board from a newer Tack alone", () => {
		const doc = spikeBoard();
		metaMap(doc).set("schema", BOARD_SCHEMA + 1);
		const report = migrateBoard(doc);
		expect(report).toMatchObject({ newer: true, applied: [], to: BOARD_SCHEMA + 1 });
		expect(shapesMap(doc).get("a")?.get("z")).toBe("1");
	});

	it("stops at a migration that throws, keeping the stamp before it", () => {
		const migrations: BoardMigration[] = [
			{ version: 1, name: "fine", up: () => 0 },
			{
				version: 2,
				name: "broken",
				up: () => {
					throw new Error("nope");
				},
			},
			{ version: 3, name: "never", up: () => 0 },
		];
		const doc = new Y.Doc();
		const report = migrateBoard(doc, { migrations });
		expect(report.to).toBe(1);
		expect(report.failed?.name).toBe("broken");
		expect(boardSchema(doc)).toBe(1);
	});
});

describe("z-keys", () => {
	it("leaves boards whose keys are all valid untouched", () => {
		const doc = new Y.Doc();
		const shape = new Y.Map<unknown>();
		shape.set("z", "a0");
		shapesMap(doc).set("one", shape);
		expect(zKeys(doc)).toBe(0);
	});

	it("slots invalid keys between shapes that share a key", () => {
		const doc = new Y.Doc();
		const add = (id: string, z: unknown) => {
			const shape = new Y.Map<unknown>();
			shape.set("z", z);
			shapesMap(doc).set(id, shape);
		};
		add("a", "a0");
		add("b", "a0");
		add("c", "a00");
		add("d", "a1");
		expect(zKeys(doc)).toBe(1);
		const z = (id: string) => shapesMap(doc).get(id)?.get("z") as string;
		expect(z("c") > "a0" && z("c") < "a1").toBe(true);
	});
});

describe("link cards", () => {
	it("need no migration: a new shape type with keys of its own, loaded as they are", () => {
		const doc = new Y.Doc();
		const shape = new Y.Map<unknown>();
		const preview = { status: "ok", title: "Tack", fetchedAt: "2026-10-12T10:00:00.000Z" };
		for (const [key, value] of Object.entries({
			type: "link",
			x: 0,
			y: 0,
			z: "a0",
			url: "https://tack.social/",
			preview,
		})) {
			shape.set(key, value);
		}
		shapesMap(doc).set("l", shape);
		migrateBoard(doc);
		expect(shapesMap(doc).get("l")?.toJSON()).toEqual({
			type: "link",
			x: 0,
			y: 0,
			z: "a0",
			url: "https://tack.social/",
			preview,
		});
		expect(boardSchema(doc)).toBe(BOARD_SCHEMA);
	});
});
