import * as v from "valibot";
import type { Card } from "./cards.ts";
import { DEFAULT_HOST } from "./refs.ts";
import { pullSize } from "./review.ts";
import type { SearchQuery, WidgetDefinition, WidgetQuery } from "./widgets.ts";

// The milestone widget (#43): a milestone's progress (open and closed, as a
// ring), a burn-up of scope against what's done, derived from when its items
// were opened and closed, the due date with a forecast from the recent pace,
// and the open items most at risk: stale, blocked, or big and late.

export interface MilestoneConfig {
	/** Shown in the header. Empty: the milestone's own title. */
	title: string;
	host: string;
	/** `owner/name`. */
	repo: string;
	/** The milestone's title. Empty: not picked yet. */
	milestone: string;
	/** Open items with no activity for this many days are at risk. */
	staleDays: number;
}

export const STALE_DAYS = { min: 1, max: 180, default: 14 };

const milestoneSchema: v.GenericSchema<MilestoneConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	repo: v.fallback(v.pipe(v.string(), v.maxLength(200)), ""),
	milestone: v.fallback(v.pipe(v.string(), v.maxLength(255)), ""),
	staleDays: v.fallback(
		v.pipe(v.number(), v.integer(), v.minValue(STALE_DAYS.min), v.maxValue(STALE_DAYS.max)),
		STALE_DAYS.default,
	),
});

/** Most items each half of a milestone fetches: the forge's page. */
export const MILESTONE_SAMPLE = 100;

function quoted(value: string): string {
	return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** The search for a milestone's items, open or closed; null until it's picked. */
export function milestoneSearch(config: MilestoneConfig, state: "open" | "closed"): string | null {
	const repo = config.repo.trim();
	const milestone = config.milestone.trim();
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !milestone) return null;
	return `repo:${repo} milestone:${quoted(milestone)} is:${state}`;
}

export const milestoneWidget: WidgetDefinition<MilestoneConfig> = {
	kind: "milestone",
	title: "Milestone",
	description: "A milestone's progress, burn-up and due date, and what's at risk.",
	schema: milestoneSchema,
	defaults: {
		title: "",
		host: DEFAULT_HOST,
		repo: "",
		milestone: "",
		staleDays: STALE_DAYS.default,
	},
	size: { w: 420, h: 520 },
	queries(config): Record<string, WidgetQuery> {
		const open = milestoneSearch(config, "open");
		const closed = milestoneSearch(config, "closed");
		if (!open || !closed) return {};
		const search = (q: string, order: "asc" | "desc"): SearchQuery => ({
			kind: "search",
			host: config.host,
			q,
			// Open: the stalest first, as they're the likeliest risks. Closed: the latest.
			sort: "updated",
			order,
			limit: MILESTONE_SAMPLE,
		});
		return { open: search(open, "asc"), closed: search(closed, "desc") };
	},
	refresh: 300,
};

// --- Progress ---------------------------------------------------------------------

const DAY = 86_400_000;

export interface Progress {
	open: number;
	closed: number;
	total: number;
	/** Closed over total, 0 to 1; 0 for an empty milestone. */
	ratio: number;
}

export function progress(open: number, closed: number): Progress {
	const total = open + closed;
	return { open, closed, total, ratio: total === 0 ? 0 : closed / total };
}

/** When an item was opened, ms, or null where unknown. */
function opened(card: Card): number | null {
	const at = Date.parse(card.createdAt ?? "");
	return Number.isNaN(at) ? null : at;
}

/** When a closed item was closed, ms: its `closedAt`, or failing that its last update. */
function closedAt(card: Card): number | null {
	if (card.state === "open" || card.state === "draft") return null;
	const at = Date.parse(card.closedAt ?? card.updatedAt);
	return Number.isNaN(at) ? null : at;
}

export interface BurnPoint {
	at: number;
	/** Items in the milestone by then (opened by then). */
	scope: number;
	/** Items closed by then. */
	done: number;
}

export interface BurnUp {
	points: BurnPoint[];
	start: number;
	end: number;
	/** Fewer items were fetched than there are, so the oldest are assumed from the start. */
	sampled: boolean;
	/** Closed per week over the last two weeks (or the whole span, if shorter). */
	pace: number;
	/** When it'll be done at that pace, or null if nothing's closing (or it's done). */
	forecast: number | null;
}

/**
 * The burn-up: scope (items opened) and done (items closed) over time, from
 * the earliest item to now, in at most `steps` steps. Items beyond what was
 * fetched (`totals` larger than the lists) count from the start, so the
 * lines end at the real totals.
 */
export function burnUp(
	open: readonly Card[],
	closed: readonly Card[],
	options: { now: number; totals?: { open: number; closed: number }; steps?: number },
): BurnUp {
	const { now } = options;
	const steps = Math.max(2, options.steps ?? 28);
	const items = [...open, ...closed];
	const openedTimes = items.map(opened);
	const closedTimes = closed.map(closedAt).filter((t): t is number => t !== null);
	const known = [...openedTimes, ...closedTimes].filter((t): t is number => t !== null);
	// At least a week, so a brand-new milestone still draws as a chart.
	const start = Math.min(now - 7 * DAY, ...known);
	const end = now;
	const totals = options.totals ?? { open: open.length, closed: closed.length };
	const missingScope = Math.max(0, totals.open + totals.closed - items.length);
	const missingDone = Math.max(0, totals.closed - closedTimes.length);

	const points: BurnPoint[] = [];
	for (let i = 0; i < steps; i++) {
		const at = start + ((end - start) * i) / (steps - 1);
		let scope = missingScope;
		for (const t of openedTimes) if (t === null || t <= at) scope++;
		let done = missingDone;
		for (const t of closedTimes) if (t <= at) done++;
		points.push({ at, scope: Math.max(scope, done), done });
	}

	const window = Math.min(14 * DAY, end - start);
	const recent = closedTimes.filter((t) => t > end - window).length;
	const pace = window > 0 ? (recent / window) * 7 * DAY : 0;
	const remaining = totals.open;
	const forecast = remaining > 0 && pace > 0 ? now + (remaining / pace) * 7 * DAY : null;
	return {
		points,
		start,
		end,
		sampled: missingScope > 0 || missingDone > 0,
		pace,
		forecast,
	};
}

export type DueTone = "none" | "ok" | "soon" | "overdue" | "done";

export interface Due {
	tone: DueTone;
	/** “Due in 18 days”, “Due tomorrow”, “3 days overdue”, “No due date”. */
	text: string;
	/** Days until due (negative when overdue), or null without a date. */
	days: number | null;
}

/** How the due date reads, now. */
export function dueOf(dueOn: string | null | undefined, now: number, finished = false): Due {
	const at = Date.parse(dueOn ?? "");
	if (Number.isNaN(at))
		return { tone: finished ? "done" : "none", text: "No due date", days: null };
	// Due dates are days: count whole days, by the end of the due day (UTC).
	const days = Math.ceil((at - now) / DAY);
	if (finished) return { tone: "done", text: "Done", days };
	if (days < 0) {
		const late = -days;
		return { tone: "overdue", text: `${late} ${late === 1 ? "day" : "days"} overdue`, days };
	}
	if (days === 0) return { tone: "soon", text: "Due today", days };
	if (days === 1) return { tone: "soon", text: "Due tomorrow", days };
	return { tone: days <= 7 ? "soon" : "ok", text: `Due in ${days} days`, days };
}

/** Whether the forecast lands after the due date (null if either is unknown). */
export function late(forecast: number | null, dueOn: string | null | undefined): boolean | null {
	const due = Date.parse(dueOn ?? "");
	if (forecast === null || Number.isNaN(due)) return null;
	// By the end of the due day.
	return forecast > due + DAY;
}

// --- At risk -----------------------------------------------------------------------

export type RiskReason = "stale" | "blocked" | "big";

export interface AtRisk {
	card: Card;
	reasons: RiskReason[];
	/** Days since its last activity. */
	idle: number;
}

const BLOCKED = /\bblocked\b|\bon[ -]?hold\b|\bwaiting\b/i;
const BIG = /\b(epic|big|large|size[\s:/-]*(l|xl|large))\b/i;

/**
 * Open items at risk of missing the milestone: no activity for `staleDays`
 * (stale), labelled blocked or on hold (blocked), or big (a large pull
 * request, or labelled epic or large) with the due date a week away or past
 * (big and late). Most reasons first, then the longest idle.
 */
export function atRisk(
	open: readonly Card[],
	options: { now: number; dueOn: string | null | undefined; staleDays: number },
): AtRisk[] {
	const due = Date.parse(options.dueOn ?? "");
	const lateSoon = !Number.isNaN(due) && due - options.now < 7 * DAY;
	const out: AtRisk[] = [];
	for (const card of open) {
		if (card.state !== "open" && card.state !== "draft") continue;
		const updated = Date.parse(card.updatedAt);
		const idle = Number.isNaN(updated) ? 0 : Math.floor((options.now - updated) / DAY);
		const reasons: RiskReason[] = [];
		if (idle >= options.staleDays) reasons.push("stale");
		if (card.labels.some((label) => BLOCKED.test(label.name))) reasons.push("blocked");
		const size = pullSize(card);
		const big =
			size?.bucket === "l" ||
			size?.bucket === "xl" ||
			card.labels.some((label) => BIG.test(label.name));
		if (big && lateSoon) reasons.push("big");
		if (reasons.length > 0) out.push({ card, reasons, idle });
	}
	return out.sort((a, b) => b.reasons.length - a.reasons.length || b.idle - a.idle);
}

export const RISK_LABELS: Record<RiskReason, string> = {
	stale: "Stale",
	blocked: "Blocked",
	big: "Big and late",
};
