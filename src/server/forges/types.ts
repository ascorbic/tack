import type { Card, MissingCard } from "../../shared/cards.ts";
import type { ForgeId, ItemRef } from "../../shared/refs.ts";

/** What a forge supports, so the UI can offer only what will work. */
export interface ForgeCapabilities {
	subIssues: boolean;
	blockedBy: boolean;
	discussions: boolean;
	draftPulls: boolean;
	ciStatus: boolean;
}

/**
 * A repository's identity on its forge. The id survives renames and
 * transfers; the name is just what it's called today.
 */
export interface RepoIdentity {
	forge: ForgeId;
	host: string;
	/** Stable, forge-native id, e.g. GitHub's repository id. */
	id: string;
	/** Current repository path, lowercased, e.g. `ascorbic/unpic`. */
	name: string;
	/** The forge's global id for the repository, where it has one. */
	nodeId?: string;
}

export type MissingReason = MissingCard["reason"];

/** An item to fetch, with the forge's global id for it when already known. */
export interface FetchRef extends ItemRef {
	nodeId?: string;
}

/** A webhook delivery, verified and normalised by a forge adapter. */
export interface Delivery {
	/** Unique per delivery, for dedupe. Redeliveries reuse it. */
	id: string;
	event: string;
	action: string | null;
	/** The repository, as of this delivery. A new name means it was renamed. */
	repo: RepoIdentity;
	/** Raw body, kept in the repository's event log. */
	payload: string;
	/** Items this delivery changed, already normalised. */
	cards: Card[];
	/**
	 * Items whose derived state (CI, reviews, mergeability) changed in ways
	 * the payload can't describe. They're refetched after a short debounce,
	 * so a burst of CI events costs one fetch.
	 */
	refetch?: {
		/** Item references, e.g. `#100`. */
		items: string[];
		/** Commits whose CI changed, matched to pull requests by head commit. */
		commits: string[];
	};
}

export type WebhookResult =
	| { type: "delivery"; delivery: Delivery }
	/** Handled without touching any repository: pings, bad signatures, ignored events. */
	| { type: "response"; response: Response };

export interface ForgeAdapter {
	id: ForgeId;
	capabilities: ForgeCapabilities;
	/**
	 * Look up a repository's stable identity by its path. Forges without one
	 * use the path as the id.
	 */
	resolveRepo?(host: string, name: string, env: Env): Promise<RepoIdentity | MissingReason>;
	/**
	 * Fetch current state for items, all in the same repository, in as few
	 * requests as the forge allows. `repo` is the repository's identity when
	 * known; refs may use an older name for it. Results are in the order of
	 * `refs`, and keyed by the repository's current name.
	 */
	fetchItems(refs: FetchRef[], env: Env, repo?: RepoIdentity): Promise<(Card | MissingCard)[]>;
	/**
	 * Check cached cards against the forge, cheaply, and return fresh data for
	 * the ones that changed. Unchanged cards are left out.
	 */
	reconcile?(repo: RepoIdentity, cards: Card[], env: Env): Promise<(Card | MissingCard)[]>;
	/** Verify and normalise an incoming webhook, for forges that send them. */
	receiveWebhook?(request: Request, env: Env): Promise<WebhookResult>;
}
