import type * as Y from "yjs";
import {
	type DigestRun,
	type DigestSettings,
	type DigestSubscription,
	type DigestView,
	WEEK_MS,
	type WeeklyDigest,
	buildWeeklyDigest,
	describeSchedule,
	digestMarkdown,
	isQuietWeek,
	nextDigestAt,
	validEmail,
	weekKey,
} from "../../shared/digests.ts";
import type { Digest } from "../../shared/since.ts";
import { readShapes } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import type { DigestApi, DigestResult } from "../digests/api.ts";

// A pretend digest server for the playground (#68): the board's week, as
// "since you were here" keeps it (`SimulatedSince`), built into a digest
// the way the board's object builds one, with settings, your subscription
// and how the last ones went kept in memory. Repositories starting
// `private` refuse a Discussion, to try the errors.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PlayDigestSource {
	/** What "since you were here" would say now. */
	since(): Digest;
	doc: Y.Doc;
	now(): number;
}

export class PlayDigests implements DigestApi {
	settings: DigestSettings | null = null;
	subscription: (DigestSubscription & { at: number }) | null = null;
	runs: DigestRun[] = [];
	repoPublic: boolean | null = null;
	/** Who's looking: the playground's sign-in and view-only toggles. */
	access = { canManage: true, canEdit: true };
	emailAvailable = true;
	/** How long the pretend server takes. */
	delay = 500;

	constructor(
		private source: PlayDigestSource,
		private board: { id: string; title: string },
		private timeZone: string,
	) {}

	/** The week so far, as one audience would get it. */
	digest(): WeeklyDigest {
		const since = this.source.since();
		const to = this.source.now();
		const from = since.since ?? to - WEEK_MS;
		return buildWeeklyDigest({
			board: { ...this.board, url: `${location.origin}/play?scenario=digest` },
			from,
			to,
			timeZone: this.settings?.timeZone ?? this.timeZone,
			edits: since.edits,
			more: since.more,
			shapes: readShapes(this.source.doc),
			cards: since.cards,
			card: (key) => {
				const card = cardStore.get(key);
				if (!card || "missing" in card) return null;
				return { title: card.title, url: card.url, kind: card.kind, state: card.state };
			},
			pushes: since.pushes,
		});
	}

	view(): DigestView {
		const digest = this.digest();
		const discussion = this.settings?.discussion && this.access.canEdit ? digest : null;
		return {
			settings: this.settings,
			by: this.settings ? { login: "you", name: "You" } : null,
			nextAt: this.settings ? nextDigestAt(this.settings, this.source.now()) : null,
			runs: this.runs,
			repoPublic: this.repoPublic,
			emailAvailable: this.emailAvailable,
			canManage: this.access.canManage,
			subscribers: this.access.canManage ? (this.subscription?.confirmed ? 1 : 0) + 3 : null,
			subscription: this.subscription
				? { email: this.subscription.email, confirmed: this.subscription.confirmed }
				: null,
			preview: {
				email: digest,
				discussion,
				markdown:
					discussion && this.settings
						? digestMarkdown(discussion, { schedule: describeSchedule(this.settings) })
						: null,
			},
		};
	}

	private async answer(): Promise<DigestResult> {
		await sleep(this.delay);
		return { ok: true, value: this.view() };
	}

	get = () => this.answer();

	set = async (_board: string, settings: DigestSettings): Promise<DigestResult> => {
		if (!this.access.canManage) return { ok: false, error: "owner_required" };
		const repo = settings.discussion?.repo.replace(/^github\.com\//, "") ?? "";
		if (settings.discussion && repo.startsWith("private")) {
			await sleep(this.delay);
			return {
				ok: false,
				error: "not_installed",
				message: `The Tack app isn’t installed on ${repo}.`,
			};
		}
		this.settings = settings;
		this.repoPublic = settings.discussion ? true : null;
		return this.answer();
	};

	off = async (): Promise<DigestResult> => {
		this.settings = null;
		return this.answer();
	};

	subscribe = async (_board: string, body: { email: string }): Promise<DigestResult> => {
		if (!this.settings?.email) return { ok: false, error: "email_off" };
		if (!validEmail(body.email)) return { ok: false, error: "invalid_email" };
		const same = this.subscription?.email === body.email;
		if (same && this.subscription?.confirmed) return this.answer();
		if (same && this.subscription && this.source.now() - this.subscription.at < 60_000) {
			await sleep(this.delay);
			return { ok: false, error: "too_soon" };
		}
		this.subscription = { email: body.email, confirmed: false, at: this.source.now() };
		return this.answer();
	};

	unsubscribe = async (): Promise<DigestResult> => {
		this.subscription = null;
		return this.answer();
	};

	/** You followed the link in the confirmation email. */
	confirm(): boolean {
		if (!this.subscription || this.subscription.confirmed) return false;
		this.subscription = { ...this.subscription, confirmed: true };
		return true;
	}

	/** The week's digest goes out, as the board's alarm would send it. Returns what happened. */
	send(): string {
		const settings = this.settings;
		if (!settings) return "Digests are off: turn them on in the dialog first.";
		const at = this.source.now();
		const week = weekKey(at, settings.timeZone);
		const quiet = isQuietWeek(this.digest());
		const runs: DigestRun[] = [];
		if (settings.discussion) {
			const repo = settings.discussion.repo.replace(/^github\.com\//, "");
			runs.push(
				quiet
					? { week, channel: "discussion", status: "quiet", at }
					: {
							week,
							channel: "discussion",
							status: "sent",
							at,
							url: `https://github.com/${repo}/discussions/${40 + this.runs.length}`,
						},
			);
		}
		if (settings.email) {
			const people = 3 + (this.subscription?.confirmed ? 1 : 0);
			runs.push(
				quiet
					? { week, channel: "email", status: "quiet", at }
					: { week, channel: "email", status: "sent", at, sent: people, failed: 0 },
			);
		}
		this.runs = [...runs, ...this.runs.filter((run) => run.week !== week)].slice(0, 8);
		return quiet
			? "A quiet week: nothing went out."
			: "This week’s digest went out. Open the dialog to see how it went.";
	}
}
