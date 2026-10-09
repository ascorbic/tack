import type { Card } from "../../shared/cards.ts";
import type { OperationKind } from "../../shared/changes.ts";
import { itemKey, itemOf, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import type { RelatedResult } from "../../shared/widgets.ts";
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
// refused, to show failures.

const LABELS = [
	{ name: "bug", color: "d73a4a" },
	{ name: "enhancement", color: "a2eeef" },
	{ name: "docs", color: "0075ca" },
	{ name: "good first issue", color: "7057ff" },
];
const STATES = ["open", "open", "closed", "merged", "draft"] as const;

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
	const state = STATES[n % STATES.length] ?? "open";
	return {
		...common,
		kind: state === "merged" || state === "draft" ? "pull" : "issue",
		title: `Synthetic card ${n}: a reasonably long title so it wraps onto two lines`,
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
		const target = op.kind === "item.subIssue" ? op.parent : "target" in op ? op.target : null;
		const key = target && "key" in target ? target.key : undefined;
		// Synthetic cards never change, so the answer is all the confirmation there is.
		return { ok: true, ...(key ? { key } : {}), confirmed: true } satisfies ApplyResult;
	},

	async canWrite() {
		return true;
	},

	async repoMeta(repo) {
		return {
			repo: `${repo.host}/${repo.name}`,
			labels: LABELS,
			milestones: [{ title: "v1", dueOn: null }],
			assignees: [],
			discussionCategories: [],
			watchers: 0,
			defaultBranch: "main",
			writable: true,
		};
	},

	async listDirectory() {
		return [];
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
	const numbers = new Set<number>();
	const add = (list: string[], m: number) => {
		list.push(key(m));
		numbers.add(m);
	};
	if (isIssue(n)) {
		const parent = Math.floor(n / 10);
		if (parent >= 1 && isIssue(parent)) {
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
