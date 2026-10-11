// Weekly digests (#68), on the board's object: once a week, at the hour its
// owner chose in their time zone, what happened on the board goes out as a
// GitHub Discussion (as the app, through the forge's write path) and by
// email to members who asked for it and confirmed their address.
//
// - Only the owner turns them on (`PUT /api/boards/:id/digest`), and a
//   Discussion only goes to a repository where the app is installed and
//   the owner can write; both are checked again before every post, with
//   the owner's own token, as backups are.
// - Each place gets at most one digest a week (`weekKey`), however often
//   the alarm fires: what went out is kept per week and place in
//   `digest_runs`. A post that may have gone through without an answer is
//   looked for before posting again (`retryOf`).
// - What each audience gets is decided here. A Discussion gets cards and
//   pushes only from repositories known to be public, or the Discussion's
//   own; an email only what its reader can read, checked with their own
//   token, and only while they can still open the board.
// - A quiet week (nothing happened) sends nothing.
// - It reuses what "since you were here" keeps (the change log and card
//   history, src/server/since.ts) and the push audit log.
// - The schedule lives in the board's SQLite and its alarm, which the push
//   engine and backups share (`alarmAt` only ever brings it forward).

import type * as Y from "yjs";
import type { Card, MissingCard } from "../shared/cards.ts";
import {
	type DigestError,
	type DigestRun,
	type DigestSettings,
	type DigestSubscription,
	type DigestView,
	WEEK_MS,
	type WeeklyDigest,
	buildWeeklyDigest,
	describeSchedule,
	digestMarkdown,
	digestTitle,
	isQuietWeek,
	nextDigestAt,
	validEmail,
	weekKey,
} from "../shared/digests.ts";
import type { AuditEntry } from "../shared/push.ts";
import { parseRepoKey, repoKeyOf } from "../shared/refs.ts";
import type { CardActivity, EditEntry, PushDigest } from "../shared/since.ts";
import { readShapes } from "../shared/structure.ts";
import { boardPath, slugify } from "../shared/boards.ts";
import { sign } from "./auth/crypto.ts";
import { roleFor } from "./boards/access.ts";
import { confirmationEmail, digestHtml, digestText } from "./digestEmail.ts";
import { emailSender } from "./email.ts";
import { type MissingReason, type RepoIdentity, forge } from "./forges/index.ts";
import { installationToken } from "./github/tokens.ts";
import { userToken } from "./identity.ts";
import { log } from "./log.ts";
import { directory, instance } from "./namespaces.ts";

type Entry = Card | MissingCard;

/** How soon to try again after a failure worth retrying, and how many times. */
const RETRY_MS = 15 * 60_000;
const MAX_RETRIES = 4;
/** Confirmation emails: one per person per this long, and at most this many per board an hour. */
const CONFIRM_GAP_MS = 10 * 60_000;
const CONFIRM_PER_HOUR = 20;
/** How long the links in emails work. */
const CONFIRM_TTL_S = 7 * 24 * 60 * 60;
const UNSUBSCRIBE_TTL_S = 400 * 24 * 60 * 60;
/** At most this many people get a board's digest by email. */
export const MAX_SUBSCRIBERS = 200;
/** Weeks of runs kept, for the dialog. */
const RUNS_KEPT_WEEKS = 12;

export const CONFIRM_PURPOSE = "digest-confirm";
export const UNSUBSCRIBE_PURPOSE = "digest-unsubscribe";
const PRIVATE_CHANGE = "A change to a private repository";

/** What the links in emails carry: the board, the person and their subscription's nonce. */
export interface DigestToken {
	b: string;
	u: number;
	n: string;
}

export interface DigestHost {
	/** The board's id. */
	name: string;
	env: Env;
	doc: Y.Doc;
	sql: SqlStorage;
	route(repoKey: string): Promise<RepoIdentity | MissingReason>;
	/** The board's card for an item, as the server holds it. */
	card(key: string): Entry | undefined;
	/** Edits by anyone since a time (the change log). */
	edits(since: number): { edits: EditEntry[]; more: number };
	/** What happened to the board's cards since a time (card history). */
	cardActivity(since: number): CardActivity[];
	/** The push audit log, newest first, unfiltered. */
	audit(): AuditEntry[];
	knownPublic(repoKey: string): boolean;
	canRead(userId: number, repoKey: string): Promise<boolean>;
	/** Wait (briefly) for the board's cards to arrive, after waking. */
	settle(): Promise<void>;
	alarmAt(at: number): Promise<void>;
}

interface Stored {
	settings: DigestSettings;
	title: string;
	/** This instance's address, for links. */
	origin: string;
	by: { id: number; login: string; name?: string };
	/** The next digest, ms since the epoch. */
	nextAt: number;
	repoPublic: boolean | null;
	/**
	 * Where the last digest's week ended, ms since the epoch: the next one
	 * starts there, so nothing falls between two (the clocks changing, a
	 * change of day).
	 */
	lastTo?: number;
	/** A week being retried: the same week, the same range. */
	retry: { week: string; from: number; to: number; attempts: number } | null;
}

type RunRow = {
	week: string;
	target: string;
	status: "sending" | "sent" | "failed" | "quiet";
	at: number;
	url: string | null;
	error: string | null;
	started_at: number;
};

type SubscriberRow = {
	user_id: number;
	login: string;
	email: string;
	nonce: string;
	confirmed_at: number | null;
	asked_at: number;
};

export type DigestCheck =
	| { ok: true; repo: RepoIdentity; token: string; repoPublic: boolean | null }
	| { ok: false; error: DigestError; message: string };

const short = (repoKey: string) => parseRepoKey(repoKey)?.repo ?? repoKey;

/**
 * Whether a board's owner may post its digest as a Discussion in a
 * repository, as the app: the forge has Discussions, the app's installed,
 * the owner can write there (checked with their own token), Discussions
 * are on and the category exists. Returns the app's token to post with.
 */
export async function checkDiscussionTarget(
	env: Env,
	target: { repo: string; category: string },
	ownerId: number | null,
	route: (repoKey: string) => Promise<RepoIdentity | MissingReason>,
): Promise<DigestCheck> {
	const parsed = parseRepoKey(target.repo);
	const adapter = parsed ? forge(parsed.forge) : null;
	const name = short(target.repo);
	if (!parsed || !adapter?.apply || !adapter.capabilities.discussions || !adapter.canWrite) {
		return { ok: false, error: "invalid_repo", message: `Tack can’t post Discussions in ${name}.` };
	}
	const repo = await route(target.repo);
	if (repo === "error") {
		return { ok: false, error: "unreachable", message: `Couldn’t reach ${parsed.host}.` };
	}
	if (typeof repo === "string") {
		return {
			ok: false,
			error: "not_installed",
			message: `Couldn’t find ${name}, or the Tack app isn’t installed on it.`,
		};
	}
	const ownerToken = ownerId !== null && ownerId > 0 ? await userToken(env, ownerId) : null;
	if (!ownerToken) {
		return {
			ok: false,
			error: "sign_in_required",
			message:
				"The board’s owner needs to sign in to Tack again, so it can check they can still post there.",
		};
	}
	const installed = adapter.installed
		? await adapter.installed(repo, env, { fresh: true }).catch(() => false)
		: true;
	const appToken = installed ? await installationToken(env, target.repo) : null;
	if (!appToken) {
		return {
			ok: false,
			error: "not_installed",
			message: `The Tack app isn’t installed on ${name}.`,
		};
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
	if (adapter.repoMeta) {
		const meta = await adapter.repoMeta(repo, env).catch(() => null);
		if (!meta) {
			return { ok: false, error: "unreachable", message: `Couldn’t read ${name}’s Discussions.` };
		}
		if (meta.discussionCategories.length === 0) {
			return {
				ok: false,
				error: "discussions_off",
				message: `Discussions are turned off in ${name}.`,
			};
		}
		const wanted = target.category.trim().toLowerCase();
		if (!meta.discussionCategories.some((c) => c.trim().toLowerCase() === wanted)) {
			return {
				ok: false,
				error: "invalid_category",
				message: `${name} has no Discussion category called “${target.category}”.`,
			};
		}
	}
	return {
		ok: true,
		repo,
		token: appToken,
		repoPublic: repo.private === undefined ? null : !repo.private,
	};
}

function randomNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Digests {
	private running: Promise<void> | null = null;
	/** Shortened by tests. */
	retryMs = RETRY_MS;

	constructor(private readonly host: DigestHost) {
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS digest (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS digest_runs (
				week TEXT NOT NULL,
				target TEXT NOT NULL,
				status TEXT NOT NULL,
				at INTEGER NOT NULL,
				url TEXT,
				error TEXT,
				started_at INTEGER NOT NULL,
				PRIMARY KEY (week, target)
			);
			CREATE TABLE IF NOT EXISTS digest_subscribers (
				user_id INTEGER PRIMARY KEY,
				login TEXT NOT NULL,
				email TEXT NOT NULL,
				nonce TEXT NOT NULL,
				confirmed_at INTEGER,
				asked_at INTEGER NOT NULL
			);
		`);
	}

	private read(): Stored | null {
		const row = this.host.sql
			.exec<{ state: string }>("SELECT state FROM digest WHERE id = 1")
			.toArray()[0];
		return row ? (JSON.parse(row.state) as Stored) : null;
	}

	private write(stored: Stored | null): void {
		if (!stored) this.host.sql.exec("DELETE FROM digest");
		else {
			this.host.sql.exec(
				"INSERT OR REPLACE INTO digest (id, state) VALUES (1, ?)",
				JSON.stringify(stored),
			);
		}
	}

	private subscriber(userId: number): SubscriberRow | null {
		return (
			this.host.sql
				.exec<SubscriberRow>(
					"SELECT user_id, login, email, nonce, confirmed_at, asked_at FROM digest_subscribers WHERE user_id = ?",
					userId,
				)
				.toArray()[0] ?? null
		);
	}

	// --- What people see -------------------------------------------------------------

	/** The dialog: settings, how recent digests went, your subscription, and the next digest so far. */
	async view(viewer: {
		userId: number;
		canManage: boolean;
		/** Editors see the Discussion's preview. */
		canEdit: boolean;
	}): Promise<DigestView> {
		const stored = this.read();
		const now = Date.now();
		const from = stored ? Math.min(now, this.weekFrom(stored, stored.nextAt)) : now - WEEK_MS;
		const timeZone = stored?.settings.timeZone ?? "UTC";
		const email = await this.digestFor(
			{ kind: "person", userId: viewer.userId },
			from,
			now,
			stored,
			timeZone,
		);
		const target = stored?.settings.discussion ?? null;
		const discussion =
			viewer.canEdit && target
				? await this.digestFor(
						{ kind: "discussion", repo: target.repo },
						from,
						now,
						stored,
						timeZone,
					)
				: null;
		const row = this.subscriber(viewer.userId);
		const subscription: DigestSubscription | null = row
			? { email: row.email, confirmed: row.confirmed_at !== null }
			: null;
		return {
			settings: stored?.settings ?? null,
			by: stored
				? { login: stored.by.login, ...(stored.by.name ? { name: stored.by.name } : {}) }
				: null,
			nextAt: stored ? stored.nextAt : null,
			runs: this.runs(),
			repoPublic: stored?.repoPublic ?? null,
			emailAvailable: emailSender(this.host.env) !== null,
			canManage: viewer.canManage,
			subscribers: viewer.canManage ? this.confirmedCount() : null,
			subscription,
			preview: {
				email,
				discussion,
				markdown:
					discussion && stored
						? digestMarkdown(discussion, { schedule: describeSchedule(stored.settings) })
						: null,
			},
		};
	}

	private confirmedCount(): number {
		return (
			this.host.sql
				.exec<{ n: number }>(
					"SELECT count(*) AS n FROM digest_subscribers WHERE confirmed_at IS NOT NULL",
				)
				.one().n ?? 0
		);
	}

	/** Recent digests, newest first: a Discussion's row, and every email of a week summed up. */
	runs(): DigestRun[] {
		const rows = this.host.sql
			.exec<RunRow>(
				"SELECT week, target, status, at, url, error, started_at FROM digest_runs ORDER BY week DESC, at DESC",
			)
			.toArray();
		const out: DigestRun[] = [];
		const emails = new Map<string, DigestRun>();
		for (const row of rows) {
			if (row.target === "discussion") {
				out.push({
					week: row.week,
					channel: "discussion",
					status: row.status === "sending" ? "failed" : row.status,
					at: row.at,
					...(row.url ? { url: row.url } : {}),
					...(row.error ? { error: row.error } : {}),
				});
				continue;
			}
			let run = emails.get(row.week);
			if (!run) {
				run = { week: row.week, channel: "email", status: "quiet", at: row.at, sent: 0, failed: 0 };
				emails.set(row.week, run);
				out.push(run);
			}
			run.at = Math.max(run.at, row.at);
			if (row.status === "sent") {
				run.sent = (run.sent ?? 0) + 1;
				run.status = "sent";
			} else if (row.status === "failed" || row.status === "sending") {
				run.failed = (run.failed ?? 0) + 1;
				if (run.status !== "sent") run.status = "failed";
				if (row.error && !run.error) run.error = row.error;
			}
		}
		const order = { discussion: 0, email: 1 };
		return out
			.sort((a, b) => b.week.localeCompare(a.week) || order[a.channel] - order[b.channel])
			.slice(0, 8);
	}

	// --- The owner's settings ----------------------------------------------------------

	/** Turn digests on, or change them, as checked by the Worker (the owner). */
	async configure(input: {
		settings: DigestSettings;
		title: string;
		origin: string;
		by: Stored["by"];
		repoPublic: boolean | null;
	}): Promise<void> {
		const previous = this.read();
		const nextAt = nextDigestAt(input.settings, Date.now());
		this.write({
			settings: input.settings,
			title: input.title,
			origin: input.origin,
			by: input.by,
			nextAt,
			repoPublic: input.repoPublic,
			retry: previous?.retry ?? null,
		});
		log.info("digest.configured", {
			board: this.host.name,
			discussion: input.settings.discussion?.repo ?? null,
			email: input.settings.email,
			weekday: input.settings.weekday,
			hour: input.settings.hour,
			timeZone: input.settings.timeZone,
			by: input.by.login,
		});
		await this.arm();
	}

	disable(by: string): void {
		if (!this.read()) return;
		this.write(null);
		log.info("digest.disabled", { board: this.host.name, by });
	}

	/** The board was renamed: digests say so. */
	renamed(title: string): void {
		const stored = this.read();
		if (stored) this.write({ ...stored, title });
	}

	// --- Email subscriptions -----------------------------------------------------------

	/**
	 * Someone who can open the board asks for its digest by email (checked by
	 * the Worker): a confirmation email goes to the address, and nothing
	 * else does until its link is followed.
	 */
	async subscribe(input: {
		userId: number;
		login: string;
		email: string;
		origin: string;
	}): Promise<{ ok: true; value: DigestSubscription } | { ok: false; error: DigestError }> {
		const stored = this.read();
		const sender = emailSender(this.host.env);
		const secret = this.host.env.TACK_SECRET;
		if (!sender || !secret) return { ok: false, error: "email_unavailable" };
		if (!stored?.settings.email) return { ok: false, error: "email_off" };
		const email = input.email.trim();
		if (!validEmail(email)) return { ok: false, error: "invalid_email" };
		const now = Date.now();
		const existing = this.subscriber(input.userId);
		if (existing && existing.email.toLowerCase() === email.toLowerCase()) {
			if (existing.confirmed_at !== null) {
				return { ok: true, value: { email: existing.email, confirmed: true } };
			}
			if (now - existing.asked_at < CONFIRM_GAP_MS) return { ok: false, error: "too_soon" };
		}
		const recent = this.host.sql
			.exec<{ n: number }>(
				"SELECT count(*) AS n FROM digest_subscribers WHERE asked_at > ?",
				now - 3_600_000,
			)
			.one().n;
		const total = this.host.sql
			.exec<{ n: number }>("SELECT count(*) AS n FROM digest_subscribers")
			.one().n;
		if ((recent ?? 0) >= CONFIRM_PER_HOUR || (!existing && (total ?? 0) >= MAX_SUBSCRIBERS)) {
			return { ok: false, error: "too_soon" };
		}
		const nonce = randomNonce();
		const token = await sign<DigestToken>(
			secret,
			CONFIRM_PURPOSE,
			{ b: this.host.name, u: input.userId, n: nonce },
			CONFIRM_TTL_S,
		);
		const message = confirmationEmail({
			board: stored.title,
			confirm: `${input.origin}/digest?confirm=${encodeURIComponent(token)}`,
			schedule: describeSchedule(stored.settings),
		});
		const sent = await sender.send({ to: email, ...message });
		if (!sent.ok) {
			log.warn("digest.confirm.failed", {
				board: this.host.name,
				user: input.userId,
				code: sent.code,
			});
			return { ok: false, error: "email_unavailable" };
		}
		this.host.sql.exec(
			`INSERT OR REPLACE INTO digest_subscribers (user_id, login, email, nonce, confirmed_at, asked_at)
			VALUES (?, ?, ?, ?, NULL, ?)`,
			input.userId,
			input.login,
			email,
			nonce,
			now,
		);
		log.info("digest.subscribe.asked", { board: this.host.name, user: input.userId });
		return { ok: true, value: { email, confirmed: false } };
	}

	/** Their link was followed: the subscription is confirmed, if it's the one the link was for. */
	confirm(userId: number, nonce: string): { title: string; path: string; schedule: string } | null {
		const stored = this.read();
		const row = this.subscriber(userId);
		if (!stored || !row || row.nonce !== nonce) return null;
		if (row.confirmed_at === null) {
			this.host.sql.exec(
				"UPDATE digest_subscribers SET confirmed_at = ? WHERE user_id = ?",
				Date.now(),
				userId,
			);
			log.info("digest.subscribed", { board: this.host.name, user: userId });
		}
		return {
			title: stored.title,
			path: boardPath({ id: this.host.name, slug: slugify(stored.title) }),
			schedule: describeSchedule(stored.settings),
		};
	}

	/** Stop someone's digest: from the board (theirs), or a link in an email (`nonce`). */
	unsubscribe(userId: number, nonce?: string): { title: string } | null {
		const row = this.subscriber(userId);
		if (!row || (nonce !== undefined && row.nonce !== nonce)) return null;
		this.host.sql.exec("DELETE FROM digest_subscribers WHERE user_id = ?", userId);
		log.info("digest.unsubscribed", {
			board: this.host.name,
			user: userId,
			via: nonce ? "link" : "board",
		});
		return { title: this.read()?.title ?? "this board" };
	}

	// --- Sending -------------------------------------------------------------------------

	/** From the alarm: send the week's digest if it's due. */
	async runIfDue(): Promise<void> {
		const stored = this.read();
		if (!stored) return;
		if (stored.nextAt <= Date.now()) await this.run();
		else await this.arm();
	}

	/** One run at a time. */
	run(): Promise<void> {
		this.running ??= this.runOnce()
			.catch((error: unknown) =>
				log.error("digest.failed", { board: this.host.name, reason: "exception", error }),
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

	private async runOnce(): Promise<void> {
		const stored = this.read();
		if (!stored) return;
		const now = Date.now();
		const { settings } = stored;
		// Asleep for over a week (no alarm, an outage): the latest week only.
		const due =
			stored.nextAt <= now - WEEK_MS ? nextDigestAt(settings, now - WEEK_MS) : stored.nextAt;
		const job = stored.retry ?? {
			week: weekKey(due, settings.timeZone),
			from: this.weekFrom(stored, due),
			to: due,
			attempts: 0,
		};
		let retry = false;
		try {
			const policy = await directory(this.host.env).accessPolicy(this.host.name);
			if (!policy) return;
			if (settings.discussion) {
				retry = (await this.postDiscussion(stored, job, policy.ownerId)) || retry;
			}
			if (settings.email) retry = (await this.sendEmails(stored, job, policy)) || retry;
		} finally {
			const latest = this.read();
			if (latest) {
				const again = retry && job.attempts < MAX_RETRIES;
				this.write({
					...latest,
					...(again ? {} : { lastTo: job.to }),
					retry: again ? { ...job, attempts: job.attempts + 1 } : null,
					nextAt: again
						? Date.now() + this.retryMs
						: nextDigestAt(latest.settings, Math.max(Date.now(), job.to)),
				});
				this.pruneRuns();
				await this.arm();
			}
		}
	}

	/** Where a week ending at `to` starts: where the last one ended, within reason. */
	private weekFrom(stored: Stored, to: number): number {
		const usual = to - WEEK_MS;
		if (stored.lastTo === undefined || stored.lastTo >= to) return usual;
		// Not from months ago, after a long sleep: a week and a day at most.
		return Math.max(stored.lastTo, usual - WEEK_MS / 7);
	}

	private runRow(week: string, target: string): RunRow | null {
		return (
			this.host.sql
				.exec<RunRow>(
					"SELECT week, target, status, at, url, error, started_at FROM digest_runs WHERE week = ? AND target = ?",
					week,
					target,
				)
				.toArray()[0] ?? null
		);
	}

	private record(
		week: string,
		target: string,
		status: RunRow["status"],
		extra: { url?: string; error?: string; startedAt?: number } = {},
	): void {
		const now = Date.now();
		this.host.sql.exec(
			`INSERT OR REPLACE INTO digest_runs (week, target, status, at, url, error, started_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			week,
			target,
			status,
			now,
			extra.url ?? null,
			extra.error ?? null,
			extra.startedAt ?? now,
		);
	}

	private pruneRuns(): void {
		const weeks = this.host.sql
			.exec<{ week: string }>("SELECT DISTINCT week FROM digest_runs ORDER BY week DESC")
			.toArray()
			.map((row) => row.week);
		const oldest = weeks[RUNS_KEPT_WEEKS - 1];
		if (oldest) this.host.sql.exec("DELETE FROM digest_runs WHERE week < ?", oldest);
	}

	/** Post the week's Discussion, unless it's gone already. Returns whether it's worth trying again. */
	private async postDiscussion(
		stored: Stored,
		job: { week: string; from: number; to: number },
		ownerId: number | null,
	): Promise<boolean> {
		const target = stored.settings.discussion;
		if (!target) return false;
		const done = this.runRow(job.week, "discussion");
		if (done && (done.status === "sent" || done.status === "quiet")) return false;
		const context = { board: this.host.name, week: job.week, repo: target.repo };
		const check = await checkDiscussionTarget(this.host.env, target, ownerId, (key) =>
			this.host.route(key),
		);
		if (!check.ok) {
			// A person has to fix it: say why, and try next week.
			this.record(job.week, "discussion", "failed", { error: check.message });
			log.warn("digest.discussion.failed", { ...context, reason: check.error });
			return check.error === "unreachable";
		}
		const digest = await this.digestFor(
			{ kind: "discussion", repo: target.repo },
			job.from,
			job.to,
			stored,
			stored.settings.timeZone,
		);
		if (isQuietWeek(digest)) {
			this.record(job.week, "discussion", "quiet");
			log.info("digest.quiet", { ...context, channel: "discussion" });
			return false;
		}
		// An earlier try that never heard back may have posted it: the adapter looks first.
		const retryOf =
			done?.status === "sending" || done?.status === "failed" ? done.started_at : undefined;
		const startedAt = retryOf ?? Date.now();
		this.record(job.week, "discussion", "sending", { startedAt });
		const result = await forge(check.repo.forge).apply?.(
			{
				kind: "discussion.create",
				repo: target.repo,
				category: target.category,
				title: digestTitle(digest),
				body: digestMarkdown(digest, { schedule: describeSchedule(stored.settings) }),
			},
			check.repo,
			{ as: "app", token: check.token },
			this.host.env,
			retryOf !== undefined ? { retryOf } : {},
		);
		if (!result?.ok) {
			const error = result?.error ?? `Tack can’t post Discussions in ${short(target.repo)}.`;
			this.record(job.week, "discussion", "failed", { error, startedAt });
			log.warn("digest.discussion.failed", { ...context, error });
			return result?.retryable ?? false;
		}
		this.record(job.week, "discussion", "sent", {
			...(result.url ? { url: result.url } : {}),
			startedAt,
		});
		if (check.repoPublic !== stored.repoPublic) {
			const latest = this.read();
			if (latest) this.write({ ...latest, repoPublic: check.repoPublic });
		}
		log.info("digest.posted", { ...context, url: result.url });
		return false;
	}

	/** Email the week's digest to everyone who confirmed. Returns whether any are worth trying again. */
	private async sendEmails(
		stored: Stored,
		job: { week: string; from: number; to: number },
		policy: NonNullable<Awaited<ReturnType<ReturnType<typeof directory>["accessPolicy"]>>>,
	): Promise<boolean> {
		const sender = emailSender(this.host.env);
		const secret = this.host.env.TACK_SECRET;
		if (!sender || !secret) return false;
		const subscribers = this.host.sql
			.exec<SubscriberRow>(
				`SELECT user_id, login, email, nonce, confirmed_at, asked_at FROM digest_subscribers
				WHERE confirmed_at IS NOT NULL ORDER BY user_id LIMIT ?`,
				MAX_SUBSCRIBERS,
			)
			.toArray();
		if (subscribers.length === 0) return false;
		const people = instance(this.host.env);
		const configured = await people.isConfigured();
		let retry = false;
		let sent = 0;
		for (const subscriber of subscribers) {
			const target = `email:${subscriber.user_id}`;
			const done = this.runRow(job.week, target);
			if (done && (done.status === "sent" || done.status === "quiet")) continue;
			const context = { board: this.host.name, week: job.week, user: subscriber.user_id };
			// Only while they can still open the board.
			const allowed = !configured || (await people.canUse(subscriber.user_id));
			if (!roleFor(policy, { userId: subscriber.user_id, allowed })) {
				this.host.sql.exec("DELETE FROM digest_subscribers WHERE user_id = ?", subscriber.user_id);
				log.info("digest.unsubscribed", { ...context, via: "access" });
				continue;
			}
			const digest = await this.digestFor(
				{ kind: "person", userId: subscriber.user_id },
				job.from,
				job.to,
				stored,
				stored.settings.timeZone,
			);
			if (isQuietWeek(digest)) {
				this.record(job.week, target, "quiet");
				continue;
			}
			const unsubscribe = `${stored.origin}/api/digests/unsubscribe?token=${encodeURIComponent(
				await sign<DigestToken>(
					secret,
					UNSUBSCRIBE_PURPOSE,
					{ b: this.host.name, u: subscriber.user_id, n: subscriber.nonce },
					UNSUBSCRIBE_TTL_S,
				),
			)}`;
			const page = unsubscribe.replace("/api/digests/unsubscribe?", "/digest?unsubscribe=1&");
			const links = { unsubscribe: page, schedule: describeSchedule(stored.settings) };
			const result = await sender.send({
				to: subscriber.email,
				subject: digestTitle(digest),
				text: digestText(digest, links),
				html: digestHtml(digest, links),
				headers: {
					"List-Unsubscribe": `<${unsubscribe}>`,
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				},
			});
			if (result.ok) {
				sent++;
				this.record(job.week, target, "sent");
			} else {
				this.record(job.week, target, "failed", { error: result.error });
				log.warn("digest.email.failed", { ...context, code: result.code });
				if (result.code === "E_RECIPIENT_SUPPRESSED") {
					// It'll never arrive: stop, and they can ask again from the board.
					this.host.sql.exec(
						"DELETE FROM digest_subscribers WHERE user_id = ?",
						subscriber.user_id,
					);
					log.info("digest.unsubscribed", { ...context, via: "suppressed" });
				}
				retry = retry || result.retryable;
			}
		}
		log.info("digest.emailed", { board: this.host.name, week: job.week, sent });
		return retry;
	}

	/**
	 * The week as one audience may see it: a Discussion's readers (anyone who
	 * can read its repository), or one person (what they can read).
	 */
	private async digestFor(
		audience: { kind: "discussion"; repo: string } | { kind: "person"; userId: number },
		from: number,
		to: number,
		stored: Stored | null,
		timeZone: string,
	): Promise<WeeklyDigest> {
		await this.host.settle();
		const { edits, more } = this.host.edits(from);
		const activity = this.host.cardActivity(from);
		const audit = this.host.audit().filter((entry) => {
			const at = Date.parse(entry.at);
			return at > from && at <= to;
		});
		const repos = new Set<string>([
			...activity.map((a) => repoKeyOf(a.key)),
			...audit.flatMap((entry) => entry.changes.flatMap((c) => (c.repo ? [c.repo] : []))),
		]);
		const shapes = readShapes(this.host.doc);
		for (const shape of shapes.values()) {
			if (shape.type === "action" && shape.ref) repos.add(repoKeyOf(shape.ref));
		}
		const readable = new Map<string, boolean>();
		for (const repoKey of repos) {
			let yes = this.host.knownPublic(repoKey);
			if (!yes) {
				yes =
					audience.kind === "discussion"
						? repoKey.toLowerCase() === audience.repo.toLowerCase()
						: await this.host.canRead(audience.userId, repoKey).catch(() => false);
			}
			readable.set(repoKey, yes);
		}
		const canSee = (key: string) => readable.get(repoKeyOf(key)) ?? false;
		const pushes: PushDigest[] = audit.map((entry) => ({
			pushId: entry.pushId,
			at: Date.parse(entry.at),
			by: entry.by,
			applied: entry.changes.filter((c) => c.status !== "failed").length,
			failed: entry.changes.filter((c) => c.status === "failed").length,
			summaries: entry.changes
				.slice(0, 3)
				.map((c) => (c.repo && readable.get(c.repo) ? c.summary : PRIVATE_CHANGE)),
		}));
		const title = stored?.title ?? this.host.name;
		const origin = stored?.origin ?? "";
		return buildWeeklyDigest({
			board: {
				id: this.host.name,
				title,
				url: `${origin}${boardPath({ id: this.host.name, slug: slugify(title) })}`,
			},
			from,
			to,
			timeZone,
			edits,
			more,
			shapes,
			cards: activity.filter((a) => canSee(a.key)),
			card: (key) => {
				if (!canSee(key)) return null;
				const card = this.host.card(key);
				if (!card || "missing" in card) return null;
				return { title: card.title, url: card.url, kind: card.kind, state: card.state };
			},
			pushes,
		});
	}
}
