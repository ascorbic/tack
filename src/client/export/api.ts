import type { BackupError, BackupRequest, BackupStatus } from "../../shared/backups.ts";
import type { ImportBoardRequest, ImportedBoard } from "../../shared/boardExport.ts";

// Importing boards and their backups (#59): `src/server/exports.ts`.

export type BackupView = BackupStatus & { canManage: boolean };

export type BackupResult =
	| { ok: true; value: BackupView }
	| { ok: false; error: BackupError | "offline"; message?: string };

export type ImportResult =
	| { ok: true; value: ImportedBoard }
	| { ok: false; error: string; message?: string };

async function request<T>(
	path: string,
	init: RequestInit = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string; message?: string }> {
	try {
		const response = await fetch(path, {
			...init,
			headers: {
				accept: "application/json",
				...(init.body ? { "content-type": "application/json" } : {}),
			},
		});
		const body = (await response.json().catch(() => null)) as
			| (T & { error?: undefined })
			| { error: string; message?: string }
			| null;
		if (response.ok && body) return { ok: true, value: body as T };
		if (body && "error" in body && body.error) {
			return { ok: false, error: body.error, ...(body.message ? { message: body.message } : {}) };
		}
		return { ok: false, error: response.status === 413 ? "too_large" : "offline" };
	} catch {
		return { ok: false, error: "offline" };
	}
}

const backupUrl = (board: string) => `/api/boards/${encodeURIComponent(board)}/backup`;

export const backupApi = {
	get: (board: string) => request<BackupView>(backupUrl(board)) as Promise<BackupResult>,
	set: (board: string, settings: BackupRequest) =>
		request<BackupView>(backupUrl(board), {
			method: "PUT",
			body: JSON.stringify(settings),
		}) as Promise<BackupResult>,
	off: (board: string) =>
		request<BackupView>(backupUrl(board), { method: "DELETE" }) as Promise<BackupResult>,
	now: (board: string) =>
		request<BackupView>(`${backupUrl(board)}/run`, { method: "POST" }) as Promise<BackupResult>,
};

export const importApi = {
	create: (body: ImportBoardRequest) =>
		request<ImportedBoard>("/api/boards/import", {
			method: "POST",
			body: JSON.stringify(body),
		}) as Promise<ImportResult>,
};
