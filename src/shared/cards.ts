import type { ForgeId } from "./refs.ts";

// Normalised, forge-neutral card data. This is what travels to clients over
// the board's custom-message channel; it never goes into the Yjs document.

export type CardState = "open" | "closed" | "merged" | "draft";

export interface Card {
	/** Canonical item key, e.g. `github.com/ascorbic/unpic#100`. */
	key: string;
	forge: ForgeId;
	host: string;
	/** Repository path on the host, e.g. `ascorbic/unpic`. */
	repo: string;
	/** Forge-native reference, e.g. `#100` or `!12`. */
	item: string;
	kind: "issue" | "pull";
	title: string;
	state: CardState;
	/** Why it was closed, where the forge says: completed, not_planned, duplicate. */
	stateReason: string | null;
	labels: { name: string; color: string }[];
	assignees: { login: string; avatarUrl: string }[];
	author: { login: string; avatarUrl: string } | null;
	comments: number;
	reactions: number;
	url: string;
	updatedAt: string;
	/**
	 * The forge's global id for the item (a GraphQL node id on GitHub), for
	 * batched refetches. Absent when the forge has none or it wasn't fetched.
	 */
	nodeId?: string;
	/** Review and CI state, for pull requests. */
	pull?: PullDetails;
	/**
	 * Whether updates arrive as they happen (the app is installed, so
	 * webhooks flow), rather than being checked for while someone's looking.
	 * Set by the server from the repository's status; absent in fixtures.
	 */
	live?: boolean;
	/** Whether Tack may write to the item (the app is installed). Writes come in M2. */
	writable?: boolean;
	/**
	 * Whether the repository is public. Anything but `public` is treated as
	 * private: the server only sends it to viewers who can read the repository.
	 */
	visibility?: "public" | "private";
}

/** Pull request state beyond open/closed: CI, reviews, mergeability, links. */
export interface PullDetails {
	/**
	 * How much the forge told us. `basic` details come from a cheaper source
	 * (e.g. GitHub's REST API, without a token) and have no CI rollup, review
	 * decision or linked items, so the card says so rather than guessing.
	 */
	detail: "full" | "basic";
	/** The head commit, to match commit-level CI events to the pull request. */
	head: string | null;
	/** The CI rollup on the head commit, or null when it isn't available. */
	checks: Checks | null;
	/** The overall review decision, where the forge has one. */
	review: ReviewDecision | null;
	/** Requested and actual reviewers, each with their latest state. */
	reviewers: Reviewer[];
	mergeable: "mergeable" | "conflicting" | "unknown";
	/** Issues this pull request closes when merged. */
	linked: LinkedItem[];
}

export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export interface Checks {
	/** The rollup: failing beats pending beats passing. `none` when nothing ran. */
	state: "passing" | "failing" | "pending" | "none";
	passed: number;
	failed: number;
	pending: number;
	/** Skipped, neutral and stale checks: they ran, but say nothing. */
	skipped: number;
	/** Failing checks by name, capped at a handful. */
	failing: { name: string; url: string | null }[];
}

export type ReviewState =
	| "approved"
	| "changes_requested"
	| "commented"
	| "dismissed"
	| "requested";

export interface Reviewer {
	login: string;
	avatarUrl: string;
	state: ReviewState;
}

export interface LinkedItem {
	/** Item key, like a card key. */
	key: string;
	/** Forge-native reference, e.g. `#100`. */
	item: string;
	repo: string;
	title: string;
	state: CardState;
	url: string;
	/** Whether the linked item's repository is private, where the forge says. */
	private?: boolean;
}

/** How many failing check names a card keeps. */
export const MAX_FAILING_CHECKS = 8;

/** Roll check counts up into an overall state. */
export function checksState(counts: Pick<Checks, "passed" | "failed" | "pending" | "skipped">) {
	if (counts.failed > 0) return "failing" as const;
	if (counts.pending > 0) return "pending" as const;
	if (counts.passed + counts.skipped > 0) return "passing" as const;
	return "none" as const;
}

/**
 * A card the server couldn't load (a 404, an unreachable forge), or won't
 * show this viewer: `private` is the placeholder sent to viewers who can't
 * read the repository, and carries nothing but the key the board already has.
 */
export interface MissingCard {
	key: string;
	missing: true;
	reason: "not_found" | "forbidden" | "unsupported" | "error" | "private";
	/**
	 * For repositories that couldn't be read: whether the app is installed
	 * on it. If it isn't, the repository may be private, and installing the
	 * app is the way to read it.
	 */
	installed?: boolean;
}

/**
 * Client to server: `recheck` asks the board to check the viewer's access
 * to private repositories again now (say, after they were added to one).
 */
export type BoardRequest = { type: "recheck" };

/** Server to client, on the board's custom-message channel. */
export type CardMessage =
	| { type: "card"; card: Card }
	| { type: "card-missing"; card: MissingCard }
	| { type: "cards"; cards: (Card | MissingCard)[] };

export function isMissing(card: Card | MissingCard): card is MissingCard {
	return "missing" in card;
}
