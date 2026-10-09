import type { Card, CardState, MissingCard, PullDetails } from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";
import { repoToken } from "../github/tokens.ts";
import { log } from "../log.ts";
import { INSTALLATION_EVENTS, installationEvent, verifyWebhook } from "../github/webhooks.ts";
import { fetchItemsGraphQL, GraphQLUnavailable, staleItemsGraphQL } from "./github-graphql.ts";
import type {
	FetchRef,
	ForgeAdapter,
	MissingReason,
	RepoIdentity,
	WebhookResult,
} from "./types.ts";

const HOST = "github.com";
const API = "https://api.github.com";
const REPO_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

// The subset of GitHub's issue/PR payload we read. Webhook payloads and REST
// responses share this shape.
export interface GitHubIssueLike {
	number: number;
	title: string;
	state: "open" | "closed";
	state_reason?: string | null;
	html_url: string;
	repository_url?: string;
	updated_at: string;
	node_id?: string;
	comments?: number;
	labels?: ({ name?: string; color?: string } | string)[];
	assignees?: { login: string; avatar_url: string }[] | null;
	user?: { login: string; avatar_url: string } | null;
	reactions?: { total_count?: number };
	pull_request?: { merged_at?: string | null } | null;
	draft?: boolean;
	merged?: boolean;
	merged_at?: string | null;
	// Pull requests only (webhooks and the pulls endpoint).
	head?: { sha?: string };
	mergeable?: boolean | null;
	requested_reviewers?: { login: string; avatar_url: string }[] | null;
}

interface GitHubRepository {
	id: number;
	node_id?: string;
	full_name: string;
}

interface WithPulls {
	head_sha?: string;
	pull_requests?: { number: number }[];
}

interface WebhookPayload {
	action?: string;
	repository?: GitHubRepository;
	issue?: GitHubIssueLike;
	pull_request?: GitHubIssueLike;
	check_run?: WithPulls;
	check_suite?: WithPulls;
	workflow_run?: WithPulls;
	sha?: string;
}

/** The `owner/repo` part of an API or web URL, if it has one. */
function repoFromUrl(url: string | undefined): string | null {
	const match = /^https:\/\/(?:api\.)?github\.com\/(?:repos\/)?([\w.-]+\/[\w.-]+)/i.exec(url ?? "");
	return match?.[1]?.toLowerCase() ?? null;
}

/**
 * What REST and webhook payloads say about a pull request: no CI rollup,
 * review decision or linked issues, so `detail` is `basic`.
 */
function basicPullDetails(pull: GitHubIssueLike): PullDetails {
	return {
		detail: "basic",
		head: pull.head?.sha ?? null,
		checks: null,
		review: null,
		reviewers: (pull.requested_reviewers ?? []).map((r) => ({
			login: r.login,
			avatarUrl: r.avatar_url,
			state: "requested",
		})),
		mergeable:
			pull.mergeable === true ? "mergeable" : pull.mergeable === false ? "conflicting" : "unknown",
		linked: [],
	};
}

export function normaliseIssue(
	repo: string,
	issue: GitHubIssueLike,
	isPull = Boolean(issue.pull_request),
): Card {
	const merged = Boolean(issue.merged || issue.merged_at || issue.pull_request?.merged_at);
	let state: CardState = issue.state;
	if (isPull && merged) state = "merged";
	else if (isPull && issue.state === "open" && issue.draft) state = "draft";
	const item = `#${issue.number}`;
	// The payload knows the repository's current name, even if we asked by an old one.
	const name = repoFromUrl(issue.repository_url) ?? repo.toLowerCase();

	return {
		key: itemKey({ host: HOST, repo: name, item }),
		forge: "github",
		host: HOST,
		repo: name,
		item,
		kind: isPull ? "pull" : "issue",
		title: issue.title,
		state,
		stateReason: issue.state_reason ?? null,
		labels: (issue.labels ?? []).flatMap((label) =>
			typeof label === "string"
				? [{ name: label, color: "cccccc" }]
				: label.name
					? [{ name: label.name, color: label.color ?? "cccccc" }]
					: [],
		),
		assignees: (issue.assignees ?? []).map((a) => ({ login: a.login, avatarUrl: a.avatar_url })),
		author: issue.user ? { login: issue.user.login, avatarUrl: issue.user.avatar_url } : null,
		comments: issue.comments ?? 0,
		reactions: issue.reactions?.total_count ?? 0,
		url: issue.html_url,
		updatedAt: issue.updated_at,
		...(issue.node_id ? { nodeId: issue.node_id } : {}),
		...(isPull ? { pull: basicPullDetails(issue) } : {}),
	};
}

function restHeaders(token: string | null): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		"user-agent": "tack",
		"x-github-api-version": "2022-11-28",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

function missingReason(response: Response): MissingReason {
	if (response.status === 404) return "not_found";
	const rateLimited =
		response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
	if ((response.status === 401 || response.status === 403) && !rateLimited) return "forbidden";
	return "error";
}

function tokenFor(env: Env, name: string): Promise<string | null> {
	return repoToken(env, `${HOST}/${name}`.toLowerCase());
}

// REST, one item at a time: the fallback when there's no token for GraphQL.
async function fetchItemRest(
	name: string,
	item: string,
	token: string | null,
): Promise<Card | MissingCard> {
	const key = itemKey({ host: HOST, repo: name, item });
	const number = item.slice(1);
	const headers = restHeaders(token);
	const base = `${API}/repos/${name}`;
	try {
		const res = await fetch(`${base}/issues/${number}`, { headers });
		if (!res.ok) return { key, missing: true, reason: missingReason(res) };
		const issue = await res.json<GitHubIssueLike>();
		if (issue.pull_request) {
			// The issues endpoint doesn't say whether a PR is a draft, or
			// anything about its head, reviewers or mergeability.
			const pr = await fetch(`${base}/pulls/${number}`, { headers });
			if (pr.ok) {
				const pull = await pr.json<GitHubIssueLike>();
				Object.assign(issue, {
					draft: pull.draft,
					head: pull.head,
					mergeable: pull.mergeable,
					requested_reviewers: pull.requested_reviewers,
				});
			}
		}
		return normaliseIssue(name, issue);
	} catch {
		return { key, missing: true, reason: "error" };
	}
}

/**
 * Items updated since the oldest cached card, from one REST list request,
 * when there's no token for GraphQL. The list holds the 100 most recently
 * updated items, which covers any board that's been asleep a while.
 */
async function reconcileRest(name: string, cards: Card[], token: string | null) {
	const since = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
	const url = new URL(`${API}/repos/${name}/issues`);
	for (const [param, value] of Object.entries({
		state: "all",
		sort: "updated",
		direction: "desc",
		per_page: "100",
		since,
	})) {
		url.searchParams.set(param, value);
	}
	const res = await fetch(url, { headers: restHeaders(token) }).catch(() => null);
	if (!res?.ok) return [];
	const cached = new Map(cards.map((card) => [card.item, card]));
	const changed = (await res.json<GitHubIssueLike[]>()).filter((issue) => {
		const card = cached.get(`#${issue.number}`);
		return card && issue.updated_at > card.updatedAt;
	});
	return Promise.all(
		changed.map((issue) =>
			// Pull requests need a second request for their details.
			issue.pull_request
				? fetchItemRest(name, `#${issue.number}`, token)
				: Promise.resolve(normaliseIssue(name, issue)),
		),
	);
}

function reply(body: unknown, status: number): WebhookResult {
	return { type: "response", response: Response.json(body, { status }) };
}

function repoIdentity(repository: GitHubRepository): RepoIdentity {
	return {
		forge: "github",
		host: HOST,
		id: String(repository.id),
		name: repository.full_name.toLowerCase(),
		...(repository.node_id ? { nodeId: repository.node_id } : {}),
	};
}

/** Items and commits whose CI or reviews a delivery says changed. */
function refetchFor(event: string, payload: WebhookPayload) {
	const items = new Set<string>();
	const commits = new Set<string>();
	if (event === "pull_request" || event === "pull_request_review") {
		if (payload.pull_request) items.add(`#${payload.pull_request.number}`);
	} else if (event === "check_run" || event === "check_suite" || event === "workflow_run") {
		const run = payload[event];
		for (const pull of run?.pull_requests ?? []) items.add(`#${pull.number}`);
		// Pull requests from forks aren't listed, so match by head commit too.
		if (run?.head_sha) commits.add(run.head_sha);
	} else if (event === "status") {
		if (payload.sha) commits.add(payload.sha);
	}
	return items.size + commits.size > 0 ? { items: [...items], commits: [...commits] } : undefined;
}

export const github: ForgeAdapter = {
	id: "github",
	capabilities: {
		subIssues: true,
		blockedBy: true,
		discussions: true,
		draftPulls: true,
		ciStatus: true,
	},

	async resolveRepo(_host, name, env) {
		if (!REPO_NAME_RE.test(name)) return "not_found";
		const token = await tokenFor(env, name);
		try {
			// Renamed and transferred repositories redirect to their new home.
			const res = await fetch(`${API}/repos/${name}`, { headers: restHeaders(token) });
			if (!res.ok) return missingReason(res);
			return repoIdentity(await res.json<GitHubRepository>());
		} catch {
			return "error";
		}
	},

	async fetchItems(refs, env, repo) {
		const results = new Map<FetchRef, Card | MissingCard>();
		const supported = refs.filter((ref) => {
			const ok = /^#\d+$/.test(ref.item);
			if (!ok) results.set(ref, { key: itemKey(ref), missing: true, reason: "unsupported" });
			return ok;
		});
		const name = repo?.name ?? supported[0]?.repo;
		if (name && supported.length > 0) {
			const token = await tokenFor(env, name);
			let fetched: Map<string, Card | MissingCard> | null = null;
			if (token) {
				try {
					fetched = await fetchItemsGraphQL({ name, nodeId: repo?.nodeId }, supported, token);
				} catch (error) {
					if (!(error instanceof GraphQLUnavailable)) throw error;
					log.warn("github.graphql.unavailable", { repo: name, fallback: "fetch", error });
				}
			}
			await Promise.all(
				supported.map(async (ref) => {
					results.set(ref, fetched?.get(ref.item) ?? (await fetchItemRest(name, ref.item, token)));
				}),
			);
		}
		return refs.map(
			(ref) => results.get(ref) ?? { key: itemKey(ref), missing: true, reason: "error" },
		);
	},

	async reconcile(repo, cards, env) {
		if (cards.length === 0) return [];
		const token = await tokenFor(env, repo.name);
		if (token) {
			try {
				const { stale, gone } = await staleItemsGraphQL(cards, token);
				const fresh =
					stale.length > 0
						? await fetchItemsGraphQL(
								repo,
								stale.map((card) => ({ item: card.item, nodeId: card.nodeId })),
								token,
							)
						: new Map();
				return [
					...fresh.values(),
					...gone.map((card): MissingCard => ({
						key: card.key,
						missing: true,
						reason: "not_found",
					})),
				];
			} catch (error) {
				if (!(error instanceof GraphQLUnavailable)) throw error;
				log.warn("github.graphql.unavailable", { repo: repo.name, fallback: "reconcile", error });
			}
		}
		return reconcileRest(repo.name, cards, token);
	},

	async receiveWebhook(request, env) {
		const body = await request.text();
		const verified = await verifyWebhook(env, body, request.headers.get("x-hub-signature-256"));
		if (verified === "unconfigured") return reply({ error: "webhook secret not configured" }, 500);
		if (verified === "invalid") return reply({ error: "invalid signature" }, 401);

		const event = request.headers.get("x-github-event") ?? "";
		if (event === "ping") return reply({ ok: true }, 200);
		if (INSTALLATION_EVENTS.has(event)) {
			await installationEvent(env, event, body);
			return reply({ status: "processed" }, 202);
		}

		const payload = JSON.parse(body) as WebhookPayload;
		// Repository ids survive renames and transfers, so they route deliveries.
		if (!payload.repository?.id || !payload.repository.full_name) {
			return reply({ status: "ignored", reason: "no repository" }, 202);
		}
		const repo = repoIdentity(payload.repository);

		const cards: Card[] = [];
		if (event === "issues" && payload.issue) cards.push(normaliseIssue(repo.name, payload.issue));
		if (event === "pull_request" && payload.pull_request) {
			cards.push(normaliseIssue(repo.name, payload.pull_request, true));
		}

		return {
			type: "delivery",
			delivery: {
				id: request.headers.get("x-github-delivery") ?? crypto.randomUUID(),
				event,
				action: payload.action ?? null,
				repo,
				payload: body,
				cards,
				refetch: refetchFor(event, payload),
			},
		};
	},
};
