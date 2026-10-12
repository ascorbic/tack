import type { Card, DiscussionCategory, DiscussionDetails } from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";
import { PEOPLE, makeChecks, pullDetails, reviewer } from "./ci.ts";

// Fixture cards on the fake forge, for the playground and gallery.

const REPO = "acme/unpic";

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

function linked(item: string, title: string, state: "open" | "closed" = "open") {
	return {
		key: itemKey({ host: "fake.tack", repo: REPO, item }),
		item,
		repo: REPO,
		title,
		state,
		url: `https://fake.tack/${REPO}/${item.slice(1)}`,
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
		pull: pullDetails({
			checks: makeChecks({ passed: 7, pending: 4, skipped: 1 }),
			reviewers: [reviewer("kai", "requested"), reviewer("priya", "commented")],
			linked: [linked("#412", "Drop Node 18 support")],
		}),
	}),
	fixture({
		item: "#377",
		title: "Custom domains aren’t detected for Skyfold",
		labels: [LABELS.bug, LABELS.provider],
		comments: 9,
		reactions: 31,
	}),
	fixture({
		item: "#409",
		kind: "pull",
		state: "merged",
		title: "Document the Wombat provider",
		labels: [LABELS.docs],
		comments: 3,
		pull: pullDetails({
			checks: makeChecks({ passed: 9, skipped: 2 }),
			review: "approved",
			reviewers: [reviewer("jo", "approved")],
			linked: [linked("#391", "Wombat provider has no docs", "closed")],
		}),
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
		title: "Add Pictura transformations",
		labels: [LABELS.provider, LABELS.goodFirst],
		comments: 1,
		pull: pullDetails({
			checks: makeChecks({ passed: 10, failed: 1, failing: ["lint"] }),
			review: null,
		}),
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
			title: "Portside provider ignores quality=auto",
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

/** Pull requests in every CI, review and merge state. */
export const PULL_GALLERY: { label: string; card: Card }[] = [
	{
		label: "Checks running, review requested",
		card: fixture({
			kind: "pull",
			title: "Support signed URLs for Skyfold",
			labels: [LABELS.provider],
			comments: 2,
			pull: pullDetails({
				checks: makeChecks({ passed: 5, pending: 6, skipped: 1 }),
				reviewers: [reviewer("kai", "requested"), reviewer("tom", "requested")],
			}),
		}),
	},
	{
		label: "Checks failing, changes requested",
		card: fixture({
			kind: "pull",
			title: "Detect custom domains from the CDN response headers",
			labels: [LABELS.bug, LABELS.provider],
			comments: 11,
			pull: pullDetails({
				checks: makeChecks({ passed: 9, failed: 2 }),
				review: "changes_requested",
				reviewers: [reviewer("priya", "changes_requested"), reviewer("kai", "approved")],
				linked: [linked("#377", "Custom domains aren’t detected for Skyfold")],
			}),
		}),
	},
	{
		label: "All green, approved",
		card: fixture({
			kind: "pull",
			title: "Add width and height to the Larkspur docs example",
			labels: [LABELS.docs],
			comments: 1,
			pull: pullDetails({
				checks: makeChecks({ passed: 14, skipped: 2 }),
				review: "approved",
				reviewers: [reviewer("jo", "approved"), reviewer("kai", "approved")],
				linked: [linked("#402", "Larkspur example is missing dimensions")],
			}),
		}),
	},
	{
		label: "Merge conflicts",
		card: fixture({
			kind: "pull",
			title: "Move providers into their own packages",
			labels: [LABELS.breaking],
			comments: 23,
			pull: pullDetails({
				checks: makeChecks({ passed: 12 }),
				reviewers: [reviewer("tom", "commented")],
				mergeable: "conflicting",
			}),
		}),
	},
	{
		label: "Lots failing, several linked issues",
		card: fixture({
			kind: "pull",
			title: "Upgrade to TypeScript 7",
			comments: 4,
			pull: pullDetails({
				checks: makeChecks({ passed: 3, failed: 7, pending: 1 }),
				reviewers: [reviewer("priya", "requested")],
				linked: [
					linked("#380", "Type errors with exactOptionalPropertyTypes"),
					linked("#385", "Types are slow to check"),
					linked("#390", "Drop the old .d.ts build"),
				],
			}),
		}),
	},
	{
		label: "Without the GitHub App (REST only)",
		card: fixture({
			kind: "pull",
			title: "Fix srcset width rounding at 2x density",
			labels: [LABELS.bug],
			comments: 3,
			pull: pullDetails({
				detail: "basic",
				checks: null,
				review: null,
				reviewers: [reviewer("kai", "requested")],
				mergeable: "unknown",
			}),
		}),
	},
	{
		label: "No checks, commented",
		card: fixture({
			kind: "pull",
			title: "Typo in README",
			pull: pullDetails({
				checks: makeChecks({}),
				review: null,
				reviewers: [reviewer("jo", "commented")],
			}),
		}),
	},
	{
		label: "Draft, checks running",
		card: fixture({
			kind: "pull",
			state: "draft",
			title: "Spike: AVIF quality defaults",
			pull: pullDetails({ checks: makeChecks({ passed: 2, pending: 9 }), review: null }),
		}),
	},
];

/** Discussion categories, as a repository might set them up. */
export const CATEGORIES = {
	rfcs: { name: "RFCs", emoji: "📝", answerable: false },
	qa: { name: "Q&A", emoji: "🙏", answerable: true },
	ideas: { name: "Ideas", emoji: "💡", answerable: false },
	showAndTell: { name: "Show and tell", emoji: "🙌", answerable: false },
	announcements: { name: "Announcements", emoji: "📣", answerable: false },
} satisfies Record<string, DiscussionCategory>;

/** A discussion on the fake forge: its own kind of card, with its category and upvotes. */
export function discussion(
	overrides: Partial<Card> & Pick<Card, "title" | "item">,
	details: Partial<DiscussionDetails> & { category: DiscussionCategory },
): Card {
	const repo = overrides.repo ?? REPO;
	return fixture({
		kind: "discussion",
		url: `https://fake.tack/${repo}/discussions/${overrides.item.slice(1)}`,
		...overrides,
		discussion: { answered: false, answer: null, upvotes: 0, locked: false, ...details },
	});
}

/** Discussions in every state, on acme/unpic: an RFC, questions, ideas, an announcement. */
export const DISCUSSIONS: Card[] = [
	discussion(
		{
			item: "#482",
			title: "RFC: a plugin API for image providers",
			labels: [LABELS.enhancement],
			author: PEOPLE.priya,
			comments: 31,
			reactions: 12,
		},
		{ category: CATEGORIES.rfcs, upvotes: 24 },
	),
	discussion(
		{
			item: "#483",
			title: "How do I set a default quality for every image?",
			author: PEOPLE.tom,
			comments: 5,
		},
		{
			category: CATEGORIES.qa,
			upvotes: 7,
			answered: true,
			answer: {
				url: "https://fake.tack/acme/unpic/discussions/483#discussioncomment-1",
				author: "kai",
				chosenAt: new Date().toISOString(),
			},
		},
	),
	discussion(
		{
			item: "#484",
			title: "Why does provider detection run on every request?",
			labels: [LABELS.provider],
			author: PEOPLE.jo,
			comments: 2,
		},
		{ category: CATEGORIES.qa, upvotes: 3 },
	),
	discussion(
		{
			item: "#485",
			state: "closed",
			stateReason: "resolved",
			title: "Should 5.0 drop the CommonJS build?",
			labels: [LABELS.breaking],
			author: PEOPLE.kai,
			comments: 46,
		},
		{ category: CATEGORIES.ideas, upvotes: 38 },
	),
	discussion(
		{
			item: "#486",
			title: "Show and tell: an image gallery on emdash",
			author: PEOPLE.jo,
			comments: 9,
			reactions: 21,
		},
		{ category: CATEGORIES.showAndTell, upvotes: 18 },
	),
	discussion(
		{
			item: "#487",
			state: "closed",
			stateReason: "outdated",
			title: "Ideas for the docs site’s search",
			author: PEOPLE.tom,
			comments: 4,
		},
		{ category: CATEGORIES.ideas, upvotes: 2 },
	),
	discussion(
		{
			item: "#488",
			title: "unpic 5.0 is out",
			author: PEOPLE.priya,
			comments: 14,
			reactions: 52,
		},
		{ category: CATEGORIES.announcements, upvotes: 41, locked: true },
	),
];

/** The gallery's discussions: one of each state. */
export const DISCUSSION_GALLERY: { label: string; card: Card }[] = [
	{ label: "Discussion, an open RFC", card: DISCUSSIONS[0] as Card },
	{ label: "Discussion, answered", card: DISCUSSIONS[1] as Card },
	{ label: "Discussion, unanswered question", card: DISCUSSIONS[2] as Card },
	{ label: "Discussion, closed as resolved", card: DISCUSSIONS[3] as Card },
	{ label: "Discussion, closed as outdated", card: DISCUSSIONS[5] as Card },
	{ label: "Discussion, locked announcement", card: DISCUSSIONS[6] as Card },
];

/** A public upstream repository the app isn't installed on: read lazily, not live (#9). */
export const UPSTREAM = "pixelmill/pixelmill";

/** Cards from repositories with and without the app, and private references (#9, #10). */
export const ACCESS_GALLERY: { label: string; card: Card }[] = [
	{
		label: "Not live: a public repo without the app",
		card: fixture({
			repo: UPSTREAM,
			item: "#4012",
			title: "AVIF output is darker than the source on some displays",
			labels: [LABELS.bug],
			comments: 9,
			reactions: 4,
			live: false,
			writable: false,
			visibility: "public",
		}),
	},
	{
		label: "Not live: a pull request (no CI without the app)",
		card: fixture({
			repo: UPSTREAM,
			item: "#4031",
			kind: "pull",
			title: "Colour-managed AVIF encoding",
			comments: 2,
			live: false,
			writable: false,
			visibility: "public",
			pull: pullDetails({
				detail: "basic",
				checks: null,
				review: null,
				reviewers: [reviewer("kai", "requested")],
				mergeable: "unknown",
			}),
		}),
	},
	{
		label: "Live: a private repo with the app",
		card: fixture({
			repo: "acme/roadmap",
			item: "#12",
			title: "Plan the 5.0 announcement",
			labels: [LABELS.docs],
			comments: 3,
			live: true,
			writable: true,
			visibility: "private",
		}),
	},
];

/** A card on another forge (#65): its host and kind of key, with the fixture's defaults. */
function elsewhere(
	forge: Card["forge"],
	host: string,
	repo: string,
	item: string,
	page: string,
	overrides: Overrides,
): Card {
	return fixture({
		forge,
		host,
		repo,
		item,
		key: itemKey({ host, repo, item }),
		url: `https://${host}/${repo}/${page}/${item.slice(1)}`,
		...overrides,
	});
}

/** Cards from GitLab, Codeberg and Tangled (#65), as instances serve them. */
export const FORGE_GALLERY: { label: string; card: Card }[] = [
	{
		label: "GitLab issue: Tack can push, no webhook yet",
		card: elsewhere("gitlab", "gitlab.com", "ascorbic/cirrus", "#4512", "-/issues", {
			title: "Blob uploads over 50 MB fail with a 413",
			labels: [LABELS.bug],
			comments: 6,
			reactions: 3,
			thumbsUp: { count: 3 },
			live: false,
			writable: true,
			visibility: "public",
		}),
	},
	{
		label: "GitLab merge request, live: its pipeline and reviewers",
		card: elsewhere("gitlab", "gitlab.com", "ascorbic/cirrus", "!7021", "-/merge_requests", {
			kind: "pull",
			title: "Stream blob uploads to R2",
			comments: 4,
			live: true,
			writable: true,
			visibility: "public",
			pull: pullDetails({
				checks: makeChecks({ failed: 1, failing: ["test:linux"] }),
				review: "changes_requested",
				reviewers: [reviewer("priya", "changes_requested")],
			}),
		}),
	},
	{
		label: "Codeberg pull request: read-only, checked while open",
		card: elsewhere("forgejo", "codeberg.org", "ascorbic/emdash", "#7", "pulls", {
			kind: "pull",
			title: "Document the image plugin's options",
			comments: 2,
			live: false,
			writable: false,
			visibility: "public",
			pull: pullDetails({ checks: makeChecks({ passed: 5 }), review: null, reviewers: [] }),
		}),
	},
	{
		label: "Tangled issue: read-only, no webhooks",
		card: elsewhere("tangled", "tangled.org", "mk.gg/tack", "#775", "issues", {
			title: "Cursors linger after a reconnect",
			comments: 5,
			author: { login: "mk.gg", avatarUrl: "" },
			live: false,
			writable: false,
			visibility: "public",
		}),
	},
];
