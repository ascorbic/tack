// Board format versions on a real board in Miniflare (#55): new boards are
// stamped with the current format, and a board saved in an old format is
// brought up to date when it next loads, with the upgrade in its history.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { BoardInfo } from "../src/shared/boards.ts";
import type { Timeline } from "../src/shared/history.ts";
import { BOARD_SCHEMA, boardSchema, metaMap } from "../src/shared/schema.ts";
import { isValidZ, shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { boardStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

function api(worker: Miniflare, path: string, cookie: string, body?: unknown) {
	return worker.dispatchFetch(`${ORIGIN}${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			cookie,
			...(body ? { "content-type": "application/json", origin: ORIGIN } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function open(worker: Miniflare, id: string, cookie: string): Promise<BoardClient> {
	const result = await connectBoard(worker, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status} ${result.error}`);
	await result.client.roundTrip();
	return result.client;
}

async function timeline(worker: Miniflare, id: string, cookie: string): Promise<Timeline> {
	return (await (await api(worker, `/api/boards/${id}/history`, cookie)).json()) as Timeline;
}

describe("board format versions", () => {
	it("stamps a new board with the current format, as part of where its history begins", async () => {
		const mf = startWorker({ devAuth: true });
		try {
			const cookie = await signIn(mf, "olive");
			const board = (await (
				await api(mf, "/api/boards", cookie, { title: "Fresh", visibility: "private" })
			).json()) as BoardInfo;
			const client = await open(mf, board.id, cookie);
			expect(boardSchema(client.doc)).toBe(BOARD_SCHEMA);
			const report = await (await boardStub(mf, board.id)).schemaReport();
			expect(report).toMatchObject({ schema: BOARD_SCHEMA, current: BOARD_SCHEMA });
			// No "Tack upgraded the board" on a board that's never been anything else.
			const history = await timeline(mf, board.id, cookie);
			expect(history.steps.filter((step) => !step.origin)).toEqual([]);
			client.close();
		} finally {
			await mf.dispose();
		}
	});

	it("brings an old-format board up to date when it loads, and records the upgrade", async () => {
		const persist = mkdtempSync(join(tmpdir(), "tack-schema-"));
		try {
			// A board saved before versioning: stacking keys the spike wrote, and no stamp.
			const first = startWorker({ devAuth: true, persist });
			const cookie = await signIn(first, "olive");
			const board = (await (
				await api(first, "/api/boards", cookie, { title: "Old", visibility: "private" })
			).json()) as BoardInfo;
			const owner = await open(first, board.id, cookie);
			owner.doc.transact(() => {
				for (const [id, z] of [
					["one", "1"],
					["two", "2"],
					["three", "a0"],
				] as const) {
					const shape = new Y.Map<unknown>();
					shape.set("type", "sticky");
					shape.set("x", 0);
					shape.set("y", 0);
					shape.set("text", id);
					shape.set("z", z);
					shapesMap(owner.doc).set(id, shape);
				}
				metaMap(owner.doc).delete("schema");
			});
			await owner.roundTrip();
			// Reading history saves the board (the save is otherwise debounced).
			await timeline(first, board.id, cookie);
			owner.close();
			await first.dispose();

			const woken = startWorker({ devAuth: true, persist });
			try {
				const again = await signIn(woken, "olive");
				const client = await open(woken, board.id, again);
				const shapes = shapesMap(client.doc);
				expect(boardSchema(client.doc)).toBe(BOARD_SCHEMA);
				const z = (id: string) => shapes.get(id)?.get("z") as string;
				for (const id of ["one", "two", "three"]) {
					expect(typeof z(id)).toBe("string");
					expect(isValidZ(z(id))).toBe(true);
				}
				// The order the canvas drew them in is kept.
				expect(z("one") < z("two") && z("two") < z("three")).toBe(true);
				expect(z("three")).toBe("a0");
				expect(shapes.get("one")?.get("text")).toBe("one");

				const report = await (await boardStub(woken, board.id)).schemaReport();
				expect(report.migration).toMatchObject({
					from: 0,
					to: BOARD_SCHEMA,
					applied: [{ version: 1, name: "z-keys", changed: 2 }],
				});
				// The upgrade is Tack's, in history.
				let last: Timeline["steps"][number] | undefined;
				await eventually(async () => {
					last = (await timeline(woken, board.id, again)).steps.at(-1);
					return Boolean(last?.other?.includes("meta"));
				});
				expect(last?.actors).toEqual(["sys:server"]);
				client.close();
			} finally {
				await woken.dispose();
			}

			// Once up to date, loading again migrates nothing.
			const third = startWorker({ devAuth: true, persist });
			try {
				const cookie3 = await signIn(third, "olive");
				const client = await open(third, board.id, cookie3);
				const report = await (await boardStub(third, board.id)).schemaReport();
				expect(report.migration).toMatchObject({ from: BOARD_SCHEMA, applied: [] });
				client.close();
			} finally {
				await third.dispose();
			}
		} finally {
			rmSync(persist, { recursive: true, force: true });
		}
	});
});
