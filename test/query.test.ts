import { describe, expect, it } from "vite-plus/test";
import { mentionsIn } from "../src/shared/mentions.ts";
import { matchesQuery, parseQuery, queryRepos, unsupportedForRules } from "../src/shared/query.ts";
import { card } from "./card-fixture.ts";

const q = (text: string) => ({ host: "github.com", q: text });

describe("parseQuery", () => {
	it("reads qualifiers, quoted values, negation and words", () => {
		const parsed = parseQuery(
			'repo:acme/widgets -label:"good first issue" is:open wobble sort:created',
		);
		expect(parsed.terms).toEqual([
			{ key: "repo", values: ["acme/widgets"], negated: false },
			{ key: "label", values: ["good first issue"], negated: true },
			{ key: "is", values: ["open"], negated: false },
		]);
		expect(parsed.words).toEqual(["wobble"]);
		expect(parsed.unsupported).toEqual([]);
	});

	it("keeps qualifiers it doesn't know aside", () => {
		expect(parseQuery("milestone:v1 repo:a/b").unsupported).toEqual(["milestone:v1"]);
	});

	it("lists the repositories a query searches", () => {
		expect(queryRepos(q("repo:Acme/Widgets repo:acme/gears -repo:acme/old is:open"))).toEqual([
			"github.com/acme/widgets",
			"github.com/acme/gears",
		]);
	});
});

describe("matchesQuery", () => {
	it("matches the triage example: open issues with no label", () => {
		const query = q("repo:acme/widgets is:issue is:open no:label");
		expect(matchesQuery(card(), query)).toBe(true);
		expect(matchesQuery(card({ labels: [{ name: "bug", color: "f00" }] }), query)).toBe(false);
		expect(matchesQuery(card({ state: "closed" }), query)).toBe(false);
		expect(matchesQuery(card({ kind: "pull" }), query)).toBe(false);
		expect(matchesQuery(card({ repo: "acme/gears" }), query)).toBe(false);
	});

	it("reads labels as any of a comma list, and negation", () => {
		const bug = card({ labels: [{ name: "Bug", color: "f00" }] });
		expect(matchesQuery(bug, q("label:bug,docs"))).toBe(true);
		expect(matchesQuery(bug, q("-label:bug"))).toBe(false);
		expect(matchesQuery(card(), q("-label:bug"))).toBe(true);
	});

	it("matches words against the title", () => {
		expect(matchesQuery(card(), q("wobble tuesdays"))).toBe(true);
		expect(matchesQuery(card(), q("wobble -tuesdays"))).toBe(false);
		expect(matchesQuery(card(), q('"on tuesdays"'))).toBe(true);
	});

	it("knows pull request states", () => {
		const draft = card({ kind: "pull", state: "draft" });
		expect(matchesQuery(draft, q("is:pr is:open is:draft"))).toBe(true);
		expect(matchesQuery(card({ kind: "pull", state: "merged" }), q("is:closed is:merged"))).toBe(
			true,
		);
	});

	it("says it can't tell rather than guessing", () => {
		expect(matchesQuery(card(), q("milestone:v1"))).toBeNull();
		expect(matchesQuery(card(), q("assignee:@me"))).toBeNull();
		// ...unless something it can tell already rules the card out.
		expect(matchesQuery(card({ state: "closed" }), q("is:open milestone:v1"))).toBe(false);
	});

	it("never matches another forge", () => {
		expect(matchesQuery(card(), { host: "fake.tack", q: "is:open" })).toBe(false);
	});
});

describe("unsupportedForRules", () => {
	it("accepts what a card can answer, with a repository", () => {
		expect(unsupportedForRules("repo:acme/widgets is:issue label:bug")).toBeNull();
	});

	it("explains what it can't check", () => {
		expect(unsupportedForRules("repo:a/b milestone:v1")).toMatch(/milestone:v1/);
		expect(unsupportedForRules("repo:a/b assignee:@me")).toMatch(/@me/);
		expect(unsupportedForRules("is:issue")).toMatch(/repo:/);
		expect(unsupportedForRules("repo:a/b is:locked")).toMatch(/is:locked/);
	});
});

describe("mentionsIn", () => {
	const at = { host: "github.com", repo: "acme/widgets", self: "github.com/acme/widgets#40" };

	it("finds bare, cross-repository and linked references, once each", () => {
		expect(
			mentionsIn(
				"See #12 and acme/gears#3, also https://github.com/Acme/Other/issues/9 and #12 again",
				at,
			),
		).toEqual([
			{ key: "github.com/acme/widgets#12", closes: false },
			{ key: "github.com/acme/gears#3", closes: false },
			{ key: "github.com/acme/other#9", closes: false },
		]);
	});

	it("knows closing keywords, which win over a plain mention", () => {
		expect(mentionsIn("Relates to #12.\n\nFixes: #12, closes acme/gears#3", at)).toEqual([
			{ key: "github.com/acme/widgets#12", closes: true },
			{ key: "github.com/acme/gears#3", closes: true },
		]);
	});

	it("ignores code, itself, and things that only look like references", () => {
		expect(mentionsIn("`#12` ```\nfixes #13\n``` #40 abc#14 color: #fff", at)).toEqual([]);
	});
});
