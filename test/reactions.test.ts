import { describe, expect, it } from "vite-plus/test";
import {
	MAX_NAMED,
	fakeReactors,
	isReactorsResult,
	namePeople,
	namedReactors,
	reactionLine,
} from "../src/shared/reactions.ts";
import { toGroups } from "../src/server/forges/github-reactors.ts";

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
