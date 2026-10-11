// Weekly digests (#68), the pure parts: the schedule in the owner's time
// zone, which week a digest is for, what goes in a digest, and its words.

import { describe, expect, it } from "vite-plus/test";
import {
	type DigestInput,
	buildWeeklyDigest,
	describeRange,
	digestHighlights,
	digestMarkdown,
	digestTitle,
	isQuietWeek,
	maskEmail,
	nextDigestAt,
	validEmail,
	validTimeZone,
	weekKey,
	zonedTime,
} from "../src/shared/digests.ts";
import type { ShapeProps } from "../src/shared/shapes.ts";
import type { EditEntry } from "../src/shared/since.ts";
import { digestHtml, digestText } from "../src/server/digestEmail.ts";
import { parseFrom } from "../src/server/email.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

describe("the schedule", () => {
	it("goes out on the chosen weekday and hour, in the owner's time zone", () => {
		const london = { weekday: 1, hour: 9, timeZone: "Europe/London" } as const;
		// Saturday 11 Oct 2026, noon UTC: next Monday, 9:00 BST is 8:00 UTC.
		expect(new Date(nextDigestAt(london, at("2026-10-10T12:00:00Z"))).toISOString()).toBe(
			"2026-10-12T08:00:00.000Z",
		);
		// On the Monday itself, before nine: that day. After: a week on.
		expect(new Date(nextDigestAt(london, at("2026-10-12T07:00:00Z"))).toISOString()).toBe(
			"2026-10-12T08:00:00.000Z",
		);
		expect(new Date(nextDigestAt(london, at("2026-10-12T08:00:00Z"))).toISOString()).toBe(
			"2026-10-19T08:00:00.000Z",
		);
		// After the clocks go back (25 Oct), 9:00 is 9:00 UTC.
		expect(new Date(nextDigestAt(london, at("2026-10-20T00:00:00Z"))).toISOString()).toBe(
			"2026-10-26T09:00:00.000Z",
		);
		const tokyo = { weekday: 5, hour: 18, timeZone: "Asia/Tokyo" } as const;
		expect(new Date(nextDigestAt(tokyo, at("2026-10-10T00:00:00Z"))).toISOString()).toBe(
			"2026-10-16T09:00:00.000Z",
		);
		const la = { weekday: 0, hour: 0, timeZone: "America/Los_Angeles" } as const;
		expect(new Date(nextDigestAt(la, at("2026-10-10T00:00:00Z"))).toISOString()).toBe(
			"2026-10-11T07:00:00.000Z",
		);
	});

	it("knows the moment an hour starts on a day, there", () => {
		expect(new Date(zonedTime("2026-03-29", 9, "Europe/London")).toISOString()).toBe(
			"2026-03-29T08:00:00.000Z",
		);
		expect(new Date(zonedTime("2026-01-05", 9, "UTC")).toISOString()).toBe(
			"2026-01-05T09:00:00.000Z",
		);
	});

	it("names each week once, in the owner's time zone", () => {
		expect(weekKey(at("2026-10-12T08:00:00Z"), "Europe/London")).toBe("2026-W42");
		// Any day that week is the same week; the next Monday isn't.
		expect(weekKey(at("2026-10-16T08:00:00Z"), "Europe/London")).toBe("2026-W42");
		expect(weekKey(at("2026-10-19T08:00:00Z"), "Europe/London")).toBe("2026-W43");
		// Late Sunday in UTC is Monday in Tokyo.
		expect(weekKey(at("2026-10-18T20:00:00Z"), "UTC")).toBe("2026-W42");
		expect(weekKey(at("2026-10-18T20:00:00Z"), "Asia/Tokyo")).toBe("2026-W43");
		// The year of a week is its Thursday's.
		expect(weekKey(at("2027-01-01T12:00:00Z"), "UTC")).toBe("2026-W53");
	});

	it("says a week in words", () => {
		expect(
			describeRange(at("2026-10-05T08:00:00Z"), at("2026-10-12T08:00:00Z"), "Europe/London"),
		).toBe("5–12 Oct");
		expect(
			describeRange(at("2026-09-28T08:00:00Z"), at("2026-10-05T08:00:00Z"), "Europe/London", true),
		).toBe("28 Sep – 5 Oct 2026");
	});

	it("checks time zones and addresses", () => {
		expect(validTimeZone("Europe/London")).toBe(true);
		expect(validTimeZone("Mars/Olympus")).toBe(false);
		expect(validEmail("priya@example.com")).toBe(true);
		expect(validEmail("priya@example")).toBe(false);
		expect(validEmail("two words@example.com")).toBe(false);
		expect(validEmail("a@b.c<script>")).toBe(false);
		expect(maskEmail("priya@example.com")).toBe("p•••@example.com");
		expect(parseFrom("Tack <tack@example.com>")).toEqual({
			email: "tack@example.com",
			name: "Tack",
		});
		expect(parseFrom("tack@example.com")).toEqual({ email: "tack@example.com" });
		expect(parseFrom("")).toBeNull();
	});
});

const FROM = at("2026-10-05T08:00:00Z");
const TO = at("2026-10-12T08:00:00Z");
const MID = at("2026-10-08T12:00:00Z");
const PRIYA = { kind: "person" as const, id: 1, login: "priya", name: "Priya" };
const KAI = { kind: "person" as const, id: 2, login: "kai", name: "Kai" };

function input(overrides: Partial<DigestInput> = {}): DigestInput {
	const shapes = new Map<string, ShapeProps>([
		[
			"d1",
			{
				type: "decision",
				x: 0,
				y: 0,
				z: "a0",
				title: "Use Yjs for sync",
				status: "decided",
				decidedAt: new Date(MID).toISOString(),
				decidedBy: { name: "Priya", color: "#ff8800" },
			},
		],
		[
			"d0",
			{
				type: "decision",
				x: 0,
				y: 0,
				z: "a0",
				title: "Decided long ago",
				status: "decided",
				decidedAt: new Date(FROM - DAY).toISOString(),
			},
		],
		["d2", { type: "decision", x: 0, y: 0, z: "a0", title: "Still proposed" }],
		[
			"a1",
			{
				type: "action",
				x: 0,
				y: 0,
				z: "a0",
				text: "Write the RFC",
				owner: { login: "kai" },
				done: new Date(MID).toISOString(),
			},
		],
		[
			"a2",
			{
				type: "action",
				x: 0,
				y: 0,
				z: "a0",
				text: "Ship it",
				owner: { login: "kai" },
				due: "2026-10-09",
			},
		],
		["a3", { type: "action", x: 0, y: 0, z: "a0", text: "Plan the launch", due: "2026-10-20" }],
		[
			"a4",
			{
				type: "action",
				x: 0,
				y: 0,
				z: "a0",
				text: "Fix the secret thing",
				ref: "github.com/acme/secret#3",
				due: "2026-10-01",
			},
		],
		["c1", { type: "card", x: 0, y: 0, z: "a0", ref: "github.com/acme/widgets#12" }],
	]);
	const edits: EditEntry[] = [
		{ shape: "a3", kind: "added", type: "action", at: MID, by: KAI },
		{ shape: "s1", kind: "added", type: "sticky", at: MID, by: PRIYA },
		{ shape: "s2", kind: "added", type: "sticky", at: MID, by: PRIYA },
		{ shape: "c1", kind: "moved", type: "card", at: MID, by: KAI },
		// Before the week: left out.
		{ shape: "s0", kind: "added", type: "sticky", at: FROM - HOUR, by: PRIYA },
	];
	return {
		board: { id: "roadmap", title: "Roadmap", url: "https://tack.example/b/roadmap/roadmap" },
		from: FROM,
		to: TO,
		timeZone: "Europe/London",
		edits,
		more: 0,
		shapes,
		cards: [
			{ key: "github.com/acme/widgets#12", kind: "comments", at: MID, count: 3 },
			{ key: "github.com/acme/widgets#12", kind: "closed", at: MID + HOUR },
		],
		card: (key) =>
			key === "github.com/acme/widgets#12"
				? {
						title: "Widgets wobble",
						url: "https://github.com/acme/widgets/issues/12",
						kind: "issue",
						state: "closed",
					}
				: null,
		pushes: [
			{
				pushId: "p1",
				at: MID,
				by: { login: "priya", name: "Priya" },
				applied: 2,
				failed: 1,
				summaries: ["Create issue “Plan the launch”"],
			},
		],
		...overrides,
	};
}

describe("a week of a board", () => {
	it("says what was decided, what's done, new and overdue, GitHub, pushes and who did what", () => {
		const digest = buildWeeklyDigest(input());
		expect(digest.decisions).toEqual([
			{ id: "d1", title: "Use Yjs for sync", by: "Priya", at: MID },
		]);
		expect(digest.actions.done.map((a) => a.text)).toEqual(["Write the RFC"]);
		expect(digest.actions.opened.map((a) => a.text)).toEqual(["Plan the launch"]);
		expect(digest.actions.overdue.map((a) => [a.text, a.dueWords])).toEqual([
			// Most overdue first.
			["Fix the secret thing", "11 days late"],
			["Ship it", "3 days late"],
		]);
		// The linked issue's repository can't be read here, so it isn't named.
		expect(digest.actions.overdue[0]?.ref).toBeUndefined();
		expect(digest.items).toEqual([
			{
				key: "github.com/acme/widgets#12",
				ref: "acme/widgets#12",
				title: "Widgets wobble",
				url: "https://github.com/acme/widgets/issues/12",
				kind: "issue",
				activity: ["3 new comments", "closed"],
			},
		]);
		expect(digest.pushes).toEqual([
			{
				by: "Priya",
				at: MID,
				applied: 2,
				failed: 1,
				summaries: ["Create issue “Plan the launch”"],
			},
		]);
		// Most active first; ties in the order they were seen.
		expect(digest.people).toEqual([
			{ name: "Kai", login: "kai", summary: "added 1 action item, moved 1 card", count: 2 },
			{ name: "Priya", login: "priya", summary: "added 2 stickies", count: 2 },
		]);
		expect(isQuietWeek(digest)).toBe(false);
		expect(digestHighlights(digest)).toEqual([
			"1 decision",
			"1 action item done",
			"2 overdue",
			"1 closed on GitHub",
		]);
		expect(digestTitle(digest)).toBe("Roadmap: the week of 5–12 Oct");
	});

	it("lists a new action item that's late already once, as late", () => {
		const base = input();
		const digest = buildWeeklyDigest(
			input({
				edits: [...base.edits, { shape: "a2", kind: "added", type: "action", at: MID, by: KAI }],
			}),
		);
		expect(digest.actions.opened.map((a) => a.text)).toEqual(["Plan the launch"]);
		expect(digest.actions.overdue.map((a) => a.text)).toContain("Ship it");
	});

	it("is quiet when nothing happened", () => {
		const digest = buildWeeklyDigest(
			input({ shapes: new Map(), edits: [], cards: [], pushes: [] }),
		);
		expect(isQuietWeek(digest)).toBe(true);
		// Overdue items alone aren't news: they're the same every week.
		const overdueOnly = buildWeeklyDigest(
			input({
				shapes: new Map([
					["a2", { type: "action", x: 0, y: 0, z: "a0", text: "Ship it", due: "2026-10-01" }],
				]),
				edits: [],
				cards: [],
				pushes: [],
			}),
		);
		expect(overdueOnly.actions.overdue).toHaveLength(1);
		expect(isQuietWeek(overdueOnly)).toBe(true);
	});

	it("writes a Discussion that mentions, links and formats nothing anyone wrote", () => {
		const shapes = new Map<string, ShapeProps>([
			[
				"d1",
				{
					type: "decision",
					x: 0,
					y: 0,
					z: "a0",
					title: "Ping @everyone about [this](https://evil.example) <b>now</b> #1",
					status: "decided",
					decidedAt: new Date(MID).toISOString(),
				},
			],
		]);
		const markdown = digestMarkdown(buildWeeklyDigest(input({ shapes })), {
			schedule: "Mondays at 9:00 (Europe/London)",
		});
		expect(markdown).toContain("[**Roadmap**](https://tack.example/b/roadmap/roadmap)");
		expect(markdown).toContain("### Decisions");
		expect(markdown).not.toMatch(/(^|[^‍])@everyone/);
		expect(markdown).not.toContain("](https://evil.example)");
		expect(markdown).not.toContain("<b>");
		// Items are named, not linked, so no issue's timeline gets a reference every week.
		expect(markdown).toContain("acme/widgets\\#12 Widgets wobble: 3 new comments, closed");
		expect(markdown).not.toContain("https://github.com/acme/widgets/issues/12");
		expect(markdown).toContain("- **Priya** added 2 stickies");
		expect(markdown).toContain("Mondays at 9:00 (Europe/London)");
	});

	it("emails it as text and as escaped HTML", () => {
		const shapes = new Map<string, ShapeProps>([
			[
				"d1",
				{
					type: "decision",
					x: 0,
					y: 0,
					z: "a0",
					title: `<img src=x onerror="alert(1)">`,
					status: "decided",
					decidedAt: new Date(MID).toISOString(),
				},
			],
		]);
		const digest = buildWeeklyDigest(input({ shapes }));
		const links = {
			unsubscribe: "https://tack.example/digest?unsubscribe=1&token=t",
			schedule: "Mondays at 9:00 (Europe/London)",
		};
		const html = digestHtml(digest, links);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).toContain('href="https://github.com/acme/widgets/issues/12"');
		expect(html).toContain('href="https://tack.example/digest?unsubscribe=1&amp;token=t"');
		const text = digestText(digest, links);
		expect(text).toContain("Roadmap: 5–12 Oct 2026");
		expect(text).toContain("https://github.com/acme/widgets/issues/12");
		expect(text).toContain("Stop getting it: https://tack.example/digest?unsubscribe=1&token=t");
	});
});
