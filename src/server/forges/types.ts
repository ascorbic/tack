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

/** A webhook delivery, verified and normalised by a forge adapter. */
export interface Delivery {
	/** Unique per delivery, for dedupe. */
	id: string;
	event: string;
	action: string | null;
	/** Repository key, e.g. `github.com/ascorbic/unpic`. */
	repoKey: string;
	/** Raw body, kept in the repository's event log. */
	payload: string;
	/** Items this delivery changed, already normalised. */
	cards: Card[];
}

export type WebhookResult =
	| { type: "delivery"; delivery: Delivery }
	/** Handled without touching any repository: pings, bad signatures, ignored events. */
	| { type: "response"; response: Response };

export interface ForgeAdapter {
	id: ForgeId;
	capabilities: ForgeCapabilities;
	/** Fetch current state for items, all in the same repository. */
	fetchItems(refs: ItemRef[], env: Env): Promise<(Card | MissingCard)[]>;
	/** Verify and normalise an incoming webhook, for forges that send them. */
	receiveWebhook?(request: Request, env: Env): Promise<WebhookResult>;
}
