// Images on boards: their files, kept beside the board.
//
//   POST /api/boards/:id/images            multipart: `image`, and an optional
//                                          `thumb`; editors → 201 { hash, type, width, height }
//   POST /api/boards/:id/images/copy       { from, hashes }: files from another board
//                                          (copy and paste between boards); editors here
//                                          who can open the other → { copied, missing }
//   GET  /api/boards/:id/images/:hash      the file, for anyone who can open the board
//
// Files live in the board's own Durable Object, in its SQLite storage, like
// its document and its backlink snapshots: no bucket to set up, they go
// wherever the board goes, and access is the board's. Each is named by the
// SHA-256 of its bytes, so the same file is stored once however many times
// it's on the board, and a file's address never changes what it serves:
// browsers keep it for a year without asking again.
//
// The browser downscales and re-encodes before uploading (src/client/images/),
// but nothing here trusts that: the server checks the bytes are a raster
// format it keeps (never SVG), no bigger than the limit, with dimensions it
// can read and that aren't huge (a small file can decode to a vast image).
// Files are served as what they are, with nosniff and a CSP that lets
// nothing run, from the instance's own origin.
//
// Garbage collection: as the board saves, at most hourly, files no shape
// has shown for a week (`IMAGE_KEEP_MS`) and that nothing in the board's
// history mentions are deleted. So undo, someone's clipboard and History's
// Bring back all find a removed image's file for at least a week, and as
// long as history can reach it. Boards are archived, never deleted; if one
// ever is, deleting its object deletes its files.

import { BOARD_ID, canEdit } from "../shared/boards.ts";
import {
	IMAGE_LIMITS,
	type ImageType,
	checkImageFile,
	hashImage,
	isImageHash,
	readImageSize,
	sniffImage,
} from "../shared/images.ts";
import { json } from "./auth/http.ts";
import { lookupRequest } from "./auth/session.ts";
import { roleFor, visitorKey } from "./boards/access.ts";
import { log } from "./log.ts";
import { boards, directory } from "./namespaces.ts";

/** A file nothing shows is kept at least this long after it was last seen on the board. */
export const IMAGE_KEEP_MS = 7 * 24 * 60 * 60_000;
/** How often a board looks for files it can let go of. */
export const IMAGE_SWEEP_MS = 60 * 60_000;

/** The most an upload's body may be: a file, its thumbnail, and the form around them. */
const MAX_BODY = IMAGE_LIMITS.bytes + IMAGE_LIMITS.thumbBytes + 64 * 1024;
/** How many files one copy asks for. */
const MAX_COPY = 50;

const ERRORS: Record<string, number> = {
	type: 415,
	size: 413,
	dimensions: 413,
	unreadable: 415,
	quota: 413,
};

export async function handleImages(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/api\/boards\/([^/]+)\/images(?:\/([^/]+))?$/.exec(url.pathname);
	if (!match) return null;
	const id = decode(match[1] ?? "");
	if (!id || !BOARD_ID.test(id)) return notFound();
	const rest = match[2];
	if (rest === undefined) {
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
		const response = await upload(request, env, id);
		await discardBody(request);
		return response;
	}
	if (rest === "copy") {
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
		return copy(request, env, id);
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: "method_not_allowed" }, { status: 405 });
	}
	return serve(request, env, id, rest);
}

/** The asker's role on a board, or null if they can't open it (or it isn't there). */
async function roleOn(request: Request, env: Env, board: string) {
	const { configured, session } = env.TACK_SECRET
		? await lookupRequest(request, env)
		: { configured: false, session: null };
	const visitor = {
		user: session?.viewer ?? null,
		allowed: !configured || (session?.allowed ?? false),
	};
	const policy = await directory(env).accessPolicy(board);
	return {
		role: policy ? roleFor(policy, visitorKey(visitor)) : null,
		login: visitor.user?.login,
	};
}

async function upload(request: Request, env: Env, board: string): Promise<Response> {
	const { role, login } = await roleOn(request, env, board);
	if (!role) return refuse(404, "not_found", "access", { board });
	if (!canEdit(role)) return refuse(403, "forbidden", "not_editor", { board, login });
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
		return refuse(413, "size", "size", { board }, tooBig());
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return refuse(400, "invalid", "form", { board });
	}
	const file = form.get("image");
	if (!file || typeof file === "string") return refuse(400, "invalid", "form", { board });
	if (file.size > IMAGE_LIMITS.bytes) {
		return refuse(413, "size", "size", { board, bytes: file.size }, tooBig());
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	const checked = checkImageFile(bytes);
	if ("reason" in checked) {
		return refuse(
			ERRORS[checked.reason] ?? 400,
			checked.reason,
			checked.reason,
			{ board },
			checked.message,
		);
	}
	const thumb = await readThumb(form.get("thumb"));
	const hash = await hashImage(bytes);
	const stored = await boards(env)
		.getByName(board)
		.storeImage({
			hash,
			bytes: bytes.buffer as ArrayBuffer,
			type: checked.type,
			width: checked.width,
			height: checked.height,
			thumb,
		});
	if (!stored.ok) {
		return refuse(
			413,
			"quota",
			"quota",
			{ board },
			"This board has no room for more images. Remove some, then try again.",
		);
	}
	log.info("image.stored", {
		board,
		bytes: bytes.byteLength,
		type: checked.type,
		width: checked.width,
		height: checked.height,
		deduped: !stored.added,
		login,
	});
	return json(
		{ hash, type: checked.type, width: checked.width, height: checked.height },
		{ status: 201 },
	);
}

/** A thumbnail is a convenience (board images drawn on the server): one that's wrong is dropped. */
async function readThumb(
	value: File | string | null,
): Promise<{ bytes: ArrayBuffer; type: ImageType } | undefined> {
	if (!value || typeof value === "string" || value.size > IMAGE_LIMITS.thumbBytes) return undefined;
	const bytes = new Uint8Array(await value.arrayBuffer());
	const type = sniffImage(bytes);
	// Only what the server's renderer draws.
	if (type !== "image/png" && type !== "image/jpeg") return undefined;
	const size = readImageSize(bytes, type);
	const edge = IMAGE_LIMITS.thumbEdge * 2;
	if (!size || size.width > edge || size.height > edge) return undefined;
	return { bytes: bytes.buffer as ArrayBuffer, type };
}

async function copy(request: Request, env: Env, board: string): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		from?: unknown;
		hashes?: unknown;
	} | null;
	const from = typeof body?.from === "string" ? body.from : "";
	const hashes = Array.isArray(body?.hashes) ? body.hashes.filter(isImageHash) : [];
	if (!BOARD_ID.test(from) || hashes.length === 0 || hashes.length > MAX_COPY) {
		return json({ error: "invalid" }, { status: 400 });
	}
	const here = await roleOn(request, env, board);
	if (!here.role) return refuse(404, "not_found", "access", { board });
	if (!canEdit(here.role)) return refuse(403, "forbidden", "not_editor", { board });
	// The files come from a board they can open, or not at all: the same 404
	// whether it doesn't exist or they can't see it.
	const there = await roleOn(request, env, from);
	if (!there.role) return refuse(404, "not_found", "copy_access", { board, from });
	const target = boards(env).getByName(board);
	const source = boards(env).getByName(from);
	const copied: string[] = [];
	const missing: string[] = [];
	for (const hash of new Set(hashes)) {
		if (await target.hasImage(hash)) {
			copied.push(hash);
			continue;
		}
		const file = await source.imageRecord(hash);
		if (!file) {
			missing.push(hash);
			continue;
		}
		const stored = await target.storeImage({ hash, ...file });
		if (!stored.ok) {
			return refuse(
				413,
				"quota",
				"quota",
				{ board },
				"This board has no room for more images. Remove some, then try again.",
			);
		}
		copied.push(hash);
	}
	log.info("image.copied", { board, from, copied: copied.length, missing: missing.length });
	return json({ copied, missing });
}

async function serve(request: Request, env: Env, board: string, hash: string): Promise<Response> {
	if (!isImageHash(hash)) return notFound();
	const { role } = await roleOn(request, env, board);
	// Not there, or not theirs to see: the same answer.
	if (!role) return notFound();
	const etag = `"${hash}"`;
	const cache = {
		etag,
		// Private: only people who can open the board may see it.
		"cache-control": "private, max-age=31536000, immutable",
	};
	if (request.headers.get("if-none-match")?.includes(etag)) {
		return new Response(null, { status: 304, headers: cache });
	}
	const file = await boards(env).getByName(board).imageFile(hash);
	if (!file) return notFound();
	return new Response(request.method === "HEAD" ? null : file.bytes, {
		headers: {
			...cache,
			"content-type": file.type,
			"content-length": String(file.bytes.byteLength),
			"content-disposition": "inline",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
		},
	});
}

function notFound(): Response {
	return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

function refuse(
	status: number,
	error: string,
	reason: string,
	context: object,
	message?: string,
): Response {
	log.warn("image.rejected", { reason, ...context });
	return json({ error, ...(message ? { message } : {}) }, { status });
}

function tooBig(): string {
	return `Images can be up to ${IMAGE_LIMITS.bytes / (1024 * 1024)} MB.`;
}

/**
 * Read the rest of a refused upload's body without keeping it, so the
 * client sees the refusal rather than a reset connection (as snapshots do).
 */
async function discardBody(request: Request): Promise<void> {
	if (!request.body || request.bodyUsed) return;
	await request.body.pipeTo(new WritableStream()).catch(() => {});
}

function decode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

// Storage, inside the Board object ------------------------------------------------

// Rows max out at 2 MB, so files are kept in chunks.
const CHUNK = 1024 * 1024;

const TABLES = `
	CREATE TABLE IF NOT EXISTS board_images (
		hash TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		bytes INTEGER NOT NULL,
		width INTEGER NOT NULL,
		height INTEGER NOT NULL,
		thumb BLOB,
		thumb_type TEXT,
		created_at INTEGER NOT NULL,
		last_used INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS board_image_chunks (
		hash TEXT NOT NULL,
		seq INTEGER NOT NULL,
		chunk BLOB NOT NULL,
		PRIMARY KEY (hash, seq)
	);
`;

export interface StoredImage {
	hash: string;
	bytes: ArrayBuffer;
	type: ImageType;
	width: number;
	height: number;
	thumb?: { bytes: ArrayBuffer; type: ImageType };
}

export type StoreResult = { ok: true; added: boolean } | { ok: false; reason: "quota" };

/** A board's image files, in its object's SQLite storage. */
export class ImageStore {
	private ready = false;

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly now: () => number = Date.now,
	) {}

	private get sql(): SqlStorage {
		if (!this.ready) {
			this.storage.sql.exec(TABLES);
			this.ready = true;
		}
		return this.storage.sql;
	}

	has(hash: string): boolean {
		return (
			this.sql
				.exec<{ n: number }>("SELECT COUNT(*) AS n FROM board_images WHERE hash = ?", hash)
				.one().n > 0
		);
	}

	/** Keep a file, unless it's already here (a thumbnail it lacked is added) or there's no room. */
	store(image: StoredImage): StoreResult {
		const sql = this.sql;
		const now = this.now();
		if (this.has(image.hash)) {
			if (image.thumb) {
				sql.exec(
					"UPDATE board_images SET thumb = ?, thumb_type = ?, last_used = ? WHERE hash = ? AND thumb IS NULL",
					image.thumb.bytes,
					image.thumb.type,
					now,
					image.hash,
				);
			}
			sql.exec("UPDATE board_images SET last_used = ? WHERE hash = ?", now, image.hash);
			return { ok: true, added: false };
		}
		const usage = this.usage();
		if (
			usage.count >= IMAGE_LIMITS.boardCount ||
			usage.bytes + image.bytes.byteLength > IMAGE_LIMITS.boardBytes
		) {
			return { ok: false, reason: "quota" };
		}
		this.storage.transactionSync(() => {
			sql.exec(
				`INSERT INTO board_images (hash, type, bytes, width, height, thumb, thumb_type, created_at, last_used)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				image.hash,
				image.type,
				image.bytes.byteLength,
				image.width,
				image.height,
				image.thumb?.bytes ?? null,
				image.thumb?.type ?? null,
				now,
				now,
			);
			for (let i = 0; i * CHUNK < image.bytes.byteLength; i++) {
				sql.exec(
					"INSERT INTO board_image_chunks (hash, seq, chunk) VALUES (?, ?, ?)",
					image.hash,
					i,
					image.bytes.slice(i * CHUNK, (i + 1) * CHUNK),
				);
			}
		});
		return { ok: true, added: true };
	}

	/** A file's bytes and type. */
	file(hash: string): { bytes: ArrayBuffer; type: ImageType } | null {
		const [row] = this.sql
			.exec<{ type: string }>("SELECT type FROM board_images WHERE hash = ?", hash)
			.toArray();
		if (!row) return null;
		const chunks = this.sql
			.exec<{ chunk: ArrayBuffer }>(
				"SELECT chunk FROM board_image_chunks WHERE hash = ? ORDER BY seq",
				hash,
			)
			.toArray();
		const total = chunks.reduce((n, each) => n + each.chunk.byteLength, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const { chunk } of chunks) {
			out.set(new Uint8Array(chunk), offset);
			offset += chunk.byteLength;
		}
		return { bytes: out.buffer, type: row.type as ImageType };
	}

	/** Everything kept about a file, to copy it to another board. */
	record(hash: string): Omit<StoredImage, "hash"> | null {
		const [row] = this.sql
			.exec<{
				width: number;
				height: number;
				thumb: ArrayBuffer | null;
				thumb_type: string | null;
			}>("SELECT width, height, thumb, thumb_type FROM board_images WHERE hash = ?", hash)
			.toArray();
		const file = row && this.file(hash);
		if (!row || !file) return null;
		return {
			...file,
			width: row.width,
			height: row.height,
			...(row.thumb && row.thumb_type
				? { thumb: { bytes: row.thumb, type: row.thumb_type as ImageType } }
				: {}),
		};
	}

	/** Thumbnails as data URLs, for drawing the board on the server. */
	thumbs(hashes: Iterable<string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const hash of hashes) {
			const [row] = this.sql
				.exec<{ thumb: ArrayBuffer | null; thumb_type: string | null }>(
					"SELECT thumb, thumb_type FROM board_images WHERE hash = ?",
					hash,
				)
				.toArray();
			if (row?.thumb && row.thumb_type) out[hash] = dataUrl(row.thumb, row.thumb_type);
		}
		return out;
	}

	usage(): { count: number; bytes: number } {
		const row = this.sql
			.exec<{ count: number; bytes: number | null }>(
				"SELECT COUNT(*) AS count, SUM(bytes) AS bytes FROM board_images",
			)
			.one();
		return { count: row.count, bytes: row.bytes ?? 0 };
	}

	/**
	 * Note the files the board shows now, and let go of those nothing's shown
	 * for `IMAGE_KEEP_MS` that `mentioned` (the board's history) doesn't
	 * name either. Returns the hashes deleted.
	 */
	sweep(shown: ReadonlySet<string>, mentioned: (hash: string) => boolean): string[] {
		const sql = this.sql;
		const now = this.now();
		const rows = sql
			.exec<{ hash: string; last_used: number }>("SELECT hash, last_used FROM board_images")
			.toArray();
		const removed: string[] = [];
		this.storage.transactionSync(() => {
			for (const { hash, last_used } of rows) {
				if (shown.has(hash)) {
					sql.exec("UPDATE board_images SET last_used = ? WHERE hash = ?", now, hash);
				} else if (now - last_used >= IMAGE_KEEP_MS && !mentioned(hash)) {
					sql.exec("DELETE FROM board_image_chunks WHERE hash = ?", hash);
					sql.exec("DELETE FROM board_images WHERE hash = ?", hash);
					removed.push(hash);
				}
			}
		});
		return removed;
	}
}

/**
 * Whether the board's history mentions a file: Yjs keeps strings as they
 * are in updates, so a hash in any step or keyframe is its bytes. Halves
 * are searched for, so one split across two chunks is still found (a false
 * match only keeps a file longer).
 */
export function historyMentions(sql: SqlStorage, hash: string): boolean {
	const encode = (text: string) => new TextEncoder().encode(text);
	for (const half of [hash.slice(0, 32), hash.slice(32)]) {
		try {
			const [row] = sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM history_blobs WHERE instr(chunk, ?) > 0",
					encode(half).buffer,
				)
				.toArray();
			if ((row?.n ?? 0) > 0) return true;
		} catch {
			// No history table: nothing in history.
			return false;
		}
	}
	return false;
}

function dataUrl(bytes: ArrayBuffer, type: string): string {
	let binary = "";
	const view = new Uint8Array(bytes);
	for (let i = 0; i < view.length; i += 0x8000) {
		binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
	}
	return `data:${type};base64,${btoa(binary)}`;
}
