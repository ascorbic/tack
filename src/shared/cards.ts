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
}

/** A card the server couldn't load, e.g. a private repo or a 404. */
export interface MissingCard {
	key: string;
	missing: true;
	reason: "not_found" | "forbidden" | "unsupported" | "error";
}

export type CardMessage =
	| { type: "card"; card: Card }
	| { type: "card-missing"; card: MissingCard }
	| { type: "cards"; cards: (Card | MissingCard)[] };

export function isMissing(card: Card | MissingCard): card is MissingCard {
	return "missing" in card;
}
