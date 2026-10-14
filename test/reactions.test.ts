import { describe, expect, it } from "vite-plus/test";
import {
	MAX_NAMED,
	fakeReactionCounts,
	fakeReactors,
	topReactions,
	isReactorsResult,
	namePeople,
	namedReactors,
	reactionLine,
} from "../src/shared/reactions.ts";
import { toGroups } from "../src/server/forges/github-reactors.ts";
import { placeTip } from "../src/client/reactions/placement.ts";

const people = (...names: string[]) => names.map((name) => ({ name }));

describe("naming who reacted", () => {
	it("joins names as a sentence", () => {
		expect(namePeople(people("Kai Andersen"))).toBe("Kai Andersen");
		expect(namePeople(people("Kai Andersen", "Priya Shah"))).toBe("Kai Andersen and Priya Shah");
		expect(namePeople(people("Kai Andersen", "Priya Shah", "Jo Rivera"))).toBe(
			"Kai Andersen, Priya Shah and Jo Rivera",
		);
	});

	it("says You, first, wherever you are among them", () => {
		expect(namePeople([{ name: "Kai Andersen" }, { name: "Priya Shah", you: true }])).toBe(
			"You and Kai Andersen",
		);
		expect(reactionLine("👍", [{ name: "Kai", you: true }])).toBe("👍 You");
	});

	it("names ten at most, then counts the others", () => {
		const twelve = people(...Array.from({ length: 12 }, (_, i) => `Person ${i + 1}`));
		const phrase = namePeople(twelve);
		expect(phrase.split(", ")).toHaveLength(MAX_NAMED);
		expect(phrase).toMatch(/Person 10 and 2 others$/);
		expect(namePeople(people(...Array.from({ length: 11 }, (_, i) => `P${i}`)))).toMatch(
			/and 1 other$/,
		);
	});

	it("counts those the forge didn't name", () => {
		expect(namePeople(people("Kai Andersen", "Priya Shah"), 5)).toBe(
			"Kai Andersen, Priya Shah and 3 others",
		);
		expect(namePeople([], 1)).toBe("1 person");
		expect(namePeople([], 4)).toBe("4 people");
	});

	it("prefers the names Tack knows, then the forge's, then logins", () => {
		const named = namedReactors(
			[
				{ login: "kai", name: "Kai A." },
				{ login: "priya", name: "Priya" },
				{ login: "ola-n" },
				{ login: "Me" },
			],
			"me",
			(login) => (login === "kai" ? "Kai Andersen" : null),
		);
		expect(named).toEqual([
			{ name: "Kai Andersen" },
			{ name: "Priya" },
			{ name: "ola-n" },
			{ name: "Me", you: true },
		]);
	});
});

describe("a line that must fit", () => {
	const many = people("Mina Larsen", "ola-n", "Sam Kim", "Ana Ruiz", "Leo Brandt", "Noor Haddad");
	it("names fewer rather than wrap, and always at least one", () => {
		expect(namePeople(many, 11, { max: 3, chars: 40 })).toBe(
			"Mina Larsen, ola-n, Sam Kim and 8 others",
		);
		expect(namePeople(many, 11, { max: 3, chars: 31 })).toBe("Mina Larsen, ola-n and 9 others");
		expect(namePeople(many, 11, { max: 3, chars: 5 })).toBe("Mina Larsen and 10 others");
	});

	it("keeps names whole, breaking only between them", () => {
		expect(namePeople(people("Kai Andersen", "Priya Shah"), 5, { whole: true })).toBe(
			"Kai\u00a0Andersen, Priya\u00a0Shah and 3\u00a0others",
		);
	});
});

describe("where the tooltip goes", () => {
	const board = { left: 0, top: 56, right: 1280, bottom: 800 };
	const size = { width: 260, height: 80 };
	const pill = (left: number, top: number) => ({ left, top, right: left + 40, bottom: top + 18 });

	it("is centred above its pill, or below if there's no room", () => {
		expect(placeTip(pill(600, 400), size, board)).toEqual({ left: 490, top: 312, side: "above" });
		expect(placeTip(pill(600, 100), size, board).side).toBe("below");
	});

	it("prefers below when asked, above when there's no room", () => {
		expect(placeTip(pill(600, 400), size, board, "below")).toEqual({
			left: 490,
			top: 426,
			side: "below",
		});
		expect(placeTip(pill(600, 760), size, board, "below").side).toBe("above");
	});

	it("lines up with the pill's edge near the board's, never past it", () => {
		expect(placeTip(pill(92, 400), size, board).left).toBe(84);
		expect(placeTip(pill(1220, 400), size, board).left).toBe(1268 - 260);
		expect(placeTip(pill(2, 400), size, board).left).toBe(8);
	});
});

describe("a card's reaction pills", () => {
	const counts = [
		{ emoji: "👍", count: 11 },
		{ emoji: "😄", count: 2 },
		{ emoji: "🎉", count: 3 },
		{ emoji: "❤️", count: 6 },
		{ emoji: "🚀", count: 4 },
		{ emoji: "👀", count: 1 },
	];
	it("show the top one or two where pills don't fit, in GitHub's order", () => {
		expect(topReactions(counts, 2).map((c) => c.emoji)).toEqual(["👍", "❤️"]);
		expect(topReactions(counts, 1)).toEqual([{ emoji: "👍", count: 11 }]);
	});

	it("are the fake forge's people's, adding up to its count", () => {
		const fake = fakeReactionCounts("fake.tack/tack/cirrus#8", 8);
		expect(fake).toEqual([
			{ emoji: "👍", count: 4 },
			{ emoji: "🎉", count: 1 },
			{ emoji: "❤️", count: 2 },
			{ emoji: "🚀", count: 1 },
		]);
	});
});

describe("GitHub's reaction groups", () => {
	it("become emoji, leaving out empty ones and reactors who are gone", () => {
		expect(
			toGroups([
				{
					content: "THUMBS_UP",
					reactors: {
						totalCount: 3,
						nodes: [{ login: "kai", name: "Kai Andersen" }, { login: "ola-n", name: null }, null],
					},
				},
				{ content: "CONFUSED", reactors: { totalCount: 0, nodes: [] } },
				{ content: "ROCKET", reactors: { totalCount: 1, nodes: [{ login: "priya" }] } },
				{ content: "SOMETHING_NEW", reactors: { totalCount: 1, nodes: [{ login: "jo" }] } },
			]),
		).toEqual([
			{
				emoji: "👍",
				count: 3,
				reactors: [{ login: "kai", name: "Kai Andersen" }, { login: "ola-n" }],
			},
			{ emoji: "🚀", count: 1, reactors: [{ login: "priya" }] },
		]);
	});
});

describe("the fake forge's reactors", () => {
	it("add up to the card's count, the same people every time", () => {
		const groups = fakeReactors("fake.tack/tack/cirrus#8", 8);
		expect(groups.reduce((n, g) => n + g.count, 0)).toBe(8);
		expect(groups.map((g) => g.emoji)).toEqual(["👍", "❤️", "🎉", "🚀"]);
		for (const group of groups) {
			expect(new Set(group.reactors.map((r) => r.login)).size).toBe(group.reactors.length);
			expect(group.reactors.length).toBe(Math.min(group.count, MAX_NAMED));
		}
		expect(fakeReactors("fake.tack/tack/cirrus#8", 8)).toEqual(groups);
		expect(fakeReactors("fake.tack/tack/cirrus#9", 0)).toEqual([]);
		expect(isReactorsResult({ kind: "reactors", key: "k", groups })).toBe(true);
		expect(isReactorsResult({ kind: "reactors", key: "k", groups: [{ emoji: 1 }] })).toBe(false);
	});
});
