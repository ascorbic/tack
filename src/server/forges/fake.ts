import type { Card } from "../../shared/cards.ts";
import type { OperationKind } from "../../shared/changes.ts";
import { itemKey, itemOf, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import {
	matchSearch,
	parseSearch,
	searchKind,
	searchScope,
	sortResults,
} from "../../shared/search.ts";
import type { RelatedResult } from "../../shared/widgets.ts";
import { fakeReactors } from "../../shared/reactions.ts";
import type { ApplyResult, ForgeAdapter } from "./types.ts";

// A synthetic forge at `fake.tack`, for stress tests and tests. Items are
// generated from their number and never fetched over the network.
// Example key: fake.tack/stress/cards#42
//
// Writes go nowhere: `apply` answers as a forge would, without a network,
// so the push flow can be tried end to end without GitHub, sub-issues and
// blocked-by included. Created items get a number from 100000 up: even for
// issues, odd for pull requests, so their (synthetic) cards are open items
// of the right kind. Anything with "[fail]" in its title or body is
// refused, to show failures. Synthetic issues have a parent (`fakeParent`),
// so making one a sub-issue of anything else is refused, as GitHub refuses
// a second parent, unless it's moved (`replaceParent`).

const LABELS = [
	{ name: "bug", color: "d73a4a" },
	{ name: "enhancement", color: "a2eeef" },
	{ name: "docs", color: "0075ca" },
	{ name: "good first issue", color: "7057ff" },
];
const STATES = ["open", "open", "closed", "merged", "draft"] as const;
/** Who can be assigned in every fake repository. */
const FAKE_PEOPLE = ["kai", "priya", "tom", "jo"];

/** What the fake forge can write: everything but Discussions. */
const FAKE_WRITES: OperationKind[] = [
	"issue.create",
	"item.labels",
	"item.milestone",
	"item.assignees",
	"item.state",
	"item.subIssue",
	"item.blockedBy",
	"item.comment",
	"pr.create",
];

/** Numbers from here up are items `apply` made. */
const CREATED_FROM = 100_000;

/** A number for an item `apply` makes: even for issues, odd for pull requests. */
function createdNumber(kind: "issue" | "pull"): number {
	const n = CREATED_FROM + 2 * Math.floor(Math.random() * 450_000);
	return kind === "pull" ? n + 1 : n;
}

/**
 * A synthetic issue's parent: n/10, where both are issues (see
 * `fakeRelated`). Items `apply` made have none.
 */
export function fakeParent(n: number): number | null {
	if (n >= CREATED_FROM || isFakeDiscussion(n) || !isIssue(n)) return null;
	const parent = Math.floor(n / 10);
	return parent >= 1 && isIssue(parent) ? parent : null;
}

const fakeTitle = (n: number) =>
	`Synthetic card ${n}: a reasonably long title so it wraps onto two lines`;

/**
 * Discussions on the fake forge: numbers from `DISCUSSIONS_FROM` to just
 * below `CREATED_FROM` (as on GitHub, they share the repository's numbers
 * with its issues and pull requests). Their category, answer and state go
 * round by number, so every kind shows up among the first few.
 */
export const DISCUSSIONS_FROM = 90_000;

export function isFakeDiscussion(n: number): boolean {
	return n >= DISCUSSIONS_FROM && n < CREATED_FROM;
}

const CATEGORIES = [
	{ name: "Ideas", emoji: "💡", answerable: false },
	{ name: "Q&A", emoji: "🙏", answerable: true },
	{ name: "RFCs", emoji: "📝", answerable: false },
	{ name: "Announcements", emoji: "📣", answerable: false },
	{ name: "General", emoji: "💬", answerable: false },
	{ name: "Show and tell", emoji: "🙌", answerable: false },
];

const DISCUSSION_TITLES = [
	"RFC: a plugin API for image providers",
	"How do I set a default quality for every image?",
	"Ideas for the 6.0 release",
	"Should we drop the CommonJS build?",
	"Show and tell: a gallery built with Tack",
	"Why does the CDN detection run on every request?",
];

function fakeDiscussion(
	common: Pick<
		Card,
		"key" | "forge" | "host" | "repo" | "item" | "assignees" | "author" | "url" | "updatedAt"
	>,
	n: number,
): Card {
	const i = n - DISCUSSIONS_FROM;
	const category = CATEGORIES[i % CATEGORIES.length] ?? CATEGORIES[0]!;
	const closed = i % 7 === 6;
	const answered = category.answerable && i % 2 === 1;
	return {
		...common,
		url: `https://fake.tack/${common.repo}/discussions/${n}`,
		kind: "discussion",
		title: DISCUSSION_TITLES[i % DISCUSSION_TITLES.length] ?? fakeTitle(n),
		state: closed ? "closed" : "open",
		stateReason: closed ? "resolved" : null,
		labels: i % 3 === 0 ? [] : LABELS.slice(1, 1 + (i % 3)),
		comments: (i * 7) % 23,
		reactions: i % 5,
		discussion: {
			category,
			answered,
			answer: answered
				? {
						url: `https://fake.tack/${common.repo}/discussions/${n}#discussioncomment-${n}`,
						author: "kai",
						chosenAt: new Date(0).toISOString(),
					}
				: null,
			// Out of step with their numbers, so the most upvoted aren't the newest.
			upvotes: (i * 13) % 31,
			locked: i % 11 === 10,
		},
	};
}

export function fakeCard(repo: string, n: number): Card {
	const item = `#${n}`;
	const common: Pick<
		Card,
		"key" | "forge" | "host" | "repo" | "item" | "assignees" | "author" | "url" | "updatedAt"
	> = {
		key: itemKey({ host: "fake.tack", repo, item }),
		forge: "fake",
		host: "fake.tack",
		repo,
		item,
		assignees: [],
		author: null,
		url: `https://fake.tack/${repo}/${n}`,
		updatedAt: new Date(0).toISOString(),
	};
	if (n >= CREATED_FROM) {
		const kind = n % 2 === 1 ? "pull" : "issue";
		return {
			...common,
			kind,
			title: `Made on the fake forge: ${kind === "pull" ? "pull request" : "issue"} ${n}`,
			state: "open",
			stateReason: null,
			labels: [],
			comments: 0,
			reactions: 0,
		};
	}
	if (isFakeDiscussion(n)) return fakeDiscussion(common, n);
	const state = STATES[n % STATES.length] ?? "open";
	const parent = fakeParent(n);
	const kind = state === "merged" || state === "draft" ? "pull" : "issue";
	return {
		...common,
		kind,
		...(kind === "issue"
			? {
					parent: parent
						? {
								key: itemKey({ host: "fake.tack", repo, item: `#${parent}` }),
								title: fakeTitle(parent),
							}
						: null,
				}
			: {}),
		title: fakeTitle(n),
		state,
		stateReason: state === "closed" ? "completed" : null,
		labels: LABELS.slice(0, (n % 3) + 1),
		comments: n % 17,
		reactions: n % 9,
	};
}

export const fake: ForgeAdapter = {
	id: "fake",
	capabilities: {
		subIssues: true,
		blockedBy: true,
		discussions: false,
		draftPulls: true,
		ciStatus: false,
		writes: FAKE_WRITES,
	},
	async fetchItems(refs) {
		return refs.map((ref) => fakeCard(ref.repo, Number(ref.item.slice(1))));
	},

	async apply(op, repo) {
		const text = JSON.stringify(op);
		if (text.includes("[fail]")) {
			return {
				ok: false,
				error: "The fake forge refused this, as asked (“[fail]”).",
				retryable: false,
			};
		}
		if (!FAKE_WRITES.includes(op.kind)) {
			return { ok: false, error: "The fake forge can't do that.", retryable: false };
		}
		if (op.kind === "issue.create" || op.kind === "pr.create") {
			const n = createdNumber(op.kind === "pr.create" ? "pull" : "issue");
			const key = itemKey({ host: repo.host, repo: repo.name, item: `#${n}` });
			return { ok: true, key, url: `https://fake.tack/${repo.name}/${n}`, confirmed: true };
		}
		if (op.kind === "item.subIssue") {
			// Synthetic issues have the parent `fakeParent` gives them, and
			// one only: moving one there takes `replaceParent`.
			const child = "key" in op.child ? Number(itemOf(op.child.key)?.slice(1)) : NaN;
			const parent = "key" in op.parent ? op.parent.key.toLowerCase() : "";
			const has = Number.isInteger(child) ? fakeParent(child) : null;
			const current = has ? itemKey({ host: repo.host, repo: repo.name, item: `#${has}` }) : null;
			if (current && current.toLowerCase() !== parent && !op.replaceParent) {
				return {
					ok: false,
					error: `#${child} already has a parent issue (#${has}), and an issue can only have one.`,
					retryable: false,
					detail: "The fake forge said: Sub issue may only have one parent",
					problem: { code: "has_parent", parent: current },
				};
			}
		}
		const target = op.kind === "item.subIssue" ? op.parent : "target" in op ? op.target : null;
		const key = target && "key" in target ? target.key : undefined;
		// Synthetic cards never change, so the answer is all the confirmation there is.
		return { ok: true, ...(key ? { key } : {}), confirmed: true } satisfies ApplyResult;
	},

	async canWrite() {
		return true;
	},

	// Backups (#59) go nowhere either: a made-up commit, or a refusal for a
	// branch with "fail" in its name.
	async writeBranch(repo, write) {
		if (write.branch.includes("fail")) {
			return {
				ok: false,
				error: "The fake forge refused this, as asked (a branch called “fail”).",
				retryable: false,
			};
		}
		const sha = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		return { ok: true, sha, url: `https://fake.tack/${repo.name}/commit/${sha}`, unchanged: false };
	},

	async repoMeta(repo) {
		return {
			repo: `${repo.host}/${repo.name}`,
			labels: LABELS,
			milestones: [{ title: "v1", dueOn: null }],
			// A made-up team, so assigning (and volunteers) can be tried.
			assignees: [...FAKE_PEOPLE],
			discussionCategories: [],
			watchers: 0,
			defaultBranch: "main",
			writable: true,
		};
	},

	// Every fake repository has the same categories its discussions go round.
	async discussionCategories() {
		return CATEGORIES.map((category) => ({ ...category }));
	},

	async listDirectory() {
		return [];
	},

	// Who reacted: made-up people, as many as the card counts (`fakeReactors`).
	async reactors(key) {
		const parsed = parseRepoKey(repoKeyOf(key));
		const n = Number(itemOf(key)?.slice(1));
		if (!parsed || !Number.isInteger(n) || n < 1) {
			return { kind: "error", reason: "invalid", message: "Not a fake.tack item." };
		}
		const card = fakeCard(parsed.repo, n);
		return { kind: "reactors", key: card.key, groups: fakeReactors(card.key, card.reactions) };
	},

	async related(key) {
		const parsed = parseRepoKey(repoKeyOf(key));
		const n = Number(itemOf(key)?.slice(1));
		if (!parsed || !Number.isInteger(n) || n < 1) {
			return { kind: "error", reason: "invalid", message: "Not a fake.tack item." };
		}
		return fakeRelated(parsed.repo, n);
	},

	async release(repo) {
		return {
			kind: "release",
			repo: `${repo.host}/${repo.name}`,
			latest: {
				tag: "v1.4.0",
				name: "1.4.0",
				publishedAt: "2026-09-01T12:00:00Z",
				url: `https://fake.tack/${repo.name}/releases/v1.4.0`,
			},
			// Every merged pull request is synthetic, so a handful stand in.
			mergedSince: [3, 8, 13, 18, 23].map((n) => ({
				...fakeCard(repo.name, n),
				visibility: "public" as const,
			})),
		};
	},

	// Searches items 1 to `FAKE_SEARCH_ITEMS` of the repositories it names (`repo:stress/cards`),
	// evaluating the search with the same matcher drop-to-match uses. Words
	// match titles; anything it can't evaluate rules an item out.
	async search(query, _env, auth) {
		const parsed = parseSearch(query.q);
		const { repos } = searchScope(parsed);
		if (repos.length === 0) {
			return {
				kind: "error",
				reason: "invalid",
				message: "The fake forge only searches within repositories: add repo:owner/name.",
			};
		}
		// Discussions answer searches that ask for them, and the card tool's, which take either kind.
		const kind = searchKind(parsed);
		const discussions = kind === "discussion" || (kind === null && query.anyKind);
		const withDiscussions = discussions ? parseSearch(`${query.q} is:discussion`) : parsed;
		const items = repos
			.flatMap((repo) => [
				...Array.from({ length: FAKE_SEARCH_ITEMS }, (_, i) =>
					fakeCard(repo, FAKE_SEARCH_ITEMS - i),
				),
				...(discussions
					? Array.from({ length: FAKE_SEARCH_DISCUSSIONS }, (_, i) =>
							fakeCard(repo, DISCUSSIONS_FROM + 1 + i),
						)
					: []),
			])
			.filter(
				(card) =>
					matchSearch(card, card.kind === "discussion" ? withDiscussions : parsed, {
						viewer: auth?.viewer,
					}) === "yes",
			);
		return {
			kind: "search",
			total: items.length,
			items: sortResults(items, query).slice(0, Math.min(Math.max(1, query.limit ?? 50), 100)),
		};
	},
};

const isIssue = (n: number) => n % 5 <= 2;

/**
 * What's related to a synthetic item, worked out from its number, so it's
 * the same every time and consistent both ways: issue n's sub-issues are
 * 10n+1, 10n+2 and 10n+5 (so its parent is n/10), each issue is blocked
 * by the one five after it (a chain), and each issue is closed by the next
 * merged pull request (numbers ending 3 or 8), which closes the three
 * issues before it. Issues on multiples of five are mentioned by the draft
 * after them too.
 */
export function fakeRelated(repo: string, n: number): RelatedResult {
	const key = (m: number) => itemKey({ host: "fake.tack", repo, item: `#${m}` });
	const result: RelatedResult = {
		kind: "related",
		key: key(n),
		subIssues: [],
		blockedBy: [],
		blocking: [],
		linkedPulls: [],
		cards: [],
	};
	// Discussions aren't linked to anything.
	if (isFakeDiscussion(n)) return result;
	const numbers = new Set<number>();
	const add = (list: string[], m: number) => {
		list.push(key(m));
		numbers.add(m);
	};
	if (isIssue(n)) {
		const parent = fakeParent(n);
		if (parent) {
			result.parent = key(parent);
			numbers.add(parent);
		}
		if (n < 1000) for (const k of [1, 2, 5]) add(result.subIssues, n * 10 + k);
		add(result.blockedBy, n + 5);
		if (n > 5) add(result.blocking, n - 5);
		add(result.linkedPulls, n + 3 - (n % 5));
		if (n % 5 === 0) add(result.linkedPulls, n + 4);
	} else if (n % 5 === 3) {
		result.closes = [];
		for (const m of [n - 3, n - 2, n - 1]) if (m >= 1) add(result.closes, m);
	}
	result.cards = [...numbers].map((m) => ({ ...fakeCard(repo, m), visibility: "public" }));
	return result;
}

/** How many items each fake repository has, for searching. */
export const FAKE_SEARCH_ITEMS = 30;

/** How many discussions each fake repository has, for searching: one of each category. */
export const FAKE_SEARCH_DISCUSSIONS = 6;
