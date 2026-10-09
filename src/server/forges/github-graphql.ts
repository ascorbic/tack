import {
	type Card,
	type Checks,
	checksState,
	type LinkedItem,
	MAX_FAILING_CHECKS,
	type MissingCard,
	type PullDetails,
	type Reviewer,
	type ReviewState,
} from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";
import type { RepoIdentity } from "./types.ts";

// Batched reads from GitHub's GraphQL API. Known items are refetched by node
// id with `nodes(ids:)`; new ones by number, as aliased `issueOrPullRequest`
// fields on their repository. Either way, one request covers a whole batch.
// GraphQL always needs a token, so callers fall back to REST without one.

const HOST = "github.com";
const ENDPOINT = "https://api.github.com/graphql";

/** Full items per request, well inside GitHub's node limits. */
const ITEM_BATCH = 50;
/** `nodes(ids:)` takes at most 100 ids. */
const FRESHNESS_BATCH = 100;

// Issue and PullRequest `state` are different enums, so they're aliased:
// GraphQL won't merge same-named fields of different types in one selection.
const COMMON = `
	id number title url updatedAt
	repository { nameWithOwner }
	author { login avatarUrl }
	labels(first: 10) { nodes { name color } }
	assignees(first: 5) { nodes { login avatarUrl } }
	comments { totalCount }
	reactions { totalCount }`;

const COUNTS = `
	checkRunCountsByState { state count }
	statusContextCountsByState { state count }`;

export const FRAGMENTS = `
fragment TackIssue on Issue {${COMMON}
	issueState: state
	stateReason
}
fragment TackPull on PullRequest {${COMMON}
	pullState: state
	isDraft
	mergeable
	reviewDecision
	headRefOid
	latestReviews(first: 10) { nodes { state author { login avatarUrl } } }
	reviewRequests(first: 10) {
		nodes {
			requestedReviewer {
				... on User { login avatarUrl }
				... on Bot { login avatarUrl }
				... on Mannequin { login avatarUrl }
				... on Team { login: slug teamAvatarUrl: avatarUrl }
			}
		}
	}
	closingIssuesReferences(first: 5) {
		nodes { number title url issueState: state repository { nameWithOwner isPrivate } }
	}
	commits(last: 1) {
		nodes {
			commit {
				statusCheckRollup {
					state
					contexts(first: 50) {${COUNTS}
						nodes {
							__typename
							... on CheckRun { name status conclusion detailsUrl }
							... on StatusContext { context state targetUrl }
						}
					}
				}
			}
		}
	}
}`;

export const ITEM = "__typename ...TackIssue ...TackPull";

// --- Response shapes --------------------------------------------------------

interface Actor {
	login: string;
	avatarUrl: string;
}

interface Common {
	id: string;
	number: number;
	title: string;
	url: string;
	updatedAt: string;
	repository: { nameWithOwner: string };
	author: Actor | null;
	labels: { nodes: { name: string; color: string }[] };
	assignees: { nodes: Actor[] };
	comments: { totalCount: number };
	reactions: { totalCount: number };
}

export interface GqlIssue extends Common {
	__typename: "Issue";
	issueState: "OPEN" | "CLOSED";
	stateReason: string | null;
}

interface StateCount {
	state: string;
	count: number;
}

type Context =
	| {
			__typename: "CheckRun";
			name: string;
			status: string;
			conclusion: string | null;
			detailsUrl: string | null;
	  }
	| { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };

interface Rollup {
	state: string;
	contexts: {
		checkRunCountsByState?: StateCount[] | null;
		statusContextCountsByState?: StateCount[] | null;
		nodes?: (Context | null)[];
	};
}

export interface GqlPull extends Common {
	__typename: "PullRequest";
	pullState: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	headRefOid: string;
	latestReviews: { nodes: ({ state: string; author: Actor | null } | null)[] };
	reviewRequests: {
		nodes: ({
			requestedReviewer: {
				login?: string;
				avatarUrl?: string;
				teamAvatarUrl?: string | null;
			} | null;
		} | null)[];
	};
	closingIssuesReferences: {
		nodes: ({
			number: number;
			title: string;
			url: string;
			issueState: "OPEN" | "CLOSED";
			repository: { nameWithOwner: string; isPrivate?: boolean };
		} | null)[];
	};
	commits: { nodes: ({ commit: { statusCheckRollup: Rollup | null } } | null)[] };
}

export type GqlItem = GqlIssue | GqlPull | { __typename: string };

interface Freshness {
	__typename: string;
	id?: string;
	updatedAt?: string;
	headRefOid?: string;
	mergeable?: GqlPull["mergeable"];
	commits?: { nodes: ({ commit: { statusCheckRollup: Rollup | null } } | null)[] };
}

// --- Transport ---------------------------------------------------------------

/** The request itself failed (auth, rate limits, outages), as opposed to missing items. */
export class GraphQLUnavailable extends Error {}

async function graphql<T>(
	token: string,
	name: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"user-agent": "tack",
			},
			body: JSON.stringify({ query, variables, operationName: name }),
		});
	} catch (error) {
		throw new GraphQLUnavailable(String(error));
	}
	if (!response.ok) throw new GraphQLUnavailable(`GraphQL ${response.status}`);
	const body = await response.json<{ data?: T | null; errors?: { type?: string }[] }>();
	// Missing nodes come back as nulls with NOT_FOUND errors alongside the
	// data. Only a response with no data at all means the request failed.
	if (!body.data) throw new GraphQLUnavailable(`GraphQL errors: ${JSON.stringify(body.errors)}`);
	return body.data;
}

function chunks<T>(list: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
	return result;
}

// --- Fetching ----------------------------------------------------------------

export interface ItemRequest {
	/** Forge-native reference, `#123`. */
	item: string;
	nodeId?: string;
}

/**
 * Fetch items in batches: by node id where known, otherwise by number on the
 * repository. Results are keyed by item reference.
 */
export async function fetchItemsGraphQL(
	repo: Pick<RepoIdentity, "name" | "nodeId">,
	requests: ItemRequest[],
	token: string,
): Promise<Map<string, Card | MissingCard>> {
	const results = new Map<string, Card | MissingCard>();
	for (const batch of chunks(requests, ITEM_BATCH)) {
		const byId = batch.filter((r) => r.nodeId);
		const byNumber = batch.filter((r) => !r.nodeId);

		const params: string[] = [];
		const fields: string[] = [];
		const variables: Record<string, unknown> = {};
		if (byId.length > 0) {
			params.push("$ids: [ID!]!");
			fields.push(`nodes(ids: $ids) { ${ITEM} }`);
			variables.ids = byId.map((r) => r.nodeId);
		}
		if (byNumber.length > 0) {
			const aliases = byNumber
				.map(
					(r) =>
						`i${r.item.slice(1)}: issueOrPullRequest(number: ${Number(r.item.slice(1))}) { ${ITEM} }`,
				)
				.join("\n");
			// The repository's node id survives renames; its name may not.
			if (repo.nodeId) {
				params.push("$repo: ID!");
				fields.push(`repo: node(id: $repo) { ... on Repository { ${aliases} } }`);
				variables.repo = repo.nodeId;
			} else {
				params.push("$owner: String!", "$name: String!");
				fields.push(`repo: repository(owner: $owner, name: $name) { ${aliases} }`);
				const [owner, name] = repo.name.split("/");
				Object.assign(variables, { owner, name });
			}
		}

		const query = `query TackItems(${params.join(", ")}) {\n${fields.join("\n")}\n}\n${FRAGMENTS}`;
		const data = await graphql<{
			nodes?: (GqlItem | null)[];
			repo?: Record<string, GqlItem | null> | null;
		}>(token, "TackItems", query, variables);

		byId.forEach((request, i) => {
			results.set(request.item, toCard(data.nodes?.[i], request.item, repo.name));
		});
		for (const request of byNumber) {
			results.set(
				request.item,
				toCard(data.repo?.[`i${request.item.slice(1)}`], request.item, repo.name),
			);
		}
	}
	return results;
}

/**
 * Of these cached cards, the ones that changed on GitHub, judged by one
 * cheap query per hundred cards: `updatedAt`, plus each pull request's head
 * commit, mergeability and check counts, since CI doesn't touch `updatedAt`.
 * Cards that disappeared come back as missing.
 */
export async function staleItemsGraphQL(
	cards: Card[],
	token: string,
): Promise<{ stale: Card[]; gone: Card[] }> {
	const stale: Card[] = [];
	const gone: Card[] = [];
	const known = cards.filter((card) => card.nodeId);
	// Cards fetched without GraphQL have no node id, and nothing to compare.
	stale.push(...cards.filter((card) => !card.nodeId));

	const query = `query TackFreshness($ids: [ID!]!) {
	nodes(ids: $ids) {
		__typename
		... on Issue { id updatedAt }
		... on PullRequest {
			id updatedAt headRefOid mergeable
			commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {${COUNTS}
			} } } } }
		}
	}
}`;
	for (const batch of chunks(known, FRESHNESS_BATCH)) {
		const data = await graphql<{ nodes: (Freshness | null)[] }>(token, "TackFreshness", query, {
			ids: batch.map((card) => card.nodeId),
		});
		batch.forEach((card, i) => {
			const node = data.nodes[i];
			if (!node?.updatedAt) gone.push(card);
			else if (isStale(card, node)) stale.push(card);
		});
	}
	return { stale, gone };
}

function isStale(card: Card, node: Freshness): boolean {
	if (node.updatedAt !== card.updatedAt) return true;
	if (node.__typename !== "PullRequest") return false;
	const pull = card.pull;
	if (!pull || pull.detail !== "full") return true;
	if (node.headRefOid !== pull.head) return true;
	if (node.mergeable && mergeable(node.mergeable) !== pull.mergeable) return true;
	const rollup = node.commits?.nodes[0]?.commit.statusCheckRollup ?? null;
	const counts = rollup ? countChecks(rollup) : null;
	if (!counts) return pull.checks !== null && pull.checks.state !== "none";
	const cached = pull.checks;
	return (
		!cached ||
		counts.passed !== cached.passed ||
		counts.failed !== cached.failed ||
		counts.pending !== cached.pending ||
		counts.skipped !== cached.skipped
	);
}

// --- Normalising ---------------------------------------------------------------

function toCard(node: GqlItem | null | undefined, item: string, repo: string): Card | MissingCard {
	const key = itemKey({ host: HOST, repo, item });
	if (!node) return { key, missing: true, reason: "not_found" };
	if (node.__typename === "Issue") return normaliseGqlIssue(node as GqlIssue);
	if (node.__typename === "PullRequest") return normaliseGqlPull(node as GqlPull);
	return { key, missing: true, reason: "unsupported" };
}

function base(node: Common): Omit<Card, "kind" | "state" | "stateReason"> {
	const repo = node.repository.nameWithOwner.toLowerCase();
	const item = `#${node.number}`;
	return {
		key: itemKey({ host: HOST, repo, item }),
		forge: "github",
		host: HOST,
		repo,
		item,
		title: node.title,
		labels: node.labels.nodes.map((label) => ({ name: label.name, color: label.color })),
		assignees: node.assignees.nodes.map((a) => ({ login: a.login, avatarUrl: a.avatarUrl })),
		author: node.author ? { login: node.author.login, avatarUrl: node.author.avatarUrl } : null,
		comments: node.comments.totalCount,
		reactions: node.reactions.totalCount,
		url: node.url,
		updatedAt: node.updatedAt,
		nodeId: node.id,
	};
}

export function normaliseGqlIssue(node: GqlIssue): Card {
	return {
		...base(node),
		kind: "issue",
		state: node.issueState === "OPEN" ? "open" : "closed",
		stateReason: node.stateReason?.toLowerCase() ?? null,
	};
}

export function normaliseGqlPull(node: GqlPull): Card {
	const state =
		node.pullState === "MERGED"
			? "merged"
			: node.pullState === "CLOSED"
				? "closed"
				: node.isDraft
					? "draft"
					: "open";
	const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
	const pull: PullDetails = {
		detail: "full",
		head: node.headRefOid,
		checks: rollup ? checks(rollup) : emptyChecks(),
		review: node.reviewDecision
			? (node.reviewDecision.toLowerCase() as PullDetails["review"])
			: null,
		reviewers: reviewers(node),
		mergeable: mergeable(node.mergeable),
		linked: node.closingIssuesReferences.nodes.flatMap((issue): LinkedItem[] => {
			if (!issue) return [];
			const repo = issue.repository.nameWithOwner.toLowerCase();
			const item = `#${issue.number}`;
			return [
				{
					key: itemKey({ host: HOST, repo, item }),
					item,
					repo,
					title: issue.title,
					state: issue.issueState === "OPEN" ? "open" : "closed",
					url: issue.url,
					...(issue.repository.isPrivate === undefined
						? {}
						: { private: issue.repository.isPrivate }),
				},
			];
		}),
	};
	return { ...base(node), kind: "pull", state, stateReason: null, pull };
}

function mergeable(value: GqlPull["mergeable"]): PullDetails["mergeable"] {
	return value === "MERGEABLE" ? "mergeable" : value === "CONFLICTING" ? "conflicting" : "unknown";
}

// Check run and status states, by what they mean for the rollup. Anything
// unrecognised counts as pending, which is the safe thing to show.
const FAILED = new Set([
	"FAILURE",
	"ERROR",
	"CANCELLED",
	"TIMED_OUT",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);
const PASSED = new Set(["SUCCESS", "COMPLETED"]);
const SKIPPED = new Set(["NEUTRAL", "SKIPPED", "STALE"]);

type Bucket = "passed" | "failed" | "pending" | "skipped";

function bucket(state: string): Bucket {
	if (FAILED.has(state)) return "failed";
	if (PASSED.has(state)) return "passed";
	if (SKIPPED.has(state)) return "skipped";
	return "pending";
}

function contextState(context: Context): string {
	return context.__typename === "CheckRun" ? (context.conclusion ?? context.status) : context.state;
}

function countChecks(rollup: Rollup): Record<Bucket, number> | null {
	const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
	const { checkRunCountsByState: runs, statusContextCountsByState: statuses } = rollup.contexts;
	if (runs || statuses) {
		for (const { state, count } of [...(runs ?? []), ...(statuses ?? [])]) {
			counts[bucket(state)] += count;
		}
		return counts;
	}
	if (!rollup.contexts.nodes) return null;
	for (const context of rollup.contexts.nodes) if (context) counts[bucket(contextState(context))]++;
	return counts;
}

function checks(rollup: Rollup): Checks {
	const counts = countChecks(rollup) ?? { passed: 0, failed: 0, pending: 0, skipped: 0 };
	const failing = (rollup.contexts.nodes ?? []).flatMap((context) =>
		context && bucket(contextState(context)) === "failed"
			? [
					context.__typename === "CheckRun"
						? { name: context.name, url: context.detailsUrl }
						: { name: context.context, url: context.targetUrl },
				]
			: [],
	);
	return { ...counts, state: checksState(counts), failing: failing.slice(0, MAX_FAILING_CHECKS) };
}

function emptyChecks(): Checks {
	return { state: "none", passed: 0, failed: 0, pending: 0, skipped: 0, failing: [] };
}

/** Whose turn it is first: blocking reviews, then approvals, then requests. */
const REVIEW_ORDER: ReviewState[] = [
	"changes_requested",
	"approved",
	"requested",
	"commented",
	"dismissed",
];

function reviewers(node: GqlPull): Reviewer[] {
	const byLogin = new Map<string, Reviewer>();
	for (const review of node.latestReviews.nodes) {
		const state = review?.state.toLowerCase() as ReviewState | "pending" | undefined;
		if (!review?.author || !state || state === "pending") continue;
		byLogin.set(review.author.login, {
			login: review.author.login,
			avatarUrl: review.author.avatarUrl,
			state,
		});
	}
	// A request after a review means it's their turn again.
	for (const request of node.reviewRequests.nodes) {
		const reviewer = request?.requestedReviewer;
		if (!reviewer?.login) continue;
		byLogin.set(reviewer.login, {
			login: reviewer.login,
			avatarUrl: reviewer.avatarUrl ?? reviewer.teamAvatarUrl ?? "",
			state: "requested",
		});
	}
	return [...byLogin.values()].sort(
		(a, b) => REVIEW_ORDER.indexOf(a.state) - REVIEW_ORDER.indexOf(b.state),
	);
}
