import * as v from "valibot";
import type { Card } from "./cards.ts";
import { DEFAULT_HOST } from "./refs.ts";
import type { QueryContext, SearchQuery, WidgetDefinition, WidgetQuery } from "./widgets.ts";

// The timeline widget (#43): the items of a search that were opened, closed,
// merged or updated between two dates, laid out along a horizontal time
// axis. Ranges are relative ("the last two weeks", moving on with the
// clock) or fixed. Everything here is pure, so the layout is unit-tested:
// ticks that suit the span, markers stacked where they're close, and
// clusters where they're too dense to tell apart.

export const TIMELINE_EVENTS = ["created", "closed", "merged", "updated"] as const;
export type TimelineEvent = (typeof TIMELINE_EVENTS)[number];

export const TIMELINE_RANGES = ["1w", "2w", "1m", "3m", "fixed"] as const;
export type TimelineRange = (typeof TIMELINE_RANGES)[number];

export interface TimelineConfig {
	/** Shown in the header. Empty means it's named after what it shows. */
	title: string;
	host: string;
	/** What to look in, in the forge's search language: usually `repo:owner/name`. */
	q: string;
	/** Which date places an item on the axis. */
	event: TimelineEvent;
	range: TimelineRange;
	/** A fixed range's first and last days, `YYYY-MM-DD` (UTC). */
	from: string;
	to: string;
	limit: number;
}

export const TIMELINE_LIMITS = { min: 10, max: 100, default: 100 };

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How many days each relative range covers, today included. */
export const RANGE_DAYS: Record<Exclude<TimelineRange, "fixed">, number> = {
	"1w": 7,
	"2w": 14,
	"1m": 30,
	"3m": 90,
};

const date = v.fallback(v.union([v.pipe(v.string(), v.regex(DATE_RE)), v.literal("")]), "");

const timelineSchema: v.GenericSchema<TimelineConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	q: v.fallback(v.pipe(v.string(), v.maxLength(400)), ""),
	event: v.fallback(v.picklist(TIMELINE_EVENTS), "created"),
	range: v.fallback(v.picklist(TIMELINE_RANGES), "2w"),
	from: date,
	to: date,
	limit: v.fallback(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(TIMELINE_LIMITS.min),
			v.maxValue(TIMELINE_LIMITS.max),
		),
		TIMELINE_LIMITS.default,
	),
});

/** Midnight UTC at the start of the day `t` is in. */
export function startOfDay(t: number): number {
	return Math.floor(t / DAY) * DAY;
}

/** `YYYY-MM-DD` for the UTC day `t` is in. */
export function isoDay(t: number): string {
	return new Date(startOfDay(t)).toISOString().slice(0, 10);
}

function parseDay(day: string): number | null {
	if (!DATE_RE.test(day)) return null;
	const t = Date.parse(`${day}T00:00:00Z`);
	return Number.isFinite(t) ? t : null;
}

/**
 * The days a timeline covers, as `[from, to)` in ms: whole UTC days, so the
 * search (which takes dates) and the axis agree. Relative ranges end with
 * today; a fixed range that's missing a day, or backwards, is read sensibly.
 */
export function timelineRange(
	config: Pick<TimelineConfig, "range" | "from" | "to">,
	now: number,
): { from: number; to: number } {
	const today = startOfDay(now);
	if (config.range !== "fixed") {
		return { from: today - (RANGE_DAYS[config.range] - 1) * DAY, to: today + DAY };
	}
	let from = parseDay(config.from);
	let to = parseDay(config.to);
	if (from === null && to === null) return { from: today - 13 * DAY, to: today + DAY };
	from ??= (to as number) - 13 * DAY;
	to ??= Math.max(from, today);
	if (to < from) [from, to] = [to, from];
	return { from, to: to + DAY };
}

/** The search a timeline runs: its scope, with the event's date range added. */
export function timelineSearch(config: TimelineConfig, now: number): SearchQuery | null {
	const q = config.q.trim();
	if (!q) return null;
	const { from, to } = timelineRange(config, now);
	const span = `${isoDay(from)}..${isoDay(to - DAY)}`;
	const terms = [q];
	if (config.event === "merged" && !/\bis:(pr|pull-request)\b/i.test(q)) terms.push("is:pr");
	terms.push(`${config.event}:${span}`);
	return {
		kind: "search",
		host: config.host,
		q: terms.join(" "),
		sort: config.event === "created" ? "created" : "updated",
		order: "desc",
		limit: config.limit,
	};
}

export const timelineWidget: WidgetDefinition<TimelineConfig> = {
	kind: "timeline",
	title: "Timeline",
	description: "What was opened, closed or merged between two dates, along a line.",
	schema: timelineSchema,
	defaults: {
		title: "",
		host: DEFAULT_HOST,
		q: "",
		event: "created",
		range: "2w",
		from: "",
		to: "",
		limit: TIMELINE_LIMITS.default,
	},
	size: { w: 720, h: 320 },
	queries(config, context: QueryContext): Record<string, WidgetQuery> {
		const search = timelineSearch(config, context.now || Date.now());
		return search ? { items: search } : {};
	},
	refresh: 300,
};

/** When an item's event happened, ms since the epoch, or null if the card doesn't say. */
export function eventTime(card: Card, event: TimelineEvent): number | null {
	const raw =
		event === "created"
			? card.createdAt
			: event === "closed"
				? card.closedAt
				: event === "merged"
					? card.mergedAt
					: card.updatedAt;
	if (!raw) return null;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : null;
}

const EVENT_WORDS: Record<TimelineEvent, string> = {
	created: "Opened",
	closed: "Closed",
	merged: "Merged",
	updated: "Updated",
};

/** “Opened”, “Merged”… */
export function eventWord(event: TimelineEvent): string {
	return EVENT_WORDS[event];
}

const RANGE_WORDS: Record<Exclude<TimelineRange, "fixed">, string> = {
	"1w": "the last week",
	"2w": "the last 2 weeks",
	"1m": "the last month",
	"3m": "the last 3 months",
};

/** “Sep 28 – Oct 10” */
export function rangeText(from: number, to: number): string {
	const last = to - DAY;
	const a = dayLabel(from);
	const sameYear = new Date(from).getUTCFullYear() === new Date(last).getUTCFullYear();
	const b = dayLabel(last) + (sameYear ? "" : ` ${new Date(last).getUTCFullYear()}`);
	return from === startOfDay(last) ? a : `${a} – ${b}`;
}

/** A title from the config, like “Merged in the last 2 weeks”. */
export function timelineTitle(config: TimelineConfig, now: number): string {
	if (config.title.trim()) return config.title.trim();
	if (!config.q.trim()) return "New timeline";
	const when =
		config.range === "fixed"
			? (() => {
					const { from, to } = timelineRange(config, now);
					return rangeText(from, to);
				})()
			: `in ${RANGE_WORDS[config.range]}`;
	return `${EVENT_WORDS[config.event]} ${when}`;
}

// --- Layout -------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(t: number): string {
	const d = new Date(t);
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export interface Tick {
	t: number;
	x: number;
	label: string;
	/** The first of a month (or year): drawn stronger. */
	major: boolean;
}

type Unit = { days: number } | { months: number };

/** Tick steps from finest to coarsest. */
const UNITS: Unit[] = [
	{ days: 1 },
	{ days: 2 },
	{ days: 7 },
	{ days: 14 },
	{ months: 1 },
	{ months: 3 },
	{ months: 6 },
	{ months: 12 },
];

/** Ticks for `[from, to)` across `width` pixels, at least `spacing` apart. */
export function timelineTicks(from: number, to: number, width: number, spacing = 64): Tick[] {
	const span = Math.max(DAY, to - from);
	const px = (t: number) => ((t - from) / span) * width;
	const unit = UNITS.find((u) => {
		const step = "days" in u ? u.days * DAY : u.months * 30.4 * DAY;
		return (step / span) * width >= spacing;
	}) ?? { months: 12 };
	const ticks: Tick[] = [];
	if ("days" in unit) {
		// Days and weeks: weeks start on Mondays.
		let t = startOfDay(from);
		if (unit.days >= 7) {
			const weekday = (new Date(t).getUTCDay() + 6) % 7;
			if (weekday !== 0) t += (7 - weekday) * DAY;
		} else if (t < from) {
			t += DAY;
		}
		for (; t < to; t += unit.days * DAY) {
			const d = new Date(t);
			const major = d.getUTCDate() === 1;
			ticks.push({ t, x: px(t), label: major ? MONTHS[d.getUTCMonth()]! : dayLabel(t), major });
		}
	} else {
		const d = new Date(from);
		let year = d.getUTCFullYear();
		let month = d.getUTCMonth();
		if (Date.UTC(year, month, 1) < from) month += 1;
		month = Math.ceil(month / unit.months) * unit.months;
		for (;;) {
			const t = Date.UTC(year, month, 1);
			if (t >= to) break;
			const at = new Date(t);
			year = at.getUTCFullYear();
			month = at.getUTCMonth();
			ticks.push({
				t,
				x: px(t),
				label: month === 0 ? String(year) : MONTHS[month]!,
				major: month === 0,
			});
			month += unit.months;
		}
	}
	return ticks;
}

export interface TimelineItem {
	key: string;
	t: number;
}

/** One marker on the axis: an item, stacked in a lane, or a cluster of too many to show. */
export type TimelineMark =
	| { kind: "item"; key: string; t: number; x: number; lane: number }
	| { kind: "cluster"; keys: string[]; from: number; to: number; x: number };

export interface TimelineLayout {
	ticks: Tick[];
	marks: TimelineMark[];
	/** Where today is, or null when it's off the axis. */
	today: number | null;
	/** Items outside the range (the forge's dates and ours can disagree at the edges). */
	outside: number;
}

export interface LayoutOptions {
	from: number;
	to: number;
	width: number;
	now: number;
	/** Markers closer than this, in pixels, are stacked (or clustered). */
	gap?: number;
	/** At most this many stacked; any more and they become a cluster. */
	lanes?: number;
}

/**
 * Lay items out along the axis. Items closer together than `gap` form a
 * group: a small group stacks into lanes, newest on top; a bigger one
 * becomes a cluster at its middle, counted.
 */
export function layoutTimeline(items: TimelineItem[], options: LayoutOptions): TimelineLayout {
	const { from, to, width, now } = options;
	const gap = options.gap ?? 16;
	const lanes = Math.max(1, options.lanes ?? 4);
	const span = Math.max(1, to - from);
	const px = (t: number) => ((t - from) / span) * width;
	const inside = items.filter((item) => item.t >= from && item.t < to);
	const sorted = [...inside].sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1));

	const groups: TimelineItem[][] = [];
	for (const item of sorted) {
		const group = groups.at(-1);
		const first = group?.[0];
		if (group && first && px(item.t) - px(first.t) < gap) group.push(item);
		else groups.push([item]);
	}

	const marks: TimelineMark[] = [];
	for (const group of groups) {
		if (group.length <= lanes) {
			// Newest nearest the axis's top lane, so the latest reads first.
			[...group].reverse().forEach((item, lane) => {
				marks.push({ kind: "item", key: item.key, t: item.t, x: px(item.t), lane });
			});
			continue;
		}
		const first = group[0] as TimelineItem;
		const last = group.at(-1) as TimelineItem;
		marks.push({
			kind: "cluster",
			keys: [...group].reverse().map((item) => item.key),
			from: first.t,
			to: last.t,
			x: (px(first.t) + px(last.t)) / 2,
		});
	}
	return {
		ticks: timelineTicks(from, to, width),
		marks,
		today: now >= from && now < to ? px(now) : null,
		outside: items.length - inside.length,
	};
}

export interface DensityBar {
	/** The day (or week) it counts, from. */
	t: number;
	/** Left edge and width, in pixels. */
	x: number;
	w: number;
	count: number;
	/** `count` against the busiest bar, 0 to 1. */
	share: number;
}

/**
 * How busy each day (or week, when days would be too thin to see) was: bars
 * behind the markers, so the rhythm of a range reads at a glance, and from
 * far away.
 */
export function timelineDensity(
	items: TimelineItem[],
	{ from, to, width }: Pick<LayoutOptions, "from" | "to" | "width">,
): DensityBar[] {
	const span = Math.max(1, to - from);
	const perDay = (DAY / span) * width;
	const step = perDay >= 7 ? DAY : 7 * DAY;
	const start =
		step === DAY
			? startOfDay(from)
			: startOfDay(from) - ((new Date(startOfDay(from)).getUTCDay() + 6) % 7) * DAY;
	const counts = new Map<number, number>();
	for (const item of items) {
		if (item.t < from || item.t >= to) continue;
		const bucket = start + Math.floor((item.t - start) / step) * step;
		counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
	}
	const most = Math.max(1, ...counts.values());
	return [...counts]
		.sort(([a], [b]) => a - b)
		.map(([t, count]) => {
			const left = Math.max(from, t);
			const right = Math.min(to, t + step);
			return {
				t,
				x: ((left - from) / span) * width,
				w: ((right - left) / span) * width,
				count,
				share: count / most,
			};
		});
}
