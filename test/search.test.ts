import { describe, expect, it } from "vite-plus/test";
import { stageTriage } from "../src/shared/actions.ts";
import type { Card } from "../src/shared/cards.ts";
import { listChanges } from "../src/shared/changes.ts";
import {
	formatTerm,
	matchSearch,
	mentionsMe,
	parseSearch,
	planMatch,
	searchScope,
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
