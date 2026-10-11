// Backups to a branch (#59), on the board's object: now and then, the
// board's JSON export (src/shared/boardExport.ts) is committed to a branch
// of its own in a repository its owner chose, as the app, through the
// forge's write path (`writeBranch`, an orphan branch the first time).
//
// - Only the owner turns it on (`PUT /api/boards/:id/backup`), and only for
//   a repository where the app is installed and they can write. Both are
//   checked again before every backup, with the owner's own token: whoever
//   owns the board then (ownership can be handed over), so backups stop if
//   they lose access, and say why.
// - Nothing's written when nothing's changed since the last backup (a hash
//   of the export, without its time).
// - Cards from repositories that aren't public are left out, unless they're
//   from the backup's own repository: anyone who can read the backups can
//   read those. Face-down stickies stay out, as in every export.
// - The schedule lives in the board's SQLite and its alarm, which the push
//   engine shares (`alarmAt` only ever brings it forward). A failure that's
//   worth retrying (rate limits, outages) tries again sooner.

import type * as Y from "yjs";
import {
	BACKUP_INTERVALS,
	type BackupError,
	type BackupSettings,
	type BackupStatus,
	backupPath,
	backupRepoKey,
	validBranchName,
} from "../shared/backups.ts";
import { exportBoard, serialiseExport } from "../shared/boardExport.ts";
import type { Card, MissingCard } from "../shared/cards.ts";
import { parseRepoKey, repoKeyOf } from "../shared/refs.ts";
import { directory } from "./namespaces.ts";
import { type MissingReason, type RepoIdentity, forge } from "./forges/index.ts";
import { installationToken } from "./github/tokens.ts";
import { userToken } from "./identity.ts";
import { log } from "./log.ts";
import { isPublic } from "./visibility.ts";

type Entry = Card | MissingCard;

/** How soon to try again after a failure worth retrying, without a time from the forge. */
const RETRY_MS = 15 * 60_000;

export interface BackupHost {
	/** The board's id. */
	name: string;
	env: Env;
	doc: Y.Doc;
	sql: SqlStorage;
	route(repoKey: string): Promise<RepoIdentity | MissingReason>;
	/** The board's card for an item, as the server holds it. */
	card(key: string): Entry | undefined;
	alarmAt(at: number): Promise<void>;
}

interface Stored {
	settings: BackupSettings;
	title: string;
	by: { id: number; login: string; name?: string };
	lastAt: string | null;
	lastUrl: string | null;
	lastHash: string | null;
	error: string | null;
	errorAt: string | null;
	/** ms since the epoch. */
	nextAt: number;
	repoPublic: boolean | null;
	omitted: BackupStatus["omitted"];
}

export type TargetCheck =
	| { ok: true; repo: RepoIdentity; token: string }
	| { ok: false; error: BackupError; message: string };

const short = (repoKey: string) => parseRepoKey(repoKey)?.repo ?? repoKey;

/**
 * Whether a board's owner may back up to a repository, as the app: the
 * forge can, the app's installed there (on forges that need it) and the
 * owner can write there, checked with their own token. Returns the
 * repository and the app's token to write with.
 */
export async function checkTarget(
	env: Env,
	settings: Pick<BackupSettings, "repo" | "branch">,
	ownerId: number | null,
	route: (repoKey: string) => Promise<RepoIdentity | MissingReason>,
): Promise<TargetCheck> {
	const key = backupRepoKey(settings.repo);
	const parsed = key ? parseRepoKey(key) : null;
	const adapter = parsed ? forge(parsed.forge) : null;
	const name = key ? short(key) : settings.repo;
	if (!key || !adapter?.writeBranch || !adapter.canWrite) {
		return { ok: false, error: "invalid_repo", message: `Tack can’t back up to ${name}.` };
	}
	if (!validBranchName(settings.branch)) {
		return {
			ok: false,
			error: "invalid_branch",
			message: `“${settings.branch}” isn’t a branch name.`,
		};
	}
	const repo = await route(key);
	if (repo === "error") {
		return { ok: false, error: "unreachable", message: `Couldn’t reach ${parsed?.host}.` };
	}
	if (typeof repo === "string") {
		// A private repository the app isn't on looks missing from here.
		return {
			ok: false,
			error: "not_installed",
			message: `Couldn’t find ${name}, or the Tack app isn’t installed on it.`,
		};
	}
	let ownerToken = "";
	let appToken = "fake";
	if (adapter.installed) {
		const token = ownerId !== null && ownerId > 0 ? await userToken(env, ownerId) : null;
		if (!token) {
			return {
				ok: false,
				error: "sign_in_required",
				message:
					"The board’s owner needs to sign in to Tack again, so it can check they can still write there.",
			};
		}
		ownerToken = token;
		const installed = await adapter.installed(repo, env, { fresh: true }).catch(() => false);
		const minted = installed ? await installationToken(env, key) : null;
		if (!minted) {
			return {
				ok: false,
				error: "not_installed",
				message: `The Tack app isn’t installed on ${name}.`,
			};
		}
		appToken = minted;
	}
	try {
		if (!(await adapter.canWrite(repo, ownerToken, env))) {
			return {
				ok: false,
				error: "no_access",
				message: `The board’s owner can’t write to ${name}.`,
			};
		}
	} catch {
		return { ok: false, error: "unreachable", message: `Couldn’t check access to ${name}.` };
	}
	return { ok: true, repo, token: appToken };
}

async function hash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Backups {
	private running: Promise<void> | null = null;

	constructor(private readonly host: BackupHost) {
		host.sql.exec(
			"CREATE TABLE IF NOT EXISTS backup (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
		);
	}

	private read(): Stored | null {
		const row = this.host.sql
			.exec<{ state: string }>("SELECT state FROM backup WHERE id = 1")
			.toArray()[0];
		return row ? (JSON.parse(row.state) as Stored) : null;
	}

	private write(stored: Stored | null): void {
		if (!stored) this.host.sql.exec("DELETE FROM backup");
		else {
			this.host.sql.exec(
				"INSERT OR REPLACE INTO backup (id, state) VALUES (1, ?)",
				JSON.stringify(stored),
			);
		}
	}

	status(): BackupStatus {
		const stored = this.read();
		return {
			settings: stored?.settings ?? null,
			path: backupPath(this.host.name),
			by: stored
				? { login: stored.by.login, ...(stored.by.name ? { name: stored.by.name } : {}) }
				: null,
			lastAt: stored?.lastAt ?? null,
			lastUrl: stored?.lastUrl ?? null,
			error: stored?.error ?? null,
			errorAt: stored?.errorAt ?? null,
			nextAt: stored ? new Date(stored.nextAt).toISOString() : null,
			repoPublic: stored?.repoPublic ?? null,
			omitted: stored?.omitted ?? null,
		};
	}

	/**
	 * Turn backups on, or change where they go, as checked by the Worker
	 * (the owner, who can write there). The first backup is made straight away.
	 */
	async configure(input: {
		settings: BackupSettings;
		title: string;
		by: Stored["by"];
		repoPublic: boolean | null;
	}): Promise<BackupStatus> {
		const previous = this.read();
		const moved =
			!previous ||
			previous.settings.repo !== input.settings.repo ||
			previous.settings.branch !== input.settings.branch;
		this.write({
			settings: input.settings,
			title: input.title,
			by: input.by,
			lastAt: moved ? null : (previous?.lastAt ?? null),
			lastUrl: moved ? null : (previous?.lastUrl ?? null),
			lastHash: moved ? null : (previous?.lastHash ?? null),
			error: null,
			errorAt: null,
			nextAt: moved
				? Date.now()
				: (previous?.lastAt ? Date.parse(previous.lastAt) : Date.now()) +
					BACKUP_INTERVALS[input.settings.every].ms,
			repoPublic: input.repoPublic,
			omitted: moved ? null : (previous?.omitted ?? null),
		});
		log.info("backup.configured", {
			board: this.host.name,
			repo: input.settings.repo,
			branch: input.settings.branch,
			every: input.settings.every,
			by: input.by.login,
		});
		if (moved) await this.run("now");
		else await this.arm();
		return this.status();
	}

	disable(by: string): void {
		const stored = this.read();
		if (!stored) return;
		this.write(null);
		log.info("backup.disabled", { board: this.host.name, repo: stored.settings.repo, by });
	}

	/** The board was renamed: the next backup's commit says so. */
	renamed(title: string): void {
		const stored = this.read();
		if (stored) this.write({ ...stored, title });
	}

	/** From the alarm: back up if it's due. */
	async runIfDue(): Promise<void> {
		const stored = this.read();
		if (!stored) return;
		if (stored.nextAt <= Date.now()) await this.run("schedule");
		else await this.arm();
	}

	/** Back up now (`now`: asked for, so written even if nothing's changed since). One at a time. */
	run(reason: "schedule" | "now"): Promise<void> {
		this.running ??= this.runOnce(reason)
			.catch((error: unknown) =>
				log.error("backup.failed", { board: this.host.name, reason: "exception", error }),
			)
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}

	private async arm(): Promise<void> {
		const stored = this.read();
		if (stored) await this.host.alarmAt(Math.max(stored.nextAt, Date.now()));
	}

	private async runOnce(reason: "schedule" | "now"): Promise<void> {
		const stored = this.read();
		if (!stored) return;
		const { settings } = stored;
		const interval = BACKUP_INTERVALS[settings.every].ms;
		const context = { board: this.host.name, repo: settings.repo, branch: settings.branch, reason };
		const failed = (message: string, retryAt?: number) => {
			const now = Date.now();
			this.write({
				...stored,
				error: message,
				errorAt: new Date(now).toISOString(),
				nextAt: retryAt ?? now + Math.min(interval, RETRY_MS),
			});
			log.warn("backup.failed", { ...context, error: message });
		};

		try {
			const policy = await directory(this.host.env).accessPolicy(this.host.name);
			if (!policy) return;
			const check = await checkTarget(this.host.env, settings, policy.ownerId, (key) =>
				this.host.route(key),
			);
			if (!check.ok) {
				// Not worth hammering: a person has to fix it. Try again on schedule.
				failed(check.message, Date.now() + interval);
				return;
			}

			const { data, omitted } = exportBoard(this.host.doc, {
				title: stored.title,
				includeCard: (key) => {
					if (repoKeyOf(key).toLowerCase() === settings.repo) return true;
					const card = this.host.card(key);
					return card !== undefined && isPublic(card) && !("missing" in card);
				},
			});
			const fingerprint = await hash(serialiseExport({ ...data, exportedAt: "" }));
			if (reason === "schedule" && fingerprint === stored.lastHash) {
				this.write({ ...stored, nextAt: Date.now() + interval });
				log.info("backup.unchanged", context);
				return;
			}
			const adapter = forge(check.repo.forge);
			const result = await adapter.writeBranch?.(
				check.repo,
				{
					branch: settings.branch,
					files: [{ path: backupPath(this.host.name), content: serialiseExport(data) }],
					message: `Back up “${stored.title}” from Tack`,
				},
				{ as: "app", token: check.token },
				this.host.env,
			);
			if (!result) {
				failed(`Tack can’t back up to ${short(settings.repo)}.`, Date.now() + interval);
				return;
			}
			if (!result.ok) {
				failed(result.error, result.retryable ? result.retryAt : Date.now() + interval);
				return;
			}
			const now = Date.now();
			this.write({
				...stored,
				lastAt: new Date(now).toISOString(),
				lastUrl: result.url,
				lastHash: fingerprint,
				error: null,
				errorAt: null,
				nextAt: now + interval,
				repoPublic: check.repo.private === undefined ? null : !check.repo.private,
				omitted,
			});
			log.info("backup.written", {
				...context,
				sha: result.sha,
				unchanged: result.unchanged,
				shapes: data.shapes.length,
				omittedCards: omitted.cards,
			});
		} finally {
			await this.arm();
		}
	}
}
