// GitHub Discussions as cards: reading them over GraphQL (by number beside
// issues and pull requests, by node id, fresh or not), webhook payloads,
// searching, the permission an older install lacks, and writing labels,
// closing, reopening and comments back. In Node, against the fake GitHub.

import type { Request } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Card } from "../src/shared/cards.ts";
import { reflects } from "../src/shared/confirm.ts";
import {
	matchSearch,
	parseSearch,
	searchKind,
	withoutDiscussionType,
} from "../src/shared/search.ts";
import {
	categoryEmoji,
	emojiFromHtml,
	emojiFromShortcode,
} from "../src/server/forges/github-emoji.ts";
import {
	fetchItemsGraphQL,
	type GqlDiscussion,
	normaliseGqlDiscussion,
	staleItemsGraphQL,
} from "../src/server/forges/github-graphql.ts";
import { normaliseDiscussion } from "../src/server/forges/github.ts";
import { searchGitHub } from "../src/server/forges/github-search.ts";
import { applyGitHub } from "../src/server/forges/github-write.ts";
import { fakeCard } from "../src/server/forges/fake.ts";
import { fake } from "../src/server/forges/fake.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import type { RepoIdentity, WriteAuth } from "../src/server/forges/types.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";

const REPO_ID = 1;
const REPO: RepoIdentity = {
	forge: "github",
	host: "github.com",
	id: "1",
	name: "acme/unpic",
	nodeId: "R_1",
};
const KEY = "github.com/acme/unpic";
const T0 = "2026-10-01T00:00:00Z";
const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "" };

function gqlDiscussion(overrides: Partial<GqlDiscussion> = {}): GqlDiscussion {
	return {
		__typename: "Discussion",
		id: "D_kwDO",
		number: 41,
		title: "RFC: a plugin API for providers",
		url: "https://github.com/Acme/Unpic/discussions/41",
		updatedAt: T0,
		createdAt: "2026-09-20T00:00:00Z",
		closedAt: null,
		repository: { nameWithOwner: "Acme/Unpic" },
		author: { login: "kai", avatarUrl: "https://avatars.example/kai" },
		labels: { nodes: [{ name: "rfc", color: "5319e7" }] },
		comments: { totalCount: 12 },
		reactions: { totalCount: 3 },
		thumbsUp: { totalCount: 2, nodes: [{ user: { login: "Priya" } }, { user: null }] },
		discussionClosed: false,
		discussionStateReason: null,
		locked: false,
		upvoteCount: 17,
		category: {
			name: "Q&A",
			emoji: ":pray:",
			emojiHTML: '<div><g-emoji class="g-emoji" alias="pray">🙏</g-emoji></div>',
			isAnswerable: true,
		},
		answer: null,
		answerChosenAt: null,
		...overrides,
	};
}

describe("a discussion over GraphQL", () => {
	it("is a card of its own kind, with its category, upvotes and lock", () => {
		const card = normaliseGqlDiscussion(gqlDiscussion());
		expect(card).toMatchObject({
			key: `${KEY}#41`,
			repo: "acme/unpic",
			item: "#41",
			kind: "discussion",
			state: "open",
			stateReason: null,
			labels: [{ name: "rfc", color: "5319e7" }],
			assignees: [],
			author: { login: "kai" },
			comments: 12,
			thumbsUp: { count: 2, logins: ["priya"] },
			nodeId: "D_kwDO",
			discussion: {
				category: { name: "Q&A", emoji: "🙏", answerable: true },
				answered: false,
				answer: null,
				upvotes: 17,
				locked: false,
			},
		});
		// Discussions have no milestone or assignees to be unsure about.
		expect(card.milestone).toBeUndefined();
	});

	it("says when it's answered, and by whom", () => {
		const card = normaliseGqlDiscussion(
			gqlDiscussion({
				answer: { url: "https://github.com/acme/unpic/discussions/41#c1", author: { login: "jo" } },
				answerChosenAt: "2026-10-02T00:00:00Z",
			}),
		);
		expect(card.discussion).toMatchObject({
			answered: true,
			answer: {
				url: "https://github.com/acme/unpic/discussions/41#c1",
				author: "jo",
				chosenAt: "2026-10-02T00:00:00Z",
			},
		});
	});

	it("reads closing reasons as discussions word them, and reopened as open", () => {
		const closed = (reason: GqlDiscussion["discussionStateReason"]) =>
			normaliseGqlDiscussion(
				gqlDiscussion({ discussionClosed: true, discussionStateReason: reason }),
			);
		expect(closed("OUTDATED")).toMatchObject({ state: "closed", stateReason: "outdated" });
		expect(closed("RESOLVED").stateReason).toBe("resolved");
		expect(
			normaliseGqlDiscussion(gqlDiscussion({ discussionStateReason: "REOPENED" })),
		).toMatchObject({ state: "open", stateReason: null });
	});
});

describe("category emoji", () => {
	it("comes from GraphQL's HTML, else from a shortcode it knows", () => {
		expect(emojiFromHtml('<div><g-emoji alias="bulb">💡</g-emoji></div>')).toBe("💡");
		expect(emojiFromHtml("<div>💬</div>")).toBe("💬");
		expect(emojiFromHtml("<div>not an emoji</div>")).toBeNull();
		expect(emojiFromShortcode(":speech_balloon:")).toBe("💬");
		expect(emojiFromShortcode(":ballot_box:")).toBe("🗳️");
		expect(emojiFromShortcode(":never_heard_of_it:")).toBeNull();
		expect(categoryEmoji(null, ":mega:")).toBe("📣");
	});
});

describe("a discussion's webhook payload", () => {
	const payload = {
		number: 41,
		title: "RFC: a plugin API for providers",
		html_url: "https://github.com/acme/unpic/discussions/41",
		node_id: "D_kwDO",
		state: "open",
		state_reason: null,
		locked: true,
		comments: 13,
		updated_at: "2026-10-03T00:00:00Z",
		answer_html_url: "https://github.com/acme/unpic/discussions/41#c1",
		answer_chosen_at: "2026-10-03T00:00:00Z",
		category: { name: "Ideas", emoji: ":bulb:", is_answerable: false },
		user: { login: "kai", avatar_url: "" },
		labels: [{ name: "rfc", color: "5319e7" }],
		repository_url: "https://api.github.com/repos/acme/unpic",
	};

	it("makes the card, leaving upvotes to the next full read", () => {
		const card = normaliseDiscussion("acme/unpic", payload, {
			html_url: payload.answer_html_url,
			user: { login: "jo" },
		});
		expect(card).toMatchObject({
			key: `${KEY}#41`,
			kind: "discussion",
			state: "open",
			comments: 13,
			discussion: {
				category: { name: "Ideas", emoji: "💡", answerable: false },
				answered: true,
				answer: { author: "jo" },
				locked: true,
			},
		});
		expect(card.discussion?.upvotes).toBeUndefined();
		expect(
			normaliseDiscussion("acme/unpic", {
				...payload,
				state: "closed",
				state_reason: "duplicate",
				answer_html_url: null,
				answer_chosen_at: null,
			}),
		).toMatchObject({ state: "closed", stateReason: "duplicate", discussion: { answered: false } });
	});
});

describe("searches", () => {
	const discussion = normaliseGqlDiscussion(gqlDiscussion());
	const match = (q: string, card: Card = discussion) => matchSearch(card, parseSearch(q));

	it("find discussions only when they ask for them, as GitHub's do", () => {
		expect(searchKind(parseSearch("repo:acme/unpic plugin"))).toBeNull();
		expect(searchKind(parseSearch("repo:acme/unpic is:pr"))).toBe("issues");
		expect(searchKind(parseSearch("is:discussion category:q&a"))).toBe("discussion");
		expect(match("repo:acme/unpic")).toBe("no");
		expect(match("repo:acme/unpic is:discussion")).toBe("yes");
		expect(match("repo:acme/unpic type:discussion label:rfc")).toBe("yes");
		expect(match("is:issue")).toBe("no");
		expect(withoutDiscussionType("repo:acme/unpic is:discussion is:open")).toBe(
			"repo:acme/unpic is:open",
		);
	});

	it("tell answered from unanswered, categories, and locks", () => {
		expect(match("is:discussion is:unanswered")).toBe("yes");
		expect(match("is:discussion is:answered")).toBe("no");
		expect(match('is:discussion category:"Q&A"')).toBe("yes");
		expect(match("is:discussion category:ideas")).toBe("no");
		expect(match("is:discussion is:unlocked")).toBe("yes");
	});
});

describe("against GitHub", () => {
	let github: FakeGitHub;
	let token: string;

	beforeEach(() => {
		github = new FakeGitHub();
		github.addRepo(REPO_ID, "acme/unpic", {
			writers: ["alice"],
			labels: [
				{ name: "rfc", color: "5319e7" },
				{ name: "bug", color: "d73a4a" },
			],
			discussionCategories: ["Ideas", "Q&A"],
		});
		github.install(7, "acme", ["acme/unpic"]);
		github.setItem(REPO_ID, { number: 40, kind: "issue", title: "Providers", updatedAt: T0 });
		github.addDiscussion(REPO_ID, 41, {
			title: "RFC: a plugin API for providers",
			category: "Ideas",
			labels: [{ name: "rfc", color: "5319e7" }],
			upvotes: 9,
			updatedAt: T0,
		});
		github.addDiscussion(REPO_ID, 42, {
			title: "How do I set a default quality?",
			category: "Q&A",
			answer: { login: "jo", chosenAt: T0 },
			updatedAt: T0,
		});
		token = github.userTokenFor(ALICE);
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
			github.fetch(new globalThis.Request(input, init) as unknown as Request),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		gate.clear();
	});

	it("reads a number as whichever it is, in one request", async () => {
		const cards = await fetchItemsGraphQL(
			REPO,
			[{ item: "#40" }, { item: "#41" }, { item: "#42" }, { item: "#99" }],
			token,
		);
		expect(cards.get("#40")).toMatchObject({ kind: "issue", title: "Providers" });
		expect(cards.get("#41")).toMatchObject({
			kind: "discussion",
			url: "https://github.com/acme/unpic/discussions/41",
			discussion: { category: { name: "Ideas", emoji: "💡" }, upvotes: 9, answered: false },
		});
		expect(cards.get("#42")).toMatchObject({
			kind: "discussion",
			discussion: { category: { name: "Q&A", emoji: "🙏", answerable: true }, answered: true },
		});
		expect(cards.get("#99")).toMatchObject({ missing: true, reason: "not_found" });
		expect(github.requests.filter((r) => r.operation === "TackItems")).toHaveLength(1);

		// Known ones by node id after that.
		const again = await fetchItemsGraphQL(REPO, [{ item: "#41", nodeId: "D_1_41" }], token);
		expect(again.get("#41")).toMatchObject({
			kind: "discussion",
			title: "RFC: a plugin API for providers",
		});
	});

	it("notices new upvotes, which don't change when a discussion was updated", async () => {
		const [card] = (await fetchItemsGraphQL(REPO, [{ item: "#41" }], token)).values();
		expect(await staleItemsGraphQL([card as Card], token)).toEqual({ stale: [], gone: [] });
		const discussion = github.discussion(REPO_ID, 41);
		if (discussion) discussion.upvotes = 10;
		expect((await staleItemsGraphQL([card as Card], token)).stale).toHaveLength(1);
	});

	it("says when the app needs the Discussions permission, and doesn't call that gone", async () => {
		// An install from before Tack read discussions.
		github.install(7, "acme", ["acme/unpic"], {
			permissions: { issues: "write", pull_requests: "write", metadata: "read" },
		});
		const app = github.installationTokenFor(7);
		const cards = await fetchItemsGraphQL(REPO, [{ item: "#40" }, { item: "#41" }], app);
		expect(cards.get("#40")).toMatchObject({ kind: "issue" });
		expect(cards.get("#41")).toEqual({
			key: `${KEY}#41`,
			missing: true,
			reason: "forbidden",
			permission: "discussions",
		});
		const byId = await fetchItemsGraphQL(REPO, [{ item: "#41", nodeId: "D_1_41" }], app);
		expect(byId.get("#41")).toMatchObject({ reason: "forbidden", permission: "discussions" });
		const cached = normaliseGqlDiscussion(gqlDiscussion({ id: "D_1_41", number: 41 }));
		expect(await staleItemsGraphQL([cached], app)).toEqual({ stale: [], gone: [] });
	});

	it("searches discussions when asked, and the card tool's both kinds", async () => {
		const discussions = await searchGitHub(
			{ kind: "search", host: "github.com", q: "repo:acme/unpic is:discussion quality" },
			{} as Env,
			{ token },
		);
		expect(discussions).toMatchObject({ kind: "search", items: [{ key: `${KEY}#42` }] });
		// A widget's search is GitHub's issue search, as ever.
		const widget = await searchGitHub(
			{ kind: "search", host: "github.com", q: "repo:acme/unpic" },
			{} as Env,
			{ token },
		);
		expect(widget.kind === "search" && widget.items.map((card) => card.kind)).toEqual(["issue"]);
		// The card tool's finds either kind.
		const either = await searchGitHub(
			{ kind: "search", host: "github.com", q: "repo:acme/unpic", anyKind: true },
			{} as Env,
			{ token },
		);
		expect(either.kind === "search" && either.items.map((card) => card.item).sort()).toEqual([
			"#40",
			"#41",
			"#42",
		]);
		// Without a token, nothing can search discussions.
		expect(
			await searchGitHub(
				{ kind: "search", host: "github.com", q: "repo:acme/unpic is:discussion" },
				{} as Env,
				{},
			),
		).toMatchObject({ kind: "error", reason: "signed_out" });
	});

	describe("writing back", () => {
		let auth: WriteAuth;
		beforeEach(() => {
			auth = { as: "user", token };
		});
		const target = { key: `${KEY}#41` };

		it("adds and removes labels, and says when a label doesn't exist", async () => {
			expect(
				await applyGitHub(
					{ kind: "item.labels", target, add: ["bug"], remove: ["rfc", "nope"], discussion: true },
					REPO,
					auth,
				),
			).toEqual({
				ok: true,
				key: `${KEY}#41`,
				url: "https://github.com/acme/unpic/discussions/41",
				confirmed: false,
			});
			expect(github.discussion(REPO_ID, 41)?.labels?.map((l) => l.name)).toEqual(["bug"]);
			expect(
				await applyGitHub(
					{ kind: "item.labels", target, add: ["wontfix"], discussion: true },
					REPO,
					auth,
				),
			).toMatchObject({
				ok: false,
				error: "There's no label called “wontfix” in acme/unpic to add.",
			});
			// Nothing went through the issues API.
			expect(github.requests.filter((r) => r.path.includes("/issues/41"))).toEqual([]);
		});

		it("closes as resolved or outdated, and reopens", async () => {
			const close = await applyGitHub(
				{ kind: "item.state", target, state: "closed", reason: "not_planned", discussion: true },
				REPO,
				auth,
			);
			expect(close).toMatchObject({ ok: true, key: `${KEY}#41`, confirmed: false });
			expect(github.discussion(REPO_ID, 41)).toMatchObject({
				closed: true,
				stateReason: "OUTDATED",
			});
			const [card] = (await fetchItemsGraphQL(REPO, [{ item: "#41" }], token)).values();
			expect(card).toMatchObject({ state: "closed", stateReason: "outdated" });
			// The card shows what was pushed, worded as discussions word it.
			expect(
				reflects(
					{ kind: "item.state", target, state: "closed", reason: "not_planned", discussion: true },
					card as Card,
				),
			).toBe(true);
			await applyGitHub(
				{ kind: "item.state", target, state: "open", discussion: true },
				REPO,
				auth,
			);
			expect(github.discussion(REPO_ID, 41)?.closed).toBe(false);
		});

		it("comments, once, even when the first answer was lost", async () => {
			const op = {
				kind: "item.comment" as const,
				target,
				body: "On the planning board",
				discussion: true,
			};
			expect(await applyGitHub(op, REPO, auth)).toMatchObject({ ok: true, confirmed: true });
			expect(await applyGitHub(op, REPO, auth, { retryOf: Date.now() })).toMatchObject({
				ok: true,
			});
			expect(github.discussion(REPO_ID, 41)?.comments).toHaveLength(1);
		});

		it("is refused without write access", async () => {
			const bob = github.userTokenFor({ id: 502, login: "bob", name: "Bob", avatar_url: "" });
			expect(
				await applyGitHub({ kind: "item.state", target, state: "closed", discussion: true }, REPO, {
					as: "user",
					token: bob,
				}),
			).toMatchObject({ ok: false });
			expect(github.discussion(REPO_ID, 41)?.closed).toBeFalsy();
		});
	});
});

describe("the test forge", () => {
	it("has discussions of every kind from 90001, which link like GitHub's", () => {
		const cards = [90_001, 90_002, 90_003].map((n) => fakeCard("acme/unpic", n));
		expect(cards.map((card) => card.kind)).toEqual(["discussion", "discussion", "discussion"]);
		expect(cards[0]?.url).toBe("https://fake.tack/acme/unpic/discussions/90001");
		expect(cards.some((card) => card.discussion?.answered)).toBe(true);
	});

	it("finds them for the card tool, and for searches that ask", async () => {
		const search = (q: string, anyKind?: boolean) =>
			fake.search!({ kind: "search", host: "fake.tack", q, anyKind }, {} as Env);
		const asked = await search("repo:acme/unpic is:discussion");
		expect(asked.kind === "search" && asked.items.every((c) => c.kind === "discussion")).toBe(true);
		expect(asked.kind === "search" && asked.items.length).toBeGreaterThan(0);
		const widget = await search("repo:acme/unpic");
		expect(widget.kind === "search" && widget.items.some((c) => c.kind === "discussion")).toBe(
			false,
		);
		const tool = await search("repo:acme/unpic", true);
		expect(tool.kind === "search" && tool.items.some((c) => c.kind === "discussion")).toBe(true);
	});
});
