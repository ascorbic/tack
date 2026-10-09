import type { Card } from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";
import type { ForgeAdapter } from "./types.ts";

// A synthetic forge at `fake.tack`, for stress tests and tests. Items are
// generated from their number and never fetched over the network.
// Example key: fake.tack/stress/cards#42

const LABELS = [
	{ name: "bug", color: "d73a4a" },
	{ name: "enhancement", color: "a2eeef" },
	{ name: "docs", color: "0075ca" },
	{ name: "good first issue", color: "7057ff" },
];
const STATES = ["open", "open", "closed", "merged", "draft"] as const;

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
		writes: [],
	},
	async fetchItems(refs) {
		return refs.map((ref) => fakeCard(ref.repo, Number(ref.item.slice(1))));
	},
};
