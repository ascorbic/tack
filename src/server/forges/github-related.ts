import type { Card } from "../../shared/cards.ts";
import { itemOf, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import type { QueryError, RelatedResult, ReleaseResult } from "../../shared/widgets.ts";
import { repoToken } from "../github/tokens.ts";
import {
	FRAGMENTS,
	type GqlIssue,
	type GqlPull,
	normaliseGqlIssue,
	normaliseGqlPull,
} from "./github-graphql.ts";
import type { ReadAuth, RepoIdentity } from "./types.ts";
import { forgeFetch, graphqlRateLimited, noteBodyLimit, rateLimitOf } from "./rateLimit.ts";

// Reading around an item for widgets (M3): what's related to an issue (its
// parent, sub-issues, dependencies and the pull requests that close or
// mention it), and a repository's latest release with what's merged since.
// One GraphQL query each (two for a release), as the viewer where they have
// a token, so GitHub itself leaves out what they can't see. Without one, the
// app's token for the repository reads it, and the caller filters private
// items out for viewers who can't read them (see src/server/related.ts).

const HOST = "github.com";
const ENDPOINT = "https://api.github.com/graphql";

/** How many of each relation to read. GitHub allows 100; boards want far fewer. */
const PAGE = 50;

// Each related item, with whether its repository is private, so the caller
// can filter what the viewer may see.
const ITEM = `__typename
	... on Issue { ...TackIssue repository { isPrivate } }
	... on PullRequest { ...TackPull repository { isPrivate } }`;

const MENTIONS = `timelineItems(first: ${PAGE}, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
	nodes {
		__typename
		... on CrossReferencedEvent { source { ${ITEM} } }
		... on ConnectedEvent { subject { ${ITEM} } }
	}
}`;

const RELATED = `query TackRelated($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		issueOrPullRequest(number: $number) {
			__typename
			... on Issue {
				parent { ${ITEM} }
				subIssues(first: ${PAGE}) { nodes { ${ITEM} } }
				blockedBy(first: ${PAGE}) { nodes { ${ITEM} } }
				blocking(first: ${PAGE}) { nodes { ${ITEM} } }
				closedByPullRequestsReferences(first: ${PAGE}, includeClosedPrs: true) { nodes { ${ITEM} } }
				${MENTIONS}
			}
			... on PullRequest {
				closingIssuesReferences(first: ${PAGE}) { nodes { ${ITEM} } }
				${MENTIONS}
			}
		}
	}
}
${FRAGMENTS}`;

const RELEASE = `query TackRelease($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		nameWithOwner
		defaultBranchRef { name }
		latestRelease { tagName name publishedAt url }
	}
}`;

const MERGED_SINCE = `query TackMergedSince($q: String!) {
	search(query: $q, type: ISSUE, first: ${PAGE}) {
		nodes { ${ITEM} }
	}
}
${FRAGMENTS}`;

type Item =
	| ((GqlIssue | GqlPull) & { repository: { isPrivate?: boolean } })
	| { __typename: string };
type Nodes = { nodes: (Item | null)[] } | null | undefined;
type Mention = {
	__typename: string;
	source?: Item | null;
	subject?: Item | null;
};

interface RelatedData {
	repository: {
		issueOrPullRequest:
			| ({
					__typename: "Issue" | "PullRequest";
					parent?: Item | null;
					subIssues?: Nodes;
					blockedBy?: Nodes;
					blocking?: Nodes;
					closedByPullRequestsReferences?: Nodes;
					closingIssuesReferences?: Nodes;
					timelineItems?: { nodes: (Mention | null)[] } | null;
			  } & Record<string, unknown>)
			| null;
	} | null;
}

interface ReleaseData {
	repository: {
		nameWithOwner: string;
		defaultBranchRef: { name: string } | null;
		latestRelease: {
			tagName: string;
			name: string | null;
			publishedAt: string;
			url: string;
		} | null;
	} | null;
}

/** Card data for a related item, with its visibility, or null for anything else. */
function toCard(node: Item | null | undefined): Card | null {
	if (!node) return null;
	let card: Card;
	if (node.__typename === "Issue") card = normaliseGqlIssue(node as GqlIssue);
	else if (node.__typename === "PullRequest") card = normaliseGqlPull(node as GqlPull);
	else return null;
	const isPrivate = (node as { repository: { isPrivate?: boolean } }).repository.isPrivate;
	return isPrivate === undefined ? card : { ...card, visibility: isPrivate ? "private" : "public" };
}

/** Run a query, or say why it couldn't run. */
export async function run<T>(
	token: string,
	name: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<T | QueryError> {
	let response: Response;
	try {
		response = await forgeFetch(ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"user-agent": "tack",
			},
			body: JSON.stringify({ query, variables, operationName: name }),
		});
	} catch {
		return { kind: "error", reason: "error", message: "Couldn’t reach GitHub." };
	}
	const message = response.ok
		? ""
		: await response
				.clone()
				.text()
				.catch(() => "");
	const limit = response.ok ? null : rateLimitOf(response, { message, url: ENDPOINT });
	if (limit) {
		return {
			kind: "error",
			reason: "rate_limited",
			message: "GitHub’s rate limit is used up for now.",
			retryAt: limit.retryAt,
		};
	}
	if (response.status === 401 || response.status === 403) {
		return { kind: "error", reason: "no_access", message: "GitHub didn’t allow that." };
	}
	if (!response.ok) {
		return { kind: "error", reason: "error", message: `GitHub answered ${response.status}.` };
	}
	const body = await response
		.json<{ data?: T | null; errors?: { type?: string; message?: string }[] }>()
		.catch(() => null);
	if (graphqlRateLimited(body?.errors)) {
		return {
			kind: "error",
			reason: "rate_limited",
			message: "GitHub’s rate limit is used up for now.",
			retryAt: noteBodyLimit(`Bearer ${token}`, response, ENDPOINT),
		};
	}
	if (!body?.data) {
		const notFound = body?.errors?.some((error) => error.type === "NOT_FOUND");
		return notFound
			? { kind: "error", reason: "no_access", message: "It doesn’t exist, or you can’t see it." }
			: { kind: "error", reason: "error", message: "GitHub couldn’t answer that." };
	}
	return body.data;
}

export function isError(value: unknown): value is QueryError {
	return typeof value === "object" && value !== null && (value as QueryError).kind === "error";
}

/** The token to read with: the viewer's own, else the app's (or `GITHUB_TOKEN`). */
export async function readToken(env: Env, repo: string, auth?: ReadAuth): Promise<string | null> {
	return auth?.token ?? (await repoToken(env, `${HOST}/${repo}`.toLowerCase()));
}

const SIGNED_OUT: QueryError = {
	kind: "error",
	reason: "signed_out",
	message: "Sign in with GitHub to see what’s related.",
};

/** Items related to one issue or pull request. */
export async function relatedGitHub(
	key: string,
	env: Env,
	auth?: ReadAuth,
): Promise<RelatedResult | QueryError> {
	const parsed = parseRepoKey(repoKeyOf(key));
	const item = itemOf(key);
	const [owner, name] = parsed?.repo.split("/") ?? [];
	if (!parsed || parsed.host !== HOST || !owner || !name || !item?.startsWith("#")) {
		return {
			kind: "error",
			reason: "invalid",
			message: "That isn’t a GitHub issue or pull request.",
		};
	}
	const token = await readToken(env, parsed.repo, auth);
	if (!token) return SIGNED_OUT;
	const data = await run<RelatedData>(token, "TackRelated", RELATED, {
		owner,
		name,
		number: Number(item.slice(1)),
	});
	if (isError(data)) return data;
	const node = data.repository?.issueOrPullRequest;
	if (!node) {
		return {
			kind: "error",
			reason: "no_access",
			message: "It doesn’t exist, or you can’t see it.",
		};
	}

	const cards = new Map<string, Card>();
	const keep = (nodes: (Item | null | undefined)[], kind?: Card["kind"]): string[] => {
		const keys: string[] = [];
		for (const raw of nodes) {
			const card = toCard(raw);
			if (!card || (kind && card.kind !== kind) || card.key === key) continue;
			if (!keys.includes(card.key)) keys.push(card.key);
			cards.set(card.key, card);
		}
		return keys;
	};
	const mentions = (node.timelineItems?.nodes ?? []).map((m) => m?.source ?? m?.subject ?? null);
	const parent = keep([node.parent])[0];
	const result: RelatedResult = {
		kind: "related",
		key,
		...(parent ? { parent } : {}),
		subIssues: keep(node.subIssues?.nodes ?? []),
		blockedBy: keep(node.blockedBy?.nodes ?? []),
		blocking: keep(node.blocking?.nodes ?? []),
		// Closing pull requests first, then ones that only mention it.
		linkedPulls: [
			...new Set([
				...keep(node.closedByPullRequestsReferences?.nodes ?? [], "pull"),
				...keep(mentions, "pull"),
			]),
		],
		cards: [],
	};
	if (node.__typename === "PullRequest") {
		result.closes = keep(node.closingIssuesReferences?.nodes ?? [], "issue");
	}
	result.cards = [...cards.values()];
	return result;
}

/** A repository's latest release, and the pull requests merged into its default branch since. */
export async function releaseGitHub(
	repo: RepoIdentity,
	env: Env,
	auth?: ReadAuth,
): Promise<ReleaseResult | QueryError> {
	const [owner, name] = repo.name.split("/");
	if (!owner || !name) return { kind: "error", reason: "invalid", message: "Not a repository." };
	const token = await readToken(env, repo.name, auth);
	if (!token) return SIGNED_OUT;
	const data = await run<ReleaseData>(token, "TackRelease", RELEASE, { owner, name });
	if (isError(data)) return data;
	if (!data.repository) {
		return {
			kind: "error",
			reason: "no_access",
			message: "It doesn’t exist, or you can’t see it.",
		};
	}
	const { nameWithOwner, defaultBranchRef, latestRelease } = data.repository;
	const filters = [`repo:${nameWithOwner}`, "is:pr", "is:merged", "sort:updated-desc"];
	if (defaultBranchRef) filters.push(`base:${defaultBranchRef.name}`);
	if (latestRelease) filters.push(`merged:>${latestRelease.publishedAt}`);
	const merged = await run<{ search: { nodes: (Item | null)[] } }>(
		token,
		"TackMergedSince",
		MERGED_SINCE,
		{ q: filters.join(" ") },
	);
	if (isError(merged)) return merged;
	return {
		kind: "release",
		repo: `${HOST}/${repo.name}`,
		latest: latestRelease
			? {
					tag: latestRelease.tagName,
					name: latestRelease.name,
					publishedAt: latestRelease.publishedAt,
					url: latestRelease.url,
				}
			: null,
		mergedSince: merged.search.nodes.flatMap((node) => {
			const card = toCard(node);
			return card?.kind === "pull" ? [card] : [];
		}),
	};
}
