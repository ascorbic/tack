import type { Card } from "../../shared/cards.ts";
import type { OperationKind } from "../../shared/changes.ts";
import { itemKey } from "../../shared/refs.ts";
import type { ApplyResult, ForgeAdapter } from "./types.ts";

// A synthetic forge at `fake.tack`, for stress tests and tests. Items are
// generated from their number and never fetched over the network.
// Example key: fake.tack/stress/cards#42
//
// Writes go nowhere: `apply` answers as a forge would, without a network,
// so the push flow can be tried end to end without GitHub. Created items
// get a number from 100000 up (their cards are synthetic, like any other).
// Anything with "[fail]" in its title or body is refused, to show failures.

const LABELS = [
	{ name: "bug", color: "d73a4a" },
	{ name: "enhancement", color: "a2eeef" },
	{ name: "docs", color: "0075ca" },
	{ name: "good first issue", color: "7057ff" },
];
const STATES = ["open", "open", "closed", "merged", "draft"] as const;

/** What the fake forge can write: everything but what its capabilities say it lacks. */
const FAKE_WRITES: OperationKind[] = [
	"issue.create",
	"item.labels",
	"item.milestone",
	"item.assignees",
	"item.state",
	"item.comment",
	"pr.create",
];

export function fakeCard(repo: string, n: number): Card {
	const state = STATES[n % STATES.length] ?? "open";
	const item = `#${n}`;
	return {
		key: itemKey({ host: "fake.tack", repo, item }),
		forge: "fake",
		host: "fake.tack",
		repo,
		item,
		kind: state === "merged" || state === "draft" ? "pull" : "issue",
		title: `Synthetic card ${n}: a reasonably long title so it wraps onto two lines`,
		state,
		stateReason: state === "closed" ? "completed" : null,
		labels: LABELS.slice(0, (n % 3) + 1),
		assignees: [],
		author: null,
		comments: n % 17,
		reactions: n % 9,
		url: `https://fake.tack/${repo}/${n}`,
		updatedAt: new Date(0).toISOString(),
	};
}

export const fake: ForgeAdapter = {
	id: "fake",
	capabilities: {
		subIssues: false,
		blockedBy: false,
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
			const n = 100_000 + Math.floor(Math.random() * 900_000);
			const key = itemKey({ host: repo.host, repo: repo.name, item: `#${n}` });
			return { ok: true, key, url: `https://fake.tack/${repo.name}/${n}`, confirmed: true };
		}
		const target = "target" in op ? op.target : null;
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
};
