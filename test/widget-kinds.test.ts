import { describe, expect, it } from "vite-plus/test";
import type { Card, PullDetails } from "../src/shared/cards.ts";
import {
	atRisk,
	burnUp,
	dueOf,
	late,
	milestoneSearch,
	milestoneWidget,
	progress,
} from "../src/shared/milestone.ts";
import {
	ageTone,
	longAge,
	oldestFirst,
	pullSize,
	queueSummary,
	reviewSearch,
	reviewStanding,
	reviewTitle,
	reviewWidget,
	shortAge,
} from "../src/shared/review.ts";
import { matchSearch, parseSearch } from "../src/shared/search.ts";
import {
	pingComment,
	spanText,
	staleCutoff,
	staleGroups,
	staleSearch,
	staleTitle,
	staleWidget,
} from "../src/shared/stale.ts";
import {
	queryScope,
	readConfig,
	widgetDefinition,
	widgetQueries,
} from "../src/shared/widgetRegistry.ts";
import { card } from "./card-fixture.ts";

const NOW = Date.UTC(2026, 9, 10, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function pull(details: Partial<PullDetails> = {}, overrides: Partial<Card> = {}): Card {
	return card({
		kind: "pull",
		pull: {
			detail: "full",
			head: null,
			checks: null,
			review: null,
			reviewers: [],
			mergeable: "mergeable",
			linked: [],
			...details,
		},
		...overrides,
	});
}

describe("the registry", () => {
	it("knows the review queue, milestone and stale finder", () => {
		expect(widgetDefinition("review")).toBe(reviewWidget);
		expect(widgetDefinition("milestone")).toBe(milestoneWidget);
		expect(widgetDefinition("stale")).toBe(staleWidget);
	});

	it("reads their configs with defaults", () => {
		expect(readConfig(reviewWidget, { scope: "sideways", limit: 3 })).toEqual(
			reviewWidget.defaults,
		);
		expect(readConfig(milestoneWidget, { staleDays: 0, repo: "a/b" })).toEqual({
			...milestoneWidget.defaults,
			repo: "a/b",
		});
		expect(readConfig(staleWidget, { days: -1, label: "dusty" })).toEqual({
			...staleWidget.defaults,
			label: "dusty",
		});
	});
});

describe("the review queue", () => {
	const config = reviewWidget.defaults;

	it("searches what's waiting on you, a team, or a repository, oldest first", () => {
		expect(reviewSearch(config)).toBe("is:pr is:open review-requested:@me draft:false");
		expect(reviewSearch({ ...config, drafts: true })).toBe("is:pr is:open review-requested:@me");
		expect(reviewSearch({ ...config, scope: "team", team: "@acme/core" })).toBe(
			"is:pr is:open team-review-requested:acme/core draft:false",
		);
		expect(reviewSearch({ ...config, scope: "team", team: "core" })).toBeNull();
		expect(reviewSearch({ ...config, scope: "repo", repo: "acme/widgets" })).toBe(
			"repo:acme/widgets is:pr is:open -review:approved draft:false",
		);
		expect(widgetQueries({ widget: "review", config: { scope: "repo" } })).toEqual({});
		const { pulls } = widgetQueries({ widget: "review", config: { scope: "repo", repo: "a/b" } });
		expect(pulls).toMatchObject({ kind: "search", sort: "created", order: "asc" });
		expect(queryScope(pulls as never)).toEqual({ repos: ["github.com/a/b"], owners: [] });
	});

	it("is named after what it's waiting on", () => {
		expect(reviewTitle(config)).toBe("Waiting on your review");
		expect(reviewTitle({ ...config, scope: "team", team: "acme/core" })).toBe(
			"Waiting on @acme/core",
		);
		expect(reviewTitle({ ...config, scope: "repo", repo: "acme/widgets" })).toBe(
			"Reviews in widgets",
		);
		expect(reviewTitle({ ...config, title: "Mine" })).toBe("Mine");
	});

	it("says how long each has waited", () => {
		expect(shortAge(20 * 60_000)).toBe("20m");
		expect(shortAge(5 * HOUR)).toBe("5h");
		expect(shortAge(3 * DAY + 5 * HOUR)).toBe("3d");
		expect(shortAge(20 * DAY)).toBe("2w");
		expect(shortAge(95 * DAY)).toBe("3mo");
		expect(longAge(1 * DAY)).toBe("1 day");
		expect(ageTone(5 * HOUR)).toBe("fresh");
		expect(ageTone(2 * DAY)).toBe("waiting");
		expect(ageTone(4 * DAY)).toBe("long");
	});

	it("sizes pull requests by lines changed", () => {
		expect(pullSize(pull())).toBeNull();
		expect(pullSize(pull({ additions: 3, deletions: 2 }))?.bucket).toBe("xs");
		expect(pullSize(pull({ additions: 80, deletions: 15 }))?.bucket).toBe("s");
		expect(pullSize(pull({ additions: 300, deletions: 100, changedFiles: 6 }))).toEqual({
			bucket: "m",
			lines: 400,
			additions: 300,
			deletions: 100,
			files: 6,
		});
		expect(pullSize(pull({ additions: 1200, deletions: 0 }))?.bucket).toBe("xl");
	});

	it("reads where its review stands", () => {
		expect(reviewStanding(pull())).toBe("waiting");
		expect(reviewStanding(pull({ review: "approved" }))).toBe("approved");
		expect(reviewStanding(pull({ review: "changes_requested" }))).toBe("changes");
		expect(
			reviewStanding(pull({ reviewers: [{ login: "kai", avatarUrl: "", state: "commented" }] })),
		).toBe("commented");
		expect(reviewStanding(pull({ detail: "basic" }))).toBe("unknown");
	});

	it("puts the oldest first, and sums the queue up", () => {
		const cards = [
			pull({}, { key: "a", createdAt: ago(2 * HOUR) }),
			pull(
				{ checks: { state: "failing", passed: 0, failed: 1, pending: 0, skipped: 0, failing: [] } },
				{ key: "b", createdAt: ago(9 * DAY) },
			),
			pull({ review: "changes_requested" }, { key: "c", createdAt: ago(2 * DAY) }),
		];
		expect(oldestFirst(cards).map((c) => c.key)).toEqual(["b", "c", "a"]);
		expect(queueSummary(cards, NOW, 12)).toEqual({
			count: 12,
			oldest: 9 * DAY,
			failing: 1,
			long: 1,
			withAuthor: 1,
		});
	});

	it("matches the fake forges' reading of its searches", () => {
		const asked = pull(
			{ reviewers: [{ login: "kai", avatarUrl: "", state: "requested" }] },
			{ createdAt: ago(DAY) },
		);
		const q = parseSearch(reviewSearch(config) ?? "");
		expect(matchSearch(asked, q, { viewer: "kai" })).toBe("yes");
		expect(matchSearch(asked, q, { viewer: "jo" })).toBe("no");
		expect(matchSearch({ ...asked, state: "draft" }, q, { viewer: "kai" })).toBe("no");
	});
});

describe("the milestone", () => {
	const config = { ...milestoneWidget.defaults, repo: "acme/widgets", milestone: "v1.0 beta" };

	it("searches its open and closed items, once it's picked", () => {
		expect(milestoneSearch(config, "open")).toBe('repo:acme/widgets milestone:"v1.0 beta" is:open');
		expect(milestoneSearch({ ...config, milestone: "" }, "open")).toBeNull();
		const queries = widgetQueries({ widget: "milestone", config });
		expect(Object.keys(queries)).toEqual(["open", "closed"]);
		expect(queries.open).toMatchObject({ sort: "updated", order: "asc", limit: 100 });
	});

	it("measures progress", () => {
		expect(progress(3, 9)).toEqual({ open: 3, closed: 9, total: 12, ratio: 0.75 });
		expect(progress(0, 0).ratio).toBe(0);
	});

	it("burns up from when items were opened and closed", () => {
		const open = [card({ createdAt: ago(20 * DAY) }), card({ createdAt: ago(3 * DAY) })];
		const closed = [
			card({ state: "closed", createdAt: ago(20 * DAY), closedAt: ago(10 * DAY) }),
			card({ state: "closed", createdAt: ago(18 * DAY), closedAt: ago(2 * DAY) }),
			card({ state: "closed", createdAt: ago(15 * DAY), closedAt: ago(1 * DAY) }),
		];
		const burn = burnUp(open, closed, { now: NOW, steps: 21 });
		expect(burn.start).toBe(NOW - 20 * DAY);
		expect(burn.points[0]).toEqual({ at: NOW - 20 * DAY, scope: 2, done: 0 });
		expect(burn.points.at(-1)).toEqual({ at: NOW, scope: 5, done: 3 });
		expect(burn.sampled).toBe(false);
		// Three closed in the last fortnight: one and a half a week, so two open take 9⅓ days.
		expect(burn.pace).toBeCloseTo(1.5);
		expect(((burn.forecast ?? 0) - NOW) / DAY).toBeCloseTo(28 / 3);
	});

	it("counts items it didn't fetch from the start", () => {
		const burn = burnUp([card({ createdAt: ago(3 * DAY) })], [], {
			now: NOW,
			totals: { open: 1, closed: 4 },
		});
		expect(burn.sampled).toBe(true);
		expect(burn.points[0]).toMatchObject({ scope: 4, done: 4 });
		expect(burn.points.at(-1)).toMatchObject({ scope: 5, done: 4 });
		expect(burn.forecast).toBeNull();
	});

	it("says when it's due, and whether the pace makes it", () => {
		expect(dueOf(null, NOW)).toMatchObject({ tone: "none", text: "No due date" });
		expect(dueOf(new Date(NOW + 18 * DAY).toISOString(), NOW)).toMatchObject({
			tone: "ok",
			text: "Due in 18 days",
		});
		expect(dueOf(new Date(NOW + 12 * HOUR).toISOString(), NOW).text).toBe("Due tomorrow");
		expect(dueOf(new Date(NOW - 3 * DAY).toISOString(), NOW)).toMatchObject({
			tone: "overdue",
			text: "3 days overdue",
		});
		expect(dueOf(null, NOW, true).tone).toBe("done");
		const due = new Date(NOW + 7 * DAY).toISOString();
		expect(late(NOW + 6 * DAY, due)).toBe(false);
		expect(late(NOW + 10 * DAY, due)).toBe(true);
		expect(late(null, due)).toBeNull();
	});

	it("finds what's at risk: stale, blocked, or big and late", () => {
		const items = [
			card({ key: "fresh", updatedAt: ago(DAY) }),
			card({ key: "stale", updatedAt: ago(20 * DAY) }),
			card({
				key: "blocked",
				updatedAt: ago(30 * DAY),
				labels: [{ name: "status: blocked", color: "000" }],
			}),
			pull({ additions: 900, deletions: 300 }, { key: "big", updatedAt: ago(DAY) }),
		];
		const soon = new Date(NOW + 3 * DAY).toISOString();
		expect(
			atRisk(items, { now: NOW, dueOn: soon, staleDays: 14 }).map((r) => [r.card.key, r.reasons]),
		).toEqual([
			["blocked", ["stale", "blocked"]],
			["stale", ["stale"]],
			["big", ["big"]],
		]);
		// Big isn't a risk with time to spare.
		const later = new Date(NOW + 30 * DAY).toISOString();
		expect(atRisk(items, { now: NOW, dueOn: later, staleDays: 14 }).map((r) => r.card.key)).toEqual(
			["blocked", "stale"],
		);
	});
});

describe("the stale finder", () => {
	const config = { ...staleWidget.defaults, q: "repo:acme/widgets is:open" };

	it("searches for items quiet since the cutoff, quietest first", () => {
		expect(staleCutoff(NOW, 30)).toBe("2026-09-10");
		expect(staleSearch(config, NOW)).toBe("repo:acme/widgets is:open updated:<2026-09-10");
		expect(staleSearch({ ...config, q: "is:open updated:<2025-01-01" }, NOW)).toBe(
			"is:open updated:<2025-01-01",
		);
		expect(staleSearch({ ...config, q: " " }, NOW)).toBeNull();
		const { items } = widgetQueries({ widget: "stale", config });
		expect(items).toMatchObject({ sort: "updated", order: "asc", limit: 50 });
	});

	it("says spans of time in words", () => {
		expect(spanText(30)).toBe("30 days");
		expect(spanText(14)).toBe("2 weeks");
		expect(spanText(60)).toBe("2 months");
		expect(spanText(730)).toBe("2 years");
		expect(staleTitle(config)).toBe("Quiet for 30 days+");
	});

	it("groups items by how long they've been quiet", () => {
		const items = [10, 31, 59, 61, 200].map((days) =>
			card({ key: `${days}`, updatedAt: ago(days * DAY + HOUR) }),
		);
		const groups = staleGroups(items, NOW, 30);
		expect(groups.map((g) => [g.label, g.items.map((i) => i.card.key)])).toEqual([
			["30 days – 2 months", ["59", "31"]],
			["2–4 months", ["61"]],
			["4 months+", ["200"]],
		]);
	});

	it("pings whoever's assigned, or whoever opened it", () => {
		const quiet = card({ updatedAt: ago(45 * DAY) });
		expect(pingComment(quiet, NOW)).toMatch(/^@alice: this issue has been quiet for 45 days\./);
		expect(pingComment({ ...quiet, assignees: [{ login: "kai", avatarUrl: "" }] }, NOW)).toMatch(
			/^@kai: /,
		);
	});

	it("matches the fake forges' reading of its searches", () => {
		const q = parseSearch(staleSearch(config, NOW) ?? "");
		expect(matchSearch(card({ updatedAt: ago(40 * DAY) }), q)).toBe("yes");
		expect(matchSearch(card({ updatedAt: ago(10 * DAY) }), q)).toBe("no");
	});
});
