import { orderCounts } from "../../shared/reactions.ts";
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
	type GitLabItem,
	type GitLabPipeline,
	type GitLabProject,
	type GitLabUser,
	gitlabApiFor as apiFor,
	projectRef,
} from "./gitlab-api.ts";
import {
	applyGitLab,
	canWriteGitLab,
	GITLAB_WRITES,
	listDirectoryGitLab,
	repoMetaGitLab,
} from "./gitlab-write.ts";
import { digestOf, sameSecret } from "./hmac.ts";
import { rateLimitOf } from "./rateLimit.ts";
import { hexColor, iso, missingReason, type RestApi, send } from "./rest.ts";
import type {
	FetchRef,
	ForgeAdapter,
	MissingReason,
	PollResult,
	RepoIdentity,
	WebhookResult,
} from "./types.ts";

// GitLab (gitlab.com, and self-hosted instances), #65. Issues are `#12` and
// merge requests `!12`, as GitLab writes them, in projects nested in groups
// as deep as they like: `gitlab.com/group/subgroup/project!12`. Reads use the
// instance's token for the host, or none (public projects only); never a
// viewer's GitHub token. Webhooks are set up by hand, on a project or a
// group, pointing at `/webhooks/gitlab` with the host's secret as the token
// (see config.ts). Confidential issues are never shown, even in public projects.

/** How many items one list request can ask for. */
const PAGE = 100;

/** A project's path from an item's page: `group/sub/project` from `…/group/sub/project/-/issues/3`. */
function repoFromUrl(url: string | undefined, host: string): string | null {
	const match =
		/^https?:\/\/([^/]+)\/(.+?)\/(?:-\/)?(?:issues|merge_requests|work_items)\/\d+/i.exec(
			url ?? "",
		);
	return match && match[1]?.toLowerCase() === host ? (match[2]?.toLowerCase() ?? null) : null;
}

function person(user: GitLabUser): { login: string; avatarUrl: string } {
	return { login: user.username, avatarUrl: user.avatar_url ?? "" };
}

/** An issue or merge request as a card. Merge requests' details come from `pullDetails`. */
export function normaliseGitLab(
	host: string,
	repo: string,
	kind: "issue" | "pull",
	item: GitLabItem,
	pull?: PullDetails,
): Card {
	let state: CardState =
		item.state === "merged" ? "merged" : item.state === "opened" ? "open" : "closed";
	if (kind === "pull" && state === "open" && (item.draft || item.work_in_progress)) state = "draft";
	const name = repoFromUrl(item.web_url, host) ?? repo.toLowerCase();
	const ref = `${kind === "pull" ? "!" : "#"}${item.iid}`;
	const upvotes = item.upvotes ?? 0;
	return {
		key: itemKey({ host, repo: name, item: ref }),
		forge: "gitlab",
		host,
		repo: name,
		item: ref,
		kind,
		title: item.title,
		state,
		stateReason: null,
		labels: (item.labels ?? []).map((label) =>
			typeof label === "string"
				? { name: label, color: "cccccc" }
				: { name: label.name, color: hexColor(label.color) },
		),
		assignees: (item.assignees ?? []).map(person),
		author: item.author ? person(item.author) : null,
		comments: item.user_notes_count ?? 0,
		reactions: upvotes + (item.downvotes ?? 0),
		// GitLab counts 👍 and 👎 on the item itself; other award emoji take a request each.
		reactionCounts: orderCounts([
			{ emoji: "👍", count: upvotes },
			{ emoji: "👎", count: item.downvotes ?? 0 },
		]),
		thumbsUp: { count: upvotes },
		url: item.web_url,
		updatedAt: iso(item.updated_at),
		...(item.created_at ? { createdAt: iso(item.created_at) } : {}),
		...(item.closed_at !== undefined
			? { closedAt: iso(item.closed_at ?? item.merged_at ?? null) }
			: {}),
		...(kind === "pull" ? { mergedAt: iso(item.merged_at ?? null) } : {}),
		...(item.milestone !== undefined
			? {
					milestone: item.milestone
						? { title: item.milestone.title, dueOn: iso(item.milestone.due_date ?? null) }
						: null,
				}
			: {}),
		...(kind === "pull" ? { pull: pull ?? basicPull(item) } : {}),
	};
}

/** What a merge request's own fields say, without its pipeline or reviews. */
function basicPull(mr: GitLabItem): PullDetails {
	return {
		detail: "basic",
		...changes(mr),
		head: mr.sha ?? null,
		checks: null,
		review: null,
		reviewers: (mr.reviewers ?? []).map((r) => ({ ...person(r), state: "requested" as const })),
		mergeable: mergeableOf(mr),
		linked: [],
	};
}

/** GitLab counts changed files as a string, "1000+" past its limit. */
function changes(mr: GitLabItem): Pick<PullDetails, "changedFiles"> {
	const count = Number.parseInt(mr.changes_count ?? "", 10);
	return Number.isFinite(count) ? { changedFiles: count } : {};
}

function mergeableOf(mr: GitLabItem): PullDetails["mergeable"] {
	if (mr.state !== "opened") return "unknown";
	if (mr.has_conflicts || mr.detailed_merge_status === "conflict") return "conflicting";
	return mr.detailed_merge_status === "mergeable" ? "mergeable" : "unknown";
}

const PENDING = new Set([
	"created",
	"waiting_for_resource",
	"preparing",
	"pending",
	"running",
	"scheduled",
	"waiting_for_callback",
]);

/** A pipeline as a CI rollup: its failed jobs by name, or the pipeline as one check. */
export function checksFromPipeline(
	pipeline: GitLabPipeline | null | undefined,
	failedJobs: { name: string; web_url?: string }[] = [],
): Checks | null {
	if (!pipeline) return null;
	const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
	const failing: Checks["failing"] = [];
	if (pipeline.status === "success") counts.passed = 1;
	else if (pipeline.status === "failed") {
		counts.failed = Math.max(1, failedJobs.length);
		const jobs = failedJobs.length
			? failedJobs
			: [{ name: `Pipeline #${pipeline.id}`, web_url: pipeline.web_url }];
		for (const job of jobs.slice(0, MAX_FAILING_CHECKS)) {
			failing.push({ name: job.name, url: job.web_url ?? null });
		}
	} else if (PENDING.has(pipeline.status)) counts.pending = 1;
	else counts.skipped = 1;
	return { state: checksState(counts), ...counts, failing };
}

/** Reviewers' states (GitLab 16+), and what they add up to. */
export function reviewsOf(
	mr: GitLabItem,
	states: { user: GitLabUser; state?: string }[] | null,
): { review: ReviewDecision | null; reviewers: Reviewer[] } {
	const reviewers: Reviewer[] = states
		? states.map(({ user, state }) => ({
				...person(user),
				state:
					state === "approved"
						? "approved"
						: state === "requested_changes"
							? "changes_requested"
							: state === "reviewed"
								? "commented"
								: "requested",
			}))
		: (mr.reviewers ?? []).map((r) => ({ ...person(r), state: "requested" as const }));
	const review: ReviewDecision | null =
		mr.detailed_merge_status === "requested_changes" ||
		reviewers.some((r) => r.state === "changes_requested")
			? "changes_requested"
			: mr.detailed_merge_status === "not_approved"
				? "review_required"
				: reviewers.length > 0 && reviewers.every((r) => r.state === "approved")
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
	if (!response) return { ok: false, response: new Response(null, { status: 503 }) };
	if (!response.ok) return { ok: false, response };
	return { ok: true, value: await response.json<T>() };
}

/** Issues by number, in lists of up to a hundred, with their labels' colours. */
async function fetchIssues(
	api: RestApi,
	host: string,
	repo: { id?: string; name: string },
	numbers: number[],
): Promise<Map<number, Card | MissingCard>> {
	const results = new Map<number, Card | MissingCard>();
	const key = (n: number) => itemKey({ host, repo: repo.name, item: `#${n}` });
	for (let i = 0; i < numbers.length; i += PAGE) {
		const chunk = numbers.slice(i, i + PAGE);
		const params = new URLSearchParams({ with_labels_details: "true", per_page: String(PAGE) });
		for (const n of chunk) params.append("iids[]", String(n));
		const listed = await getJson<GitLabItem[]>(
			api,
			`/projects/${projectRef(repo)}/issues?${params.toString()}`,
		);
		if (!listed.ok) {
			const reason = missingReason(listed.response);
			for (const n of chunk) results.set(n, { key: key(n), missing: true, reason });
			continue;
		}
		const found = new Map(listed.value.map((issue) => [issue.iid, issue]));
		for (const n of chunk) {
			const issue = found.get(n);
			results.set(
				n,
				!issue
					? { key: key(n), missing: true, reason: "not_found" }
					: issue.confidential
						? // Only the project's members may read it: never on a board.
							{ key: key(n), missing: true, reason: "forbidden" }
						: normaliseGitLab(host, repo.name, "issue", issue),
			);
		}
	}
	return results;
}

/** One merge request in full: its pipeline, failed jobs and reviewers. */
async function fetchMergeRequest(
	api: RestApi,
	host: string,
	repo: { id?: string; name: string },
	n: number,
	labels: Map<number, GitLabItem["labels"]>,
): Promise<Card | MissingCard> {
	const key = itemKey({ host, repo: repo.name, item: `!${n}` });
	const project = `/projects/${projectRef(repo)}`;
	const mr = await getJson<GitLabItem>(api, `${project}/merge_requests/${n}`);
	if (!mr.ok) return { key, missing: true, reason: missingReason(mr.response) };
	const value = { ...mr.value, labels: labels.get(n) ?? mr.value.labels };
	const pipeline = value.state === "opened" ? value.head_pipeline : null;
	const [jobs, reviewers] = await Promise.all([
		pipeline?.status === "failed"
			? getJson<{ name: string; web_url?: string }[]>(
					api,
					`${project}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=${MAX_FAILING_CHECKS}`,
				)
			: Promise.resolve(null),
		getJson<{ user: GitLabUser; state?: string }[]>(
			api,
			`${project}/merge_requests/${n}/reviewers`,
		),
	]);
	const { review, reviewers: people } = reviewsOf(value, reviewers.ok ? reviewers.value : null);
	return normaliseGitLab(host, repo.name, "pull", value, {
		detail: "full",
		...changes(value),
		head: value.sha ?? null,
		checks: checksFromPipeline(pipeline, jobs?.ok ? jobs.value : []),
		review,
		reviewers: people,
		mergeable: mergeableOf(value),
		linked: [],
	});
}

/** Merge requests by number: one list for their labels' colours, then each in full. */
async function fetchMergeRequests(
	api: RestApi,
	host: string,
	repo: { id?: string; name: string },
	numbers: number[],
): Promise<Map<number, Card | MissingCard>> {
	const labels = new Map<number, GitLabItem["labels"]>();
	for (let i = 0; i < numbers.length; i += PAGE) {
		const params = new URLSearchParams({ with_labels_details: "true", per_page: String(PAGE) });
		for (const n of numbers.slice(i, i + PAGE)) params.append("iids[]", String(n));
		const listed = await getJson<GitLabItem[]>(
			api,
			`/projects/${projectRef(repo)}/merge_requests?${params.toString()}`,
		);
		if (listed.ok) for (const mr of listed.value) labels.set(mr.iid, mr.labels);
	}
	const cards = await Promise.all(
		numbers.map((n) =>
			fetchMergeRequest(api, host, repo, n, labels).catch((): MissingCard => ({
				key: itemKey({ host, repo: repo.name, item: `!${n}` }),
				missing: true,
				reason: "error",
			})),
		),
	);
	return new Map(numbers.map((n, i) => [n, cards[i] as Card | MissingCard]));
}

/** Items in one project, by their references (`#12`, `!3`). */
export async function fetchGitLab(
	api: RestApi,
	host: string,
	repo: { id?: string; name: string },
	items: string[],
): Promise<Map<string, Card | MissingCard>> {
	const issues = items.filter((item) => /^#\d+$/.test(item)).map((item) => Number(item.slice(1)));
	const mrs = items.filter((item) => /^!\d+$/.test(item)).map((item) => Number(item.slice(1)));
	const [issueCards, mrCards] = await Promise.all([
		issues.length ? fetchIssues(api, host, repo, issues).catch(() => new Map()) : new Map(),
		mrs.length ? fetchMergeRequests(api, host, repo, mrs).catch(() => new Map()) : new Map(),
	]);
	const results = new Map<string, Card | MissingCard>();
	for (const [n, card] of issueCards) results.set(`#${n}`, card);
	for (const [n, card] of mrCards) results.set(`!${n}`, card);
	return results;
}

/** Issues and merge requests updated since `since`, by reference. */
async function updatedSince(
	api: RestApi,
	repo: RepoIdentity,
	since: string,
): Promise<
	{ status: "changed"; items: Map<string, string> } | { status: "error"; retryAt?: number }
> {
	const params = new URLSearchParams({
		updated_after: since,
		order_by: "updated_at",
		sort: "desc",
		per_page: String(PAGE),
	});
	const items = new Map<string, string>();
	for (const [kind, prefix] of [
		["issues", "#"],
		["merge_requests", "!"],
	] as const) {
		const response = await send(
			api,
			`/projects/${projectRef(repo)}/${kind}?${params.toString()}`,
		).catch(() => null);
		if (!response?.ok) {
			const limit = response ? rateLimitOf(response) : null;
			return { status: "error", ...(limit ? { retryAt: limit.retryAt } : {}) };
		}
		for (const item of await response.json<GitLabItem[]>()) {
			items.set(`${prefix}${item.iid}`, iso(item.updated_at));
		}
	}
	return { status: "changed", items };
}

/** Fresh cards for the cached ones that changed since `since`. */
async function changedSince(
	api: RestApi,
	repo: RepoIdentity,
	cards: Card[],
	since: string,
): Promise<PollResult> {
	const listed = await updatedSince(api, repo, since);
	if (listed.status === "error") return listed;
	const changed = cards
		.filter((card) => {
			const updated = listed.items.get(card.item);
			return updated !== undefined && updated > card.updatedAt;
		})
		.map((card) => card.item);
	if (changed.length === 0) return { status: "changed", etag: null, cards: [] };
	const fresh = await fetchGitLab(api, repo.host, repo, changed);
	return { status: "changed", etag: null, cards: [...fresh.values()] };
}

function repoIdentity(
	host: string,
	project: Pick<GitLabProject, "id" | "path_with_namespace"> & {
		visibility?: string;
		visibility_level?: number;
	},
): RepoIdentity {
	const visibility =
		project.visibility ??
		(project.visibility_level === 20
			? "public"
			: project.visibility_level === undefined
				? undefined
				: "private");
	return {
		forge: "gitlab",
		host,
		id: String(project.id),
		name: project.path_with_namespace.toLowerCase(),
		...(visibility ? { private: visibility !== "public" } : {}),
	};
}

interface WebhookPayload {
	object_kind?: string;
	event_type?: string;
	project?: {
		id?: number;
		path_with_namespace?: string;
		web_url?: string;
		visibility_level?: number;
	};
	object_attributes?: {
		iid?: number;
		title?: string;
		description?: string | null;
		action?: string;
		confidential?: boolean;
		noteable_type?: string;
		sha?: string;
	};
	issue?: { iid?: number; confidential?: boolean };
	merge_request?: { iid?: number };
}

function reply(body: unknown, status: number): WebhookResult {
	return { type: "response", response: Response.json(body, { status }) };
}

function hostOf(url: string | undefined): string | null {
	try {
		return url ? new URL(url).host.toLowerCase() : null;
	} catch {
		return null;
	}
}

export const gitlab: ForgeAdapter = {
	id: "gitlab",
	capabilities: {
		subIssues: false,
		// Blocking links are a paid GitLab feature: not offered.
		blockedBy: false,
		discussions: false,
		draftPulls: true,
		ciStatus: true,
		writes: GITLAB_WRITES,
	},
	liveFromDeliveries: true,

	async resolveRepo(host, name, env) {
		const api = apiFor(env, host);
		if (!api) return "unsupported";
		const result = await getJson<GitLabProject>(api, `/projects/${projectRef(name)}`).catch(
			() => null,
		);
		if (!result) return "error";
		if (!result.ok) return missingReason(result.response) as MissingReason;
		return repoIdentity(host, result.value);
	},

	async fetchItems(refs, env, repo) {
		const first = refs[0];
		if (!first) return [];
		const host = first.host.toLowerCase();
		const api = apiFor(env, host);
		const fetched =
			api && (repo || first.repo)
				? await fetchGitLab(
						api,
						host,
						repo ?? { name: first.repo },
						refs.map((ref) => ref.item),
					)
				: new Map<string, Card | MissingCard>();
		return refs.map(
			(ref: FetchRef): Card | MissingCard =>
				fetched.get(ref.item) ?? {
					key: itemKey(ref),
					missing: true,
					reason: api ? "error" : "unsupported",
				},
		);
	},

	async reconcile(repo, cards, env) {
		const api = apiFor(env, repo.host);
		if (!api || cards.length === 0) return [];
		const oldest = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
		const result = await changedSince(api, repo, cards, oldest);
		return result.status === "changed" ? result.cards : [];
	},

	async poll(repo, cards, env, options) {
		const api = apiFor(env, repo.host);
		if (!api) return { status: "error" };
		const oldest = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
		return changedSince(api, repo, cards, options.since ?? oldest);
	},

	// Tack can't tell who may read a project that isn't public: nobody sees its cards.
	async canRead(repo) {
		return repo.private === false;
	},

	writable(repo, env) {
		const config = hostConfig(env, repo.host);
		return Boolean(config?.writes && config.token);
	},
	apply: (op, repo, _auth, env, options) => applyGitLab(op, repo, env, options),
	canWrite: (repo, _token, env, pusher) => canWriteGitLab(repo, env, pusher),
	repoMeta: (repo, env) => repoMetaGitLab(repo, env),
	listDirectory: (repo, path, env) => listDirectoryGitLab(repo, path, env),

	async receiveWebhook(request, env) {
		const body = await request.text();
		let payload: WebhookPayload;
		try {
			payload = JSON.parse(body) as WebhookPayload;
		} catch {
			return reply({ error: "invalid body" }, 400);
		}
		const host = hostOf(payload.project?.web_url);
		const config = host ? hostConfig(env, host) : null;
		if (!host || config?.forge !== "gitlab") return reply({ error: "unknown host" }, 403);
		if (!config.webhookSecret) return reply({ error: "webhook secret not configured" }, 403);
		if (!(await sameSecret(config.webhookSecret, request.headers.get("x-gitlab-token")))) {
			return reply({ error: "invalid token" }, 401);
		}
		const digest = await digestOf(body);
		const event = request.headers.get("x-gitlab-event") ?? payload.object_kind ?? "";
		const project = payload.project;
		if (!project?.id || !project.path_with_namespace) {
			return reply({ status: "ignored", reason: "no repository" }, 202);
		}
		const repo = repoIdentity(host, {
			id: project.id,
			path_with_namespace: project.path_with_namespace,
			...(project.visibility_level !== undefined
				? { visibility_level: project.visibility_level }
				: {}),
		});

		// Which items it's about. Payloads leave things out (comment counts, the
		// author's avatar), so they're read in full, here and now, with the
		// instance's token; whatever can't be read is read again shortly instead.
		const attributes = payload.object_attributes ?? {};
		const items = new Set<string>();
		const commits = new Set<string>();
		const kind = payload.object_kind;
		if ((kind === "issue" || kind === "work_item") && attributes.iid)
			items.add(`#${attributes.iid}`);
		if (kind === "merge_request" && attributes.iid) items.add(`!${attributes.iid}`);
		if (kind === "note") {
			if (payload.issue?.iid) items.add(`#${payload.issue.iid}`);
			if (payload.merge_request?.iid) items.add(`!${payload.merge_request.iid}`);
		}
		if (kind === "pipeline") {
			if (payload.merge_request?.iid) items.add(`!${payload.merge_request.iid}`);
			if (attributes.sha) commits.add(attributes.sha);
		}
		if (items.size + commits.size === 0) return reply({ status: "ignored", reason: "event" }, 202);

		const api = apiFor(env, host);
		const cards: Card[] = [];
		const later = new Set<string>();
		if (api && kind !== "pipeline") {
			const fetched = await fetchGitLab(api, host, repo, [...items]).catch(() => new Map());
			for (const item of items) {
				const card = fetched.get(item);
				if (card && !("missing" in card)) cards.push(card);
				else later.add(item);
			}
		} else {
			for (const item of items) later.add(item);
		}

		const mentions: Record<string, ItemMention[]> = {};
		const pull = kind === "merge_request" ? cards.find((card) => card.kind === "pull") : undefined;
		if (pull) {
			const text = `${attributes.title ?? pull.title}\n${attributes.description ?? ""}`;
			const found = mentionsIn(text, { host, repo: pull.repo, self: pull.key });
			if (found.length > 0) mentions[pull.key] = found;
		}

		return {
			type: "delivery",
			delivery: {
				id:
					request.headers.get("idempotency-key") ??
					request.headers.get("x-gitlab-event-uuid") ??
					crypto.randomUUID(),
				digest,
				event,
				action: attributes.action ?? null,
				repo,
				payload: body,
				cards,
				...(later.size + commits.size > 0
					? { refetch: { items: [...later], commits: [...commits] } }
					: {}),
				...(Object.keys(mentions).length > 0 ? { mentions } : {}),
			},
		};
	},
};
