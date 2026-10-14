import type { Card, MissingCard } from "../../shared/cards.ts";
import type { Command } from "../../shared/commands.ts";
import type { ChangeProblem, Operation, OperationKind, PushAs } from "../../shared/changes.ts";
import type { ItemMention } from "../../shared/mentions.ts";
import type { RepoDiscussionCategory, RepoMeta } from "../../shared/push.ts";
import type {
	QueryError,
	RelatedResult,
	ReleaseResult,
	SearchQuery,
	SearchResult,
} from "../../shared/widgets.ts";
import type { ForgeId, ItemRef } from "../../shared/refs.ts";
import type { ReactorsResult } from "../../shared/reactions.ts";

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
	/**
	 * The SHA-256 of the signed body (`digestOf`), for dedupe that a replay
	 * can't dodge by sending a new id: the id header isn't signed.
	 */
	digest?: string;
	event: string;
	action: string | null;
	/** The repository, as of this delivery. A new name means it was renamed. */
	repo: RepoIdentity;
	/** Raw body, kept in the repository's event log. */
	payload: string;
	/** Items this delivery changed, already normalised. */
	cards: Card[];
	/**
	 * Items this delivery says are gone from the repository (`#12`): a
	 * discussion deleted or transferred. Their cards become missing.
	 */
	gone?: string[];
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
	/**
	 * What each changed item's text (a pull request's title and description)
	 * refers to, by the item's canonical key (see src/shared/mentions.ts).
	 * Rules use it to place pull requests beside what they close (#44).
	 */
	mentions?: Record<string, ItemMention[]>;
	/**
	 * A comment on one of the repository's items that's a command for the
	 * app (#58): `@tack add to roadmap`. The `Repo` runs it once per comment
	 * (see src/server/commands.ts).
	 */
	command?: CommentCommand;
}

/** A command someone left in a comment on an item, for the app (#58). */
export interface CommentCommand {
	command: Command;
	/** The comment: its forge id (for reactions) and its URL. */
	comment: { id: string; url: string };
	/** Who wrote it, on the forge. On GitHub the id is the GitHub user id, as Tack's users are. */
	author: { id: number; login: string };
	item: { key: string; ref: string; kind: "issue" | "pull" };
	/** It was edited into a command (rather than written as one). */
	edited: boolean;
	/** This instance's address, for links in replies. */
	origin: string;
}

/** Reactions the app leaves on a command: looking, done, and couldn't. */
export type CommandReaction = "eyes" | "rocket" | "confused";

export type ReplyResult =
	| { ok: true; url: string }
	/** `retryAt`: a rate limit's end (ms since the epoch), when that's why. */
	| { ok: false; error: string; retryable: boolean; retryAt?: number };

export type WebhookResult =
	| { type: "delivery"; delivery: Delivery }
	/** Handled without touching any repository: pings, bad signatures, ignored events. */
	| { type: "response"; response: Response };

/**
 * How to read a repository the app isn't installed on. `token` is someone's
 * own token (a viewer who's looking at the board), used where there's no
 * installation: it only reaches public data there, but with a far better
 * rate limit than reading anonymously. It's always a GitHub token: other
 * forges' adapters never send it anywhere (#65), and read with the
 * instance's own token for their host, or anonymously.
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
			/**
			 * What the forge itself said, when `error` puts it in other words:
			 * shown behind "Details", for whoever needs to look it up.
			 */
			detail?: string;
			/** What kind of refusal it was, when the board can offer a way out (see `ChangeProblem`). */
			problem?: ChangeProblem;
	  };

/** Files to commit to a branch of their own (backups, #59). */
export interface BranchWrite {
	branch: string;
	files: { path: string; content: string }[];
	message: string;
}

export type BranchResult =
	| {
			ok: true;
			/** The branch's head after writing, and a link to it. */
			sha: string;
			url: string;
			/** The files were already exactly that: nothing was committed. */
			unchanged: boolean;
	  }
	| Extract<ApplyResult, { ok: false }>;

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
	 * For forges without an app to install (no `installed`), whose webhooks
	 * are set up by hand on each repository or group (GitLab, Forgejo, #65):
	 * the instance can't know which repositories send them, so a repository
	 * counts as live while verified deliveries from it keep arriving (`Repo`
	 * remembers the last), and is polled while watched otherwise. Forges that
	 * send none (Tangled) are never live, so always polled. Absent: always
	 * live (the fake forge).
	 */
	liveFromDeliveries?: boolean;
	/**
	 * For forges without an app to install: whether this instance can write
	 * to a repository at all (it holds a token for the host, with writes
	 * turned on). Absent: whenever `apply` is defined.
	 */
	writable?(repo: RepoIdentity, env: Env): boolean;
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
	 * Forges without this have no private repositories. Forges where people
	 * don't sign in (all but GitHub) answer for the repository alone: only
	 * public ones, since Tack can't tell who may read the others.
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
	 * GitHub). Pushing needs this even when writing as the app. Forges
	 * without an app to install get no token (`""`): they write with the
	 * instance's own, and decide by `pusher` (who's pushing, by their GitHub
	 * login) and what that token may do.
	 */
	canWrite?(
		repo: RepoIdentity,
		token: string,
		env: Env,
		pusher?: { id: number; login: string },
	): Promise<boolean>;
	/**
	 * Commit files to a branch that's only for them (#59: a board's backups):
	 * made as an orphan branch, with no history, the first time; a commit on
	 * top of it after. Never the default branch. Never throws for forge errors.
	 */
	writeBranch?(
		repo: RepoIdentity,
		write: BranchWrite,
		auth: WriteAuth,
		env: Env,
	): Promise<BranchResult>;
	/** What a repository offers to write with: labels, milestones, people, categories. */
	repoMeta?(repo: RepoIdentity, env: Env, auth?: ReadAuth): Promise<RepoMeta>;
	/**
	 * A repository's discussion categories, in the forge's order, with their
	 * emoji and whether they take answers: empty when discussions are off.
	 * Throws if the repository can't be read. Read through `Repo`, which
	 * keeps them (`Repo.discussionCategories`).
	 */
	discussionCategories?(
		repo: RepoIdentity,
		env: Env,
		auth?: ReadAuth,
	): Promise<RepoDiscussionCategory[]>;
	// Reading for widgets (M3). `auth.token` is the viewer's own token where
	// they have one; adapters fall back to the app's for public data.

	/** Run a search in the forge's query language. */
	search?(
		query: SearchQuery,
		env: Env,
		auth?: ReadAuth & { viewer?: string },
	): Promise<SearchResult | QueryError>;
	/** Items related to one item. */
	related?(key: string, env: Env, auth?: ReadAuth): Promise<RelatedResult | QueryError>;
	/**
	 * Who reacted to an item, by kind of reaction: the first few of each
	 * (`MAX_NAMED`), with names where the forge has them. Asked when someone
	 * hovers a card's reaction count (src/server/reactors.ts).
	 */
	reactors?(key: string, env: Env, auth?: ReadAuth): Promise<ReactorsResult | QueryError>;
	/** A repository's latest release and what's merged since. */
	release?(repo: RepoIdentity, env: Env, auth?: ReadAuth): Promise<ReleaseResult | QueryError>;

	/** File names in a directory on the default branch (for numbering ADRs). */
	listDirectory?(repo: RepoIdentity, path: string, env: Env, auth?: ReadAuth): Promise<string[]>;

	// Answering comment commands (#58), as the app.

	/** React to a comment. Returns the reaction's id (to take it back), or null if it can't. */
	react?(
		repo: RepoIdentity,
		comment: string,
		reaction: CommandReaction,
		env: Env,
	): Promise<string | null>;
	/** Take back a reaction `react` left. */
	unreact?(repo: RepoIdentity, comment: string, reaction: string, env: Env): Promise<void>;
	/**
	 * Comment on an item (`#12`). With `retryOf` (when an earlier attempt
	 * was made), first look for the reply that attempt may have left.
	 */
	reply?(
		repo: RepoIdentity,
		item: string,
		body: string,
		env: Env,
		options?: { retryOf?: number },
	): Promise<ReplyResult>;
}
