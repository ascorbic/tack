import { describe, expect, it } from "vite-plus/test";
import { normaliseGqlPull } from "../src/server/forges/github-graphql.ts";
import { normaliseIssue } from "../src/server/forges/github.ts";

type GqlPull = Parameters<typeof normaliseGqlPull>[0];

function pull(overrides: Partial<GqlPull> = {}): GqlPull {
	return {
		__typename: "PullRequest",
		id: "PR_1",
		number: 12,
		title: "Faster widgets",
		url: "https://github.com/Acme/Widgets/pull/12",
		updatedAt: "2026-10-01T00:00:00Z",
		repository: { nameWithOwner: "Acme/Widgets" },
		author: null,
		labels: { nodes: [] },
		assignees: { nodes: [] },
		comments: { totalCount: 0 },
		reactions: { totalCount: 0 },
		pullState: "OPEN",
		isDraft: false,
		mergeable: "CONFLICTING",
		reviewDecision: null,
		headRefOid: "abc",
		latestReviews: { nodes: [] },
		reviewRequests: { nodes: [] },
		closingIssuesReferences: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
		...overrides,
	};
}

describe("GitHub pull requests over GraphQL", () => {
	it("keeps when they were opened, closed and merged", () => {
		const card = normaliseGqlPull(
			pull({
				pullState: "MERGED",
				createdAt: "2026-09-01T00:00:00Z",
				closedAt: "2026-09-03T00:00:00Z",
				mergedAt: "2026-09-03T00:00:00Z",
			}),
		);
		expect(card).toMatchObject({
			state: "merged",
			createdAt: "2026-09-01T00:00:00Z",
			closedAt: "2026-09-03T00:00:00Z",
			mergedAt: "2026-09-03T00:00:00Z",
		});
		// Older payloads without them read as before.
		expect("createdAt" in normaliseGqlPull(pull())).toBe(false);
	});

	it("rolls up check runs and commit statuses", () => {
		const card = normaliseGqlPull(
			pull({
				commits: {
					nodes: [
						{
							commit: {
								statusCheckRollup: {
									state: "FAILURE",
									contexts: {
										checkRunCountsByState: [
											{ state: "SUCCESS", count: 9 },
											{ state: "FAILURE", count: 1 },
											{ state: "TIMED_OUT", count: 1 },
											{ state: "IN_PROGRESS", count: 2 },
											{ state: "SKIPPED", count: 3 },
										],
										statusContextCountsByState: [
											{ state: "ERROR", count: 1 },
											{ state: "PENDING", count: 1 },
										],
										nodes: [
											{
												__typename: "CheckRun",
												name: "test (20)",
												status: "COMPLETED",
												conclusion: "FAILURE",
												detailsUrl: "https://ci/1",
											},
											{
												__typename: "CheckRun",
												name: "build",
												status: "COMPLETED",
												conclusion: "SUCCESS",
												detailsUrl: null,
											},
											{
												__typename: "CheckRun",
												name: "e2e",
												status: "COMPLETED",
												conclusion: "TIMED_OUT",
												detailsUrl: null,
											},
											{
												__typename: "StatusContext",
												context: "ci/netlify",
												state: "ERROR",
												targetUrl: "https://netlify/1",
											},
										],
									},
								},
							},
						},
					],
				},
			}),
		);
		expect(card).toMatchObject({ key: "github.com/acme/widgets#12", repo: "acme/widgets" });
		expect(card.pull?.checks).toEqual({
			state: "failing",
			passed: 9,
			failed: 3,
			pending: 3,
			skipped: 3,
			failing: [
				{ name: "test (20)", url: "https://ci/1" },
				{ name: "e2e", url: null },
				{ name: "ci/netlify", url: "https://netlify/1" },
			],
		});
		expect(card.pull?.mergeable).toBe("conflicting");
	});

	it("says there are no checks, rather than that they're unknown", () => {
		expect(normaliseGqlPull(pull()).pull?.checks).toMatchObject({ state: "none", passed: 0 });
	});

	it("orders reviewers by whose move it is, and re-requests win", () => {
		const avatar = (login: string) => `https://avatars/${login}`;
		const card = normaliseGqlPull(
			pull({
				reviewDecision: "CHANGES_REQUESTED",
				latestReviews: {
					nodes: [
						{ state: "COMMENTED", author: { login: "jo", avatarUrl: avatar("jo") } },
						{ state: "APPROVED", author: { login: "kai", avatarUrl: avatar("kai") } },
						{ state: "CHANGES_REQUESTED", author: { login: "tom", avatarUrl: avatar("tom") } },
						{ state: "APPROVED", author: { login: "priya", avatarUrl: avatar("priya") } },
					],
				},
				reviewRequests: {
					nodes: [
						{ requestedReviewer: { login: "priya", avatarUrl: avatar("priya") } },
						{ requestedReviewer: { login: "docs-team", teamAvatarUrl: null } },
					],
				},
			}),
		);
		expect(card.pull?.review).toBe("changes_requested");
		expect(card.pull?.reviewers.map((r) => `${r.login}:${r.state}`)).toEqual([
			"tom:changes_requested",
			"kai:approved",
			"priya:requested",
			"docs-team:requested",
			"jo:commented",
		]);
	});

	it("links the issues a pull request closes, across repositories", () => {
		const card = normaliseGqlPull(
			pull({
				pullState: "MERGED",
				closingIssuesReferences: {
					nodes: [
						{
							number: 3,
							title: "Widgets are slow",
							url: "https://github.com/acme/other/issues/3",
							issueState: "CLOSED",
							repository: { nameWithOwner: "Acme/Other" },
						},
					],
				},
			}),
		);
		expect(card.state).toBe("merged");
		expect(card.pull?.linked).toEqual([
			{
				key: "github.com/acme/other#3",
				item: "#3",
				repo: "acme/other",
				title: "Widgets are slow",
				state: "closed",
				url: "https://github.com/acme/other/issues/3",
			},
		]);
	});
});

describe("GitHub pull requests over REST", () => {
	it("have basic details, and the current repository name", () => {
		const card = normaliseIssue(
			"acme/old-name",
			{
				number: 5,
				title: "t",
				state: "open",
				html_url: "https://github.com/acme/new-name/pull/5",
				repository_url: "https://api.github.com/repos/Acme/New-Name",
				updated_at: "2026-01-01T00:00:00Z",
				head: { sha: "def" },
				mergeable: null,
				requested_reviewers: [{ login: "kai", avatar_url: "https://avatars/kai" }],
			},
			true,
		);
		expect(card).toMatchObject({ key: "github.com/acme/new-name#5", repo: "acme/new-name" });
		expect(card.pull).toEqual({
			detail: "basic",
			head: "def",
			checks: null,
			review: null,
			reviewers: [{ login: "kai", avatarUrl: "https://avatars/kai", state: "requested" }],
			mergeable: "unknown",
			linked: [],
		});
	});
});

describe("👍 reactions, which dot votes count", () => {
	it("say who reacted over GraphQL", () => {
		const card = normaliseGqlPull(
			pull({
				thumbsUp: {
					totalCount: 3,
					nodes: [{ user: { login: "Priya" } }, { user: null }, { user: { login: "kai" } }],
				},
			}),
		);
		expect(card.thumbsUp).toEqual({ count: 3, logins: ["priya", "kai"] });
		expect(normaliseGqlPull(pull()).thumbsUp).toBeUndefined();
	});

	it("only count over REST and in webhooks", () => {
		const card = normaliseIssue("acme/widgets", {
			number: 5,
			title: "t",
			state: "open",
			html_url: "https://github.com/acme/widgets/issues/5",
			updated_at: "2026-01-01T00:00:00Z",
			reactions: { total_count: 4, "+1": 3 },
		});
		expect(card.thumbsUp).toEqual({ count: 3 });
	});
});
