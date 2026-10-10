import { describe, expect, it } from "vite-plus/test";
import {
	eventTime,
	layoutTimeline,
	timelineRange,
	timelineSearch,
	timelineTicks,
	timelineTitle,
	timelineWidget,
} from "../src/shared/timeline.ts";
import { readConfig, widgetQueries } from "../src/shared/widgetRegistry.ts";
import { card } from "./card-fixture.ts";

const DAY = 86_400_000;
// Saturday 10 October 2026, mid-afternoon.
const NOW = Date.UTC(2026, 9, 10, 15, 30);
const config = (overrides: Record<string, unknown> = {}) =>
	readConfig(timelineWidget, { q: "repo:acme/widgets", ...overrides });

describe("timeline ranges", () => {
	it("end with today for relative ranges, in whole days", () => {
		expect(timelineRange(config({ range: "2w" }), NOW)).toEqual({
			from: Date.UTC(2026, 8, 27),
			to: Date.UTC(2026, 9, 11),
		});
		expect(timelineRange(config({ range: "1w" }), NOW).from).toBe(Date.UTC(2026, 9, 4));
	});

	it("read fixed ranges sensibly, even backwards or half-set", () => {
		const fixed = { range: "fixed", from: "2026-09-01", to: "2026-09-30" };
		expect(timelineRange(config(fixed), NOW)).toEqual({
			from: Date.UTC(2026, 8, 1),
			to: Date.UTC(2026, 9, 1),
		});
		expect(timelineRange(config({ ...fixed, from: "2026-09-30", to: "2026-09-01" }), NOW)).toEqual({
			from: Date.UTC(2026, 8, 1),
			to: Date.UTC(2026, 9, 1),
		});
		// Only a start: up to today.
		expect(timelineRange(config({ range: "fixed", from: "2026-10-01" }), NOW).to).toBe(
			Date.UTC(2026, 9, 11),
		);
		// Malformed dates fall back to nothing set: the last two weeks.
		expect(readConfig(timelineWidget, { range: "fixed", from: "yesterday" }).from).toBe("");
	});
});

describe("timeline searches", () => {
	it("add the event's dates to the search", () => {
		expect(timelineSearch(config({ event: "created" }), NOW)).toEqual({
			kind: "search",
			host: "github.com",
			q: "repo:acme/widgets created:2026-09-27..2026-10-10",
			sort: "created",
			order: "desc",
			limit: 100,
		});
		expect(timelineSearch(config({ event: "merged", range: "1w" }), NOW)?.q).toBe(
			"repo:acme/widgets is:pr merged:2026-10-04..2026-10-10",
		);
		expect(timelineSearch(config({ q: "repo:a/b is:pr", event: "merged" }), NOW)?.q).toBe(
			"repo:a/b is:pr merged:2026-09-27..2026-10-10",
		);
		expect(timelineSearch(config({ q: "  " }), NOW)).toBeNull();
	});

	it("move on with the clock, through the registry", () => {
		const shape = { widget: "timeline", config: { q: "repo:acme/widgets", event: "closed" } };
		const today = widgetQueries(shape, { now: NOW, cardsIn: () => [] });
		const tomorrow = widgetQueries(shape, { now: NOW + DAY, cardsIn: () => [] });
		expect(today.items).toMatchObject({ q: "repo:acme/widgets closed:2026-09-27..2026-10-10" });
		expect(tomorrow.items).toMatchObject({ q: "repo:acme/widgets closed:2026-09-28..2026-10-11" });
	});

	it("name themselves after what they show", () => {
		expect(timelineTitle(config({ event: "merged" }), NOW)).toBe("Merged in the last 2 weeks");
		expect(
			timelineTitle(config({ range: "fixed", from: "2026-09-01", to: "2026-09-30" }), NOW),
		).toBe("Opened Sep 1 – Sep 30");
		expect(timelineTitle(config({ title: " Launch " }), NOW)).toBe("Launch");
		expect(timelineTitle(config({ q: "" }), NOW)).toBe("New timeline");
	});
});

describe("event times", () => {
	it("come from the card's dates, or nothing", () => {
		const merged = card({
			kind: "pull",
			state: "merged",
			createdAt: "2026-10-01T10:00:00Z",
			closedAt: "2026-10-02T10:00:00Z",
			mergedAt: "2026-10-02T10:00:00Z",
		});
		expect(eventTime(merged, "created")).toBe(Date.parse("2026-10-01T10:00:00Z"));
		expect(eventTime(merged, "merged")).toBe(Date.parse("2026-10-02T10:00:00Z"));
		expect(eventTime(card(), "closed")).toBeNull();
		expect(eventTime(card(), "updated")).toBe(Date.parse("2026-10-01T00:00:00Z"));
	});
});

describe("timeline layout", () => {
	const from = Date.UTC(2026, 8, 27);
	const to = Date.UTC(2026, 9, 11);
	const width = 1400; // 100px a day

	it("places items by time, stacks close ones and clusters crowds", () => {
		const items = [
			{ key: "a", t: from + 2 * DAY },
			// Two close together: stacked, newest on top.
			{ key: "b", t: from + 5 * DAY },
			{ key: "c", t: from + 5 * DAY + 3_600_000 },
			// Six within a few hours: a cluster.
			...Array.from({ length: 6 }, (_, i) => ({ key: `d${i}`, t: from + 9 * DAY + i * 600_000 })),
			// Outside the range.
			{ key: "z", t: to + DAY },
		];
		const layout = layoutTimeline(items, { from, to, width, now: NOW, lanes: 4 });
		expect(layout.outside).toBe(1);
		const marks = layout.marks;
		expect(marks[0]).toEqual({ kind: "item", key: "a", t: from + 2 * DAY, x: 200, lane: 0 });
		expect(marks.filter((m) => m.kind === "item" && Math.round(m.x) >= 500 && m.x < 510)).toEqual([
			expect.objectContaining({ key: "c", lane: 0 }),
			expect.objectContaining({ key: "b", lane: 1 }),
		]);
		const cluster = marks.find((m) => m.kind === "cluster");
		expect(cluster).toMatchObject({ kind: "cluster", keys: ["d5", "d4", "d3", "d2", "d1", "d0"] });
		expect(cluster?.x).toBeCloseTo(900 + (5 * 600_000 * 100) / DAY / 2, 3);
		// Today is on the axis, near its end.
		expect(layout.today).toBeCloseTo(((NOW - from) / (to - from)) * width, 5);
		expect(
			layoutTimeline([], { from: from - 30 * DAY, to: from, width, now: NOW }).today,
		).toBeNull();
	});

	it("chooses ticks to suit the span", () => {
		// 14 days over 1400px: a tick a day.
		const daily = timelineTicks(from, to, 1400);
		expect(daily).toHaveLength(14);
		expect(daily[0]).toMatchObject({ x: 0, label: "Sep 27", major: false });
		expect(daily.find((tick) => tick.major)).toMatchObject({ label: "Oct", x: 400 });
		// The same days in 420px: weekly, on Mondays.
		const weekly = timelineTicks(from, to, 420);
		expect(weekly.map((tick) => tick.label)).toEqual(["Sep 28", "Oct 5"]);
		// A year: months, with the new year marked.
		const year = timelineTicks(Date.UTC(2026, 0, 15), Date.UTC(2027, 0, 15), 900);
		expect(year[0]?.label).toBe("Feb");
		expect(year.at(-1)).toMatchObject({ label: "2027", major: true });
	});
});
