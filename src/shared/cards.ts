// Normalised GitHub card data. This is what travels to clients over the
// board's custom-message channel; it never goes into the Yjs document.

export type CardState = "open" | "closed" | "merged" | "draft";

export interface Card {
	/** `owner/repo#number`, lowercased owner/repo. */
	key: string;
	kind: "issue" | "pull";
	repo: string;
	number: number;
	title: string;
	state: CardState;
	/** GitHub's close reason for issues: completed, not_planned, duplicate. */
	stateReason: string | null;
	labels: { name: string; color: string }[];
	assignees: { login: string; avatarUrl: string }[];
	author: { login: string; avatarUrl: string } | null;
	comments: number;
	reactions: number;
	url: string;
	updatedAt: string;
}

/** A card the server couldn't load, e.g. a private repo or a 404. */
export interface MissingCard {
	key: string;
	missing: true;
	reason: "not_found" | "forbidden" | "error";
}

export type CardMessage =
	| { type: "card"; card: Card }
	| { type: "card-missing"; card: MissingCard }
	| { type: "cards"; cards: (Card | MissingCard)[] };

const REF_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/;

export interface CardRef {
	owner: string;
	repo: string;
	number: number;
}

export function cardKey(ref: CardRef): string {
	return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

export function repoKey(key: string): string {
	return key.slice(0, key.indexOf("#"));
}

/** Parse `owner/repo#123` or an issue/PR URL. */
export function parseRef(input: string): CardRef | null {
	const text = input.trim();
	const match = REF_RE.exec(text) ?? URL_RE.exec(text);
	if (!match) return null;
	const [, owner, repo, number] = match;
	if (!owner || !repo || !number) return null;
	return { owner, repo, number: Number(number) };
}

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

export function normaliseIssue(
	repoFullName: string,
	issue: GitHubIssueLike,
	isPull = Boolean(issue.pull_request),
): Card {
	const [owner = "", repo = ""] = repoFullName.split("/");
	const merged = Boolean(issue.merged || issue.merged_at || issue.pull_request?.merged_at);
	let state: CardState = issue.state;
	if (isPull && merged) state = "merged";
	else if (isPull && issue.state === "open" && issue.draft) state = "draft";

	return {
		key: cardKey({ owner, repo, number: issue.number }),
		kind: isPull ? "pull" : "issue",
		repo: repoFullName.toLowerCase(),
		number: issue.number,
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

export function isMissing(card: Card | MissingCard): card is MissingCard {
	return "missing" in card;
}
