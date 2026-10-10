import * as v from "valibot";
import type { Card } from "./cards.ts";
import { DEFAULT_HOST } from "./refs.ts";
import type { SearchQuery, WidgetDefinition, WidgetQuery } from "./widgets.ts";

// The stale finder widget (#43): items with no activity for N days, grouped
// by how long they've been quiet, with quick actions that stage what to do
// about them (close as not planned, add a label, or ask in a comment
// whether they're still wanted). Nothing is written until it's pushed.

export interface StaleConfig {
	/** Shown in the header. Empty: “Quiet for 30+ days”. */
	title: string;
	host: string;
	/** Which items to look through, e.g. `repo:owner/name is:open`. Empty: not set up. */
	q: string;
	/** No activity for at least this many days. */
	days: number;
	/** The label the quick action adds. */
	label: string;
	limit: number;
}

export const STALE_THRESHOLD = { min: 1, max: 730, default: 30 };
export const STALE_LIMITS = { min: 5, max: 100, default: 50 };

const staleSchema: v.GenericSchema<StaleConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	q: v.fallback(v.pipe(v.string(), v.maxLength(1000)), ""),
	days: v.fallback(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(STALE_THRESHOLD.min),
			v.maxValue(STALE_THRESHOLD.max),
		),
		STALE_THRESHOLD.default,
	),
	label: v.fallback(v.pipe(v.string(), v.maxLength(50)), "stale"),
	limit: v.fallback(
		v.pipe(v.number(), v.integer(), v.minValue(STALE_LIMITS.min), v.maxValue(STALE_LIMITS.max)),
		STALE_LIMITS.default,
	),
});

const DAY = 86_400_000;

/** The day before which items count as stale, as a forge search date (UTC). */
export function staleCutoff(now: number, days: number): string {
	return new Date(now - days * DAY).toISOString().slice(0, 10);
}

/**
 * The search a stale finder runs: its own, quiet since the cutoff. The
 * cutoff is a date, so the search changes once a day at most; the widget
 * filters by the exact threshold as it draws.
 */
export function staleSearch(config: StaleConfig, now: number): string | null {
	const q = config.q.trim();
	if (!q) return null;
	// Their own date limit wins.
	if (/(^|\s)-?updated:/i.test(q)) return q;
	return `${q} updated:<${staleCutoff(now, config.days)}`;
}

/** The finder's title: its own, or the threshold. */
export function staleTitle(config: StaleConfig): string {
	return config.title.trim() || `Quiet for ${spanText(config.days)}+`;
}

export const staleWidget: WidgetDefinition<StaleConfig> = {
	kind: "stale",
	title: "Stale finder",
	description: "Items with no activity for a while, by age, with quick ways to tidy them up.",
	schema: staleSchema,
	defaults: {
		title: "",
		host: DEFAULT_HOST,
		q: "",
		days: STALE_THRESHOLD.default,
		label: "stale",
		limit: STALE_LIMITS.default,
	},
	size: { w: 400, h: 500 },
	queries(config, context): Record<string, WidgetQuery> {
		const q = staleSearch(config, context.now || Date.now());
		if (!q) return {};
		const query: SearchQuery = {
			kind: "search",
			host: config.host,
			q,
			// The quietest first.
			sort: "updated",
			order: "asc",
			limit: config.limit,
		};
		return { items: query };
	},
	// Going stale is slow; webhooks say when something wakes up.
	refresh: 900,
};

/** A number of days, in words: “30 days”, “6 weeks”, “4 months”, “2 years”. */
export function spanText(days: number): string {
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	if (days < 14 || (days < 60 && days % 7 !== 0)) return plural(days, "day");
	if (days < 60) return plural(days / 7, "week");
	if (days < 365) return plural(Math.round(days / 30), "month");
	return plural(Math.round((days / 365) * 10) / 10, "year");
}

/** Days since an item's last activity. */
export function idleDays(card: Card, now: number): number {
	const at = Date.parse(card.updatedAt);
	return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY));
}

export interface StaleGroup {
	/** `quiet`, `quieter`, `silent`: from the threshold to twice it, to four times, and beyond. */
	id: "quiet" | "quieter" | "silent";
	/** “30 days – 2 months”, “2–4 months”, “4 months+”. */
	label: string;
	/** Days, inclusive. */
	from: number;
	/** Days, exclusive; null for the oldest group. */
	to: number | null;
	items: { card: Card; idle: number }[];
}

/**
 * Stale items grouped by how long they've been quiet: the threshold to
 * twice it, twice to four times, and longer. Items quiet for less than the
 * threshold (the search's cutoff is by day, and time has passed since) are
 * left out. Quietest first within each group; empty groups are kept, so the
 * layout holds still as items come and go.
 */
export function staleGroups(cards: readonly Card[], now: number, days: number): StaleGroup[] {
	const bounds: [StaleGroup["id"], number, number | null][] = [
		["quiet", days, days * 2],
		["quieter", days * 2, days * 4],
		["silent", days * 4, null],
	];
	const groups = bounds.map(([id, from, to]): StaleGroup => ({
		id,
		label: to === null ? `${spanText(from)}+` : rangeText(from, to),
		from,
		to,
		items: [],
	}));
	for (const card of cards) {
		const idle = idleDays(card, now);
		if (idle < days) continue;
		const group = groups.find((g) => idle >= g.from && (g.to === null || idle < g.to));
		group?.items.push({ card, idle });
	}
	for (const group of groups) group.items.sort((a, b) => b.idle - a.idle);
	return groups;
}

/** “30 days – 2 months”, “2–4 months”: one unit when both ends share it. */
function rangeText(from: number, to: number): string {
	const a = spanText(from);
	const b = spanText(to);
	const [an, au] = a.split(" ");
	const [bn, bu] = b.split(" ");
	const unit = (u?: string) => u?.replace(/s$/, "");
	if (unit(au) === unit(bu)) return `${an}–${bn} ${bu}`;
	return `${a} – ${b}`;
}

/**
 * The comment the "ping" quick action stages: asks whoever's assigned (or
 * failing that, whoever opened it) whether it's still wanted.
 */
export function pingComment(card: Card, now: number): string {
	const people = card.assignees.length
		? card.assignees.map((a) => `@${a.login}`)
		: card.author
			? [`@${card.author.login}`]
			: [];
	const who = people.length ? `${people.join(" ")}: ` : "";
	const thing = card.kind === "pull" ? "pull request" : "issue";
	const quiet = spanText(idleDays(card, now));
	return `${who}this ${thing} has been quiet for ${quiet}. Is it still something we want? If not, we'll close it as not planned.`;
}
