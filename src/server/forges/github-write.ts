// Writing to GitHub (M2): every `Operation`, plus write access, what a
// repository offers to write with, and directory listings.
//
// Writes made with a person's own (user-to-server) token show as theirs,
// "via Tack", on GitHub; writes with an installation token show as the
// app's bot. Either way the app must be installed on the repository: user
// tokens are bounded by the installation's permissions.
//
// Nothing here throws for GitHub's errors: they come back as `ApplyResult`s
// with a message a person can act on, and rate limits come back retryable,
// with when to try again. Retries are safe: adding labels or assignees,
// sub-issues and dependencies check what's already there, and creates
// (issues, comments, pull requests, discussions) look for what an earlier,
// unanswered attempt made before making it again (`ApplyOptions.retryOf`).

import type { Operation, PushAs, Target } from "../../shared/changes.ts";
import type { Label, Milestone, RepoMeta } from "../../shared/push.ts";
import { itemKey, parseKey } from "../../shared/refs.ts";
import { isInstalled, repoToken } from "../github/tokens.ts";
import type { ApplyOptions, ApplyResult, ReadAuth, RepoIdentity, WriteAuth } from "./types.ts";

const HOST = "github.com";
const API = "https://api.github.com";
const GRAPHQL = "https://api.github.com/graphql";
/** Give up on a request that hasn't answered in this long (and say it may have gone through). */
const TIMEOUT_MS = 20_000;
/** GitHub's advice for secondary rate limits with no `retry-after`: wait at least a minute. */
const SECONDARY_WAIT_MS = 60_000;
/** An earlier attempt's creation counts as ours if it's at most this much older than the attempt. */
const RETRY_SLACK_MS = 60_000;

type Failure = Extract<ApplyResult, { ok: false }>;

/** A refusal from GitHub, kept so it can be explained for whoever pushed. */
type Refusal = { status: number; message: string; what: string };

class WriteFailure extends Error {
	constructor(
		readonly failure: Failure,
		readonly refusal?: Refusal,
	) {
		super(failure.error);
	}
}

/** Throw what an error response says, keeping the refusal behind it. */
async function refused(response: Response, what: string): Promise<never> {
	const message = await messageOf(response.clone());
	throw new WriteFailure(await failureFrom(response, what), {
		status: response.status,
		message,
		what,
	});
}

function fail(error: string, retryable = false, detail?: string): never {
	throw new WriteFailure({ ok: false, error, retryable, ...(detail ? { detail } : {}) });
}

function headers(token: string | null, json = false): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		"user-agent": "tack",
		"x-github-api-version": "2022-11-28",
		...(json ? { "content-type": "application/json" } : {}),
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

interface CallOptions {
	method?: string;
	body?: unknown;
	/** Return null for a 404, rather than failing. */
	allow404?: boolean;
}

async function send(token: string | null, url: string, options: CallOptions): Promise<Response> {
	try {
		return await fetch(url, {
			method: options.method ?? "GET",
			headers: headers(token, options.body !== undefined),
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		fail(
			timedOut
				? "GitHub didn't answer in time. Tack will check whether it went through before trying again."
				: "Couldn't reach GitHub.",
			true,
		);
	}
}

/**
 * Call the REST API. `what` finishes "Couldn't …" in error messages, e.g.
 * "add labels to acme/widgets#12".
 */
async function rest<T>(
	token: string | null,
	path: string,
	what: string,
	options: CallOptions = {},
): Promise<T> {
	const response = await send(token, `${API}${path}`, options);
	if (response.ok) {
		if (response.status === 204) return null as T;
		const text = await response.text();
		return (text ? JSON.parse(text) : null) as T;
	}
	if (response.status === 404 && options.allow404) return null as T;
	return refused(response, what);
}

/**
 * "GitHub is rate limiting Tack until 14:05 UTC": when, without a timestamp
 * nobody reads.
 */
function rateLimited(retryAt: number): string {
	return `GitHub is rate limiting Tack until ${new Date(retryAt).toISOString().slice(11, 16)} UTC, so it'll try again then.`;
}

/**
 * Turn an error response into something a person can act on: what went
 * wrong in plain words, and what to do about it. GitHub's own words, which
 * are written for developers ("Resource not accessible by integration"),
 * go in `detail`.
 */
export async function failureFrom(response: Response, what: string): Promise<Failure> {
	const message = await messageOf(response);
	const status = response.status;
	const detail = `GitHub said (${status})${message ? `: ${message}` : ""}`;
	const retryAt = rateLimitedUntil(response, message);
	if (retryAt !== null) {
		return { ok: false, error: rateLimited(retryAt), retryable: true, retryAt, detail };
	}
	if (status >= 500) {
		return {
			ok: false,
			error: `GitHub had a problem on its side and couldn't ${what}. Tack will try again.`,
			retryable: true,
			detail,
		};
	}
	return { ok: false, error: explain(status, message, what), retryable: false, detail };
}

/** What an error response says: its message and any errors under it. */
async function messageOf(response: Response): Promise<string> {
	const body = await response
		.json<{ message?: string; errors?: ({ message?: string; code?: string } | string)[] }>()
		.catch(() => null);
	const details = (body?.errors ?? [])
		.map((e) => (typeof e === "string" ? e : (e.message ?? e.code ?? "")))
		.filter(Boolean)
		.join("; ");
	return [body?.message, details].filter(Boolean).join(": ");
}

/**
 * GitHub's refusals, in plain words, with what to do. `as` is who was
 * writing: a refusal means something different for a person than for the app.
 */
export function explain(status: number, message: string, what: string, as: PushAs = "app"): string {
	if (status === 401)
		return "GitHub didn't accept your sign-in any more. Sign in again, then retry.";
	if (status === 403) {
		if (as === "user") {
			return `GitHub didn't let you ${what}. Check you can write to the repository and that Tack's app has access to it, or push as Tack's bot.`;
		}
		return /not accessible by integration/i.test(message)
			? `Tack's GitHub App doesn't have permission to ${what}. An owner of the repository may need to accept the app's new permissions, or give it access to this repository, in GitHub's settings.`
			: `GitHub didn't let Tack ${what}. Check that Tack's app can write to the repository.`;
	}
	if (status === 404) return `Couldn't ${what}: it's been deleted or moved, or Tack can't see it.`;
	if (status === 410) return `Couldn't ${what}: issues are turned off in this repository.`;
	if (status === 422) {
		if (/assignee|could not be assigned/i.test(message)) {
			return `Couldn't ${what}: someone can't be assigned there. People need access to the repository to be assigned.`;
		}
		if (/milestone/i.test(message)) {
			return `Couldn't ${what}: that milestone is closed or gone. Pick another, then retry.`;
		}
		if (/label/i.test(message)) {
			return `Couldn't ${what}: GitHub wouldn't take one of the labels. Check it still exists.`;
		}
		if (/already has a parent/i.test(message)) {
			return `Couldn't ${what}: it's already a sub-issue of another issue. Take it off that one on GitHub first.`;
		}
		if (/already exists|already (been )?(added|taken)/i.test(message)) {
			return `Couldn't ${what}: it's already there.`;
		}
		return `Couldn't ${what}: GitHub said something in it isn't valid.`;
	}
	return `Couldn't ${what} (GitHub answered ${status}).`;
}

/** When a rate limit lifts, if this response is one. */
function rateLimitedUntil(response: Response, message: string): number | null {
	if (response.status !== 403 && response.status !== 429) return null;
	const now = Date.now();
	const retryAfter = Number(response.headers.get("retry-after"));
	if (retryAfter > 0) return now + retryAfter * 1000;
	if (response.headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(response.headers.get("x-ratelimit-reset"));
		return reset > 0 ? Math.max(reset * 1000, now + 1000) : now + SECONDARY_WAIT_MS;
	}
	if (response.status === 429 || /rate limit|abuse/i.test(message)) return now + SECONDARY_WAIT_MS;
	return null;
}

interface GraphQLError {
	type?: string;
	message?: string;
}

async function graphql<T>(
	token: string | null,
	operationName: string,
	query: string,
	variables: Record<string, unknown>,
	what: string,
): Promise<T> {
	const response = await send(token, GRAPHQL, {
		method: "POST",
		body: { query, variables, operationName },
	});
	if (!response.ok) return refused(response, what);
	const body = await response.json<{ data?: T | null; errors?: GraphQLError[] }>();
	const errors = body.errors ?? [];
	if (errors.some((error) => error.type === "RATE_LIMITED")) {
		const retryAt = rateLimitedUntil(response, "rate limit") ?? Date.now() + SECONDARY_WAIT_MS;
		throw new WriteFailure({ ok: false, error: rateLimited(retryAt), retryable: true, retryAt });
	}
	if (errors.length > 0 || !body.data) {
		const message = errors.map((error) => error.message ?? error.type).join("; ");
		const status = errors.some((error) => error.type === "FORBIDDEN")
			? 403
			: errors.some((error) => error.type === "NOT_FOUND")
				? 404
				: null;
		throw new WriteFailure(
			{
				ok: false,
				error: status ? explain(status, message, what) : `Couldn't ${what}.`,
				retryable: false,
				...(message ? { detail: `GitHub said: ${message}` } : {}),
			},
			status ? { status, message, what } : undefined,
		);
	}
	return body.data;
}

// --- Items -------------------------------------------------------------------

interface IssueResponse {
	id: number;
	number: number;
	title: string;
	html_url: string;
	created_at?: string;
	pull_request?: unknown;
	assignees?: { login: string }[];
}

interface Item {
	/** The repository path in the key (it may be an older name; GitHub redirects reads). */
	repo: string;
	number: number;
	key: string;
}

/** An item key's repository and number, for keys this adapter can write to. */
function item(target: Target): Item {
	if (!("key" in target)) fail("This refers to an issue that hasn't been created yet.");
	const key = target.key;
	const ref = parseKey(key);
	const number = ref?.item.startsWith("#") ? Number(ref.item.slice(1)) : NaN;
	if (!ref || ref.forge !== "github" || !Number.isSafeInteger(number) || number < 1) {
		fail(`“${key}” isn't a GitHub issue or pull request.`);
	}
	return { repo: ref.repo, number, key: key.toLowerCase() };
}

/** `owner/repo#12`, for messages. */
function short(target: Item): string {
	return `${target.repo}#${target.number}`;
}

function issueUrl(repo: string, number: number): string {
	return `https://github.com/${repo}/issues/${number}`;
}

function keyFor(repo: RepoIdentity, number: number): string {
	return itemKey({ host: HOST, repo: repo.name, item: `#${number}` });
}

function segments(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

async function milestoneNumber(token: string, repo: string, title: string): Promise<number> {
	const milestones = await rest<{ number: number; title: string }[]>(
		token,
		`/repos/${repo}/milestones?state=all&per_page=100`,
		`list the milestones in ${repo}`,
	);
	const wanted = title.trim().toLowerCase();
	const found =
		milestones.find((m) => m.title === title) ??
		milestones.find((m) => m.title.trim().toLowerCase() === wanted);
	if (!found) fail(`There's no milestone called “${title}” in ${repo}.`);
	return found.number;
}

/** Whether a creation `retryOf` asked about happened at about the right time. */
function sinceRetry(createdAt: string | undefined, retryOf: number): boolean {
	return Boolean(createdAt) && Date.parse(createdAt ?? "") >= retryOf - RETRY_SLACK_MS;
}

/** The ref name rules a branch must follow (as `check-ref-format` has them). */
function validBranch(name: string): boolean {
	if (name.length > 200 || /^[/-]|\.\.|\/\/|@\{|\.lock$|\/$|\.$|[\s~^:?*[\\]/.test(name)) {
		return false;
	}
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i);
		if (code < 32 || code === 127) return false;
	}
	return true;
}

function validFilePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!path.startsWith("/") &&
		!path.endsWith("/") &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
	);
}

// --- Applying ------------------------------------------------------------------

export async function applyGitHub(
	op: Operation,
	repo: RepoIdentity,
	auth: WriteAuth,
	options: ApplyOptions = {},
): Promise<ApplyResult> {
	try {
		return await applyOrFail(op, repo, auth.token, options);
	} catch (error) {
		if (error instanceof WriteFailure) {
			const refusal = error.refusal;
			// A refusal reads differently when you were writing as yourself.
			if (refusal?.status === 403 && auth.as === "user" && !error.failure.retryable) {
				return {
					...error.failure,
					error: explain(refusal.status, refusal.message, refusal.what, auth.as),
				};
			}
			return error.failure;
		}
		return {
			ok: false,
			error: `Something went wrong writing to GitHub: ${error instanceof Error ? error.message : String(error)}`,
			retryable: false,
		};
	}
}

async function applyOrFail(
	op: Operation,
	repo: RepoIdentity,
	token: string,
	options: ApplyOptions,
): Promise<ApplyResult> {
	const path = `/repos/${repo.name}`;
	switch (op.kind) {
		case "issue.create": {
			if (options.retryOf !== undefined) {
				// The last attempt may have made it already.
				const recent = await rest<IssueResponse[]>(
					token,
					`${path}/issues?state=all&sort=created&direction=desc&per_page=30`,
					`check for the issue in ${repo.name}`,
				);
				const made = recent.find(
					(issue) =>
						!issue.pull_request &&
						issue.title === op.title &&
						sinceRetry(issue.created_at, options.retryOf ?? 0),
				);
				if (made) {
					return { ok: true, key: keyFor(repo, made.number), url: made.html_url, confirmed: false };
				}
			}
			const milestone = op.milestone ? await milestoneNumber(token, repo.name, op.milestone) : null;
			const issue = await rest<IssueResponse>(
				token,
				`${path}/issues`,
				`create an issue in ${repo.name}`,
				{
					method: "POST",
					body: {
						title: op.title,
						...(op.body ? { body: op.body } : {}),
						...(op.labels?.length ? { labels: op.labels } : {}),
						...(op.assignees?.length ? { assignees: op.assignees } : {}),
						...(milestone !== null ? { milestone } : {}),
					},
				},
			);
			return { ok: true, key: keyFor(repo, issue.number), url: issue.html_url, confirmed: false };
		}

		case "item.labels": {
			const target = item(op.target);
			const url = `${path}/issues/${target.number}`;
			if (op.add?.length) {
				// Adding is idempotent: labels already there stay as they are.
				await rest(token, `${url}/labels`, `add labels to ${short(target)}`, {
					method: "POST",
					body: { labels: op.add },
				});
			}
			for (const name of op.remove ?? []) {
				// A label that isn't there (any more) is a 404, which is fine.
				await rest(
					token,
					`${url}/labels/${encodeURIComponent(name)}`,
					`remove “${name}” from ${short(target)}`,
					{ method: "DELETE", allow404: true },
				);
			}
			return {
				ok: true,
				key: target.key,
				url: issueUrl(repo.name, target.number),
				confirmed: false,
			};
		}

		case "item.milestone": {
			const target = item(op.target);
			const milestone =
				op.milestone === null ? null : await milestoneNumber(token, repo.name, op.milestone);
			await rest(
				token,
				`${path}/issues/${target.number}`,
				`set the milestone of ${short(target)}`,
				{
					method: "PATCH",
					body: { milestone },
				},
			);
			// Cards don't show milestones, so GitHub's answer is the confirmation.
			return {
				ok: true,
				key: target.key,
				url: issueUrl(repo.name, target.number),
				confirmed: true,
			};
		}

		case "item.assignees": {
			const target = item(op.target);
			const url = `${path}/issues/${target.number}/assignees`;
			if (op.add?.length) {
				const issue = await rest<IssueResponse>(token, url, `assign people to ${short(target)}`, {
					method: "POST",
					body: { assignees: op.add },
				});
				// GitHub quietly skips people who can't be assigned.
				const assigned = new Set((issue.assignees ?? []).map((a) => a.login.toLowerCase()));
				const skipped = op.add.filter((login) => !assigned.has(login.toLowerCase()));
				if (skipped.length > 0) {
					fail(
						`GitHub wouldn't assign ${skipped.map((l) => `@${l}`).join(", ")} to ${short(target)}: they can't be assigned issues in ${repo.name}.`,
					);
				}
			}
			if (op.remove?.length) {
				await rest(token, url, `unassign people from ${short(target)}`, {
					method: "DELETE",
					body: { assignees: op.remove },
				});
			}
			return {
				ok: true,
				key: target.key,
				url: issueUrl(repo.name, target.number),
				confirmed: false,
			};
		}

		case "item.state": {
			const target = item(op.target);
			const body =
				op.state === "closed"
					? { state: "closed", ...(op.reason ? { state_reason: op.reason } : {}) }
					: { state: "open" };
			await rest(
				token,
				`${path}/issues/${target.number}`,
				`${op.state === "closed" ? "close" : "reopen"} ${short(target)}`,
				{ method: "PATCH", body },
			);
			return {
				ok: true,
				key: target.key,
				url: issueUrl(repo.name, target.number),
				confirmed: false,
			};
		}

		case "item.subIssue": {
			const parent = item(op.parent);
			const child = item(op.child);
			// Sub-issues are added by the child's database id, not its number.
			const childIssue = await rest<IssueResponse>(
				token,
				`/repos/${child.repo}/issues/${child.number}`,
				`find ${short(child)}`,
			);
			const url = `${path}/issues/${parent.number}/sub_issues`;
			const existing = await rest<IssueResponse[]>(
				token,
				`${url}?per_page=100`,
				`list the sub-issues of ${short(parent)}`,
			);
			if (!existing.some((issue) => issue.id === childIssue.id)) {
				await rest(token, url, `make ${short(child)} a sub-issue of ${short(parent)}`, {
					method: "POST",
					body: { sub_issue_id: childIssue.id },
				});
			}
			// Cards don't show sub-issues, so GitHub's answer is the confirmation.
			return {
				ok: true,
				key: parent.key,
				url: issueUrl(repo.name, parent.number),
				confirmed: true,
			};
		}

		case "item.blockedBy": {
			const target = item(op.target);
			const blocker = item(op.blockedBy);
			const blockerIssue = await rest<IssueResponse>(
				token,
				`/repos/${blocker.repo}/issues/${blocker.number}`,
				`find ${short(blocker)}`,
			);
			const url = `${path}/issues/${target.number}/dependencies/blocked_by`;
			const existing = await rest<IssueResponse[]>(
				token,
				`${url}?per_page=100`,
				`list what blocks ${short(target)}`,
			);
			if (!existing.some((issue) => issue.id === blockerIssue.id)) {
				await rest(token, url, `mark ${short(target)} as blocked by ${short(blocker)}`, {
					method: "POST",
					body: { issue_id: blockerIssue.id },
				});
			}
			return {
				ok: true,
				key: target.key,
				url: issueUrl(repo.name, target.number),
				confirmed: true,
			};
		}

		case "item.comment": {
			const target = item(op.target);
			const url = `${path}/issues/${target.number}/comments`;
			if (options.retryOf !== undefined) {
				const since = new Date(options.retryOf - RETRY_SLACK_MS).toISOString();
				const recent = await rest<{ body?: string; html_url: string }[]>(
					token,
					`${url}?since=${encodeURIComponent(since)}&per_page=100`,
					`check for the comment on ${short(target)}`,
				);
				const made = recent.find((comment) => comment.body?.trim() === op.body.trim());
				if (made) return { ok: true, key: target.key, url: made.html_url, confirmed: true };
			}
			const comment = await rest<{ html_url: string }>(token, url, `comment on ${short(target)}`, {
				method: "POST",
				body: { body: op.body },
			});
			// Cards can't show which comments they have: GitHub's answer is the confirmation.
			return { ok: true, key: target.key, url: comment.html_url, confirmed: true };
		}

		case "pr.create":
			return createPull(op, repo, token);

		case "discussion.create":
			return createDiscussion(op, repo, token, options);
	}
}

type PullOp = Extract<Operation, { kind: "pr.create" }>;

/**
 * Open a pull request with files: one commit on a new branch from the base
 * (the default branch unless `base` is set), made with the git data API.
 * A branch that already exists is only reused if it holds exactly these
 * files on the base (an earlier attempt of this push); otherwise nothing
 * is overwritten.
 */
async function createPull(op: PullOp, repo: RepoIdentity, token: string): Promise<ApplyResult> {
	const path = `/repos/${repo.name}`;
	if (!validBranch(op.branch)) fail(`“${op.branch}” isn't a valid branch name.`);
	if (op.files.length === 0) fail("A pull request needs at least one file.");
	const bad = op.files.find((file) => !validFilePath(file.path));
	if (bad) fail(`“${bad.path}” isn't a valid file path.`);

	let base = op.base;
	if (!base) {
		const info = await rest<{ default_branch: string }>(token, path, `look up ${repo.name}`);
		base = info.default_branch;
	}
	const baseRef = await rest<{ object: { sha: string } } | null>(
		token,
		`${path}/git/ref/heads/${segments(base)}`,
		`find the ${base} branch`,
		{ allow404: true },
	);
	if (!baseRef) fail(`There's no branch called “${base}” in ${repo.name}.`);
	const baseCommit = await rest<{ tree: { sha: string } }>(
		token,
		`${path}/git/commits/${baseRef.object.sha}`,
		`read the ${base} branch`,
	);
	// Blobs go inline in the tree: one request rather than one per file.
	const tree = await rest<{ sha: string }>(token, `${path}/git/trees`, `write the files`, {
		method: "POST",
		body: {
			base_tree: baseCommit.tree.sha,
			tree: op.files.map((file) => ({
				path: file.path,
				mode: "100644",
				type: "blob",
				content: file.content,
			})),
		},
	});

	const existing = await rest<{ object: { sha: string } } | null>(
		token,
		`${path}/git/ref/heads/${segments(op.branch)}`,
		`check for the ${op.branch} branch`,
		{ allow404: true },
	);
	if (existing) {
		const head = await rest<{ tree: { sha: string } }>(
			token,
			`${path}/git/commits/${existing.object.sha}`,
			`read the ${op.branch} branch`,
		);
		if (head.tree.sha !== tree.sha) {
			fail(`There's already a branch called “${op.branch}” in ${repo.name}. Pick another name.`);
		}
		// Ours, from an earlier attempt: open its pull request, unless that happened too.
		const owner = repo.name.split("/")[0] ?? "";
		const pulls = await rest<{ number: number; html_url: string }[]>(
			token,
			`${path}/pulls?state=all&head=${encodeURIComponent(`${owner}:${op.branch}`)}`,
			`check for a pull request from ${op.branch}`,
		);
		const made = pulls[0];
		if (made)
			return { ok: true, key: keyFor(repo, made.number), url: made.html_url, confirmed: false };
	} else {
		const commit = await rest<{ sha: string }>(token, `${path}/git/commits`, "commit the files", {
			method: "POST",
			body: { message: op.title, tree: tree.sha, parents: [baseRef.object.sha] },
		});
		await rest(token, `${path}/git/refs`, `create the ${op.branch} branch`, {
			method: "POST",
			body: { ref: `refs/heads/${op.branch}`, sha: commit.sha },
		});
	}
	const pull = await rest<{ number: number; html_url: string }>(
		token,
		`${path}/pulls`,
		`open a pull request in ${repo.name}`,
		{ method: "POST", body: { title: op.title, body: op.body, head: op.branch, base } },
	);
	return { ok: true, key: keyFor(repo, pull.number), url: pull.html_url, confirmed: false };
}

type DiscussionOp = Extract<Operation, { kind: "discussion.create" }>;

const DISCUSSION_TARGET = `query TackDiscussionTarget($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		id
		hasDiscussionsEnabled
		discussionCategories(first: 50) { nodes { id name slug } }
	}
}`;

const RECENT_DISCUSSIONS = `query TackRecentDiscussions($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		discussions(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) {
			nodes { title url createdAt }
		}
	}
}`;

const CREATE_DISCUSSION = `mutation TackCreateDiscussion($input: CreateDiscussionInput!) {
	createDiscussion(input: $input) { discussion { url number } }
}`;

interface DiscussionTarget {
	repository: {
		id: string;
		hasDiscussionsEnabled: boolean;
		discussionCategories: { nodes: { id: string; name: string; slug: string }[] };
	} | null;
}

async function createDiscussion(
	op: DiscussionOp,
	repo: RepoIdentity,
	token: string,
	options: ApplyOptions,
): Promise<ApplyResult> {
	const [owner, name] = repo.name.split("/");
	const vars = { owner, name };
	const target = await graphql<DiscussionTarget>(
		token,
		"TackDiscussionTarget",
		DISCUSSION_TARGET,
		vars,
		`look up discussions in ${repo.name}`,
	);
	const repository = target.repository;
	if (!repository) fail(`Couldn't find ${repo.name}.`);
	if (!repository.hasDiscussionsEnabled) fail(`Discussions are turned off in ${repo.name}.`);
	const wanted = op.category.trim().toLowerCase();
	const category = repository.discussionCategories.nodes.find(
		(c) => c.name.trim().toLowerCase() === wanted || c.slug === wanted,
	);
	if (!category) fail(`There's no discussion category called “${op.category}” in ${repo.name}.`);

	if (options.retryOf !== undefined) {
		const recent = await graphql<{
			repository: { discussions: { nodes: { title: string; url: string; createdAt: string }[] } };
		}>(token, "TackRecentDiscussions", RECENT_DISCUSSIONS, vars, `check for the discussion`);
		const made = recent.repository.discussions.nodes.find(
			(d) => d.title === op.title && sinceRetry(d.createdAt, options.retryOf ?? 0),
		);
		if (made) return { ok: true, url: made.url, confirmed: true };
	}
	const created = await graphql<{ createDiscussion: { discussion: { url: string } } }>(
		token,
		"TackCreateDiscussion",
		CREATE_DISCUSSION,
		{
			input: {
				repositoryId: repository.id,
				categoryId: category.id,
				title: op.title,
				body: op.body,
			},
		},
		`start a discussion in ${repo.name}`,
	);
	// Discussions aren't cards: GitHub's answer is the confirmation.
	return { ok: true, url: created.createDiscussion.discussion.url, confirmed: true };
}

// --- Reading what writes need ---------------------------------------------------

/**
 * Whether the holder of `token` can push to a repository, by id so renames
 * don't matter. Throws if GitHub can't say.
 */
export async function canWriteGitHub(repo: RepoIdentity, token: string): Promise<boolean> {
	const response = await fetch(`${API}/repositories/${repo.id}`, {
		headers: headers(token),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (response.status === 404 || response.status === 401) return false;
	if (response.status === 403 && !(await failureFrom(response.clone(), "")).retryable) return false;
	if (!response.ok) throw new Error(`Write access check failed: ${response.status}`);
	const body = await response.json<{
		permissions?: { push?: boolean; maintain?: boolean; admin?: boolean };
	}>();
	const permissions = body.permissions ?? {};
	return Boolean(permissions.push || permissions.maintain || permissions.admin);
}

async function readToken(env: Env, repo: RepoIdentity, auth?: ReadAuth): Promise<string | null> {
	return (await repoToken(env, `${HOST}/${repo.name}`)) ?? auth?.token ?? null;
}

async function pages<T>(token: string | null, path: string, what: string, max = 3): Promise<T[]> {
	const all: T[] = [];
	for (let page = 1; page <= max; page++) {
		const sep = path.includes("?") ? "&" : "?";
		const batch = await rest<T[]>(token, `${path}${sep}per_page=100&page=${page}`, what);
		all.push(...batch);
		if (batch.length < 100) break;
	}
	return all;
}

const CATEGORIES = `query TackDiscussionCategories($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		discussionCategories(first: 50) { nodes { name } }
	}
}`;

/** What a repository offers to write with. Throws if the repository can't be read. */
export async function repoMetaGitHub(
	repo: RepoIdentity,
	env: Env,
	auth?: ReadAuth,
): Promise<RepoMeta> {
	const token = await readToken(env, repo, auth);
	const path = `/repos/${repo.name}`;
	const optional = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
	try {
		const [info, labels, milestones, assignees, installed] = await Promise.all([
			rest<{
				default_branch: string;
				subscribers_count?: number;
				watchers_count?: number;
				has_discussions?: boolean;
			}>(token, path, `read ${repo.name}`),
			optional(
				pages<{ name: string; color: string; description?: string | null }>(
					token,
					`${path}/labels`,
					"list labels",
				),
				[],
			),
			optional(
				pages<{ title: string; due_on?: string | null }>(
					token,
					`${path}/milestones?state=open&sort=due_on`,
					"list milestones",
					1,
				),
				[],
			),
			optional(pages<{ login: string }>(token, `${path}/assignees`, "list assignees", 1), []),
			isInstalled(env, `${HOST}/${repo.name}`).catch(() => false),
		]);
		const [owner, name] = repo.name.split("/");
		const categories =
			info.has_discussions && token
				? await optional(
						graphql<{ repository: { discussionCategories: { nodes: { name: string }[] } } | null }>(
							token,
							"TackDiscussionCategories",
							CATEGORIES,
							{ owner, name },
							"list discussion categories",
						).then((data) => data.repository?.discussionCategories.nodes.map((c) => c.name) ?? []),
						[],
					)
				: [];
		return {
			repo: `${HOST}/${repo.name}`,
			labels: labels.map((label): Label => ({
				name: label.name,
				color: label.color,
				...(label.description ? { description: label.description } : {}),
			})),
			milestones: milestones.map((m): Milestone => ({ title: m.title, dueOn: m.due_on ?? null })),
			assignees: assignees.map((a) => a.login),
			discussionCategories: categories,
			watchers: info.subscribers_count ?? 0,
			defaultBranch: info.default_branch,
			writable: installed,
		};
	} catch (error) {
		if (error instanceof WriteFailure) throw new Error(error.failure.error);
		throw error;
	}
}

/** File names in a directory on the default branch, sorted. Empty if it doesn't exist. */
export async function listDirectoryGitHub(
	repo: RepoIdentity,
	path: string,
	env: Env,
	auth?: ReadAuth,
): Promise<string[]> {
	const token = await readToken(env, repo, auth);
	const clean = path.replace(/^\/+|\/+$/g, "");
	try {
		const entries = await rest<{ name: string; type: string }[] | { type: string } | null>(
			token,
			`/repos/${repo.name}/contents/${segments(clean)}`,
			`list ${clean || "the repository"}`,
			{ allow404: true },
		);
		if (!Array.isArray(entries)) return [];
		return entries
			.filter((entry) => entry.type === "file")
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error instanceof WriteFailure) throw new Error(error.failure.error);
		throw error;
	}
}
