import type { Card } from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";

// Fixture cards on the fake forge, for the playground and gallery.

const REPO = "acme/imagekit";

type Overrides = Partial<Card> & Pick<Card, "title">;

let next = 400;

export function fixture(overrides: Overrides): Card {
	const item = overrides.item ?? `#${next++}`;
	const repo = overrides.repo ?? REPO;
	return {
		key: itemKey({ host: "fake.tack", repo, item }),
		forge: "fake",
		host: "fake.tack",
		repo,
		item,
		kind: "issue",
		state: "open",
		stateReason: null,
		labels: [],
		assignees: [],
		author: null,
		comments: 0,
		reactions: 0,
		url: `https://fake.tack/${repo}/${item.slice(1)}`,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

export const LABELS = {
	bug: { name: "bug", color: "d73a4a" },
	enhancement: { name: "enhancement", color: "a2eeef" },
	docs: { name: "docs", color: "0075ca" },
	breaking: { name: "breaking", color: "b60205" },
	goodFirst: { name: "good first issue", color: "7057ff" },
	provider: { name: "provider", color: "fbca04" },
	needsReview: { name: "needs review", color: "0e8a16" },
};

export const PLANNING_CARDS: Card[] = [
	fixture({
		item: "#412",
		title: "Drop Node 18 support",
		labels: [LABELS.breaking, LABELS.enhancement],
		comments: 14,
		reactions: 22,
	}),
	fixture({
		item: "#418",
		kind: "pull",
		title: "Remove Node 18 from the CI matrix and engines field",
		labels: [LABELS.breaking],
		comments: 6,
	}),
	fixture({
		item: "#377",
		title: "Custom domains aren’t detected for Cloudinary",
		labels: [LABELS.bug, LABELS.provider],
		comments: 9,
		reactions: 31,
	}),
	fixture({
		item: "#409",
		kind: "pull",
		state: "merged",
		title: "Document the Bunny provider",
		labels: [LABELS.docs],
		comments: 3,
	}),
	fixture({
		item: "#398",
		state: "closed",
		stateReason: "not_planned",
		title: "Keep Node 18 support in the 5.x line",
		comments: 11,
	}),
	fixture({
		item: "#423",
		kind: "pull",
		state: "draft",
		title: "Add ImageKit transformations",
		labels: [LABELS.provider, LABELS.goodFirst],
		comments: 1,
	}),
];

export const GALLERY_CARDS: { label: string; card: Card }[] = [
	{ label: "Issue, open", card: PLANNING_CARDS[0] as Card },
	{ label: "Pull request, open", card: PLANNING_CARDS[1] as Card },
	{ label: "Pull request, merged", card: PLANNING_CARDS[3] as Card },
	{ label: "Pull request, draft", card: PLANNING_CARDS[5] as Card },
	{
		label: "Issue, closed as completed",
		card: fixture({
			state: "closed",
			stateReason: "completed",
			title: "Netlify provider ignores quality=auto",
			comments: 4,
		}),
	},
	{ label: "Issue, closed as not planned", card: PLANNING_CARDS[4] as Card },
	{
		label: "Long title, many labels",
		card: fixture({
			title:
				"When a CDN rewrites the image URL through a custom domain and a path prefix, detection falls back to the default provider and silently drops transforms",
			labels: [LABELS.bug, LABELS.provider, LABELS.needsReview, LABELS.goodFirst, LABELS.docs],
			comments: 128,
			reactions: 340,
		}),
	},
	{ label: "Minimal", card: fixture({ title: "Typo" }) },
];
