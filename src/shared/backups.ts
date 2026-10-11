// Backups to a branch (#59): a board's JSON export (boardExport.ts), written
// now and then to a branch of its own in a repository the board's owner
// chooses, as the app. Each backup is a commit, so the branch's history is
// the board's history in files. Only the owner turns it on, only for a
// repository where the app is installed and they can write, and both are
// checked again before every backup (src/server/backups.ts).

import { parseRepoKey } from "./refs.ts";

export type BackupInterval = "hour" | "day" | "week";

export const BACKUP_INTERVALS: Record<BackupInterval, { ms: number; label: string }> = {
	hour: { ms: 60 * 60_000, label: "Every hour" },
	day: { ms: 24 * 60 * 60_000, label: "Every day" },
	week: { ms: 7 * 24 * 60 * 60_000, label: "Every week" },
};

export const DEFAULT_BACKUP_BRANCH = "tack-backups";

/** Where a board's backup goes on the branch: one file per board, so boards can share a branch. */
export function backupPath(boardId: string): string {
	return `boards/${boardId}.json`;
}

/** What the owner chose. */
export interface BackupSettings {
	/** The repository's key, `github.com/owner/name`. */
	repo: string;
	branch: string;
	every: BackupInterval;
}

/** `GET /api/boards/:id/backup`: what's set, and how the last backup went. */
export interface BackupStatus {
	settings: BackupSettings | null;
	/** The file on the branch, once there is one. */
	path: string;
	/** Who turned it on. */
	by: { login: string; name?: string } | null;
	/** The last backup written, ISO 8601, and a link to its commit. */
	lastAt: string | null;
	lastUrl: string | null;
	/** Why the last try failed, in words, and when. Cleared by the next backup. */
	error: string | null;
	errorAt: string | null;
	/** When the next is due, ISO 8601 (skipped if nothing's changed since the last). */
	nextAt: string | null;
	/** Whether the repository is public, where known: the backups are readable by anyone then. */
	repoPublic: boolean | null;
	/** What the last backup left out: cards from repositories that aren't public, and face-down stickies. */
	omitted: { cards: number; faceDown: number } | null;
}

/** `PUT /api/boards/:id/backup` */
export type BackupRequest = BackupSettings;

/** Why backups couldn't be turned on. */
export type BackupError =
	| "sign_in_required"
	| "owner_required"
	| "not_found"
	| "invalid"
	| "invalid_repo"
	| "invalid_branch"
	| "not_installed"
	| "no_access"
	| "unreachable";

/** Words for why backups couldn't be turned on, for the dialog. */
export function describeBackupError(
	error: BackupError | "offline",
	repo = "that repository",
): string {
	switch (error) {
		case "sign_in_required":
			return "Sign in with GitHub to back boards up.";
		case "owner_required":
			return "Only the board’s owner can change its backups.";
		case "invalid_repo":
			return "That doesn’t look like a repository. Use owner/name.";
		case "invalid_branch":
			return "That isn’t a branch name git would take.";
		case "not_installed":
			return `The Tack app isn’t installed on ${repo}. Ask one of its admins to install it, then try again.`;
		case "no_access":
			return `You can’t write to ${repo}, so Tack won’t back up there for you.`;
		case "unreachable":
			return "Couldn’t reach GitHub just now. Try again in a moment.";
		case "offline":
			return "Couldn’t reach Tack just now. Try again?";
		default:
			return "Couldn’t turn backups on. Try again?";
	}
}

/** A branch name git would take (as `check-ref-format` has it), short enough to read. */
export function validBranchName(name: string): boolean {
	if (!name || name.length > 100) return false;
	if (/^[/-]|\.\.|\/\/|@\{|\.lock$|\/$|\.$|[\s~^:?*[\\]/.test(name)) return false;
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		if (code < 32 || code === 127) return false;
	}
	return name !== "HEAD" && name !== "@";
}

/** `owner/name` or a repository key, as a key on `host`, or null. */
export function backupRepoKey(input: string, host = "github.com"): string | null {
	const trimmed = input
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const key = /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? `${host}/${trimmed}` : trimmed;
	const parsed = parseRepoKey(key.toLowerCase());
	if (!parsed || !/^[\w.-]+\/[\w.-]+$/.test(parsed.repo)) return null;
	return `${parsed.host}/${parsed.repo}`;
}
