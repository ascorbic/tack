import { describe, expect, it } from "vite-plus/test";
import { stageTriage } from "../src/shared/actions.ts";
import type { Card } from "../src/shared/cards.ts";
import { listChanges } from "../src/shared/changes.ts";
import {
	formatTerm,
	matchSearch,
	matchesQuery,
	mentionsMe,
	parseSearch,
	planMatch,
	queryRepos,
	searchScope,
	unsupportedForRules,
} from "../src/shared/search.ts";
import * as Y from "yjs";

function card(overrides: Partial<Card> = {}): Card {
	return {
		key: "github.com/acme/widgets#12",
		forge: "github",
		host: "github.com",
		repo: "acme/widgets",
		item: "#12",
		kind: "issue",
		title: "Widgets wobble when spun",
		state: "open",
		stateReason: null,
		labels: [{ name: "docs", color: "0075ca" }],
		assignees: [{ login: "kai", avatarUrl: "" }],
		author: { login: "priya", avatarUrl: "" },
		comments: 3,
		reactions: 0,
		url: "https://github.com/acme/widgets/issues/12",
		updatedAt: "2026-10-01T00:00:00Z",
		visibility: "public",
		...overrides,
	};
}

describe("parseSearch", () => {
	it("reads qualifiers, negations, quotes and words", () => {
		const { terms } = parseSearch(
			'repo:acme/widgets is:open -label:wontfix label:"good first issue" flaky',
		);
		expect(terms.map(({ key, value, negated }) => ({ key, value, negated }))).toEqual([
			{ key: "repo", value: "acme/widgets", negated: false },
			{ key: "is", value: "open", negated: false },
			{ key: "label", value: "wontfix", negated: true },
			{ key: "label", value: "good first issue", negated: false },
			{ key: null, value: "flaky", negated: false },
		]);
	});

	it("writes terms back out, quoting where needed", () => {
		expect(formatTerm({ key: "label", value: "good first issue", negated: false })).toBe(
			'label:"good first issue"',
		);
		expect(formatTerm({ key: "label", value: "bug", negated: true })).toBe("-label:bug");
	});

	it("finds the repositories and owners a search is limited to", () => {
		expect(searchScope(parseSearch("repo:Acme/Widgets,acme/gears org:emdash -repo:x/y"))).toEqual({
			repos: ["acme/widgets", "acme/gears"],
			owners: ["emdash"],
		});
		expect(searchScope(parseSearch("is:open label:bug"))).toEqual({ repos: [], owners: [] });
	});

	it("notices @me", () => {
		expect(mentionsMe("is:open assignee:@me")).toBe(true);
		expect(mentionsMe("review-requested:@me")).toBe(true);
		expect(mentionsMe("label:@media")).toBe(false);
	});
});

describe("matchSearch", () => {
	it("says yes, no, or that it can't tell", () => {
		const c = card();
		expect(matchSearch(c, parseSearch("repo:acme/widgets is:open label:docs"))).toBe("yes");
		expect(matchSearch(c, parseSearch("repo:acme/widgets is:closed"))).toBe("no");
		expect(matchSearch(c, parseSearch("-label:docs"))).toBe("no");
		expect(matchSearch(c, parseSearch("wobble"))).toBe("yes");
		// Words not in the title might be in the body.
		expect(matchSearch(c, parseSearch("gyroscope"))).toBe("unknown");
		expect(matchSearch(c, parseSearch("assignee:@me"), { viewer: "kai" })).toBe("yes");
		expect(matchSearch(c, parseSearch("assignee:@me"))).toBe("no");
		expect(matchSearch(c, parseSearch("comments:>2 sort:updated-desc"))).toBe("yes");
		expect(matchSearch(c, parseSearch("label:bug,docs"))).toBe("yes");
	});
});

describe("matchSearch on dates, milestones and reviews", () => {
	const dated = card({
		createdAt: "2026-08-01T09:00:00Z",
		updatedAt: "2026-09-15T12:00:00Z",
		state: "closed",
		stateReason: "completed",
		closedAt: "2026-09-15T12:00:00Z",
	});
	const m = (q: string, c: Card = dated) => matchSearch(c, parseSearch(q));

	it("compares dates by day, with ranges and open ends", () => {
		expect(m("updated:<2026-09-16")).toBe("yes");
		expect(m("updated:<2026-09-15")).toBe("no");
		expect(m("updated:<=2026-09-15")).toBe("yes");
		expect(m("updated:2026-09-15")).toBe("yes");
		expect(m("updated:>2026-09-15")).toBe("no");
		expect(m("created:2026-07-01..2026-08-01")).toBe("yes");
		expect(m("created:*..2026-07-31")).toBe("no");
		expect(m("closed:>=2026-09-01")).toBe("yes");
		expect(m("closed:>=2026-09-01", card())).toBe("no");
		const merged = card({ kind: "pull", state: "merged", mergedAt: "2026-09-20T10:00:00Z" });
		expect(m("merged:2026-09-01..2026-09-30", merged)).toBe("yes");
		expect(m("merged:>2026-09-20", merged)).toBe("no");
		expect(m("merged:>2026-01-01", dated)).toBe("no");
		expect(m("created:>2026-01-01", card())).toBe("unknown");
		expect(m("updated:<soon")).toBe("unknown");
	});

	it("reads the card's milestone when it carries one", () => {
		const v1 = card({ milestone: { title: "v1", dueOn: null } });
		expect(m("milestone:v1", v1)).toBe("yes");
		expect(m("milestone:v2", v1)).toBe("no");
		expect(m("no:milestone", card({ milestone: null }))).toBe("yes");
		expect(m("milestone:v1", card())).toBe("unknown");
	});

	it("knows who's been asked to review, and the review decision", () => {
		const pull = card({
			kind: "pull",
			pull: {
				detail: "full",
				head: null,
				checks: null,
				review: "review_required",
				reviewers: [
					{ login: "kai", avatarUrl: "", state: "requested" },
					{ login: "core", avatarUrl: "", state: "requested" },
					{ login: "jo", avatarUrl: "", state: "approved" },
				],
				mergeable: "mergeable",
				linked: [],
			},
		});
		expect(matchSearch(pull, parseSearch("review-requested:@me"), { viewer: "kai" })).toBe("yes");
		expect(matchSearch(pull, parseSearch("review-requested:jo"))).toBe("no");
		expect(m("team-review-requested:acme/core", pull)).toBe("yes");
		expect(m("review:required", pull)).toBe("yes");
		expect(m("review:approved", pull)).toBe("no");
		expect(m("review-requested:kai")).toBe("no");
	});
});

// Rules and inbox frames read searches locally (#40, #44): everything from the card.
describe("matchesQuery", () => {
	const q = (text: string) => ({ host: "github.com", q: text });
	const plain = (overrides: Partial<Card> = {}) =>
		card({ title: "Widgets wobble on Tuesdays", labels: [], assignees: [], ...overrides });

	it("matches the triage example: open issues with no label", () => {
		const query = q("repo:acme/widgets is:issue is:open no:label");
		expect(matchesQuery(plain(), query)).toBe(true);
		expect(matchesQuery(plain({ labels: [{ name: "bug", color: "f00" }] }), query)).toBe(false);
		expect(matchesQuery(plain({ state: "closed" }), query)).toBe(false);
		expect(matchesQuery(plain({ kind: "pull" }), query)).toBe(false);
		expect(matchesQuery(plain({ repo: "acme/gears" }), query)).toBe(false);
	});

	it("reads labels as any of a comma list, and negation", () => {
		const bug = plain({ labels: [{ name: "Bug", color: "f00" }] });
		expect(matchesQuery(bug, q("label:bug,docs"))).toBe(true);
		expect(matchesQuery(bug, q("-label:bug"))).toBe(false);
		expect(matchesQuery(plain(), q("-label:bug"))).toBe(true);
	});

	it("decides words by the title alone", () => {
		expect(matchesQuery(plain(), q("wobble tuesdays"))).toBe(true);
		expect(matchesQuery(plain(), q("wobble -tuesdays"))).toBe(false);
		expect(matchesQuery(plain(), q('"on tuesdays"'))).toBe(true);
		expect(matchesQuery(plain(), q("gyroscope"))).toBe(false);
	});

	it("knows pull request states", () => {
		const draft = plain({ kind: "pull", state: "draft" });
		expect(matchesQuery(draft, q("is:pr is:open is:draft"))).toBe(true);
		expect(matchesQuery(plain({ kind: "pull", state: "merged" }), q("is:closed is:merged"))).toBe(
			true,
		);
	});

	it("says it can't tell rather than guessing", () => {
		expect(matchesQuery(plain(), q("milestone:v1"))).toBeNull();
		expect(matchesQuery(plain(), q("assignee:@me"))).toBeNull();
		expect(matchesQuery(plain({ author: null }), q("author:alice"))).toBeNull();
		// ...unless something it can tell already rules the card out.
		expect(matchesQuery(plain({ state: "closed" }), q("is:open milestone:v1"))).toBe(false);
		// ...or someone else it can tell is assigned.
		expect(
			matchesQuery(plain({ assignees: [{ login: "kai", avatarUrl: "" }] }), q("assignee:@me,kai")),
		).toBe(true);
	});

	it("never matches another forge", () => {
		expect(matchesQuery(plain(), { host: "fake.tack", q: "is:open" })).toBe(false);
	});

	it("lists the repositories a query searches", () => {
		expect(queryRepos(q("repo:Acme/Widgets repo:acme/gears -repo:acme/old is:open"))).toEqual([
			"github.com/acme/widgets",
			"github.com/acme/gears",
		]);
	});
});

describe("unsupportedForRules", () => {
	it("accepts what a card can answer, with a repository", () => {
		expect(unsupportedForRules("repo:acme/widgets is:issue label:bug")).toBeNull();
		expect(unsupportedForRules("repo:acme/widgets -label:wontfix flaky sort:updated")).toBeNull();
	});

	it("explains what it can't check", () => {
		expect(unsupportedForRules("repo:a/b milestone:v1")).toMatch(/milestone:v1/);
		expect(unsupportedForRules("repo:a/b assignee:@me")).toMatch(/@me/);
		expect(unsupportedForRules("is:issue")).toMatch(/repo:/);
		expect(unsupportedForRules("repo:a/b is:locked")).toMatch(/is:locked/);
		expect(unsupportedForRules("repo:a/b is:public")).toMatch(/is:public/);
	});
});

describe("planMatch", () => {
	it("stages labels, assignees, milestones and state", () => {
		const plan = planMatch(
			card({ state: "closed", stateReason: "completed" }),
			parseSearch(
				"repo:acme/widgets is:open label:bug -label:docs assignee:@me milestone:v1 sort:updated",
			),
			{ viewer: "Tom" },
		);
		expect(plan.status).toBe("changes");
		if (plan.status !== "changes") return;
		expect(plan.edits).toEqual([
			{ kind: "item.labels", add: ["bug"], remove: ["docs"] },
			{ kind: "item.assignees", add: ["Tom"] },
			{ kind: "item.milestone", milestone: "v1" },
			{ kind: "item.state", state: "open" },
		]);
		expect(plan.steps.map((step) => `${step.kind} ${step.label}`)).toEqual([
			"add-label bug",
			"remove-label docs",
			"assign @Tom",
			"milestone v1",
			"open Reopen",
		]);
	});

	it("says when a card already matches", () => {
		expect(planMatch(card(), parseSearch("repo:acme/widgets is:open label:docs"))).toEqual({
			status: "matches",
		});
	});

	it("clears with no:", () => {
		const plan = planMatch(card(), parseSearch("no:label no:assignee no:milestone"));
		expect(plan.status === "changes" && plan.edits).toEqual([
			{ kind: "item.labels", remove: ["docs"] },
			{ kind: "item.assignees", remove: ["kai"] },
			{ kind: "item.milestone", milestone: null },
		]);
	});

	it("closes with a reason", () => {
		const plan = planMatch(card(), parseSearch('is:closed reason:"not planned"'));
		expect(plan.status === "changes" && plan.edits).toEqual([
			{ kind: "item.state", state: "closed", reason: "not_planned" },
		]);
		expect(plan.status === "changes" && plan.steps[0]?.label).toBe("Close as not planned");
	});

	it("says why it can't, for text, other repositories, kinds and authors", () => {
		const plan = planMatch(
			card(),
			parseSearch("repo:acme/gears is:pr author:sam flaky review-requested:@me"),
		);
		expect(plan.status).toBe("impossible");
		if (plan.status !== "impossible") return;
		expect(plan.reasons).toHaveLength(5);
		expect(plan.reasons[0]).toContain("only shows acme/gears");
		expect(plan.reasons[1]).toContain("only shows pull requests");
		expect(plan.reasons[2]).toContain("opened by sam");
		expect(plan.reasons[3]).toContain("“flaky”");
		expect(plan.reasons[4]).toContain("review-requested:@me");
	});

	it("can't reopen a merged pull request, or assign @me signed out", () => {
		const merged = planMatch(card({ kind: "pull", state: "merged" }), parseSearch("is:open"));
		expect(merged.status === "impossible" && merged.reasons[0]).toContain("merged");
		const signedOut = planMatch(card(), parseSearch("assignee:@me"));
		expect(signedOut.status === "impossible" && signedOut.reasons[0]).toContain("sign in");
	});

	it("can't match a card on another forge", () => {
		const plan = planMatch(card(), parseSearch("is:open"), { host: "fake.tack" });
		expect(plan.status).toBe("impossible");
	});

	it("stages through the triage actions, one change per kind", () => {
		const doc = new Y.Doc();
		const plan = planMatch(card(), parseSearch("label:bug milestone:v2"));
		if (plan.status !== "changes") throw new Error("expected changes");
		for (const edit of plan.edits) {
			stageTriage(doc, [{ key: card().key, current: ["docs"] }], edit, { name: "Tom" });
		}
		expect(listChanges(doc).map((change) => change.op)).toEqual([
			{ kind: "item.labels", target: { key: card().key }, add: ["bug"] },
			{ kind: "item.milestone", target: { key: card().key }, milestone: "v2" },
		]);
	});
});
