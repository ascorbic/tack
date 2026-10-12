import {
	type Card,
	type CardState,
	type Checks,
	checksState,
	MAX_FAILING_CHECKS,
	type MissingCard,
	type PullDetails,
	type ReviewDecision,
	type Reviewer,
} from "../../shared/cards.ts";
import { type ItemMention, mentionsIn } from "../../shared/mentions.ts";
import { itemKey } from "../../shared/refs.ts";
import { hostConfig } from "./config.ts";
import {
	type ForgejoIssue,
	type ForgejoRepository,
	type ForgejoUser,
	forgejoApiFor as apiFor,
} from "./forgejo-api.ts";
import {
	applyForgejo,
	canWriteForgejo,
	FORGEJO_WRITES,
	listDirectoryForgejo,
	repoMetaForgejo,
} from "./forgejo-write.ts";
import { digestOf, verifyHexSignature } from "./hmac.ts";
import { rateLimitOf } from "./rateLimit.ts";
import { hexColor, iso, missingReason, type RestApi, segments, send } from "./rest.ts";
import type {
	FetchRef,
	ForgeAdapter,
	MissingReason,
	PollResult,
	RepoIdentity,
	WebhookResult,
} from "./types.ts";

// Forgejo (Codeberg, and Gitea, which shares its API), #65. Issues and pull
// requests share numbers, so keys are like GitHub's:
// `codeberg.org/ascorbic/emdash#7`. Reads use the instance's token for the
// host, or none (public repositories only); never a viewer's GitHub token.
// Webhooks are set up by hand, on a repository or an organisation, pointing
// at `/webhooks/forgejo` with the host's secret (see config.ts).

interface CombinedStatus {
	state?: string;
	statuses?: { status?: string; state?: string; context?: string; target_url?: string | null }[];
}

interface Review {
	user?: ForgejoUser | null;
	state?: string;
	dismissed?: boolean;
	stale?: boolean;
}

/** `owner/name` from an item's page, which knows a renamed repository's new name. */
function repoFromUrl(url: string | undefined, host: string): string | null {
	const match = /^https?:\/\/([^/]+)\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/\d+/i.exec(url ?? "");
	return match && match[1]?.toLowerCase() === host ? (match[2]?.toLowerCase() ?? null) : null;
}

/** A pull request whose title marks it a draft, as Forgejo reads it. */
const WIP = /^\s*(\[wip\]|wip:|\[draft\]|draft:)/i;

/** An issue or pull request as a card. Pull requests' details come from `pullDetails`. */
export function normaliseForgejo(
	host: string,
	repo: string,
	issue: ForgejoIssue,
	pull?: PullDetails,
): Card {
	const isPull = Boolean(issue.pull_request) || pull !== undefined || issue.head !== undefined;
	const merged = Boolean(issue.merged || issue.merged_at || issue.pull_request?.merged);
	const mergedAt = iso(issue.merged_at ?? issue.pull_request?.merged_at ?? null);
	const draft = Boolean(issue.draft ?? issue.pull_request?.draft) || WIP.test(issue.title);
	let state: CardState = issue.state;
	if (isPull && merged) state = "merged";
	else if (isPull && issue.state === "open" && draft) state = "draft";
	const name = repoFromUrl(issue.html_url, host) ?? repo.toLowerCase();
	const item = `#${issue.number}`;
	return {
		key: itemKey({ host, repo: name, item }),
		forge: "forgejo",
		host,
		repo: name,
		item,
		kind: isPull ? "pull" : "issue",
		title: issue.title,
		state,
		stateReason: null,
		labels: (issue.labels ?? []).map((label) => ({
			name: label.name,
			color: hexColor(label.color),
		})),
		assignees: (issue.assignees ?? []).map((a) => ({
			login: a.login,
			avatarUrl: a.avatar_url ?? "",
		})),
		author: issue.user ? { login: issue.user.login, avatarUrl: issue.user.avatar_url ?? "" } : null,
		comments: issue.comments ?? 0,
		reactions: 0,
		url: issue.html_url,
		updatedAt: iso(issue.updated_at),
		...(issue.created_at ? { createdAt: iso(issue.created_at) } : {}),
		...(issue.closed_at !== undefined ? { closedAt: iso(issue.closed_at) } : {}),
		...(isPull ? { mergedAt } : {}),
		...(issue.milestone !== undefined
			? {
					milestone: issue.milestone
						? { title: issue.milestone.title, dueOn: iso(issue.milestone.due_on) }
						: null,
				}
			: {}),
		...(isPull ? { pull: pull ?? basicPull(issue) } : {}),
	};
}

/** What a pull request's own payload says, without CI or reviews: `basic`, until they're fetched. */
function basicPull(pull: ForgejoIssue): PullDetails {
	return {
		detail: "basic",
		...sizeOf(pull),
		head: pull.head?.sha ?? null,
		checks: null,
		review: null,
		reviewers: (pull.requested_reviewers ?? []).map((r) => ({
			login: r.login,
			avatarUrl: r.avatar_url ?? "",
			state: "requested" as const,
		})),
		mergeable: mergeableOf(pull),
		linked: [],
	};
}

function sizeOf(pull: ForgejoIssue): Pick<PullDetails, "additions" | "deletions" | "changedFiles"> {
	return {
		...(typeof pull.additions === "number" ? { additions: pull.additions } : {}),
		...(typeof pull.deletions === "number" ? { deletions: pull.deletions } : {}),
		...(typeof pull.changed_files === "number" ? { changedFiles: pull.changed_files } : {}),
	};
}

function mergeableOf(pull: ForgejoIssue): PullDetails["mergeable"] {
	if (pull.merged || pull.state === "closed") return "unknown";
	return pull.mergeable === true
		? "mergeable"
		: pull.mergeable === false
			? "conflicting"
			: "unknown";
}

/** A commit's statuses as a CI rollup. */
export function checksFromStatus(status: CombinedStatus | null): Checks | null {
	if (!status) return null;
	const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
	const failing: Checks["failing"] = [];
	for (const entry of status.statuses ?? []) {
		const state = (entry.status ?? entry.state ?? "").toLowerCase();
		if (state === "success") counts.passed++;
		else if (state === "failure" || state === "error") {
			counts.failed++;
			if (failing.length < MAX_FAILING_CHECKS) {
				failing.push({ name: entry.context ?? "check", url: entry.target_url || null });
			}
		} else if (state === "warning" || state === "skipped") counts.skipped++;
		else counts.pending++;
	}
	return { state: checksState(counts), ...counts, failing };
}

/** Each reviewer's latest review, and what they add up to. */
export function reviewsOf(
	reviews: Review[],
	requested: ForgejoUser[],
): { review: ReviewDecision | null; reviewers: Reviewer[] } {
	const latest = new Map<string, Reviewer>();
	for (const r of requested) {
		latest.set(r.login, { login: r.login, avatarUrl: r.avatar_url ?? "", state: "requested" });
	}
	for (const r of reviews) {
		if (!r.user || r.dismissed) continue;
		const state = (r.state ?? "").toUpperCase();
		const mapped: Reviewer["state"] | null =
			state === "APPROVED"
				? "approved"
				: state === "REQUEST_CHANGES"
					? "changes_requested"
					: state === "COMMENT"
						? "commented"
						: null;
		if (!mapped) continue;
		// A comment after an approval doesn't take the approval back.
		const before = latest.get(r.user.login)?.state;
		if (mapped === "commented" && (before === "approved" || before === "changes_requested"))
			continue;
		latest.set(r.user.login, {
			login: r.user.login,
			avatarUrl: r.user.avatar_url ?? "",
			state: mapped,
		});
	}
	const reviewers = [...latest.values()];
	const review: ReviewDecision | null = reviewers.some((r) => r.state === "changes_requested")
		? "changes_requested"
		: reviewers.some((r) => r.state === "approved")
			? "approved"
			: reviewers.some((r) => r.state === "requested")
				? "review_required"
				: null;
	return { review, reviewers };
}

async function getJson<T>(
	api: RestApi,
	path: string,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
	const response = await send(api, path).catch(() => null);
	if (!response) return { ok: false, response: new Response(null, { status: 599 }) };
	if (!response.ok) return { ok: false, response };
	return { ok: true, value: await response.json<T>() };
}

/** One item, in full: the issue, and for a pull request its details, CI and reviews. */
async function fetchItem(
	api: RestApi,
	host: string,
	name: string,
	item: string,
): Promise<Card | MissingCard> {
	const key = itemKey({ host, repo: name, item });
	const number = item.slice(1);
	const base = `/repos/${segments(name)}`;
	try {
		const issue = await getJson<ForgejoIssue>(api, `${base}/issues/${number}`);
		if (!issue.ok) return { key, missing: true, reason: missingReason(issue.response) };
		if (!issue.value.pull_request) return normaliseForgejo(host, name, issue.value);
		const pull = await getJson<ForgejoIssue>(api, `${base}/pulls/${number}`);
		if (!pull.ok) return normaliseForgejo(host, name, issue.value);
		const merged = {
			...issue.value,
			...pull.value,
			labels: issue.value.labels,
			comments: issue.value.comments,
		};
		const sha = pull.value.head?.sha;
		const [status, reviews] = await Promise.all([
			sha && pull.value.state === "open"
				? getJson<CombinedStatus>(api, `${base}/commits/${encodeURIComponent(sha)}/status`)
				: Promise.resolve(null),
			getJson<Review[]>(api, `${base}/pulls/${number}/reviews`),
		]);
		const { review, reviewers } = reviewsOf(
			reviews.ok ? reviews.value : [],
			pull.value.requested_reviewers ?? [],
		);
		return normaliseForgejo(host, name, merged, {
			detail: "full",
			...sizeOf(pull.value),
			head: sha ?? null,
			checks: status?.ok ? checksFromStatus(status.value) : null,
			review,
			reviewers,
			mergeable: mergeableOf(pull.value),
			linked: [],
		});
	} catch {
		return { key, missing: true, reason: "error" };
	}
}

/** Items updated since `since`, newest first: one page, enough for a board's worth. */
async function updatedSince(
	api: RestApi,
	name: string,
	since: string,
	etag: string | null,
): Promise<
	| { status: "unchanged" }
	| { status: "changed"; etag: string | null; items: ForgejoIssue[] }
	| { status: "error"; retryAt?: number }
> {
	const params = new URLSearchParams({ state: "all", since, limit: "50" });
	const response = await send(
		api,
		`/repos/${segments(name)}/issues?${params.toString()}`,
		{},
	).catch(() => null);
	if (!response) return { status: "error" };
	if (etag && response.status === 304) return { status: "unchanged" };
	if (!response.ok) {
		const limit = rateLimitOf(response);
		return { status: "error", ...(limit ? { retryAt: limit.retryAt } : {}) };
	}
	return {
		status: "changed",
		etag: response.headers.get("etag"),
		items: await response.json<ForgejoIssue[]>(),
	};
}

function repoIdentity(host: string, repository: ForgejoRepository): RepoIdentity {
	return {
		forge: "forgejo",
		host,
		id: String(repository.id),
		name: repository.full_name.toLowerCase(),
		private: Boolean(repository.private || repository.internal),
	};
}

interface WebhookPayload {
	action?: string;
	issue?: ForgejoIssue;
	pull_request?: ForgejoIssue;
	repository?: ForgejoRepository;
	sha?: string;
	commit?: { id?: string };
}

function reply(body: unknown, status: number): WebhookResult {
	return { type: "response", response: Response.json(body, { status }) };
}

/** The host a delivery says it's from, by its repository's page. */
function hostOf(repository: ForgejoRepository | undefined): string | null {
	try {
		return repository?.html_url ? new URL(repository.html_url).host.toLowerCase() : null;
	} catch {
		return null;
	}
}

export const forgejo: ForgeAdapter = {
	id: "forgejo",
	capabilities: {
		subIssues: false,
		blockedBy: true,
		discussions: false,
		draftPulls: true,
		ciStatus: true,
		writes: FORGEJO_WRITES,
	},
	liveFromDeliveries: true,

	async resolveRepo(host, name, env) {
		const api = apiFor(env, host);
		if (!api) return "unsupported";
		const result = await getJson<ForgejoRepository>(api, `/repos/${segments(name)}`).catch(
			() => null,
		);
		if (!result) return "error";
		if (!result.ok) return missingReason(result.response) as MissingReason;
		return repoIdentity(host, result.value);
	},

	async fetchItems(refs, env, repo) {
		const results = await Promise.all(
			refs.map(async (ref: FetchRef): Promise<Card | MissingCard> => {
				const key = itemKey(ref);
				const api = apiFor(env, ref.host);
				if (!api || !/^#\d+$/.test(ref.item)) return { key, missing: true, reason: "unsupported" };
				return fetchItem(api, ref.host.toLowerCase(), repo?.name ?? ref.repo, ref.item);
			}),
		);
		return results;
	},

	async reconcile(repo, cards, env) {
		const api = apiFor(env, repo.host);
		if (!api || cards.length === 0) return [];
		const since = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
		const listed = await updatedSince(api, repo.name, since, null);
		if (listed.status !== "changed") return [];
		return refetchChanged(api, repo, cards, listed.items);
	},

	async poll(repo, cards, env, options): Promise<PollResult> {
		const api = apiFor(env, repo.host);
		if (!api) return { status: "error" };
		// Since the last poll, or (the first time) the oldest card.
		const oldest = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
		const since = options.since ?? oldest;
		const listed = await updatedSince(
			api,
			repo.name,
			since === "~" ? new Date().toISOString() : since,
			options.etag,
		);
		if (listed.status !== "changed") return listed;
		return {
			status: "changed",
			etag: listed.etag,
			cards: await refetchChanged(api, repo, cards, listed.items),
		};
	},

	// Tack can't tell who may read a repository that isn't public: nobody sees its cards.
	async canRead(repo) {
		return repo.private === false;
	},

	writable(repo, env) {
		const config = hostConfig(env, repo.host);
		return Boolean(config?.writes && config.token);
	},
	apply: (op, repo, _auth, env, options) => applyForgejo(op, repo, env, options),
	canWrite: (repo, _token, env, pusher) => canWriteForgejo(repo, env, pusher),
	repoMeta: (repo, env) => repoMetaForgejo(repo, env),
	listDirectory: (repo, path, env) => listDirectoryForgejo(repo, path, env),

	async receiveWebhook(request, env) {
		const body = await request.text();
		let payload: WebhookPayload;
		try {
			payload = JSON.parse(body) as WebhookPayload;
		} catch {
			return reply({ error: "invalid body" }, 400);
		}
		const host = hostOf(payload.repository);
		const config = host ? hostConfig(env, host) : null;
		if (!host || config?.forge !== "forgejo") return reply({ error: "unknown host" }, 403);
		if (!config.webhookSecret) return reply({ error: "webhook secret not configured" }, 403);
		const signature =
			request.headers.get("x-forgejo-signature") ?? request.headers.get("x-gitea-signature");
		if (!(await verifyHexSignature(config.webhookSecret, body, signature))) {
			return reply({ error: "invalid signature" }, 401);
		}
		const digest = await digestOf(body);
		const event =
			request.headers.get("x-forgejo-event") ?? request.headers.get("x-gitea-event") ?? "";
		const id =
			request.headers.get("x-forgejo-delivery") ??
			request.headers.get("x-gitea-delivery") ??
			crypto.randomUUID();
		if (!payload.repository?.id || !payload.repository.full_name) {
			return reply({ status: "ignored", reason: "no repository" }, 202);
		}
		const repo = repoIdentity(host, payload.repository);

		const cards: Card[] = [];
		const mentions: Record<string, ItemMention[]> = {};
		const items = new Set<string>();
		const commits = new Set<string>();
		if (payload.pull_request) {
			// Its CI and reviews aren't in the payload: read them again shortly.
			const pull = normaliseForgejo(host, repo.name, payload.pull_request, undefined);
			cards.push(pull);
			items.add(pull.item);
			const text = `${payload.pull_request.title}\n${payload.pull_request.body ?? ""}`;
			const found = mentionsIn(text, { host, repo: pull.repo, self: pull.key });
			if (found.length > 0) mentions[pull.key] = found;
		} else if (payload.issue) {
			const card = normaliseForgejo(host, repo.name, payload.issue);
			cards.push(card);
			if (card.kind === "pull") items.add(card.item);
		}
		if (event === "status") {
			const sha = payload.sha ?? payload.commit?.id;
			if (sha) commits.add(sha);
		}
		if (cards.length === 0 && items.size + commits.size === 0) {
			return reply({ status: "ignored", reason: "event" }, 202);
		}

		return {
			type: "delivery",
			delivery: {
				id,
				digest,
				event,
				action: payload.action ?? null,
				repo,
				payload: body,
				cards,
				...(items.size + commits.size > 0
					? { refetch: { items: [...items], commits: [...commits] } }
					: {}),
				...(Object.keys(mentions).length > 0 ? { mentions } : {}),
			},
		};
	},
};

/** Fresh cards for the cached ones a list says changed. */
async function refetchChanged(
	api: RestApi,
	repo: RepoIdentity,
	cards: Card[],
	listed: ForgejoIssue[],
): Promise<(Card | MissingCard)[]> {
	const cached = new Map(cards.map((card) => [card.item, card]));
	const changed = listed.filter((issue) => {
		const card = cached.get(`#${issue.number}`);
		return card && iso(issue.updated_at) > card.updatedAt;
	});
	return Promise.all(
		changed.map((issue) =>
			// Issues are all there; pull requests need their details.
			issue.pull_request
				? fetchItem(api, repo.host, repo.name, `#${issue.number}`)
				: Promise.resolve(normaliseForgejo(repo.host, repo.name, issue)),
		),
	);
}
