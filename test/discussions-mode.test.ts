// A list's Discussions mode: its controls read from and written into the
// search (both ways, leaving the rest as written), ordering by upvotes
// (GitHub's `sort:top`, put right by the upvotes each result carries),
// answered and unanswered as GitHub reads them, the ready-made lists that
// fit a repository's categories, and the categories themselves, read once
// and kept by the repository's `Repo` object.

import type { Miniflare } from "miniflare";
import type { Request } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Card } from "../src/shared/cards.ts";
import {
	NO_FILTERS,
	answersApply,
	isDiscussionSearch,
	readDiscussionFilters,
	toDiscussionSearch,
	toIssueSearch,
	writeDiscussionFilters,
} from "../src/shared/discussionFilters.ts";
import type { RepoDiscussionCategory } from "../src/shared/push.ts";
import { matchSearch, parseSearch, searchSort, sortResults } from "../src/shared/search.ts";
import { listPresets, presetConfig } from "../src/shared/widgetRegistry.ts";
import { fake, fakeCard } from "../src/server/forges/fake.ts";
import { searchGitHub, searchText } from "../src/server/forges/github-search.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import { sign } from "../src/server/forges/hmac.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { startWorker } from "./harness.ts";

const REPO = "acme/unpic";
const T0 = "2026-10-01T00:00:00Z";

describe("the controls and the search", () => {
	it("reads what the controls show from a search", () => {
		expect(
			readDiscussionFilters(
				'repo:acme/unpic is:discussion category:"Q&A" is:open is:unanswered label:docs label:"good first issue"',
			),
		).toEqual({
			repo: "acme/unpic",
			category: "Q&A",
			answered: "unanswered",
			state: "open",
			labels: ["docs", "good first issue"],
		});
		// Nothing said is everything.
		expect(readDiscussionFilters("is:discussion")).toEqual(NO_FILTERS);
		// The first of each, as GitHub would; negations and lists aren't a control's.
		expect(
			readDiscussionFilters(
				"is:discussion state:closed is:open -category:Polls label:a,b -label:c",
			),
		).toMatchObject({ state: "closed", category: null, labels: [] });
	});

	it("writes them back where they stand, leaving everything else as written", () => {
		const q = "repo:acme/unpic is:discussion plugin author:kai category:Ideas -label:wontfix";
		const filters = readDiscussionFilters(q);
		// Unchanged controls give the same search back.
		expect(writeDiscussionFilters(q, filters)).toBe(q);
		// A category is replaced in place, quoted when it must be.
		expect(writeDiscussionFilters(q, { ...filters, category: "Show and tell" })).toBe(
			'repo:acme/unpic is:discussion plugin author:kai category:"Show and tell" -label:wontfix',
		);
		// Set to everything, it goes; new ones join the end.
		expect(
			writeDiscussionFilters(q, {
				...filters,
				category: null,
				state: "open",
				answered: "answered",
				labels: ["docs"],
			}),
		).toBe(
			"repo:acme/unpic is:discussion plugin author:kai -label:wontfix is:open is:answered label:docs",
		);
		// The repository and is:discussion lead when they're missing.
		expect(writeDiscussionFilters("is:open", { ...NO_FILTERS, repo: REPO, state: "open" })).toBe(
			"repo:acme/unpic is:discussion is:open",
		);
	});

	it("round-trips: what's written reads back as the controls that wrote it", () => {
		const cases = [
			{ ...NO_FILTERS, repo: REPO },
			{ repo: REPO, category: "Q&A", answered: "unanswered", state: "open", labels: ["docs"] },
			{ repo: REPO, category: "Show and tell", answered: "any", state: "closed", labels: [] },
			{ repo: null, category: "Ideas", answered: "answered", state: "all", labels: ["a", "b c"] },
		] as const;
		for (const filters of cases) {
			const q = writeDiscussionFilters("", { ...filters, labels: [...filters.labels] });
			expect(isDiscussionSearch(q)).toBe(true);
			expect(readDiscussionFilters(q)).toEqual(filters);
			// And again, unchanged.
			expect(writeDiscussionFilters(q, readDiscussionFilters(q))).toBe(q);
		}
	});

	it("switches a search between issues and discussions, keeping what both understand", () => {
		expect(
			toDiscussionSearch("repo:acme/unpic is:issue is:open label:bug assignee:kai flaky"),
		).toBe("repo:acme/unpic is:discussion is:open label:bug flaky");
		// The board's repository, when the search names none.
		expect(toDiscussionSearch("is:open", REPO)).toBe("repo:acme/unpic is:discussion is:open");
		expect(
			toIssueSearch('repo:acme/unpic is:discussion category:"Q&A" is:unanswered is:open'),
		).toBe("repo:acme/unpic is:open");
	});
});

const discussion = (
	n: number,
	upvotes: number,
	category = { name: "Ideas", emoji: "💡", answerable: false },
	answered = false,
): Card => ({
	...fakeCard(REPO, 90_000 + n),
	discussion: { category, answered, upvotes, locked: false },
});

describe("answered and unanswered", () => {
	const qa = { name: "Q&A", emoji: "🙏", answerable: true };
	const parsed = (q: string) => parseSearch(`is:discussion ${q}`);

	it("only finds unanswered discussions in categories that take answers, as GitHub does", () => {
		expect(matchSearch(discussion(1, 0, qa), parsed("is:unanswered"))).toBe("yes");
		expect(matchSearch(discussion(2, 0, qa, true), parsed("is:unanswered"))).toBe("no");
		expect(matchSearch(discussion(3, 0), parsed("is:unanswered"))).toBe("no");
		expect(matchSearch(discussion(2, 0, qa, true), parsed("is:answered"))).toBe("yes");
	});

	it("offers the filter only where an answer can be chosen", () => {
		const categories: RepoDiscussionCategory[] = [
			{ name: "Ideas", emoji: "💡", answerable: false },
			qa,
		];
		expect(answersApply(categories, "Q&A")).toBe(true);
		expect(answersApply(categories, "ideas")).toBe(false);
		// Every category: if any one takes answers.
		expect(answersApply(categories, null)).toBe(true);
		expect(answersApply([categories[0]!], null)).toBe(false);
		// Not known yet, or not one of the repository's: it may.
		expect(answersApply(null, "Q&A")).toBe(true);
		expect(answersApply(categories, "Polls")).toBe(true);
	});
});

describe("the most upvoted first", () => {
	it("sorts by upvotes, ties as they came, and reads a sort: in the search first", () => {
		const cards = [discussion(1, 3), discussion(2, 9), discussion(3, 3), discussion(4, 12)];
		const items = (q: string, sort?: "top" | "created") =>
			sortResults(cards, { q, sort }).map((card) => card.item);
		expect(items("is:discussion", "top")).toEqual(["#90004", "#90002", "#90001", "#90003"]);
		expect(items("is:discussion sort:top-asc")).toEqual(["#90001", "#90003", "#90002", "#90004"]);
		// No order at all leaves them be.
		expect(items("is:discussion")).toEqual(["#90001", "#90002", "#90003", "#90004"]);
	});

	it("is GitHub's sort:top for discussions, and most reactions for issues", () => {
		const query = (q: string) => ({
			kind: "search" as const,
			host: "github.com",
			q,
			sort: "top" as const,
		});
		expect(searchSort(query("repo:acme/unpic is:discussion"))).toBe("top");
		expect(searchText(query("repo:acme/unpic is:discussion"))).toBe(
			"repo:acme/unpic is:discussion sort:top-desc",
		);
		expect(searchText(query("repo:acme/unpic is:issue"))).toBe(
			"repo:acme/unpic is:issue sort:reactions-desc",
		);
	});

	it("on the test forge, as on GitHub", async () => {
		const result = await fake.search!(
			{ kind: "search", host: "fake.tack", q: `repo:${REPO} is:discussion`, sort: "top" },
			{} as Env,
		);
		const upvotes = result.kind === "search" ? result.items.map((c) => c.discussion?.upvotes) : [];
		expect(upvotes.length).toBeGreaterThan(3);
		expect(upvotes).toEqual([...upvotes].sort((a, b) => (b ?? 0) - (a ?? 0)));
		const categories = await fake.discussionCategories!({} as never, {} as Env);
		expect(categories.map((c) => c.name)).toContain("Ideas");
		expect(categories.find((c) => c.name === "Q&A")?.answerable).toBe(true);
	});

	describe("against GitHub", () => {
		const ALICE: FakeUser = { id: 1, login: "alice", name: "Alice", avatar_url: "" };
		let github: FakeGitHub;

		beforeEach(() => {
			github = new FakeGitHub();
			github.addRepo(1, REPO, { writers: ["alice"], discussionCategories: ["Ideas", "Q&A"] });
			// The search index is behind: #12 got votes it doesn't know about yet.
			github.addDiscussion(1, 10, { title: "Ten", category: "Ideas", upvotes: 10, updatedAt: T0 });
			github.addDiscussion(1, 11, {
				title: "Eleven",
				category: "Ideas",
				upvotes: 4,
				updatedAt: T0,
			});
			github.addDiscussion(1, 12, {
				title: "Twelve",
				category: "Ideas",
				upvotes: 30,
				indexedUpvotes: 2,
				updatedAt: T0,
			});
			github.addDiscussion(1, 13, {
				title: "A question",
				category: "Q&A",
				upvotes: 50,
				updatedAt: T0,
			});
			vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
				github.fetch(new globalThis.Request(input, init) as unknown as Request),
			);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			gate.clear();
		});

		it("asks for sort:top, and orders what comes back by the upvotes it has now", async () => {
			const result = await searchGitHub(
				{
					kind: "search",
					host: "github.com",
					q: `repo:${REPO} is:discussion category:Ideas`,
					sort: "top",
					limit: 2,
				},
				{} as Env,
				{ token: github.userTokenFor(ALICE) },
			);
			expect(result.kind === "search" && result.items.map((card) => card.item)).toEqual([
				"#12",
				"#10",
			]);
			const search = github.requests.find((r) => r.operation === "TackSearch");
			// A few more than shown, so one that climbed past the page's end still shows.
			expect(search?.variables).toMatchObject({
				q: `repo:${REPO} category:Ideas sort:top-desc`,
				first: 22,
			});
		});
	});
});

describe("ready-made discussion lists", () => {
	const ideas = { name: "Ideas", emoji: "💡", answerable: false };
	const qa = { name: "Q&A", emoji: "🙏", answerable: true };
	const announcements = { name: "Announcements", emoji: "📣", answerable: false };
	const labels = (categories?: RepoDiscussionCategory[] | null) =>
		listPresets(REPO, null, { categories }).map((preset) => preset.label);

	it("fit the categories the repository has, and assume none they don't", () => {
		const all = listPresets(REPO, null, { categories: [ideas, qa, announcements] });
		expect(all.find((p) => p.label === "Top ideas")).toEqual({
			label: "Top ideas",
			title: "Top ideas",
			q: "repo:acme/unpic is:discussion is:open category:Ideas",
			sort: "top",
		});
		expect(all.find((p) => p.label === "Recent announcements")).toMatchObject({
			q: "repo:acme/unpic is:discussion category:Announcements",
			sort: "created",
		});
		// No ideas or announcements: the most upvoted of any category.
		expect(labels([qa])).toContain("Top discussions");
		expect(labels([qa])).not.toContain("Recent announcements");
		// Nothing takes answers: nothing's unanswered.
		expect(labels([ideas])).not.toContain("Unanswered questions");
		// Unknown: only what assumes no names.
		expect(labels(null)).toEqual(
			expect.arrayContaining(["Unanswered questions", "Top discussions"]),
		);
		// No discussions at all.
		expect(labels([]).some((label) => /discussions|questions|ideas/i.test(label))).toBe(false);
	});

	it("set the list's order too, and inboxes leave out those that are only an order", () => {
		const top = listPresets(REPO, null, { categories: [ideas] }).find((p) => p.sort === "top");
		expect(presetConfig(top!, { title: "" })).toMatchObject({ sort: "top", title: "Top ideas" });
		expect(presetConfig(top!, { title: "Ours" }).title).toBe("Ours");
		const inbox = listPresets(REPO, null, { categories: [ideas], ordered: false });
		expect(inbox.some((p) => p.sort === "top")).toBe(false);
	});
});

describe("a repository's categories, kept by its Repo", () => {
	const ID = 42;
	const REPOSITORY = { id: ID, node_id: `R_${ID}`, full_name: REPO };
	let github: FakeGitHub;
	let mf: Miniflare;

	beforeEach(() => {
		github = new FakeGitHub();
		github.addRepo(ID, REPO, { discussionCategories: ["Announcements", "Ideas", "Q&A"] });
		github.addDiscussion(ID, 41, { title: "An idea", category: "Ideas", updatedAt: T0 });
		mf = startWorker({ outboundService: github.fetch, bindings: { GITHUB_TOKEN: "test-token" } });
	});

	afterEach(async () => {
		await mf.dispose();
	});

	const categories = async () => {
		const response = await mf.dispatchFetch(
			`https://example.com/api/repos/categories?repo=github.com/${REPO}`,
		);
		expect(response.status).toBe(200);
		return ((await response.json()) as { categories: RepoDiscussionCategory[] }).categories;
	};
	const reads = () =>
		github.requests.filter((r) => r.operation === "TackDiscussionCategoryList").length;

	it("reads them once, with their emoji and whether they take answers", async () => {
		expect(await categories()).toEqual([
			{
				name: "Announcements",
				emoji: "📣",
				answerable: false,
				description: "All about Announcements",
			},
			{ name: "Ideas", emoji: "💡", answerable: false, description: "All about Ideas" },
			{ name: "Q&A", emoji: "🙏", answerable: true, description: "All about Q&A" },
		]);
		await categories();
		await categories();
		expect(reads()).toBe(1);
	});

	it("reads them again once a delivery names one it doesn't know", async () => {
		await categories();
		// Someone added a category on GitHub, and a discussion in it.
		github.addDiscussionCategory(ID, "Polls");
		const d = github.discussion(ID, 41)!;
		d.category = "Polls";
		const body = JSON.stringify({
			repository: REPOSITORY,
			...github.discussionEvent(ID, 41, "category_changed"),
		});
		const delivered = await mf.dispatchFetch("https://example.com/webhooks/github", {
			method: "POST",
			body,
			headers: {
				"x-github-event": "discussion",
				"x-github-delivery": crypto.randomUUID(),
				"x-hub-signature-256": await sign("test-secret", body),
			},
		});
		expect(delivered.status).toBe(202);
		expect((await categories()).map((c) => c.name)).toContain("Polls");
		expect(reads()).toBe(2);
	});

	it("says it can't tell for repositories it can't read", async () => {
		const response = await mf.dispatchFetch(
			"https://example.com/api/repos/categories?repo=github.com/acme/nowhere",
		);
		expect(response.status).toBe(404);
	});
});
