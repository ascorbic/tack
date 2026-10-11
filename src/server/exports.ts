// Importing boards and backing them up (#59). Exporting needs no route: the
// client has the document, and draws images and writes JSON itself.
//
//   POST   /api/boards/import           a new board from an export { board, title?, visibility? }
//   GET    /api/boards/:id/backup       backups: what's set and how the last went (editors)
//   PUT    /api/boards/:id/backup       turn them on, or change them { repo, branch, every } (the owner)
//   DELETE /api/boards/:id/backup       turn them off (the owner)
//   POST   /api/boards/:id/backup/run   back up now (the owner)

import { getServerByName } from "partyserver";
import * as v from "valibot";
import {
	BACKUP_INTERVALS,
	type BackupError,
	type BackupInterval,
	backupRepoKey,
} from "../shared/backups.ts";
import {
	BOARD_EXPORT_MAX_BYTES,
	type ImportedBoard,
	describeImportError,
	readBoardExport,
} from "../shared/boardExport.ts";
import { BOARD_ID, type BoardInfo, MAX_TITLE, canEdit } from "../shared/boards.ts";
import { isCrossSite, json } from "./auth/http.ts";
import { checkTarget } from "./backups.ts";
import type { Board } from "./board.ts";
import type { Visitor } from "./boards/access.ts";
import { notAllowed, respond, safeDecode, visitorFor } from "./boards/http.ts";
import { log } from "./log.ts";
import { boards, directory } from "./namespaces.ts";
import { resolveRepo } from "./routing.ts";

const ImportFields = v.object({
	title: v.optional(v.pipe(v.string(), v.maxLength(MAX_TITLE * 4))),
	visibility: v.optional(v.picklist(["private", "instance", "public"])),
	board: v.unknown(),
});

const BackupBody = v.object({
	repo: v.pipe(v.string(), v.maxLength(300)),
	branch: v.pipe(v.string(), v.maxLength(200)),
	every: v.picklist(Object.keys(BACKUP_INTERVALS) as BackupInterval[]),
});

const BACKUP_STATUS: Record<BackupError, number> = {
	sign_in_required: 401,
	owner_required: 403,
	not_found: 404,
	invalid: 400,
	invalid_repo: 422,
	invalid_branch: 422,
	not_installed: 422,
	no_access: 403,
	unreachable: 503,
};

function refuse(error: BackupError, message?: string): Response {
	return json({ error, ...(message ? { message } : {}) }, { status: BACKUP_STATUS[error] });
}

export async function handleExports(request: Request, env: Env): Promise<Response | null> {
	const path = new URL(request.url).pathname;
	const backup = /^\/api\/boards\/([^/]+)\/backup(\/run)?$/.exec(path);
	if (path !== "/api/boards/import" && !backup) return null;
	if (request.method !== "GET" && isCrossSite(request)) {
		log.warn("auth.rejected", { path });
		return json({ error: "forbidden" }, { status: 403 });
	}
	const visitor = await visitorFor(request, env);
	if (!backup) {
		if (request.method !== "POST") return notAllowed();
		return importRoute(request, env, visitor);
	}
	const id = backup[1] ? safeDecode(backup[1]) : null;
	if (!id || !BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });
	return backupRoute(request, env, visitor, id, Boolean(backup[2]));
}

async function importRoute(request: Request, env: Env, visitor: Visitor): Promise<Response> {
	const length = Number(request.headers.get("content-length") ?? 0);
	// The board, and a little for the title around it.
	const limit = BOARD_EXPORT_MAX_BYTES + 4096;
	if (length > limit) return json({ error: "too_large" }, { status: 413 });
	const text = await request.text();
	if (text.length > limit) return json({ error: "too_large" }, { status: 413 });
	let body: v.InferOutput<typeof ImportFields>;
	try {
		const parsed = v.safeParse(ImportFields, JSON.parse(text));
		if (!parsed.success) return json({ error: "invalid" }, { status: 400 });
		body = parsed.output;
	} catch {
		return json({ error: "invalid" }, { status: 400 });
	}
	const read = readBoardExport(body.board);
	if (!read.ok) {
		log.info("board.import.rejected", {
			reason: read.error.reason,
			by: visitor.user?.login,
		});
		return json(
			{ error: "invalid", reason: read.error.reason, message: describeImportError(read.error) },
			{ status: 422 },
		);
	}
	const index = directory(env);
	const title = (body.title ?? "").trim() || read.data.title;
	const created = await index.create(visitor, {
		...(title ? { title } : {}),
		...(body.visibility ? { visibility: body.visibility } : {}),
	});
	if (!created.ok) return respond(created);
	const board: ImportedBoard = { ...(created.value as BoardInfo), imported: null };
	try {
		const stub = await getServerByName<Env, Board>(boards(env), board.id);
		board.imported = await stub.importContent({
			data: read.data,
			by: {
				name: visitor.user?.name ?? visitor.user?.login ?? "Someone",
				...(visitor.user ? { login: visitor.user.login } : {}),
			},
		});
	} catch (error) {
		// The board's made; an empty one beats an error after the fact.
		log.error("board.import.failed", { board: board.id, error });
	}
	const fresh = await index.get(visitor, board.id);
	return json(fresh.ok ? { ...(fresh.value as BoardInfo), imported: board.imported } : board, {
		status: 201,
	});
}

async function backupRoute(
	request: Request,
	env: Env,
	visitor: Visitor,
	id: string,
	run: boolean,
): Promise<Response> {
	const method = request.method;
	if (run ? method !== "POST" : !["GET", "PUT", "DELETE"].includes(method)) return notAllowed();
	const user = visitor.user;
	if (!user) return refuse("sign_in_required");
	const found = await directory(env).get(visitor, id);
	if (!found.ok) return respond(found);
	const board = found.value as BoardInfo;
	const owner = board.role === "owner";
	if (method === "GET" ? !canEdit(board.role) : !owner) return refuse("owner_required");
	const stub = await getServerByName<Env, Board>(boards(env), id);

	if (method === "GET") return json({ ...(await stub.backupStatus()), canManage: owner });
	if (method === "DELETE")
		return json({ ...(await stub.disableBackup(user.login)), canManage: true });
	if (run) {
		const status = await stub.backupStatus();
		if (!status.settings) return refuse("invalid");
		return json({ ...(await stub.backupNow()), canManage: true });
	}

	const parsed = v.safeParse(BackupBody, await request.json().catch(() => null));
	if (!parsed.success) return refuse("invalid");
	const repo = backupRepoKey(parsed.output.repo);
	if (!repo) return refuse("invalid_repo");
	const branch = parsed.output.branch.trim();
	const check = await checkTarget(env, { repo, branch }, user.id, (key) => resolveRepo(env, key));
	if (!check.ok) {
		log.info("backup.refused", { board: id, repo, by: user.login, reason: check.error });
		return refuse(check.error, check.message);
	}
	const status = await stub.configureBackup({
		settings: { repo, branch, every: parsed.output.every },
		title: board.title,
		by: { id: user.id, login: user.login, ...(user.name ? { name: user.name } : {}) },
		repoPublic: check.repo.private === undefined ? null : !check.repo.private,
	});
	return json({ ...status, canManage: true });
}
