import * as v from "valibot";
import type { Card } from "./cards.ts";
import { DEFAULT_HOST } from "./refs.ts";
import type { SearchQuery, WidgetDefinition, WidgetQuery } from "./widgets.ts";

// The review queue widget (#43): open pull requests waiting for review,
// oldest first, with how long each has waited, how big it is, and its CI and
// review state at a glance. Waiting on you (`review-requested:@me`), on a
// team, or everything in a repository that isn't approved yet.

export const REVIEW_SCOPES = ["me", "team", "repo"] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export interface ReviewConfig {
	/** Shown in the header. Empty: named after its scope. */
	title: string;
	host: string;
	scope: ReviewScope;
	/** For `team`: `org/team`. */
	team: string;
	/** For `repo`: `owner/name`. */
	repo: string;
	/** Include draft pull requests. */
	drafts: boolean;
	limit: number;
}

export const REVIEW_LIMITS = { min: 5, max: 100, default: 30 };

const reviewSchema: v.GenericSchema<ReviewConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	scope: v.fallback(v.picklist(REVIEW_SCOPES), "me"),
	team: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	repo: v.fallback(v.pipe(v.string(), v.maxLength(200)), ""),
	drafts: v.fallback(v.boolean(), false),
	limit: v.fallback(
		v.pipe(v.number(), v.integer(), v.minValue(REVIEW_LIMITS.min), v.maxValue(REVIEW_LIMITS.max)),
		REVIEW_LIMITS.default,
	),
});

const TEAM_RE = /^[\w.-]+\/[\w.-]+$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The search a review queue runs, or null while it isn't set up. */
export function reviewSearch(config: ReviewConfig): string | null {
	const drafts = config.drafts ? "" : " draft:false";
	switch (config.scope) {
		case "me":
			return `is:pr is:open review-requested:@me${drafts}`;
		case "team": {
			const team = config.team.trim().replace(/^@/, "");
			return TEAM_RE.test(team) ? `is:pr is:open team-review-requested:${team}${drafts}` : null;
		}
		case "repo": {
			const repo = config.repo.trim();
			// Not yet approved: waiting for a first review, or another look.
			return REPO_RE.test(repo) ? `repo:${repo} is:pr is:open -review:approved${drafts}` : null;
		}
	}
}

/** The queue's title: its own, or one from its scope. */
export function reviewTitle(config: ReviewConfig): string {
	if (config.title.trim()) return config.title.trim();
	switch (config.scope) {
		case "me":
			return "Waiting on your review";
		case "team":
			return config.team.trim()
				? `Waiting on @${config.team.trim().replace(/^@/, "")}`
				: "Team reviews";
		case "repo":
			return config.repo.trim()
				? `Reviews in ${config.repo.trim().split("/").at(-1)}`
				: "Repository reviews";
	}
}

export const reviewWidget: WidgetDefinition<ReviewConfig> = {
	kind: "review",
	title: "Review queue",
	description: "Pull requests waiting for review, oldest first: age, size, CI and reviews.",
	schema: reviewSchema,
	defaults: {
		title: "",
		host: DEFAULT_HOST,
		scope: "me",
		team: "",
		repo: "",
		drafts: false,
		limit: REVIEW_LIMITS.default,
	},
	size: { w: 400, h: 480 },
	queries(config): Record<string, WidgetQuery> {
		const q = reviewSearch(config);
		if (!q) return {};
		const query: SearchQuery = {
			kind: "search",
			host: config.host,
			q,
			sort: "created",
			order: "asc",
			limit: config.limit,
		};
		return { pulls: query };
	},
	refresh: 300,
};

// --- Reading a pull request at a glance ---------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** When it started waiting: when it was opened, or failing that, last updated. */
function openedAt(card: Card): number {
	const at = Date.parse(card.createdAt ?? card.updatedAt);
	return Number.isNaN(at) ? 0 : at;
}

/** How long it's been waiting, in ms. */
export function waitingFor(card: Card, now: number): number {
	return Math.max(0, now - openedAt(card));
}

/** How a wait reads: fresh (under a day), waiting (under four), or long (four days or more). */
export type AgeTone = "fresh" | "waiting" | "long";

export function ageTone(ms: number): AgeTone {
	if (ms < DAY) return "fresh";
	if (ms < 4 * DAY) return "waiting";
	return "long";
}

/** A wait, short: `40m`, `5h`, `3d`, `2w`, `4mo`. */
export function shortAge(ms: number): string {
	if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m`;
	if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
	if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`;
	if (ms < 60 * DAY) return `${Math.floor(ms / (7 * DAY))}w`;
	return `${Math.floor(ms / (30 * DAY))}mo`;
}

/** A wait, in words: “5 hours”, “3 days”, “2 weeks”. */
export function longAge(ms: number): string {
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	if (ms < HOUR) return plural(Math.max(1, Math.round(ms / 60_000)), "minute");
	if (ms < DAY) return plural(Math.round(ms / HOUR), "hour");
	if (ms < 14 * DAY) return plural(Math.floor(ms / DAY), "day");
	if (ms < 60 * DAY) return plural(Math.floor(ms / (7 * DAY)), "week");
	return plural(Math.floor(ms / (30 * DAY)), "month");
}

export type SizeBucket = "xs" | "s" | "m" | "l" | "xl";

export interface PullSize {
	bucket: SizeBucket;
	/** Lines added plus removed. */
	lines: number;
	additions: number;
	deletions: number;
	files: number | null;
}

/** A pull request's size by lines changed, or null where the forge didn't say. */
export function pullSize(card: Card): PullSize | null {
	const pull = card.pull;
	if (pull?.additions === undefined || pull.deletions === undefined) return null;
	const lines = pull.additions + pull.deletions;
	const bucket: SizeBucket =
		lines < 10 ? "xs" : lines < 100 ? "s" : lines < 500 ? "m" : lines < 1000 ? "l" : "xl";
	return {
		bucket,
		lines,
		additions: pull.additions,
		deletions: pull.deletions,
		files: pull.changedFiles ?? null,
	};
}

/** Where its review stands. */
export type ReviewStanding =
	/** Nobody's looked yet. */
	| "waiting"
	/** Reviewed with comments, but no decision. */
	| "commented"
	/** Changes requested: it's with the author. */
	| "changes"
	| "approved"
	/** The forge didn't say. */
	| "unknown";

export function reviewStanding(card: Card): ReviewStanding {
	const pull = card.pull;
	if (!pull || pull.detail !== "full") return "unknown";
	if (pull.review === "approved") return "approved";
	if (pull.review === "changes_requested") return "changes";
	if (pull.reviewers.some((r) => r.state === "changes_requested")) return "changes";
	if (pull.reviewers.some((r) => r.state === "commented" || r.state === "approved"))
		return "commented";
	return "waiting";
}

/** Oldest first, as the queue reads (the forge sorts too; this keeps live updates in order). */
export function oldestFirst(cards: readonly Card[]): Card[] {
	return [...cards].sort((a, b) => openedAt(a) - openedAt(b) || a.key.localeCompare(b.key));
}

export interface QueueSummary {
	count: number;
	/** The longest wait, in ms; 0 when empty. */
	oldest: number;
	/** How many have failing CI. */
	failing: number;
	/** How many wait four days or more. */
	long: number;
	/** How many are back with their authors (changes requested). */
	withAuthor: number;
}

export function queueSummary(
	cards: readonly Card[],
	now: number,
	total = cards.length,
): QueueSummary {
	let oldest = 0;
	let failing = 0;
	let long = 0;
	let withAuthor = 0;
	for (const card of cards) {
		const waited = waitingFor(card, now);
		oldest = Math.max(oldest, waited);
		if (card.pull?.checks?.state === "failing") failing++;
		if (ageTone(waited) === "long") long++;
		if (reviewStanding(card) === "changes") withAuthor++;
	}
	return { count: total, oldest, failing, long, withAuthor };
}
