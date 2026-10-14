import { describe, expect, it } from "vite-plus/test";
import {
	ASSIGN_WIDTH,
	CARD_WIDTH,
	GHOST_WIDTH,
	fitPills,
	morePillWidth,
	pillRoom,
	pillWidth,
	pillsWidth,
	planFoot,
	provenanceLabelWidth,
	unfoldPills,
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

const total = (counts: readonly ReactionCount[]) => counts.reduce((sum, c) => sum + c.count, 0);

const card = (over: Record<string, unknown> = {}, counts: ReactionCount[] = FOUR) => ({
	assignees: [],
	author: null,
	comments: 14,
	discussion: undefined,
	reactions: total(counts),
	reactionCounts: counts,
	...over,
});

const face = (login: string) => ({ login, avatarUrl: "" });

/** What a foot shows: each pill's text, "+N" last. */
const text = ({ shown, rest }: ReturnType<typeof fitPills>) => [
	...shown.map((c) => `${c.emoji}${c.count}`),
	...(rest.length ? [`+${rest.length}`] : []),
];
const pills = (counts: readonly ReactionCount[], room: number) => text(fitPills(counts, room));

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

	it("is the volunteers' chip's for up to four faces, and its ghost is the chip with you in it", () => {
		expect(volunteersWidth(2)).toBeCloseTo(55, 0);
		expect(volunteersWidth(4)).toBeCloseTo(83, 0);
		// Past four, three faces and "+N": still four.
		expect(volunteersWidth(9)).toBe(volunteersWidth(4));
		expect(GHOST_WIDTH).toBe(volunteersWidth(1));
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

	it("folds them all into +N where not one fits, but keeps a lone kind's pill", () => {
		expect(pills(SIX, 60)).toEqual(["+6"]);
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
		for (let room = 30; room <= 300; room += 1) {
			const { shown, rest } = fitPills(SIX, room);
			expect(pillsWidth(shown, rest.length)).toBeLessThanOrEqual(room);
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

	it("leaves the volunteers' chip room, a little closer than the rest", () => {
		const plain = pillRoom(card());
		const two = pillRoom(card(), { volunteers: 2 });
		expect(plain - two).toBeCloseTo(volunteersWidth(2) + 12 - 4);
		expect(pills(FOUR, two)).toEqual(["👍11", "+3"]);
		expect(pills(FOUR, pillRoom(card(), { volunteers: 2 }, 280))).toEqual(["👍11", "❤️6", "+2"]);
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
			},
		});
		expect(pillRoom(discussion)).toBeLessThan(plain - 14 - 30 - 12 - 3 * 12);
	});

	it("shows more on a wider card and fewer on a narrower one", () => {
		expect(pills(SIX, pillRoom(card(), {}, 340))).toHaveLength(6);
		expect(pills(SIX, pillRoom(card(), {}, CARD_WIDTH))).toEqual(["👍11", "❤️6", "🚀4", "+3"]);
		expect(pills(SIX, pillRoom(card(), {}, 200))).toEqual(["👍11", "❤️6", "+4"]);
	});
});

describe("a card's foot as the ghost ✋ shows or Assign opens", () => {
	it("makes room for the ghost by folding the fewest left into +N", () => {
		const plan = planFoot(card(), { volunteers: 0 });
		expect(plan.room - plan.unfold!.room).toBeCloseTo(GHOST_WIDTH + 12 - 4);
		expect(plan.unfold?.kind).toBe("ghost");
		const { rest, open } = unfoldPills(FOUR, plan.room, plan.unfold!.room);
		expect(text(rest)).toEqual(["👍11", "🎉3", "❤️6", "🚀2"]);
		expect(text(open)).toEqual(["👍11", "❤️6", "+2"]);
		// Where there's room, nothing folds.
		const two = FOUR.slice(0, 2);
		const roomy = planFoot(card({}, two), { volunteers: 0 });
		expect(text(unfoldPills(two, roomy.room, roomy.unfold!.room).open)).toEqual(["👍11", "🎉3"]);
	});

	it("leaves the reactions just as they were once you press it: the chip with you in it is the ghost's size", () => {
		const ghost = planFoot(card({}, SIX), { volunteers: 0 });
		const you = planFoot(card({}, SIX), { volunteers: 1 });
		expect(you.room).toBeCloseTo(ghost.unfold!.room);
		const shown = unfoldPills(SIX, ghost.room, ghost.unfold!.room);
		expect(pillsWidth(fitPills(SIX, you.room).shown, fitPills(SIX, you.room).rest.length)).toBe(
			shown.fitWidth,
		);
	});

	it("opens Assign at the chip's end where there's room, and at its start over the reactions where there isn't", () => {
		// No reactions: room to spare.
		expect(planFoot(card({}, []), { volunteers: 2, unfolds: true }).assign).toBe("end");
		// No Assign to open: nothing changes.
		expect(planFoot(card(), { volunteers: 2 }).assign).toBeUndefined();
		const busy = planFoot(card(), { volunteers: 2, unfolds: true });
		expect(busy.assign).toBe("start");
		expect(busy.spare).toBeLessThan(ASSIGN_WIDTH);
		const { rest, open, more } = unfoldPills(FOUR, busy.room, busy.unfold!.room);
		expect(text(rest)).toEqual(["👍11", "+3"]);
		// Not even 👍 11 fits beside "+3" under Assign: "+4" stands for them all.
		expect(text(open)).toEqual(["+4"]);
		expect(more).toBe(true);
		// On a wider card, fewer fold.
		const wide = planFoot(card(), { volunteers: 2, unfolds: true }, 340);
		const widened = unfoldPills(FOUR, wide.room, wide.unfold!.room);
		expect(text(widened.rest)).toEqual(["👍11", "🎉3", "❤️6", "🚀2"]);
		expect(text(widened.open)).toEqual(["👍11", "❤️6", "+2"]);
	});

	it("folds even +N where there's no room for it under Assign", () => {
		const lone = [{ emoji: "👍", count: 11 }];
		const plan = planFoot(card({ assignees: [face("a"), face("b"), face("c")] }, lone), {
			volunteers: 4,
			unfolds: true,
		});
		expect(plan.assign).toBe("start");
		const { open, more, fitWidth } = unfoldPills(lone, plan.room, plan.unfold!.room);
		expect(text(open)).toEqual(["+1"]);
		expect(more).toBe(false);
		expect(fitWidth).toBe(0);
	});

	it("keep only pills that were already shown, in the room there is", () => {
		for (let room = 100; room <= 300; room += 3) {
			const unfolded = room - 49;
			const { rest, open, more, fitWidth } = unfoldPills(SIX, room, unfolded);
			for (const c of open.shown) expect(rest.shown).toContain(c);
			expect(open.rest.length).toBeGreaterThanOrEqual(rest.rest.length);
			if (more || open.shown.length) expect(fitWidth).toBeLessThanOrEqual(unfolded);
		}
	});

	it("says how much room a provenance label has, at rest and opened", () => {
		const plan = planFoot(card(), { volunteers: 0, provenance: true });
		expect(plan.spare).toBeLessThan(provenanceLabelWidth("From the “Bugs” list"));
		const empty = planFoot(card({}, []), { provenance: true });
		expect(empty.spare).toBeGreaterThan(provenanceLabelWidth("From the “Bugs” list"));
		// The ghost ✋ takes some of it as it shows.
		const ghost = planFoot(card({}, []), { volunteers: 0, provenance: true });
		expect(ghost.openSpare).toBeCloseTo(empty.spare - GHOST_WIDTH - 8);
	});
});
