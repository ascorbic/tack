// A plain GitHub issue card for unit tests, with any field overridden.

import type { Card } from "../src/shared/cards.ts";

export function card(overrides: Partial<Card> = {}): Card {
	const repo = overrides.repo ?? "acme/widgets";
	const item = overrides.item ?? "#12";
	return {
		key: `github.com/${repo}${item}`,
		forge: "github",
		host: "github.com",
		repo,
		item,
		kind: "issue",
		title: "Widgets wobble on Tuesdays",
		state: "open",
		stateReason: null,
		labels: [],
		assignees: [],
		author: { login: "alice", avatarUrl: "" },
		comments: 0,
		reactions: 0,
		url: "",
		updatedAt: "2026-10-01T00:00:00Z",
		...overrides,
	};
}
