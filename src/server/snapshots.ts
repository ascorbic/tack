// Board snapshots for backlink comments (#33).
//
//   POST /api/boards/:id/snapshots   image/png body, editors only → 201 { url }
//   GET  /snapshots/:id.png          public: the image, cached for a year
//
// Snapshots are rendered in the browser (src/client/actions/snapshot.ts),
// which hides cards the comment's readers mustn't see before the image is
// made: the server never sees card data here, just a PNG. They're public
// because GitHub fetches them (through its image proxy) to show in comments,
// so their ids are unguessable: the board object's id, which says nothing
// about the board, then 128 random bits. Images live in the board object's
// SQLite storage, so they go wherever the board goes.

import { BOARD_ID, canEdit } from "../shared/boards.ts";
import {
	SNAPSHOT_ID,
	SNAPSHOT_MAX_BYTES,
	SNAPSHOT_MAX_SIDE,
	pngSize,
} from "../shared/backlinks.ts";
import { isCrossSite, json } from "./auth/http.ts";
import { visitorFor } from "./boards/routes.ts";
import { log } from "./log.ts";
import { boards, directory } from "./namespaces.ts";

/** How many snapshots one board keeps, and how many bytes in all. */
export const MAX_SNAPSHOTS_PER_BOARD = 1000;
export const MAX_SNAPSHOT_BYTES_PER_BOARD = 200_000_000;

/** Routes for snapshots, or null if the request isn't for one. */
export async function handleSnapshots(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const upload = /^\/api\/boards\/([^/]+)\/snapshots$/.exec(url.pathname);
	if (upload) return uploadSnapshot(request, env, upload[1] ?? "");
	const image = /^\/snapshots\/([^/]+)\.png$/.exec(url.pathname);
	if (image) return serveSnapshot(request, env, image[1] ?? "");
	return null;
}

function refuse(status: number, error: string, reason: string, context: object = {}): Response {
	log.warn("snapshot.rejected", { reason, ...context });
	return json({ error }, { status });
}

async function uploadSnapshot(request: Request, env: Env, rawId: string): Promise<Response> {
	if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
	if (isCrossSite(request)) return refuse(403, "forbidden", "cross_site");
	let id: string;
	try {
		id = decodeURIComponent(rawId);
	} catch {
		return json({ error: "not_found" }, { status: 404 });
	}
	if (!BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });

	const visitor = await visitorFor(request, env);
	const board = await directory(env).get(visitor, id);
	if (!board.ok) {
		const status = { not_found: 404, sign_in_required: 401 }[board.error as string] ?? 403;
		return refuse(status, board.error, "access", { board: id });
	}
	if (!canEdit(board.value.role)) {
		return refuse(403, "forbidden", "not_editor", { board: id, login: visitor.user?.login });
	}

	const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (type !== "image/png") return refuse(415, "unsupported_type", "type", { board: id, type });
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > SNAPSHOT_MAX_BYTES) {
		return refuse(413, "too_large", "size", { board: id, bytes: declared });
	}
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > SNAPSHOT_MAX_BYTES) {
		return refuse(413, "too_large", "size", { board: id, bytes: bytes.byteLength });
	}
	const size = pngSize(bytes);
	if (!size) return refuse(415, "unsupported_type", "not_png", { board: id });
	if (size.width > SNAPSHOT_MAX_SIDE || size.height > SNAPSHOT_MAX_SIDE) {
		return refuse(413, "too_large", "dimensions", { board: id, ...size });
	}

	const result = await boards(env)
		.getByName(id)
		.saveSnapshot(bytes.buffer as ArrayBuffer);
	if (!result.ok) return refuse(429, "quota", "quota", { board: id });
	log.info("snapshot.stored", {
		board: id,
		bytes: bytes.byteLength,
		width: size.width,
		height: size.height,
		login: visitor.user?.login,
	});
	const origin = new URL(request.url).origin;
	return json({ url: `${origin}/snapshots/${result.id}.png` }, { status: 201 });
}

async function serveSnapshot(request: Request, env: Env, id: string): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}
	const missing = () =>
		new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
	if (!SNAPSHOT_ID.test(id)) return missing();
	const namespace = boards(env);
	let object: DurableObjectId;
	try {
		object = namespace.idFromString(id.slice(0, 64));
	} catch {
		return missing();
	}
	const png = await namespace.get(object).snapshotImage(id.slice(64));
	if (!png) {
		log.info("snapshot.missing", { id: id.slice(64, 72) });
		return missing();
	}
	return new Response(request.method === "HEAD" ? null : png, {
		headers: {
			"content-type": "image/png",
			"content-length": String(png.byteLength),
			"cache-control": "public, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "cross-origin",
		},
	});
}

// Storage, inside the Board object ------------------------------------------------

const SCHEMA = `CREATE TABLE IF NOT EXISTS board_snapshots (
	token TEXT PRIMARY KEY,
	png BLOB NOT NULL,
	bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL
)`;

/**
 * Keep a snapshot in a board object's storage. Returns its public id, or
 * null when the board has used up its allowance.
 */
export function storeSnapshot(storage: DurableObjectStorage, objectId: string, png: ArrayBuffer) {
	const sql = storage.sql;
	sql.exec(SCHEMA);
	const [usage] = sql
		.exec<{ count: number; total: number | null }>(
			"SELECT COUNT(*) AS count, SUM(bytes) AS total FROM board_snapshots",
		)
		.toArray();
	if (
		(usage?.count ?? 0) >= MAX_SNAPSHOTS_PER_BOARD ||
		(usage?.total ?? 0) + png.byteLength > MAX_SNAPSHOT_BYTES_PER_BOARD
	) {
		return null;
	}
	const random = new Uint8Array(16);
	crypto.getRandomValues(random);
	const token = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	sql.exec(
		"INSERT INTO board_snapshots (token, png, bytes, created_at) VALUES (?, ?, ?, ?)",
		token,
		png,
		png.byteLength,
		Date.now(),
	);
	return `${objectId}${token}`;
}

/** A snapshot from a board object's storage, by the random part of its id. */
export function loadSnapshot(storage: DurableObjectStorage, token: string): ArrayBuffer | null {
	const sql = storage.sql;
	sql.exec(SCHEMA);
	const [row] = sql
		.exec<{ png: ArrayBuffer }>("SELECT png FROM board_snapshots WHERE token = ?", token)
		.toArray();
	return row?.png ?? null;
}
