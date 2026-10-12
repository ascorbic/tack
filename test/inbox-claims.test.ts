import { describe, expect, it } from "vite-plus/test";
import { trayClaims } from "../src/shared/inbox.ts";
import { inboxSuggestions, labelNamed } from "../src/shared/widgetRegistry.ts";

describe("trayClaims", () => {
	it("puts an item two inboxes match in the narrower one's tray only", () => {
		const claims = trayClaims([
			{ id: "triage", total: 40, keys: ["a", "b", "c"] },
			{ id: "docs", total: 6, keys: ["b", "d"] },
		]);
		expect(Object.fromEntries(claims)).toEqual({ a: "triage", b: "docs", c: "triage", d: "docs" });
	});

	it("breaks ties by section id, so everyone sees the same trays", () => {
		const one = trayClaims([
			{ id: "z", total: 5, keys: ["a"] },
			{ id: "m", total: 5, keys: ["a"] },
		]);
		const other = trayClaims([
			{ id: "m", total: 5, keys: ["a"] },
			{ id: "z", total: 5, keys: ["a"] },
		]);
		expect(one.get("a")).toBe("m");
		expect(other.get("a")).toBe("m");
	});

	it("lets an item dismissed from one inbox wait in another", () => {
		// Dismissed from docs: not among its candidates, so triage has it.
		const claims = trayClaims([
			{ id: "triage", total: 40, keys: ["b"] },
			{ id: "docs", total: 6, keys: [] },
		]);
		expect(claims.get("b")).toBe("triage");
	});
});

describe("inbox starting points", () => {
	it("leads with the section's name as a label, when the repository has it", () => {
		const labels = ["bug", "docs", "good first issue"];
		expect(inboxSuggestions("acme/app", "Docs", labels)[0]).toEqual({
			label: "Labelled docs",
			q: "repo:acme/app is:open label:docs",
		});
		// Plural titles find singular labels, and labels with spaces are quoted.
		expect(labelNamed("Bugs", labels)).toBe("bug");
		expect(labelNamed("Good first issues", labels)).toBe("good first issue");
		// When a ready-made search is already that label, it keeps its name and place.
		expect(inboxSuggestions("acme/app", "Bugs", labels).map((s) => s.label)).toEqual([
			"Open bugs",
			"Needs triage",
			"Open pull requests",
			"Good first issues",
			"Unanswered questions",
		]);
		expect(inboxSuggestions("acme/app", "Help wanted", ["help wanted"])[0]?.q).toBe(
			'repo:acme/app is:open label:"help wanted"',
		);
	});

	it("uses the same ready-made searches as lists, under the same names", () => {
		const names = inboxSuggestions("acme/app", "Later", ["bug"]).map((s) => s.label);
		expect(names).toEqual([
			"Open bugs",
			"Needs triage",
			"Open pull requests",
			"Good first issues",
			"Unanswered questions",
		]);
	});
});
