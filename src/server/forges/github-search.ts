import { plainSearchError } from "../../shared/queryHelp.ts";
import type { Card } from "../../shared/cards.ts";
import { mentionsMe } from "../../shared/search.ts";
import type { QueryError, SearchQuery, SearchResult } from "../../shared/widgets.ts";
import { type GitHubIssueLike, normaliseIssue } from "./github.ts";
import {
	FRAGMENTS,
	type GqlIssue,
	type GqlItem,
	type GqlPull,
	ITEM,
	normaliseGqlIssue,
	normaliseGqlPull,
} from "./github-graphql.ts";
import type { ReadAuth } from "./types.ts";

// Searching GitHub for widgets (#37): GraphQL's `search` with a token, so
// results carry the same full card data as a fetch (CI, reviews, linked
// issues) and say whether each repository is private; REST issue search
// without one, which only ever sees public data.
//
// Search has its own, much smaller rate limits (30 requests a minute with a
// token, 10 without, for REST), so once GitHub says to back off, this
// isolate stops asking until it says to try again, and the board's runner
// spaces searches out (see src/server/widgets/runner.ts).

const API = "https://api.github.com";
const GRAPHQL = `${API}/graphql`;
/** GitHub rejects longer searches. */
const MAX_QUERY = 256;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** When each token (or anonymous searching) may search again, after a rate limit. */
const backoff = new Map<string, number>();

const SEARCH = `query TackSearch($q: String!, $first: Int!) {
	search(query: $q, type: ISSUE, first: $first) {
		issueCount
		nodes {
			${ITEM}
			... on Issue { repository { isPrivate } }
			... on PullRequest { repository { isPrivate } }
		}
	}
}
${FRAGMENTS}`;

type SearchNode = GqlItem & { repository?: { nameWithOwner: string; isPrivate?: boolean } };

function error(reason: QueryError["reason"], message: string, retryAt?: number): QueryError {
	return { kind: "error", reason, message, ...(retryAt ? { retryAt } : {}) };
}

/** The query as GitHub wants it: with the sort written in, as GraphQL search has no sort argument. */
export function searchText(query: SearchQuery): string {
	const q = query.q.trim();
	if (!query.sort || /(^|\s)-?sort:/i.test(q)) return q;
	return `${q} sort:${query.sort}-${query.order ?? "desc"}`;
}

/** When a rate-limited response says to try again (ms since the epoch). */
function retryAtOf(response: Response): number | null {
	const limited =
		response.status === 429 ||
		((response.status === 403 || response.status === 429) &&
			(response.headers.get("x-ratelimit-remaining") === "0" ||
				response.headers.has("retry-after")));
	if (!limited) return null;
	const after = Number(response.headers.get("retry-after"));
	if (after > 0) return Date.now() + after * 1000;
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	return reset > 0 ? reset * 1000 : Date.now() + 60_000;
}

function headers(token: string | null): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		"user-agent": "tack",
		"x-github-api-version": "2022-11-28",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

/**
 * Run a search. `auth.token` is the viewer's own token, or another signed-in
 * person's for a search the caller has limited to public repositories (the
 * board's runner does that for everyone else); `GITHUB_TOKEN` is the
 * fallback, then anonymous REST. `@me` needs `auth.viewer`: without one,
 * nobody's looking whom it could mean.
 */
export async function searchGitHub(
	query: SearchQuery,
	env: Env,
	auth?: ReadAuth & { viewer?: string },
): Promise<SearchResult | QueryError> {
	const q = searchText(query);
	if (!q) return error("invalid", "There's nothing to search for.");
	if (q.length > MAX_QUERY) {
		return error("invalid", `GitHub only searches up to ${MAX_QUERY} characters.`);
	}
	if (mentionsMe(q) && !auth?.viewer) {
		return error("signed_out", "Sign in to see what “@me” means for you.");
	}
	const limit = Math.min(Math.max(1, Math.round(query.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	const token = auth?.token || env.GITHUB_TOKEN || null;
	const key = token ?? "anonymous";
	const until = backoff.get(key) ?? 0;
	if (until > Date.now()) {
		return error("rate_limited", "GitHub asked Tack to slow down its searches.", until);
	}
	const result = token ? await searchGraphQL(q, limit, token) : await searchRest(q, limit, query);
	if (result.kind === "error" && result.reason === "rate_limited" && result.retryAt) {
		backoff.set(key, result.retryAt);
	}
	return result;
}

async function searchGraphQL(
	q: string,
	limit: number,
	token: string,
): Promise<SearchResult | QueryError> {
	let response: Response;
	try {
		response = await fetch(GRAPHQL, {
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({
				query: SEARCH,
				variables: { q, first: limit },
				operationName: "TackSearch",
			}),
		});
	} catch {
		return error("error", "GitHub couldn't be reached.");
	}
	const retryAt = retryAtOf(response);
	if (retryAt)
		return error("rate_limited", "GitHub asked Tack to slow down its searches.", retryAt);
	if (response.status === 401) return error("no_access", "GitHub didn't accept the token.");
	if (!response.ok) return error("error", `GitHub answered ${response.status}.`);
	const body = await response.json<{
		data?: { search?: { issueCount: number; nodes: (SearchNode | null)[] } } | null;
		errors?: { type?: string; message?: string }[];
	}>();
	const problem = body.errors?.[0];
	if (problem?.type === "RATE_LIMITED") {
		return error(
			"rate_limited",
			"GitHub asked Tack to slow down its searches.",
			Date.now() + 60_000,
		);
	}
	const search = body.data?.search;
	if (!search) {
		return error(
			"invalid",
			problem?.message ? plainSearchError(problem.message, q) : "GitHub couldn't run this search.",
		);
	}
	const items: Card[] = [];
	for (const node of search.nodes) {
		if (!node) continue;
		const isPrivate = node.repository?.isPrivate;
		const card =
			node.__typename === "Issue"
				? normaliseGqlIssue(node as GqlIssue)
				: node.__typename === "PullRequest"
					? normaliseGqlPull(node as GqlPull)
					: null;
		if (!card) continue;
		// Unknown visibility counts as private, so only viewers who can read it see it.
		items.push({ ...card, visibility: isPrivate === false ? "public" : "private" });
	}
	return { kind: "search", total: search.issueCount, items };
}

interface RestSearch {
	total_count: number;
	incomplete_results: boolean;
	items: (GitHubIssueLike & { repository_url: string })[];
}

async function searchRest(
	q: string,
	limit: number,
	query: SearchQuery,
): Promise<SearchResult | QueryError> {
	const url = new URL(`${API}/search/issues`);
	// REST takes the sort as parameters; leave it in the text too, harmlessly.
	url.searchParams.set("q", q);
	url.searchParams.set("per_page", String(limit));
	if (query.sort) {
		url.searchParams.set("sort", query.sort);
		url.searchParams.set("order", query.order ?? "desc");
	}
	let response: Response;
	try {
		response = await fetch(url, { headers: headers(null) });
	} catch {
		return error("error", "GitHub couldn't be reached.");
	}
	const retryAt = retryAtOf(response);
	if (retryAt)
		return error("rate_limited", "GitHub asked Tack to slow down its searches.", retryAt);
	if (response.status === 422) {
		const body = await response
			.json<{ message?: string; errors?: { message?: string }[] }>()
			.catch(() => null);
		const message = body?.errors?.[0]?.message ?? body?.message;
		return error(
			"invalid",
			message ? plainSearchError(message, q) : "GitHub couldn't run this search.",
		);
	}
	if (!response.ok) return error("error", `GitHub answered ${response.status}.`);
	const body = await response.json<RestSearch>();
	return {
		kind: "search",
		total: body.total_count,
		// Anonymous searches only ever see public repositories.
		items: body.items.map((item) => ({
			...normaliseIssue("", item),
			visibility: "public" as const,
		})),
		...(body.incomplete_results ? { incomplete: true } : {}),
	};
}

/** For tests: forget every backoff. */
export function resetSearchBackoff(): void {
	backoff.clear();
}
