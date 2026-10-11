// Board history on the server (M4, #47). The design is in
// src/shared/history.ts; here is where it's kept (the board's SQLite), who
// each update is attributed to, and the routes:
//
//   GET /api/boards/:id/history                    the `Timeline`: every step, who made them
//   GET /api/boards/:id/history/segment?step=N     the `Segment` holding step N, as bytes
//
// Anyone who can open the board can read its history, as they can its
// document: history holds nothing the document didn't (silent mode's hidden
// text never reaches either before the reveal), and card data isn't in it.

import type { Connection } from "partyserver";
import { getServerByName } from "partyserver";
import type { Awareness } from "y-protocols/awareness";
import { BOARD_ID } from "../shared/boards.ts";
import type { Actor, Attribution, HistoryStore, StepMeta, SystemKind } from "../shared/history.ts";
import { json } from "./auth/http.ts";
import { lookupRequest } from "./auth/session.ts";
import type { Board, ConnectionAccess } from "./board.ts";
import { roleFor, visitorKey } from "./boards/access.ts";
import { log } from "./log.ts";
import { boards, directory } from "./namespaces.ts";

// Rows max out at 2 MB, so updates and keyframes are chunked like the board's snapshot.
const CHUNK_SIZE = 512 * 1024;

export const HISTORY_TABLES = `
	CREATE TABLE IF NOT EXISTS history_steps (id INTEGER PRIMARY KEY, meta TEXT NOT NULL, bytes INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS history_keyframes (step INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS history_blobs (
		kind TEXT NOT NULL,
		id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		chunk BLOB NOT NULL,
		PRIMARY KEY (kind, id, seq)
	);
	CREATE TABLE IF NOT EXISTS history_actors (key TEXT PRIMARY KEY, actor TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Blob = "update" | "keyframe";

/** History in the board's SQLite storage. */
export function sqlHistoryStore(storage: DurableObjectStorage): HistoryStore {
	const sql = storage.sql;
	sql.exec(HISTORY_TABLES);

	const putBlob = (kind: Blob, id: number, bytes: Uint8Array | null) => {
		sql.exec("DELETE FROM history_blobs WHERE kind = ? AND id = ?", kind, id);
		if (!bytes) return;
		for (let i = 0; i * CHUNK_SIZE < bytes.byteLength; i++) {
			sql.exec(
				"INSERT INTO history_blobs (kind, id, seq, chunk) VALUES (?, ?, ?, ?)",
				kind,
				id,
				i,
				bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
			);
		}
	};
	const blob = (kind: Blob, id: number): Uint8Array | null => {
		const rows = sql
			.exec<{
				chunk: ArrayBuffer;
			}>("SELECT chunk FROM history_blobs WHERE kind = ? AND id = ? ORDER BY seq", kind, id)
			.toArray();
		if (rows.length === 0) return null;
		if (rows.length === 1) return new Uint8Array(rows[0]!.chunk);
		const total = rows.reduce((n, row) => n + row.chunk.byteLength, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const row of rows) {
			out.set(new Uint8Array(row.chunk), offset);
			offset += row.chunk.byteLength;
		}
		return out;
	};
	const removeBlobs = (kind: Blob, ids: readonly number[]) => {
		for (const id of ids) sql.exec("DELETE FROM history_blobs WHERE kind = ? AND id = ?", kind, id);
	};

	return {
		steps: () =>
			sql
				.exec<{ id: number; meta: string; bytes: number }>(
					"SELECT id, meta, bytes FROM history_steps ORDER BY id",
				)
				.toArray()
				.map((row) => ({ ...(JSON.parse(row.meta) as StepMeta), id: row.id, bytes: row.bytes })),
		update: (id) => blob("update", id),
		addStep: (meta, update) => {
			const row = sql
				.exec<{ id: number }>(
					"INSERT INTO history_steps (meta, bytes) VALUES (?, ?) RETURNING id",
					JSON.stringify(meta),
					meta.bytes,
				)
				.one();
			putBlob("update", row.id, update);
			return row.id;
		},
		putStep: (meta, update) => {
			const { id, ...rest } = meta;
			sql.exec(
				"INSERT OR REPLACE INTO history_steps (id, meta, bytes) VALUES (?, ?, ?)",
				id,
				JSON.stringify(rest),
				meta.bytes,
			);
			putBlob("update", id, update);
		},
		removeSteps: (ids) => {
			for (const id of ids) sql.exec("DELETE FROM history_steps WHERE id = ?", id);
			removeBlobs("update", ids);
		},
		keyframes: () =>
			sql
				.exec<{
					step: number;
					bytes: number;
				}>("SELECT step, bytes FROM history_keyframes ORDER BY step")
				.toArray()
				.map((row) => ({ step: row.step, bytes: row.bytes })),
		keyframe: (step) => blob("keyframe", step),
		putKeyframe: (step, state) => {
			sql.exec(
				"INSERT OR REPLACE INTO history_keyframes (step, bytes) VALUES (?, ?)",
				step,
				state.byteLength,
			);
			putBlob("keyframe", step, state);
		},
		removeKeyframes: (steps) => {
			for (const step of steps) sql.exec("DELETE FROM history_keyframes WHERE step = ?", step);
			removeBlobs("keyframe", steps);
		},
		actors: () =>
			sql
				.exec<{ actor: string }>("SELECT actor FROM history_actors")
				.toArray()
				.map((row) => JSON.parse(row.actor) as Actor),
		putActor: (actor) =>
			void sql.exec(
				"INSERT OR REPLACE INTO history_actors (key, actor) VALUES (?, ?)",
				actor.key,
				JSON.stringify(actor),
			),
		meta: (key) =>
			sql.exec<{ value: string }>("SELECT value FROM history_meta WHERE key = ?", key).toArray()[0]
				?.value ?? null,
		putMeta: (key, value) =>
			void sql.exec("INSERT OR REPLACE INTO history_meta (key, value) VALUES (?, ?)", key, value),
		transact: (fn) => storage.transactionSync(fn),
	};
}

// --- Who did what ---------------------------------------------------------------

const SYSTEM: Record<string, { kind: SystemKind; name: string }> = {
	push: { kind: "push", name: "Push" },
	rule: { kind: "rule", name: "Rules" },
	silent: { kind: "reveal", name: "Silent mode" },
	facilitation: { kind: "timer", name: "Timer" },
	repair: { kind: "repair", name: "Tack" },
	inbox: { kind: "inbox", name: "Inbox" },
	"stack-name": { kind: "naming", name: "Suggestions" },
};

/** Awareness state: what a person's client says about them (see src/client/presence.ts). */
interface Presence {
	user?: { name?: unknown; color?: unknown; avatarUrl?: unknown };
}

const AWARENESS_IDS = "__ypsAwarenessIds";

/**
 * Who made a transaction on the board's document. Updates from a client
 * arrive with its connection as the origin (y-partyserver): people signed
 * in are known by their GitHub id and login (from the Worker's access
 * check, which they can't forge), with the name and colour their client
 * shows; guests by their connection. Everything else is the server.
 */
export function attributeOrigin(origin: unknown, awareness: Awareness): Attribution {
	if (typeof origin === "string") {
		const system = SYSTEM[origin] ?? { kind: "server" as const, name: "Tack" };
		const key = `sys:${system.kind}`;
		return { key, actor: { key, name: system.name, color: "", system: system.kind } };
	}
	if (isConnection(origin)) {
		const access = origin.state as (ConnectionAccess & { [AWARENESS_IDS]?: number[] }) | null;
		const ids = access?.[AWARENESS_IDS] ?? [];
		const user = ids
			.map((id) => (awareness.getStates().get(id) as Presence | undefined)?.user)
			.find(Boolean);
		const name = clean(user?.name, 80);
		const color = clean(user?.color, 32);
		const avatar = clean(user?.avatarUrl, 300);
		const login = access?.login ? clean(access.login, 40) : "";
		const key = access?.userId != null ? `u:${access.userId}` : `g:${origin.id}`;
		const actor: Actor = { key, name: name || login || "Someone", color };
		if (login) actor.login = login;
		if (avatar.startsWith("https://avatars.githubusercontent.com/")) actor.avatarUrl = avatar;
		return { key, actor };
	}
	return {
		key: "sys:server",
		actor: { key: "sys:server", name: "Tack", color: "", system: "server" },
	};
}

function isConnection(origin: unknown): origin is Connection {
	return (
		typeof origin === "object" &&
		origin !== null &&
		typeof (origin as { id?: unknown }).id === "string" &&
		"state" in origin &&
		typeof (origin as { send?: unknown }).send === "function"
	);
}

function clean(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

// --- Routes ---------------------------------------------------------------------

export async function handleHistory(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/api\/boards\/([^/]+)\/history(\/segment)?$/.exec(url.pathname);
	if (!match) return null;
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
	const id = decode(match[1] ?? "");
	if (!id || !BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });

	const { configured, session } = env.TACK_SECRET
		? await lookupRequest(request, env)
		: { configured: false, session: null };
	const viewer = session?.viewer ?? null;
	const visitor = { user: viewer, allowed: !configured || (session?.allowed ?? false) };
	const policy = await directory(env).accessPolicy(id);
	if (!policy || !roleFor(policy, visitorKey(visitor))) {
		log.warn("access.denied", { board: id, reason: "history" });
		return json({ error: "not_found" }, { status: 404 });
	}

	const stub = await getServerByName<Env, Board>(boards(env), id);
	if (!match[2]) {
		return json(await stub.historyTimeline(), { headers: { "cache-control": "no-store" } });
	}
	const step = Number(url.searchParams.get("step"));
	if (!Number.isSafeInteger(step) || step < 0) return json({ error: "invalid" }, { status: 400 });
	const segment = await stub.historySegment(step);
	if (!segment) return json({ error: "not_found" }, { status: 404 });
	return new Response(segment as Uint8Array<ArrayBuffer>, {
		headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
	});
}

function decode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
