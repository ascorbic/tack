import { describe, expect, it } from "vite-plus/test";
import {
	type BarItem,
	type Measured,
	arrange,
	overflowing,
} from "../src/client/actions/barLayout.ts";

// Every selection bar: settings are icons, actions an icon and a word, the
// main action in the accent colour, and what matters least in "…" first.

const ids = (items: { item: { id: string } }[]) => items.map((a) => a.item.id);

describe("arrange", () => {
	it("puts settings first, then facilitation, actions and AI, the main action first in its group", () => {
		const laid = arrange<BarItem>([
			{ id: "stackThese" },
			{ id: "labels" },
			{ id: "summarise" },
			{ id: "closeReopen", text: "Reopen" },
			{ id: "milestone" },
			{ id: "parentIssue" },
			{ id: "draftDecision" },
		]);
		expect(ids(laid)).toEqual([
			"labels",
			"milestone",
			"parentIssue",
			"stackThese",
			"closeReopen",
			"summarise",
			"draftDecision",
		]);
		expect(laid.map((a) => [a.item.text, a.item.quiet ?? false])).toEqual([
			[undefined, false],
			[undefined, false],
			["Make parent issue", false],
			["Stack", true],
			["Reopen", true],
			["Summarise", true],
			["Decide", true],
		]);
		expect(laid.filter((a) => a.pinned).map((a) => a.item.id)).toEqual([
			"labels",
			"milestone",
			"parentIssue",
		]);
	});

	it("keeps a count as the word, and has no main action when nothing makes anything", () => {
		const [issues] = arrange<BarItem>([{ id: "makeIssues", text: "Make 6 issues" }]);
		expect(issues?.item).toMatchObject({ text: "Make 6 issues", quiet: false });
		expect(issues?.primary).toBe(true);
		const ai = arrange<BarItem>([{ id: "summarise" }, { id: "draftDecision" }]);
		expect(ai.every((a) => !a.primary && !a.pinned && a.item.quiet)).toBe(true);
	});

	it("words a section's facilitation", () => {
		const laid = arrange<BarItem>([
			{ id: "startSilent" },
			{ id: "startVote" },
			{ id: "makeInbox" },
		]);
		expect(laid.map((a) => [a.group, a.item.text])).toEqual([
			["facilitate", "Silent"],
			["facilitate", "Vote"],
			["facilitate", "Inbox"],
		]);
	});
});

describe("overflowing", () => {
	const section = arrange([
		{ id: "startSilent" },
		{ id: "startVote" },
		{ id: "makeInbox" },
		{ id: "parentIssue" },
		{ id: "groupThese" },
		{ id: "fitSection" },
		{ id: "summarise" },
		{ id: "draftDecision" },
	]);
	const items: Measured[] = section.map((a) => ({
		key: a.item.id,
		group: a.group,
		width: 80,
		pinned: a.pinned,
		rank: a.rank,
	}));
	// Colour and display (200), three rules (11 each), eight actions (640).
	const total = 200 + 3 * 11 + 640;
	const fit = (limit: number) =>
		overflowing({ total, limit, items, divider: 11, dividers: 3, more: 34 });

	it("hides nothing when it fits", () => {
		expect(fit(total).size).toBe(0);
	});

	it("hides the least important first, whole, with a group's rule when it's empty", () => {
		expect([...fit(total - 1)]).toEqual(["draftDecision"]);
		// Summarise too: the AI group goes, and its rule.
		expect([...fit(total - 100)]).toEqual(["draftDecision", "summarise"]);
		expect([...fit(total - 180)]).toEqual(["draftDecision", "summarise", "makeInbox"]);
	});

	it("never hides the main action, however narrow", () => {
		const hidden = fit(100);
		expect(hidden.has("parentIssue")).toBe(false);
		expect(hidden.size).toBe(7);
	});
});
