import type { Card, MissingCard } from "../../shared/cards.ts";
import type { Operation, OperationKind, PushAs } from "../../shared/changes.ts";
import type { RepoMeta } from "../../shared/push.ts";
import type { ForgeId, ItemRef } from "../../shared/refs.ts";

/** What a forge supports, so the UI can offer only what will work. */
export interface ForgeCapabilities {
	subIssues: boolean;
	blockedBy: boolean;
	discussions: boolean;
	draftPulls: boolean;
	ciStatus: boolean;
	/** The operations `apply` supports. The UI only offers these. */
	writes: OperationKind[];
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
	/**
	 * Whether the repository is private, where known. Unknown is treated as
	 * private: its cards only reach viewers who can read it.
	 */
	private?: boolean;
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

/**
 * How to read a repository the app isn't installed on. `token` is someone's
 * own token (a viewer who's looking at the board), used where there's no
 * installation: it only reaches public data there, but with a far better
 * rate limit than reading anonymously.
 */
export interface ReadAuth {
	token?: string | null;
}

export type PollResult =
	/** Nothing changed since the last poll (a 304, which costs no rate limit with a token). */
	| { status: "unchanged" }
	| { status: "changed"; etag: string | null; cards: (Card | MissingCard)[] }
	/** The forge couldn't be asked; try again no sooner than `retryAt`. */
	| { status: "error"; retryAt?: number };

/**
 * How to write: `token` is the pushing person's own token for `user`, or an
 * installation token for `app`.
 */
export interface WriteAuth {
	as: PushAs;
	token: string;
}

export type ApplyResult =
	| {
			ok: true;
			/** The item it created or changed, and a link to what it wrote. */
			key?: string;
			url?: string;
			/**
			 * Whether the forge's response is confirmation enough (e.g. a
			 * comment, which no card shows). Otherwise the change is `sent`
			 * until a webhook or reconciliation shows it on the card.
			 */
			confirmed: boolean;
	  }
	| {
			ok: false;
			error: string;
			/** Worth trying again: rate limits, timeouts, 5xx. */
			retryable: boolean;
			/** When to try again, for rate limits (ms since the epoch). */
			retryAt?: number;
	  };

/** How to apply: context the adapter needs to keep retries from writing twice. */
export interface ApplyOptions {
	/**
	 * Set when this operation was tried before (ms since the epoch of the
	 * first attempt), which may have gone through without our hearing back
	 * (a timeout, a 5xx). Adapters check for what that attempt would have
	 * made, such as an issue or comment, before making it again.
	 */
	retryOf?: number;
}

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
	fetchItems(
		refs: FetchRef[],
		env: Env,
		repo?: RepoIdentity,
		auth?: ReadAuth,
	): Promise<(Card | MissingCard)[]>;
	/**
	 * Check cached cards against the forge, cheaply, and return fresh data for
	 * the ones that changed. Unchanged cards are left out.
	 */
	reconcile?(
		repo: RepoIdentity,
		cards: Card[],
		env: Env,
		auth?: ReadAuth,
	): Promise<(Card | MissingCard)[]>;
	/**
	 * Whether updates for a repository arrive by webhook (on GitHub: the app
	 * is installed on it). Forges without this are treated as live.
	 */
	installed?(repo: RepoIdentity, env: Env, options?: { fresh?: boolean }): Promise<boolean>;
	/**
	 * Ask to be told when `installed` changes for a repository (a path, e.g.
	 * `owner/repo`): the `Repo` object holding it gets `installationChanged`,
	 * a board that couldn't read it at all gets `repoInstallChanged`.
	 */
	watchInstallation?(
		name: string,
		env: Env,
		watcher: { kind: "repo" | "board"; name: string },
	): Promise<void>;
	/**
	 * For repositories that aren't live: one cheap, conditional request
	 * (`etag` from the last poll) that says whether anything changed, and
	 * fresh data for the cached cards that did. `since` is when the last
	 * successful poll ran, so the adapter can tell if it might have missed
	 * something.
	 */
	poll?(
		repo: RepoIdentity,
		cards: Card[],
		env: Env,
		options: ReadAuth & { etag: string | null; since: string | null },
	): Promise<PollResult>;
	/**
	 * Whether the holder of `token` (a viewer's own token, or null for an
	 * anonymous viewer) can read a repository. Throws if the forge can't say.
	 * Forges without this have no private repositories.
	 */
	canRead?(repo: RepoIdentity, token: string | null, env: Env): Promise<boolean>;
	/** Verify and normalise an incoming webhook, for forges that send them. */
	receiveWebhook?(request: Request, env: Env): Promise<WebhookResult>;

	// Writing (M2). Every pending target is resolved before `apply` is called
	// (see `resolveTargets` in src/shared/changes.ts).

	/** Apply one operation. Never throws for forge errors: returns them. */
	apply?(
		op: Operation,
		repo: RepoIdentity,
		auth: WriteAuth,
		env: Env,
		options?: ApplyOptions,
	): Promise<ApplyResult>;
	/**
	 * Whether the holder of `token` can write to a repository (push access on
	 * GitHub). Pushing needs this even when writing as the app.
	 */
	canWrite?(repo: RepoIdentity, token: string, env: Env): Promise<boolean>;
	/** What a repository offers to write with: labels, milestones, people, categories. */
	repoMeta?(repo: RepoIdentity, env: Env, auth?: ReadAuth): Promise<RepoMeta>;
	/** File names in a directory on the default branch (for numbering ADRs). */
	listDirectory?(repo: RepoIdentity, path: string, env: Env, auth?: ReadAuth): Promise<string[]>;
}
