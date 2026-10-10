// The push engine: runs inside a board's Durable Object (`Board`), and is the
// only thing that writes staged changes to forges.
//
// A push checks who's pushing (signed in, with write access to every
// repository it writes to, where the app is installed), then queues the
// changes in dependency order in the board's SQLite storage, snapshotting
// each operation as it was when pushed: later edits to the document never
// change what's written. The queue runs from the object's alarm, one write
// at a time with a pause between them (GitHub asks for a second between
// writes), in batches, so a big push never holds the object for long.
// Retryable failures (rate limits, timeouts, 5xx) wait and try again,
// keeping the push's order; anything else fails that change, and the ones
// that needed it.
//
// Statuses go into the document (staged → sending → sent → applied, or
// failed) with `PUSH_ORIGIN`, so nobody can undo them. SQLite holds the
// truth: a change the server is pushing, or has applied, can't be pushed
// again whatever the document says, so nothing is ever written twice.
//
// A `sent` change is confirmed when the card shows it (`reflects`): the
// board subscribes to the item, so the webhook's update (or the fetch on
// subscribing) arrives through `cardsArrived`. Ones that don't confirm in
// time are fetched once more (reconciliation), then failed with a reason.

import * as Y from "yjs";
import type { Card, MissingCard } from "../../shared/cards.ts";
import {
	type ChangeEffect,
	type ChangeStatus,
	changesMap,
	listChanges,
	type Operation,
	operationRepo,
	pendingDependencies,
	type PendingChange,
	type PushAs,
	resolveTargets,
	type Stager,
} from "../../shared/changes.ts";
import { confirmationKey, reflects } from "../../shared/confirm.ts";
import type { AuditEntry, PushResponse } from "../../shared/push.ts";
import { parseKey, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import { linkActionItems } from "../../shared/actionItems.ts";
import { linkWrittenDecisions } from "../../shared/decisions.ts";
import { placeCard } from "../../shared/place.ts";
import { shapesMap } from "../../shared/shapes.ts";
import {
	type ApplyResult,
	type ForgeAdapter,
	forge,
	type MissingReason,
	type RepoIdentity,
} from "../forges/index.ts";
import { installationToken } from "../github/tokens.ts";
import { userToken } from "../identity.ts";
import { type Logger, log } from "../log.ts";
import { type PlanItem, type PlanResult, planPush, summarize as summarizeOp } from "./plan.ts";

/** The transaction origin for the server's writes to changes and shapes: never undoable. */
export const PUSH_ORIGIN = "push";

/** Who's pushing: a signed-in person (checked by the Worker). */
export interface Pusher {
	id: number;
	login: string;
	name: string | null;
}

export interface PushCommand {
	ids: string[];
	as: PushAs;
	by: Pusher;
}

export interface PushTiming {
	/** Pause between writes. GitHub asks for at least a second between mutations. */
	spacingMs: number;
	/** How long a `sent` change waits for its card to show it before reconciling. */
	confirmMs: number;
	/** The first wait before retrying a failure that doesn't say when (a timeout, a 5xx). */
	backoffMs: number;
}

/** What the engine needs from its board. */
export interface PushHost {
	name: string;
	env: Env;
	doc: Y.Doc;
	sql: SqlStorage;
	/** A repository's identity by key, as the board routes it. */
	route(repoKey: string): Promise<RepoIdentity | MissingReason>;
	/** The items to watch for confirmation changed (see `watchKeys`). */
	watch(): void;
	/** Save the document now, rather than after the usual debounce. */
	persist(): void;
	/** Make sure the alarm goes off by `at`. */
	alarmAt(at: number): Promise<void>;
	/**
	 * A write landed in these repositories (keys). Not every write comes
	 * back as a webhook the app hears (blocked-by and sub-issues don't), so
	 * the board's widgets reading them should look again.
	 */
	wrote?(repoKeys: string[]): void;
}

const DEFAULT_TIMING: PushTiming = { spacingMs: 1_000, confirmMs: 2 * 60_000, backoffMs: 5_000 };
/** Writes per alarm, so one push never holds the board's object for long. */
const BATCH = 25;
const MAX_ATTEMPTS = 8;
/** Waits before retrying failures that don't say when, in `backoffMs`: 5s, 15s, 45s… up to 15 minutes. */
const BACKOFF = [1, 3, 9, 24, 60, 120, 180];
/** Rate limits that won't lift for longer than this fail rather than wait. */
const MAX_WAIT_MS = 70 * 60_000;
/** Pushes kept in the audit log. */
const AUDIT_KEEP = 200;
/** Pushes returned by `audit`. */
const AUDIT_PAGE = 50;

type ItemState = "queued" | "sending" | "sent" | "applied" | "failed";

type PushRow = {
	id: string;
	at: number;
	user_id: number;
	login: string;
	name: string | null;
	push_as: PushAs;
	done: number;
};

type ItemRow = {
	push_id: string;
	change_id: string;
	seq: number;
	kind: string;
	/** The operation as pushed (JSON). */
	op: string;
	/** The operation as applied, pending targets resolved (JSON). */
	applied_op: string | null;
	effect: string | null;
	summary: string;
	repo: string | null;
	state: ItemState;
	attempts: number;
	first_attempt_at: number | null;
	retry_at: number | null;
	sent_at: number | null;
	reconciled: number;
	watch_key: string | null;
	result_key: string | null;
	result_url: string | null;
	error: string | null;
	updated_at: number;
};

const CREATES = new Set(["issue.create", "pr.create"]);

export class PushEngine {
	private timing = DEFAULT_TIMING;
	private running: Promise<void> | null = null;
	private lastWriteAt = 0;

	constructor(private host: PushHost) {}

	/** Create tables, bring the document in line with what was pushed, and pick up unfinished work. */
	async init(): Promise<void> {
		this.host.sql.exec(`
			CREATE TABLE IF NOT EXISTS pushes (
				id TEXT PRIMARY KEY,
				at INTEGER NOT NULL,
				user_id INTEGER NOT NULL,
				login TEXT NOT NULL,
				name TEXT,
				push_as TEXT NOT NULL,
				done INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS pushes_at ON pushes (at);
			CREATE TABLE IF NOT EXISTS push_changes (
				push_id TEXT NOT NULL,
				change_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				kind TEXT NOT NULL,
				op TEXT NOT NULL,
				applied_op TEXT,
				effect TEXT,
				summary TEXT NOT NULL,
				repo TEXT,
				state TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				first_attempt_at INTEGER,
				retry_at INTEGER,
				sent_at INTEGER,
				reconciled INTEGER NOT NULL DEFAULT 0,
				watch_key TEXT,
				result_key TEXT,
				result_url TEXT,
				error TEXT,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (push_id, change_id)
			);
			CREATE INDEX IF NOT EXISTS push_changes_change ON push_changes (change_id);
			CREATE INDEX IF NOT EXISTS push_changes_state ON push_changes (state);
		`);
		this.heal();
		await this.armAlarm();
	}

	/** For tests: shorten the pauses. */
	setTiming(timing: Partial<PushTiming>): void {
		this.timing = { ...this.timing, ...timing };
	}

	/** Item keys to stay subscribed to, so their updates confirm sent changes. */
	watchKeys(): string[] {
		return this.host.sql
			.exec<{ watch_key: string }>(
				"SELECT DISTINCT watch_key FROM push_changes WHERE state = 'sent' AND watch_key IS NOT NULL",
			)
			.toArray()
			.map((row) => row.watch_key);
	}

	// --- Pushing -------------------------------------------------------------------

	async push(command: PushCommand): Promise<PushResponse> {
		const first = this.plan(command.ids);
		if (!first.ok) return this.reject(command, first);
		const repos = repositoriesOf(first.ordered);
		const access = await this.checkAccess(repos, command.by);
		if (access) return this.reject(command, access);
		// The document may have changed while checking: plan again, and only
		// go ahead if it writes nowhere that wasn't checked.
		const plan = this.plan(command.ids);
		if (!plan.ok) return this.reject(command, plan);
		if (repositoriesOf(plan.ordered).some((repo) => !repos.includes(repo))) {
			return this.reject(command, {
				ok: false,
				reason: "busy",
				message: "These changes were edited while you pushed. Review them and push again.",
			});
		}
		return this.commit(plan.ordered, command);
	}

	private plan(ids: string[]): PlanResult {
		return planPush(listChanges(this.host.doc), ids, this.activeIds(), this.createdKeys());
	}

	private reject(
		command: PushCommand,
		result: Extract<PushResponse, { ok: false }> | Extract<PlanResult, { ok: false }>,
	): PushResponse {
		log.info("push.rejected", {
			board: this.host.name,
			by: command.by.login,
			as: command.as,
			reason: result.reason,
			repos: "repos" in result ? result.repos : undefined,
		});
		return result;
	}

	/**
	 * Whether the person may push to these repositories: signed in with their
	 * own token, the app installed, and write access. Returns why not, or null.
	 */
	private async checkAccess(
		repos: string[],
		by: Pusher,
	): Promise<Extract<PushResponse, { ok: false }> | null> {
		let token: string | null | undefined;
		const notInstalled: string[] = [];
		const noAccess: string[] = [];
		for (const repoKey of repos) {
			const parsed = parseRepoKey(repoKey);
			const adapter = parsed ? forge(parsed.forge) : null;
			if (!adapter?.apply || !adapter.canWrite) {
				noAccess.push(repoKey);
				continue;
			}
			const repo = await this.host.route(repoKey);
			if (repo === "error") {
				return {
					ok: false,
					reason: "busy",
					repos: [repoKey],
					message: `Couldn't reach ${parsed?.host ?? "the forge"}. Try again in a moment.`,
				};
			}
			if (typeof repo === "string") {
				noAccess.push(repoKey);
				continue;
			}
			// Forges that need installing need a person's own token to check access.
			if (adapter.installed) {
				token ??= by.id > 0 ? await userToken(this.host.env, by.id) : null;
				if (!token) {
					return {
						ok: false,
						reason: "signed_out",
						message: "Sign in with GitHub to push, so Tack can check you can write there.",
					};
				}
				if (!(await adapter.installed(repo, this.host.env, { fresh: true }).catch(() => false))) {
					notInstalled.push(repoKey);
					continue;
				}
			}
			try {
				if (!(await adapter.canWrite(repo, token ?? "", this.host.env))) noAccess.push(repoKey);
			} catch (error) {
				log.warn("push.access.failed", { board: this.host.name, repo: repoKey, error });
				return {
					ok: false,
					reason: "busy",
					repos: [repoKey],
					message: `Couldn't check your access to ${shortRepo(repoKey)}. Try again in a moment.`,
				};
			}
		}
		if (notInstalled.length > 0) {
			return {
				ok: false,
				reason: "not_installed",
				repos: notInstalled,
				message: `Tack's GitHub App isn't installed on ${notInstalled.map(shortRepo).join(", ")}. Install it there to push.`,
			};
		}
		if (noAccess.length > 0) {
			return {
				ok: false,
				reason: "no_write_access",
				repos: noAccess,
				message: `You can't write to ${noAccess.map(shortRepo).join(", ")}, so you can stage changes there but not push them.`,
			};
		}
		return null;
	}

	private async commit(items: PlanItem[], command: PushCommand): Promise<PushResponse> {
		const { sql, doc } = this.host;
		const pushId = crypto.randomUUID();
		const now = Date.now();
		const by: Stager = {
			id: command.by.id,
			login: command.by.login,
			name: command.by.name ?? command.by.login,
		};
		const byId = new Map(listChanges(doc).map((change) => [change.id, change]));
		this.host.sql.exec(
			"INSERT INTO pushes (id, at, user_id, login, name, push_as) VALUES (?, ?, ?, ?, ?, ?)",
			pushId,
			now,
			command.by.id,
			command.by.login,
			command.by.name,
			command.as,
		);
		items.forEach((item, seq) => {
			sql.exec(
				`INSERT INTO push_changes
					(push_id, change_id, seq, kind, op, effect, summary, repo, state, error, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				pushId,
				item.change.id,
				seq,
				String((item.op ?? item.change.op)?.kind ?? "unknown"),
				JSON.stringify(item.op ?? item.change.op ?? null),
				item.change.effect ? JSON.stringify(item.change.effect) : null,
				summarizeSafely(item, byId),
				item.repo,
				item.op ? "queued" : "failed",
				item.error ?? null,
				now,
			);
		});
		const updatedAt = new Date(now).toISOString();
		doc.transact(() => {
			for (const item of items) {
				const change = changesMap(doc).get(item.change.id);
				if (!change) continue;
				change.set("status", (item.op ? "sending" : "failed") satisfies ChangeStatus);
				change.set("pushId", pushId);
				change.set("pushedBy", by);
				change.set("pushedAs", command.as);
				change.set("updatedAt", updatedAt);
				if (item.error) change.set("error", item.error);
				else if (change.has("error")) change.delete("error");
				// A create that already happened keeps its result, so it isn't made again.
				const kind = item.op?.kind ?? "";
				if (change.has("result") && !(CREATES.has(kind) && this.previousResult(item.change.id))) {
					change.delete("result");
				}
			}
		}, PUSH_ORIGIN);
		const logger = this.logger(pushId);
		logger.info("push.started", {
			by: command.by.login,
			as: command.as,
			changes: items.length,
			repos: repositoriesOf(items),
		});
		for (const item of items) {
			if (!item.op)
				logger.warn("push.change.failed", { change: item.change.id, error: item.error });
		}
		this.host.persist();
		await this.host.alarmAt(Date.now());
		return { ok: true, pushId };
	}

	// --- Running the queue -------------------------------------------------------

	/** Run whatever's due. One run at a time; the alarm calls this. */
	run(): Promise<void> {
		this.running ??= this.runOnce()
			.catch((error: unknown) => log.error("push.run.failed", { board: this.host.name, error }))
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}

	private async runOnce(): Promise<void> {
		try {
			await this.writeDue();
			await this.reconcileDue();
		} finally {
			// Whatever happened, save what was done and come back for the rest.
			this.host.persist();
			await this.armAlarm();
		}
	}

	private async writeDue(): Promise<void> {
		const { sql } = this.host;
		let writes = 0;
		const pushes = sql.exec<PushRow>("SELECT * FROM pushes WHERE done = 0 ORDER BY at").toArray();
		for (const push of pushes) {
			let waiting = false;
			for (const row of this.rows(push.id)) {
				if (row.state !== "queued" && row.state !== "sending") continue;
				if (row.retry_at !== null && row.retry_at > Date.now()) {
					// Later changes wait too: they may depend on this one, and order matters.
					waiting = true;
					break;
				}
				if (writes >= BATCH) {
					waiting = true;
					break;
				}
				const pause = this.lastWriteAt + this.timing.spacingMs - Date.now();
				if (pause > 0) await sleep(pause);
				// Re-read: the row may have changed while waiting.
				const current = this.row(push.id, row.change_id);
				if (!current || (current.state !== "queued" && current.state !== "sending")) continue;
				const outcome = await this.attempt(push, current);
				writes++;
				if (outcome === "wait") {
					waiting = true;
					break;
				}
			}
			if (!waiting) this.finish(push);
		}
	}

	private async attempt(push: PushRow, row: ItemRow): Promise<"done" | "wait"> {
		const op = JSON.parse(row.op) as Operation;
		const { doc, env } = this.host;
		if (row.attempts === 0 && !changesMap(doc).has(row.change_id)) {
			this.fail(push, row, "Removed from the board before it was sent.");
			return "done";
		}
		const created = this.createdKeys();
		const resolved = resolveTargets(op, created);
		if (!resolved) {
			const missing = pendingDependencies(op).filter((dep) => !created.has(dep));
			const needed = missing.map((dep) => this.latestRow(dep)).find(Boolean);
			if (needed && (needed.state === "queued" || needed.state === "sending")) {
				// It's in another push that hasn't got to it yet.
				return this.retryLater(push, row, Date.now() + this.timing.spacingMs * 5, "waiting");
			}
			this.fail(
				push,
				row,
				`This needed “${needed?.summary ?? "an issue from the same push"}”, which wasn't created.`,
			);
			return "done";
		}
		const repoKey = row.repo ?? operationRepo(resolved);
		if (!repoKey) {
			this.fail(push, row, "Couldn't tell which repository this writes to.");
			return "done";
		}
		const repo = await this.host.route(repoKey);
		if (typeof repo === "string") {
			if (repo === "error") {
				this.host.sql.exec(
					"UPDATE push_changes SET attempts = attempts + 1 WHERE push_id = ? AND change_id = ?",
					row.push_id,
					row.change_id,
				);
				return this.retryOrFail(
					push,
					{ ...row, attempts: row.attempts + 1 },
					couldNotReach(repoKey),
				);
			}
			this.fail(push, row, `Couldn't find ${shortRepo(repoKey)}.`);
			return "done";
		}
		const adapter = forge(repo.forge);
		if (!adapter.apply || !adapter.capabilities.writes.includes(resolved.kind)) {
			this.fail(push, row, `${repo.host} can't do this.`);
			return "done";
		}

		// A create that an earlier push already made (it never confirmed): don't make it again.
		const previous = CREATES.has(resolved.kind) ? this.previousResult(row.change_id) : null;
		if (previous) {
			this.succeed(push, row, resolved, { ok: true, ...previous, confirmed: false });
			return "done";
		}

		const token = await this.writeToken(push, adapter, repoKey);
		if (token === null) {
			this.fail(
				push,
				row,
				push.push_as === "user"
					? "Your GitHub sign-in has expired. Sign in again, then retry."
					: `Tack's GitHub App isn't installed on ${shortRepo(repoKey)} any more.`,
			);
			return "done";
		}

		const now = Date.now();
		// Any earlier attempt, in this push or one before, may have gone through unanswered.
		const retryOf = this.firstAttemptAt(row.change_id);
		this.host.sql.exec(
			`UPDATE push_changes SET state = 'sending', attempts = attempts + 1,
				first_attempt_at = COALESCE(first_attempt_at, ?), retry_at = NULL, updated_at = ?
			WHERE push_id = ? AND change_id = ?`,
			now,
			now,
			row.push_id,
			row.change_id,
		);
		this.lastWriteAt = now;
		let result: ApplyResult;
		try {
			result = await adapter.apply(
				resolved,
				repo,
				{ as: push.push_as, token },
				env,
				retryOf === undefined ? {} : { retryOf },
			);
		} catch (error) {
			// Adapters shouldn't throw, but if one does it may have written something.
			result = {
				ok: false,
				error: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
				retryable: true,
			};
		}
		this.lastWriteAt = Date.now();
		const after = this.row(row.push_id, row.change_id) ?? row;
		if (result.ok) {
			this.succeed(push, after, resolved, result);
			return "done";
		}
		return this.retryOrFail(push, after, result);
	}

	private retryOrFail(
		push: PushRow,
		row: ItemRow,
		result: Extract<ApplyResult, { ok: false }>,
	): "done" | "wait" {
		const now = Date.now();
		const backoff =
			this.timing.backoffMs * (BACKOFF[Math.max(0, row.attempts - 1)] ?? BACKOFF.at(-1) ?? 1);
		const at = result.retryAt ?? now + backoff;
		if (!result.retryable || row.attempts >= MAX_ATTEMPTS || at - now > MAX_WAIT_MS) {
			this.fail(
				push,
				row,
				result.retryable && row.attempts >= MAX_ATTEMPTS
					? `Gave up after ${row.attempts} tries. ${result.error}`
					: result.error,
			);
			return "done";
		}
		return this.retryLater(push, row, at, result.error);
	}

	private retryLater(push: PushRow, row: ItemRow, at: number, reason: string): "wait" {
		this.host.sql.exec(
			"UPDATE push_changes SET state = 'queued', retry_at = ?, updated_at = ? WHERE push_id = ? AND change_id = ?",
			at,
			Date.now(),
			row.push_id,
			row.change_id,
		);
		this.logger(push.id).info("push.change.retry", {
			change: row.change_id,
			kind: row.kind,
			attempts: row.attempts,
			retryAt: new Date(at).toISOString(),
			reason,
		});
		return "wait";
	}

	private succeed(
		push: PushRow,
		row: ItemRow,
		op: Operation,
		result: Extract<ApplyResult, { ok: true }>,
	): void {
		const watchKey = result.confirmed ? null : confirmationKey(op, result.key);
		const state: ItemState = watchKey ? "sent" : "applied";
		const now = Date.now();
		this.host.sql.exec(
			`UPDATE push_changes SET state = ?, applied_op = ?, watch_key = ?, sent_at = ?,
				result_key = ?, result_url = ?, error = NULL, retry_at = NULL, updated_at = ?
			WHERE push_id = ? AND change_id = ?`,
			state,
			JSON.stringify(op),
			watchKey,
			now,
			result.key ?? null,
			result.url ?? null,
			now,
			row.push_id,
			row.change_id,
		);
		this.updateChange(row.change_id, {
			status: state,
			result: {
				...(result.key ? { key: result.key } : {}),
				...(result.url ? { url: result.url } : {}),
			},
			error: undefined,
		});
		const written = [operationRepo(op), result.key ? repoKeyOf(result.key) : null];
		this.host.wrote?.([...new Set(written.filter((repo): repo is string => repo !== null))]);
		const logger = this.logger(push.id);
		if (state === "applied") {
			logger.info("push.change.applied", {
				change: row.change_id,
				kind: row.kind,
				via: "response",
				attempts: row.attempts,
			});
			this.runEffect(push.id, row.change_id);
		} else {
			logger.info("push.change.sent", { change: row.change_id, kind: row.kind, item: watchKey });
			this.host.watch();
		}
	}

	private fail(push: PushRow | string, row: ItemRow, error: string): void {
		const pushId = typeof push === "string" ? push : push.id;
		this.host.sql.exec(
			"UPDATE push_changes SET state = 'failed', error = ?, retry_at = NULL, updated_at = ? WHERE push_id = ? AND change_id = ?",
			error,
			Date.now(),
			row.push_id,
			row.change_id,
		);
		this.updateChange(row.change_id, { status: "failed", error });
		this.logger(pushId).warn("push.change.failed", {
			change: row.change_id,
			kind: row.kind,
			attempts: row.attempts,
			error,
		});
	}

	/** Once nothing in a push is waiting to be written, it's complete. */
	private finish(push: PushRow): void {
		const counts = { sent: 0, applied: 0, failed: 0 };
		for (const row of this.rows(push.id)) {
			if (row.state === "queued" || row.state === "sending") return;
			counts[row.state]++;
		}
		this.host.sql.exec("UPDATE pushes SET done = 1 WHERE id = ?", push.id);
		this.logger(push.id).info("push.completed", {
			by: push.login,
			as: push.push_as,
			...counts,
			ms: Date.now() - push.at,
		});
		this.prune();
	}

	private async writeToken(
		push: PushRow,
		adapter: ForgeAdapter,
		repoKey: string,
	): Promise<string | null> {
		// Forges without installations (the fake one) need no token.
		if (!adapter.installed) return "";
		if (push.push_as === "app") return installationToken(this.host.env, repoKey);
		return push.user_id > 0 ? userToken(this.host.env, push.user_id) : null;
	}

	// --- Confirmation -----------------------------------------------------------

	/**
	 * Cards arrived (a webhook's update, a fetch, reconciliation): confirm any
	 * sent change they show.
	 */
	cardsArrived(entries: (Card | MissingCard)[]): void {
		const sent = this.host.sql
			.exec<ItemRow>("SELECT * FROM push_changes WHERE state = 'sent' AND watch_key IS NOT NULL")
			.toArray();
		if (sent.length === 0 || entries.length === 0) return;
		const byKey = new Map(entries.map((entry) => [entry.key.toLowerCase(), entry]));
		let confirmed = false;
		for (const row of sent) {
			const entry = byKey.get(row.watch_key ?? "");
			if (!entry) continue;
			const op = JSON.parse(row.applied_op ?? row.op) as Operation;
			if (reflects(op, entry) === true) {
				this.confirm(row, "card");
				confirmed = true;
			}
		}
		if (confirmed) {
			this.host.persist();
			this.host.watch();
		}
	}

	private confirm(row: ItemRow, via: "card" | "reconcile"): void {
		this.host.sql.exec(
			"UPDATE push_changes SET state = 'applied', updated_at = ? WHERE push_id = ? AND change_id = ?",
			Date.now(),
			row.push_id,
			row.change_id,
		);
		this.updateChange(row.change_id, { status: "applied" });
		this.logger(row.push_id).info("push.change.applied", {
			change: row.change_id,
			kind: row.kind,
			via,
			ms: row.sent_at ? Date.now() - row.sent_at : undefined,
		});
		this.runEffect(row.push_id, row.change_id);
	}

	/**
	 * Sent changes that haven't shown up in time: fetch the item once more,
	 * and fail the change if it still doesn't show it.
	 */
	private async reconcileDue(): Promise<void> {
		const due = this.host.sql
			.exec<ItemRow>(
				"SELECT * FROM push_changes WHERE state = 'sent' AND sent_at <= ? ORDER BY sent_at",
				Date.now() - this.timing.confirmMs,
			)
			.toArray();
		for (const row of due) {
			const key = row.watch_key ?? "";
			const ref = parseKey(key);
			const repo = ref ? await this.host.route(repoKeyOf(key)) : "unsupported";
			let entry: Card | MissingCard | null = null;
			if (ref && typeof repo !== "string") {
				entry =
					(
						await forge(repo.forge)
							.fetchItems([ref], this.host.env, repo)
							.catch(() => [])
					)[0] ?? null;
			}
			// The row may have been confirmed while fetching.
			const current = this.row(row.push_id, row.change_id);
			if (current?.state !== "sent") continue;
			const op = JSON.parse(row.applied_op ?? row.op) as Operation;
			if (entry && reflects(op, entry) === true) {
				this.confirm(current, "reconcile");
				continue;
			}
			const unknown = !entry || ("missing" in entry && entry.reason === "error");
			if (unknown && !current.reconciled) {
				// Couldn't tell: give it one more window.
				this.host.sql.exec(
					"UPDATE push_changes SET reconciled = 1, sent_at = ? WHERE push_id = ? AND change_id = ?",
					Date.now(),
					row.push_id,
					row.change_id,
				);
				continue;
			}
			const host =
				typeof repo === "string" ? "The forge" : repo.host === "github.com" ? "GitHub" : repo.host;
			const minutes = Math.max(1, Math.round(this.timing.confirmMs / 60_000));
			this.fail(
				row.push_id,
				current,
				`${host} accepted this, but ${shortKey(key)} didn't show it within ${minutes} minute${minutes === 1 ? "" : "s"}. Someone may have changed it since: check it, then retry if it's still needed.`,
			);
		}
		if (due.length > 0) this.host.watch();
	}

	// --- Effects ------------------------------------------------------------------

	/**
	 * What the board does once a change is applied. `replace` turns the
	 * shapes it came from into a card for the item, in one transaction: at
	 * the first shape's position, section and stacking order, with
	 * connectors and other changes that pointed at the shapes now pointing
	 * at the card. `link` points action items at the item, so they follow it.
	 */
	private runEffect(pushId: string, changeId: string): void {
		const row = this.row(pushId, changeId);
		// A decision written back as a pull request follows it from now on,
		// even with no one on the board.
		if (row?.kind === "pr.create") linkWrittenDecisions(this.host.doc);
		const effect = row?.effect ? (JSON.parse(row.effect) as ChangeEffect) : null;
		if (row && effect?.kind === "place" && row.result_key) {
			this.place(pushId, row, effect.near, row.result_key);
			return;
		}
		if (row && effect?.kind === "link" && row.result_key) {
			const linked = linkActionItems(this.host.doc, effect.shapes, row.result_key, PUSH_ORIGIN);
			this.logger(pushId).info("push.effect", { change: changeId, kind: "link", shapes: linked });
			return;
		}
		if (!row || effect?.kind !== "replace" || !row.result_key) return;
		const { doc } = this.host;
		const shapes = shapesMap(doc);
		const replaced = effect.shapes.filter((id) => shapes.has(id));
		const first = replaced[0] ? shapes.get(replaced[0]) : undefined;
		if (!first) return;
		const id = crypto.randomUUID();
		const gone = new Set(replaced);
		doc.transact(() => {
			const card = new Y.Map<unknown>();
			card.set("type", "card");
			card.set("ref", row.result_key);
			card.set("x", first.get("x") ?? 0);
			card.set("y", first.get("y") ?? 0);
			card.set("z", first.get("z") ?? "a0");
			card.set("parent", first.get("parent") ?? null);
			shapes.set(id, card);
			for (const old of replaced) shapes.delete(old);
			for (const shape of shapes.values()) {
				if (shape.get("type") !== "connector") continue;
				for (const end of ["from", "to"] as const) {
					const value = shape.get(end) as { shape?: string } | undefined;
					if (value?.shape && gone.has(value.shape)) shape.set(end, { ...value, shape: id });
				}
			}
			for (const change of changesMap(doc).values()) {
				const highlighted = change.get("shapes");
				if (!Array.isArray(highlighted) || !highlighted.some((s) => gone.has(s as string)))
					continue;
				change.set("shapes", [
					...new Set(highlighted.map((s) => (gone.has(s as string) ? id : (s as string)))),
				]);
			}
		}, PUSH_ORIGIN);
		this.logger(pushId).info("push.effect", {
			change: changeId,
			kind: "replace",
			shapes: replaced.length,
		});
	}

	/**
	 * `place`: a card for the created item above the shapes it was made from
	 * (a section that becomes a parent issue), connected to them, so it's on
	 * the board to follow, triage and backlink. The change then highlights
	 * the card too.
	 */
	private place(pushId: string, row: ItemRow, near: string[], key: string): void {
		const { doc } = this.host;
		const op = JSON.parse(row.op) as Operation;
		const card =
			op.kind === "issue.create"
				? { title: op.title, labels: (op.labels ?? []).map((name) => ({ name, color: "" })) }
				: undefined;
		// Stickies that became cards first (their creates confirmed sooner) are
		// their cards now.
		const shapes = shapesMap(doc);
		const replaced = new Map<string, string>();
		if (near.some((id) => !shapes.has(id))) {
			const rows = this.host.sql
				.exec<Pick<ItemRow, "effect" | "result_key">>(
					"SELECT effect, result_key FROM push_changes WHERE effect IS NOT NULL AND result_key IS NOT NULL",
				)
				.toArray();
			for (const { effect, result_key } of rows) {
				const parsed = JSON.parse(effect ?? "null") as ChangeEffect | null;
				if (parsed?.kind !== "replace") continue;
				const card = [...shapes].find(([, s]) => s.get("ref") === result_key)?.[0];
				if (card) for (const id of parsed.shapes) replaced.set(id, card);
			}
		}
		const targets = near.map((id) => (shapes.has(id) ? id : (replaced.get(id) ?? id)));
		let placed: ReturnType<typeof placeCard> = null;
		doc.transact(() => {
			placed = placeCard(doc, key, targets, { card });
			const change = changesMap(doc).get(row.change_id);
			const shapes = change?.get("shapes");
			if (placed && change && Array.isArray(shapes) && !shapes.includes(placed.card)) {
				change.set("shapes", [...(shapes as string[]), placed.card]);
			}
		}, PUSH_ORIGIN);
		const result = placed as ReturnType<typeof placeCard>;
		this.logger(pushId).info("push.effect", {
			change: row.change_id,
			kind: "place",
			placed: result ? (result.added ? "added" : "existing") : "nowhere",
			connectors: result?.connectors.length ?? 0,
		});
	}

	// --- Audit log -----------------------------------------------------------------

	/** The board's pushes, newest first. */
	audit(): AuditEntry[] {
		const pushes = this.host.sql
			.exec<PushRow>("SELECT * FROM pushes ORDER BY at DESC LIMIT ?", AUDIT_PAGE)
			.toArray();
		return pushes.map((push) => ({
			pushId: push.id,
			at: new Date(push.at).toISOString(),
			by: { login: push.login, name: push.name },
			as: push.push_as,
			changes: this.rows(push.id).map((row) => ({
				id: row.change_id,
				summary: row.summary,
				// Still on its way counts as sent.
				status: row.state === "applied" || row.state === "failed" ? row.state : "sent",
				...(row.result_url ? { url: row.result_url } : {}),
				...(row.error ? { error: row.error } : {}),
			})),
		}));
	}

	private prune(): void {
		const old = this.host.sql
			.exec<{ id: string }>(
				"SELECT id FROM pushes WHERE done = 1 ORDER BY at DESC LIMIT -1 OFFSET ?",
				AUDIT_KEEP,
			)
			.toArray();
		for (const { id } of old) {
			this.host.sql.exec("DELETE FROM pushes WHERE id = ?", id);
			// Created issues are kept, so changes that refer to them still resolve.
			this.host.sql.exec(
				"DELETE FROM push_changes WHERE push_id = ? AND NOT (kind = 'issue.create' AND result_key IS NOT NULL)",
				id,
			);
		}
	}

	// --- Storage helpers -----------------------------------------------------------

	private rows(pushId: string): ItemRow[] {
		return this.host.sql
			.exec<ItemRow>("SELECT * FROM push_changes WHERE push_id = ? ORDER BY seq", pushId)
			.toArray();
	}

	private row(pushId: string, changeId: string): ItemRow | null {
		return (
			this.host.sql
				.exec<ItemRow>(
					"SELECT * FROM push_changes WHERE push_id = ? AND change_id = ?",
					pushId,
					changeId,
				)
				.toArray()[0] ?? null
		);
	}

	/** Each change's most recent push. */
	private latestRows(): Map<string, ItemRow> {
		const latest = new Map<string, ItemRow>();
		for (const row of this.host.sql.exec<ItemRow>(
			`SELECT c.* FROM push_changes c LEFT JOIN pushes p ON p.id = c.push_id
			ORDER BY COALESCE(p.at, 0), c.seq`,
		)) {
			latest.set(row.change_id, row);
		}
		return latest;
	}

	private latestRow(changeId: string): ItemRow | null {
		return (
			this.host.sql
				.exec<ItemRow>(
					`SELECT c.* FROM push_changes c LEFT JOIN pushes p ON p.id = c.push_id
					WHERE c.change_id = ? ORDER BY COALESCE(p.at, 0) DESC LIMIT 1`,
					changeId,
				)
				.toArray()[0] ?? null
		);
	}

	/** Changes being pushed or already applied: never pushed again. */
	private activeIds(): Set<string> {
		const active = new Set<string>();
		for (const [id, row] of this.latestRows()) if (row.state !== "failed") active.add(id);
		return active;
	}

	/** Items created by `issue.create` changes, by change id. */
	private createdKeys(): Map<string, string> {
		const created = new Map<string, string>();
		for (const row of this.host.sql.exec<{ change_id: string; result_key: string }>(
			"SELECT change_id, result_key FROM push_changes WHERE kind = 'issue.create' AND result_key IS NOT NULL",
		)) {
			created.set(row.change_id, row.result_key);
		}
		return created;
	}

	/** When this change was first tried, in any push, if it ever was. */
	private firstAttemptAt(changeId: string): number | undefined {
		const row = this.host.sql
			.exec<{ at: number | null }>(
				"SELECT MIN(first_attempt_at) AS at FROM push_changes WHERE change_id = ?",
				changeId,
			)
			.toArray()[0];
		return row?.at ?? undefined;
	}

	/** What an earlier push of this change created, if it got that far. */
	private previousResult(changeId: string): { key: string; url?: string } | null {
		const row = this.host.sql
			.exec<{ result_key: string; result_url: string | null }>(
				"SELECT result_key, result_url FROM push_changes WHERE change_id = ? AND result_key IS NOT NULL LIMIT 1",
				changeId,
			)
			.toArray()[0];
		return row ? { key: row.result_key, ...(row.result_url ? { url: row.result_url } : {}) } : null;
	}

	/** Set server-owned fields on a change in the document. `undefined` removes a field. */
	private updateChange(id: string, fields: Partial<PendingChange>): void {
		const { doc } = this.host;
		const change = changesMap(doc).get(id);
		if (!change) return;
		doc.transact(() => {
			for (const [key, value] of Object.entries(fields)) {
				if (value === undefined) {
					if (change.has(key)) change.delete(key);
				} else {
					change.set(key, value);
				}
			}
			change.set("updatedAt", new Date().toISOString());
		}, PUSH_ORIGIN);
	}

	/**
	 * Bring the document in line with SQLite, in case a status write was lost
	 * (the object restarted before saving) or an editor changed one.
	 */
	private heal(): void {
		const { doc } = this.host;
		const changes = changesMap(doc);
		const fixes: [string, Partial<PendingChange>][] = [];
		for (const [id, row] of this.latestRows()) {
			const change = changes.get(id);
			if (!change) continue;
			const status: ChangeStatus =
				row.state === "queued" || row.state === "sending" ? "sending" : row.state;
			if (change.get("status") !== status || change.get("pushId") !== row.push_id) {
				fixes.push([
					id,
					{
						status,
						pushId: row.push_id,
						...(row.error ? { error: row.error } : {}),
						...(row.result_key || row.result_url
							? {
									result: {
										...(row.result_key ? { key: row.result_key } : {}),
										...(row.result_url ? { url: row.result_url } : {}),
									},
								}
							: {}),
					},
				]);
			}
		}
		if (fixes.length === 0) return;
		doc.transact(() => {
			for (const [id, fields] of fixes) this.updateChange(id, fields);
		}, PUSH_ORIGIN);
		log.info("push.healed", { board: this.host.name, changes: fixes.length });
	}

	/** When the queue next needs attention: a write that's due, or a confirmation that's late. */
	private async armAlarm(): Promise<void> {
		const now = Date.now();
		let next: number | null = null;
		for (const push of this.host.sql
			.exec<{ id: string }>("SELECT id FROM pushes WHERE done = 0")
			.toArray()) {
			const first = this.rows(push.id).find(
				(row) => row.state === "queued" || row.state === "sending",
			);
			if (!first) continue;
			const due = Math.max(first.retry_at ?? now, this.lastWriteAt + this.timing.spacingMs, now);
			next = next === null ? due : Math.min(next, due);
		}
		const sent = this.host.sql
			.exec<{ at: number | null }>(
				"SELECT MIN(sent_at) AS at FROM push_changes WHERE state = 'sent'",
			)
			.toArray()[0]?.at;
		if (sent != null) {
			const due = Math.max(sent + this.timing.confirmMs, now);
			next = next === null ? due : Math.min(next, due);
		}
		if (next !== null) await this.host.alarmAt(next);
	}

	private logger(pushId: string): Logger {
		return log.with({ board: this.host.name, push: pushId });
	}
}

function repositoriesOf(items: { repo: string | null }[]): string[] {
	return [...new Set(items.flatMap((item) => (item.repo ? [item.repo] : [])))];
}

function summarizeSafely(item: PlanItem, byId: Map<string, PendingChange>): string {
	return item.op ? summarizeOp(item.op, byId) : "A change Tack couldn't read";
}

function shortRepo(repoKey: string): string {
	return parseRepoKey(repoKey)?.repo ?? repoKey;
}

function shortKey(key: string): string {
	const ref = parseKey(key);
	return ref ? `${ref.repo}${ref.item}` : key;
}

function couldNotReach(repoKey: string): Extract<ApplyResult, { ok: false }> {
	return {
		ok: false,
		error: `Couldn't reach ${parseRepoKey(repoKey)?.host ?? "the forge"}.`,
		retryable: true,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
