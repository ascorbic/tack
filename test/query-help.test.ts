import { describe, expect, it } from "vite-plus/test";
import { mightMiss, plainSearchError, rescueQuery } from "../src/shared/queryHelp.ts";
import { withLogin } from "../src/shared/search.ts";
import { listPresets } from "../src/shared/widgetRegistry.ts";

// Searches written by people who don't speak GitHub's syntax (the review's
// "bugs in unpic"), and lists that mean the same to everyone.

const board = {
	repo: "acme/unpic",
	labels: ["bug", "docs", "good first issue", "enhancement", "provider"],
};

describe("rescueQuery", () => {
	it("reads the review's plain-language search as it was meant", () => {
		expect(rescueQuery("bugs in unpic", board)).toEqual({
			q: "repo:acme/unpic label:bug",
			changes: ["“bugs” as the bug label", "only in acme/unpic"],
			scopeOnly: false,
		});
	});

	it("turns kinds and states into qualifiers, and finds labels of several words", () => {
		expect(rescueQuery("open good first issues", board)?.q).toBe(
			'repo:acme/unpic is:open label:"good first issue"',
		);
		expect(rescueQuery("closed prs", board)?.q).toBe("repo:acme/unpic is:closed is:pr");
	});

	it("keeps words it doesn't understand as words", () => {
		expect(rescueQuery("flaky docs", board)?.q).toBe("repo:acme/unpic flaky label:docs");
	});

	it("only limits an unscoped search to the board's repository when that's all it can say", () => {
		expect(rescueQuery("is:open assignee:@me", board)).toEqual({
			q: "repo:acme/unpic is:open assignee:@me",
			changes: ["only in acme/unpic"],
			scopeOnly: true,
		});
	});

	it("has nothing to say about a search that's scoped and in qualifiers", () => {
		expect(rescueQuery("repo:acme/unpic is:open label:bug", board)).toBeNull();
		// Scoped, with words it doesn't know: words are what was asked for.
		expect(rescueQuery("repo:acme/unpic flaky test", board)).toBeNull();
		expect(rescueQuery("", board)).toBeNull();
	});

	it("leaves labels alone without the repository's labels, but still scopes", () => {
		expect(rescueQuery("bugs in unpic", { repo: "acme/unpic" })?.q).toBe("repo:acme/unpic bugs");
		expect(rescueQuery("bugs", {})).toBeNull();
	});
});

describe("mightMiss", () => {
	it("is true for words, and for searches of everywhere", () => {
		expect(mightMiss("bugs in unpic")).toBe(true);
		expect(mightMiss("is:open label:bug")).toBe(true);
		expect(mightMiss("repo:acme/unpic is:open label:bug")).toBe(false);
		expect(mightMiss("org:acme is:open")).toBe(false);
	});
});

describe("@me on a shared board", () => {
	it("names whoever's adding a ready-made list, so everyone sees the same one", () => {
		expect(withLogin("is:open assignee:@me", "alice")).toBe("is:open assignee:alice");
		expect(withLogin("review-requested:@me -author:@me", "alice")).toBe(
			"review-requested:alice -author:alice",
		);
		const presets = listPresets("acme/unpic", "alice");
		expect(presets.find((p) => p.label === "Assigned to me")).toEqual({
			label: "Assigned to me",
			title: "Assigned to alice",
			q: "is:open assignee:alice",
		});
		expect(presets.find((p) => p.label === "My review queue")?.title).toBe("alice's review queue");
	});

	it("keeps @me signed out, and leaves out repository presets without one", () => {
		const presets = listPresets(null, null);
		expect(presets.map((p) => p.q)).toEqual([
			"is:open assignee:@me",
			"is:pr is:open review-requested:@me",
		]);
	});
});

describe("plainSearchError", () => {
	const github =
		"The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.";

	it("names the repository GitHub couldn't see", () => {
		expect(plainSearchError(github, "repo:acme/unpic is:open")).toBe(
			"Can't see acme/unpic: it doesn't exist, or it's private to you. Check the spelling, or sign in as someone who can read it.",
		);
		expect(plainSearchError(github, "repo:acme/a org:emdash")).toMatch(
			/^Can't see acme\/a or emdash: one doesn't exist/,
		);
	});

	it("passes anything else through as it came", () => {
		expect(plainSearchError("Something else went wrong.", "repo:a/b")).toBe(
			"Something else went wrong.",
		);
	});
});
