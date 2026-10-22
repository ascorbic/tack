import type { Check, Review, Thread } from "forges";
import { forgejo as forgejoProvider } from "forges/forgejo";
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
import { type ForgeHostConfig, hostConfig } from "./config.ts";
import type { ForgejoIssue, ForgejoRepository } from "./forgejo-api.ts";
import {
	applyForgejo,
	canWriteForgejo,
	FORGEJO_WRITES,
	listDirectoryForgejo,
	repoMetaForgejo,
} from "./forgejo-write.ts";
import { digestOf } from "./hmac.ts";
import { fetchForLibrary, missingOf, retryAtOf } from "./library.ts";
import { hexColor, iso, TIMEOUT_MS } from "./rest.ts";
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
//
// Reads and webhook signatures go through the `forges` library's Forgejo
// provider (see library.ts). Webhook deliveries are made into cards from
// their payload as Forgejo sent it: the library's view of a delivery leaves
// out assignees, milestones, comment counts and times, which a card shows.

type ForgejoProvider = ReturnType<typeof forgejoProvider>;

/** The library's provider for a host, with the instance's token for it if it has one. */
function providerFor(config: ForgeHostConfig): ForgejoProvider {
	return forgejoProvider({
		baseUrl: `https://${config.host}`,
		...(config.token ? { auth: { type: "token", token: config.token } } : {}),
		...(config.webhookSecret ? { webhookSecret: config.webhookSecret } : {}),
		fetch: fetchForLibrary,
		timeout: TIMEOUT_MS,
		userAgent: "tack",
	});
}

/** The provider for a host this instance serves with Forgejo, or null. */
function providerAt(env: Env, host: string): ForgejoProvider | null {
	const config = hostConfig(env, host);
	return config?.forge === "forgejo" ? providerFor(config) : null;
}

function repoRef(host: string, name: string) {
	const slash = name.indexOf("/");
	return {
		forge: "forgejo",
		instance: host,
		owner: name.slice(0, slash),
		name: name.slice(slash + 1),
	} as const;
}

/** `owner/name` from an item's page, which knows a renamed repository's new name. */
function repoFromUrl(url: string | undefined, host: string): string | null {
	const match = /^https?:\/\/([^/]+)\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/\d+/i.exec(url ?? "");
	return match && match[1]?.toLowerCase() === host ? (match[2]?.toLowerCase() ?? null) : null;
}

/** A pull request whose title marks it a draft, as Forgejo reads it. */
const WIP = /^\s*(\[wip\]|wip:|\[draft\]|draft:)/i;

/** An issue or pull request from a webhook's payload as a card. */
export function normaliseForgejo(host: string, repo: string, issue: ForgejoIssue): Card {
	const isPull = Boolean(issue.pull_request) || issue.head !== undefined;
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
		...(isPull
			? {
					pull: {
						detail: "basic",
						...(typeof issue.additions === "number" ? { additions: issue.additions } : {}),
						...(typeof issue.deletions === "number" ? { deletions: issue.deletions } : {}),
						...(typeof issue.changed_files === "number"
							? { changedFiles: issue.changed_files }
							: {}),
						head: issue.head?.sha ?? null,
						checks: null,
						review: null,
						reviewers: (issue.requested_reviewers ?? []).map((r) => ({
							login: r.login,
							avatarUrl: r.avatar_url ?? "",
							state: "requested" as const,
						})),
						mergeable: mergeableOf(issue),
						linked: [],
					},
				}
			: {}),
	};
}

/** What the pulls endpoint says about merging; the library's model doesn't carry it. */
function mergeableOf(pull: ForgejoIssue): PullDetails["mergeable"] {
	if (pull.merged || pull.state === "closed") return "unknown";
	return pull.mergeable === true
		? "mergeable"
		: pull.mergeable === false
			? "conflicting"
			: "unknown";
}

const isoOf = (date: Date | undefined): string | null => (date ? date.toISOString() : null);

/** An issue or pull request the library read, as a card. Pull requests' details come from `pullDetails`. */
function cardOf(host: string, repo: string, thread: Thread, pull?: PullDetails): Card {
	const isPull = thread.kind === "pull_request";
	const draft = thread.isDraft || WIP.test(thread.title);
	const state: CardState =
		thread.state === "merged"
			? "merged"
			: thread.state === "open"
				? isPull && draft
					? "draft"
					: "open"
				: "closed";
	const name = repoFromUrl(thread.url, host) ?? repo.toLowerCase();
	const item = `#${thread.ref.number}`;
	return {
		key: itemKey({ host, repo: name, item }),
		forge: "forgejo",
		host,
		repo: name,
		item,
		kind: isPull ? "pull" : "issue",
		title: thread.title,
		state,
		stateReason: null,
		labels: thread.labels.map((label) => ({ name: label.name, color: hexColor(label.colour) })),
		assignees: thread.assignees.map((a) => ({ login: a.login, avatarUrl: a.avatarUrl ?? "" })),
		author: thread.author
			? { login: thread.author.login, avatarUrl: thread.author.avatarUrl ?? "" }
			: null,
		comments: thread.commentCount ?? 0,
		reactions: 0,
		url: thread.url ?? "",
		updatedAt: isoOf(thread.updatedAt) ?? "",
		...(thread.createdAt ? { createdAt: thread.createdAt.toISOString() } : {}),
		closedAt: isoOf(thread.closedAt),
		...(isPull ? { mergedAt: isoOf(thread.mergedAt) } : {}),
		milestone: thread.milestone
			? { title: thread.milestone.title, dueOn: isoOf(thread.milestone.dueOn) }
			: null,
		...(isPull ? { pull } : {}),
	};
}

/** A commit's statuses as a CI rollup. */
export function checksFrom(checks: Check[]): Checks {
	const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
	const failing: Checks["failing"] = [];
	for (const check of checks) {
		if (check.state === "success") counts.passed++;
		else if (check.state === "failure") {
			counts.failed++;
			if (failing.length < MAX_FAILING_CHECKS) {
				failing.push({ name: check.name || "check", url: check.url ?? null });
			}
		} else if (check.state === "neutral" || check.stateRaw === "skipped") {
			// The library reads Forgejo's `skipped` as `unknown`, which would leave CI pending.
			counts.skipped++;
		} else counts.pending++;
	}
	return { state: checksState(counts), ...counts, failing };
}

const REVIEW_STATES: Partial<Record<Review["state"], Reviewer["state"]>> = {
	approved: "approved",
	changes_requested: "changes_requested",
	commented: "commented",
};

/** Each reviewer's latest review, and what they add up to. */
export function reviewsFrom(
	reviews: Review[],
	requested: Thread["reviewers"],
): { review: ReviewDecision | null; reviewers: Reviewer[] } {
	const latest = new Map<string, Reviewer>();
	for (const r of requested) {
		latest.set(r.actor.login, {
			login: r.actor.login,
			avatarUrl: r.actor.avatarUrl ?? "",
			state: "requested",
		});
	}
	for (const r of reviews) {
		// The library keeps a dismissed review's verdict; Forgejo says it no longer counts.
		if (!r.author || (r.raw as { dismissed?: boolean }).dismissed) continue;
		const mapped = REVIEW_STATES[r.state];
		if (!mapped) continue;
		// A comment after an approval doesn't take the approval back.
		const before = latest.get(r.author.login)?.state;
		if (mapped === "commented" && (before === "approved" || before === "changes_requested"))
			continue;
		latest.set(r.author.login, {
			login: r.author.login,
			avatarUrl: r.author.avatarUrl ?? "",
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

/** One item, in full: the issue, and for a pull request its details, CI and reviews. */
async function fetchItem(
	forge: ForgejoProvider,
	host: string,
	name: string,
	item: string,
): Promise<Card | MissingCard> {
	const key = itemKey({ host, repo: name, item });
	const repo = repoRef(host, name);
	const number = item.slice(1);
	let issue: Thread;
	try {
		issue = await forge.threads.get({ ...repo, repo, kind: "issue", number });
	} catch (error) {
		return { key, missing: true, reason: missingOf(error) };
	}
	if (issue.kind !== "pull_request") return cardOf(host, name, issue);
	const ref = { ...repo, repo, kind: "pull_request", number } as const;
	try {
		const [pull, reviews] = await Promise.all([
			forge.threads.get(ref),
			forge.threads
				.reviews(ref)
				.page()
				.then((page) => page.items)
				.catch(() => [] as Review[]),
		]);
		const raw = pull.raw as ForgejoIssue;
		const sha = pull.branches?.head.sha ?? raw.head?.sha;
		const checks =
			sha && pull.state === "open"
				? await forge.checks
						.list(repo, sha)
						.then((page) => checksFrom(page.items))
						.catch(() => null)
				: null;
		const { review, reviewers } = reviewsFrom(reviews, pull.reviewers);
		return cardOf(
			host,
			name,
			{ ...pull, labels: issue.labels, commentCount: issue.commentCount },
			{
				detail: "full",
				...(pull.stats?.additions !== undefined ? { additions: pull.stats.additions } : {}),
				...(pull.stats?.deletions !== undefined ? { deletions: pull.stats.deletions } : {}),
				...(pull.stats?.changedFileCount !== undefined
					? { changedFiles: pull.stats.changedFileCount }
					: {}),
				head: sha ?? null,
				checks,
				review,
				reviewers,
				mergeable: mergeableOf(raw),
				linked: [],
			},
		);
	} catch {
		return normaliseForgejo(host, name, issue.raw as ForgejoIssue);
	}
}

/** Items updated since `since`, newest first: one page, enough for a board's worth. */
async function updatedSince(
	forge: ForgejoProvider,
	host: string,
	name: string,
	since: string,
	etag: string | null,
): Promise<
	| { status: "unchanged" }
	| { status: "changed"; etag: string | null; items: Thread[] }
	| { status: "error"; retryAt?: number }
> {
	try {
		const page = await forge.threads
			.list(repoRef(host, name), {
				state: "all",
				since: new Date(since),
				perPage: 50,
				...(etag ? { cursor: { etag } } : {}),
			})
			.page();
		if (page.notModified) return { status: "unchanged" };
		return { status: "changed", etag: page.etag ?? null, items: page.items };
	} catch (error) {
		const retryAt = retryAtOf(error);
		return { status: "error", ...(retryAt ? { retryAt } : {}) };
	}
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
		const forge = providerAt(env, host);
		if (!forge) return "unsupported";
		try {
			const repo = await forge.repos.get(repoRef(host, name));
			return repoIdentity(host, repo.raw as ForgejoRepository);
		} catch (error) {
			return missingOf(error) as MissingReason;
		}
	},

	async fetchItems(refs, env, repo) {
		const results = await Promise.all(
			refs.map(async (ref: FetchRef): Promise<Card | MissingCard> => {
				const key = itemKey(ref);
				const forge = providerAt(env, ref.host);
				if (!forge || !/^#\d+$/.test(ref.item))
					return { key, missing: true, reason: "unsupported" };
				return fetchItem(forge, ref.host.toLowerCase(), repo?.name ?? ref.repo, ref.item);
			}),
		);
		return results;
	},

	async reconcile(repo, cards, env) {
		const forge = providerAt(env, repo.host);
		if (!forge || cards.length === 0) return [];
		const since = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
		const listed = await updatedSince(forge, repo.host, repo.name, since, null);
		if (listed.status !== "changed") return [];
		return refetchChanged(forge, repo, cards, listed.items);
	},

	async poll(repo, cards, env, options): Promise<PollResult> {
		const forge = providerAt(env, repo.host);
		if (!forge) return { status: "error" };
		// Since the last poll, or (the first time) the oldest card.
		const oldest = cards.reduce((min, card) => (card.updatedAt < min ? card.updatedAt : min), "~");
		const since = options.since ?? oldest;
		const listed = await updatedSince(
			forge,
			repo.host,
			repo.name,
			since === "~" ? new Date().toISOString() : since,
			options.etag,
		);
		if (listed.status !== "changed") return listed;
		return {
			status: "changed",
			etag: listed.etag,
			cards: await refetchChanged(forge, repo, cards, listed.items),
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
		if (!(await providerFor(config).webhooks.verify({ headers: request.headers, body }))) {
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
			const pull = normaliseForgejo(host, repo.name, payload.pull_request);
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
	forge: ForgejoProvider,
	repo: RepoIdentity,
	cards: Card[],
	listed: Thread[],
): Promise<(Card | MissingCard)[]> {
	const cached = new Map(cards.map((card) => [card.item, card]));
	const changed = listed.filter((thread) => {
		const card = cached.get(`#${thread.ref.number}`);
		return card && (isoOf(thread.updatedAt) ?? "") > card.updatedAt;
	});
	return Promise.all(
		changed.map((thread) =>
			// Issues are all there; pull requests need their details.
			thread.kind === "pull_request"
				? fetchItem(forge, repo.host, repo.name, `#${thread.ref.number}`)
				: Promise.resolve(cardOf(repo.host, repo.name, thread)),
		),
	);
}
