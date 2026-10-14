import { describe, expect, it } from "vite-plus/test";
import {
	CARD_WIDTH,
	fitPills,
	morePillWidth,
	pillRoom,
	pillWidth,
	volunteersWidth,
} from "../src/shared/cardFoot.ts";
import type { ReactionCount } from "../src/shared/reactions.ts";

const FOUR: ReactionCount[] = [
	{ emoji: "👍", count: 11 },
	{ emoji: "🎉", count: 3 },
	{ emoji: "❤️", count: 6 },
	{ emoji: "🚀", count: 2 },
];

const SIX: ReactionCount[] = [
	{ emoji: "👍", count: 11 },
	{ emoji: "😄", count: 2 },
	{ emoji: "🎉", count: 3 },
	{ emoji: "❤️", count: 6 },
	{ emoji: "🚀", count: 4 },
	{ emoji: "👀", count: 1 },
];

const card = (over: Partial<Parameters<typeof pillRoom>[0]> = {}) => ({
	assignees: [],
	author: null,
	comments: 14,
	discussion: undefined,
	...over,
});

const face = (login: string) => ({ login, avatarUrl: "" });

/** What a foot shows: each pill's text, "+N" last. */
function pills(counts: readonly ReactionCount[], room: number): string[] {
	const { shown, rest } = fitPills(counts, room);
	return [...shown.map((c) => `${c.emoji}${c.count}`), ...(rest.length ? [`+${rest.length}`] : [])];
}

describe("a reaction pill's width", () => {
	// As Chromium draws them, in Geist Mono and a colour emoji font.
	it("matches the stylesheet's, to within half a pixel", () => {
		expect(pillWidth(6)).toBeCloseTo(38.61, 0);
		expect(pillWidth(11)).toBeCloseTo(45.2, 0);
		expect(pillWidth(170)).toBeCloseTo(51.81, 0);
		expect(morePillWidth(3)).toBeCloseTo(29.22, 0);
	});

	it("grows with its count's digits", () => {
		expect(pillWidth(1)).toBe(pillWidth(9));
		expect(pillWidth(10)).toBeGreaterThan(pillWidth(9));
		expect(pillWidth(1000)).toBeGreaterThan(pillWidth(999));
	});

	it("is the volunteers' chip's, at rest, for up to four faces", () => {
		expect(volunteersWidth(2)).toBeCloseTo(54, 0);
		expect(volunteersWidth(4)).toBeCloseTo(78, 0);
		// Past four, three faces and "+N": still four.
		expect(volunteersWidth(9)).toBe(volunteersWidth(4));
	});
});

describe("fitting reaction pills to a card's foot", () => {
	it("shows every pill, in GitHub's order, when they fit", () => {
		expect(pills(FOUR, 180)).toEqual(["👍11", "🎉3", "❤️6", "🚀2"]);
	});

	it("keeps the most left as room runs out, folding the rest into +N", () => {
		expect(pills(SIX, 180)).toEqual(["👍11", "❤️6", "🚀4", "+3"]);
		expect(pills(SIX, 140)).toEqual(["👍11", "❤️6", "+4"]);
		expect(pills(SIX, 100)).toEqual(["👍11", "+5"]);
	});

	it("keeps one pill, however little room there is", () => {
		expect(pills(SIX, 0)).toEqual(["👍11", "+5"]);
		expect(pills([{ emoji: "👍", count: 3 }], 0)).toEqual(["👍3"]);
	});

	it("never shows more as the room shrinks", () => {
		let before = Infinity;
		for (let room = 300; room >= 0; room -= 2) {
			const { shown } = fitPills(SIX, room);
			expect(shown.length).toBeLessThanOrEqual(before);
			before = shown.length;
		}
	});

	it("fits within the room it's given", () => {
		for (let room = 80; room <= 300; room += 1) {
			const { shown, rest } = fitPills(SIX, room);
			const width =
				shown.reduce((sum, c) => sum + pillWidth(c.count), 0) +
				(rest.length ? morePillWidth(rest.length) : 0) +
				4 * (shown.length + (rest.length ? 1 : 0) - 1);
			expect(width).toBeLessThanOrEqual(room);
		}
	});
});

describe("the room a card's reactions have", () => {
	it("is the foot's width beside the comment count", () => {
		// 252px, less 30px of padding and border, a two-digit count and its gap.
		expect(pillRoom(card())).toBeCloseTo(222 - 29.8 - 12, 0);
		expect(pills(FOUR, pillRoom(card()))).toEqual(["👍11", "🎉3", "❤️6", "🚀2"]);
		expect(pills(SIX, pillRoom(card()))).toEqual(["👍11", "❤️6", "🚀4", "+3"]);
	});

	it("leaves a busy foot's volunteers room, while keeping as many pills as fit", () => {
		// Before, a count said one pill and +3 here.
		const two = pillRoom(card(), { volunteers: 2 });
		expect(pills(FOUR, two)).toEqual(["👍11", "❤️6", "+2"]);
		const many = pillRoom(card(), { volunteers: 5 });
		expect(pills(FOUR, many)).toEqual(["👍11", "+3"]);
	});

	it("makes room for assignees, upvotes, a lock, provenance and liveness", () => {
		const plain = pillRoom(card());
		const assigned = pillRoom(card({ assignees: [face("kai"), face("priya"), face("tom")] }));
		expect(plain - assigned).toBeCloseTo(3 * 14 + 12);
		// Only three faces show, however many are assigned.
		expect(pillRoom(card({ assignees: ["a", "b", "c", "d", "e"].map(face) }))).toBe(assigned);
		expect(pills(FOUR, assigned)).toEqual(["👍11", "❤️6", "+2"]);
		expect(pillRoom(card(), { provenance: true })).toBeCloseTo(plain - 32);
		expect(pillRoom(card(), { liveness: "lazy" })).toBeLessThan(plain - 70);
		const discussion = card({
			author: face("kai"),
			discussion: {
				category: { name: "Ideas", emoji: "💡" },
				answered: false,
				upvotes: 24,
				locked: true,
			} as never,
		});
		expect(pillRoom(discussion)).toBeLessThan(plain - 14 - 30 - 12 - 3 * 12);
	});

	it("shows more on a wider card and fewer on a narrower one", () => {
		expect(pills(SIX, pillRoom(card(), {}, 340))).toHaveLength(6);
		expect(pills(SIX, pillRoom(card(), {}, CARD_WIDTH))).toEqual(["👍11", "❤️6", "🚀4", "+3"]);
		expect(pills(SIX, pillRoom(card(), {}, 200))).toEqual(["👍11", "❤️6", "+4"]);
		expect(pills(SIX, pillRoom(card(), { volunteers: 2 }, 340))).toEqual([
			"👍11",
			"🎉3",
			"❤️6",
			"🚀4",
			"+2",
		]);
	});
});
