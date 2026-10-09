import type { Card, CardState, MissingCard } from "../../shared/cards.ts";
import { type ItemRef, itemKey } from "../../shared/refs.ts";
import { verifySignature } from "./hmac.ts";
import type { ForgeAdapter, WebhookResult } from "./types.ts";

const HOST = "github.com";

// The subset of GitHub's issue/PR payload we read. Webhook payloads and REST
// responses share this shape.
export interface GitHubIssueLike {
	number: number;
	title: string;
	state: "open" | "closed";
	state_reason?: string | null;
	html_url: string;
	updated_at: string;
	comments?: number;
	labels?: ({ name?: string; color?: string } | string)[];
	assignees?: { login: string; avatar_url: string }[] | null;
	user?: { login: string; avatar_url: string } | null;
	reactions?: { total_count?: number };
	pull_request?: { merged_at?: string | null } | null;
	draft?: boolean;
	merged?: boolean;
	merged_at?: string | null;
}

interface WebhookPayload {
	action?: string;
	repository?: { full_name: string };
	issue?: GitHubIssueLike;
	pull_request?: GitHubIssueLike;
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

	return {
		key: itemKey({ host: HOST, repo, item }),
		forge: "github",
		host: HOST,
		repo: repo.toLowerCase(),
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
	};
}

// Spike: REST with an optional token. The real thing uses installation
// tokens and batched GraphQL `nodes()` queries.
async function fetchItem(ref: ItemRef, env: Env): Promise<Card | MissingCard> {
	const key = itemKey(ref);
	const number = ref.item.slice(1);
	const headers: HeadersInit = {
		accept: "application/vnd.github+json",
		"user-agent": "tack",
		...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
	};
	const base = `https://api.github.com/repos/${ref.repo}`;
	try {
		const res = await fetch(`${base}/issues/${number}`, { headers });
		if (res.status === 404) return { key, missing: true, reason: "not_found" };
		if (res.status === 403 || res.status === 401)
			return { key, missing: true, reason: "forbidden" };
		if (!res.ok) return { key, missing: true, reason: "error" };
		const issue = await res.json<GitHubIssueLike>();
		if (issue.pull_request) {
			// The issues endpoint doesn't say whether a PR is a draft.
			const pr = await fetch(`${base}/pulls/${number}`, { headers });
			if (pr.ok) Object.assign(issue, { draft: (await pr.json<GitHubIssueLike>()).draft });
		}
		return normaliseIssue(ref.repo, issue);
	} catch {
		return { key, missing: true, reason: "error" };
	}
}

function reply(body: unknown, status: number): WebhookResult {
	return { type: "response", response: Response.json(body, { status }) };
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

	fetchItems(refs, env) {
		return Promise.all(
			refs.map((ref) =>
				ref.item.startsWith("#")
					? fetchItem(ref, env)
					: Promise.resolve<MissingCard>({
							key: itemKey(ref),
							missing: true,
							reason: "unsupported",
						}),
			),
		);
	},

	async receiveWebhook(request, env) {
		if (!env.GITHUB_WEBHOOK_SECRET) return reply({ error: "webhook secret not configured" }, 500);
		const body = await request.text();
		const signature = request.headers.get("x-hub-signature-256");
		if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
			return reply({ error: "invalid signature" }, 401);
		}

		const event = request.headers.get("x-github-event") ?? "";
		if (event === "ping") return reply({ ok: true }, 200);

		const payload = JSON.parse(body) as WebhookPayload;
		const repo = payload.repository?.full_name?.toLowerCase();
		if (!repo) return reply({ status: "ignored", reason: "no repository" }, 202);

		const item =
			event === "issues"
				? payload.issue
				: event === "pull_request"
					? payload.pull_request
					: undefined;

		return {
			type: "delivery",
			delivery: {
				id: request.headers.get("x-github-delivery") ?? crypto.randomUUID(),
				event,
				action: payload.action ?? null,
				// The real thing keys by repository id so renames don't split the cache.
				repoKey: `${HOST}/${repo}`,
				payload: body,
				cards: item ? [normaliseIssue(repo, item, event === "pull_request")] : [],
			},
		};
	},
};
