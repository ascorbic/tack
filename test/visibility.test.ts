import { describe, expect, it } from "vite-plus/test";
import { visibleCard } from "../src/server/visibility.ts";
import type { Card } from "../src/shared/cards.ts";

const base: Card = {
	key: "github.com/acme/secret#5",
	forge: "github",
	host: "github.com",
	repo: "acme/secret",
	item: "#5",
	kind: "issue",
	title: "Secret roadmap",
	state: "open",
	stateReason: null,
	labels: [{ name: "embargoed", color: "000000" }],
	assignees: [{ login: "alice", avatarUrl: "https://a/alice" }],
	author: { login: "alice", avatarUrl: "https://a/alice" },
	comments: 3,
	reactions: 1,
	url: "https://github.com/acme/secret/issues/5",
	updatedAt: "2026-10-01T00:00:00Z",
	visibility: "private",
};

const link = (repo: string, isPrivate?: boolean) => ({
	key: `github.com/${repo}#1`,
	item: "#1",
	repo,
	title: `Linked in ${repo}`,
	state: "open" as const,
	url: `https://github.com/${repo}/issues/1`,
	...(isPrivate === undefined ? {} : { private: isPrivate }),
});

describe("visibleCard", () => {
	it("replaces private cards with a bare placeholder for viewers who can't read them", () => {
		expect(visibleCard(base, false)).toEqual({ key: base.key, missing: true, reason: "private" });
		expect(visibleCard(base, true)).toBe(base);
	});

	it("treats unknown visibility as private", () => {
		const { visibility: _, ...unknown } = base;
		expect(visibleCard(unknown, false)).toMatchObject({ reason: "private" });
	});

	it("shows public cards to everyone", () => {
		const card = { ...base, visibility: "public" as const };
		expect(visibleCard(card, false)).toBe(card);
	});

	it("hides titles of linked items in other repositories unless they're public", () => {
		const card: Card = {
			...base,
			kind: "pull",
			visibility: "public",
			pull: {
				detail: "full",
				head: null,
				checks: null,
				review: null,
				reviewers: [],
				mergeable: "mergeable",
				linked: [link("acme/secret"), link("acme/vault"), link("acme/open", false)],
			},
		};
		const seen = visibleCard(card, false) as Card;
		expect(seen.pull?.linked.map((l) => l.title)).toEqual([
			"Linked in acme/secret",
			"",
			"Linked in acme/open",
		]);
		expect(JSON.stringify(seen)).not.toContain("Linked in acme/vault");
	});
});
