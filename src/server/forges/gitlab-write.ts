import type { Operation, OperationKind, Target } from "../../shared/changes.ts";
import type { Label, Milestone, RepoMeta } from "../../shared/push.ts";
import { itemKey, parseKey } from "../../shared/refs.ts";
import { hostConfig, mayWrite } from "./config.ts";
import {
	accessLevel,
	type GitLabItem,
	type GitLabProject,
	gitlabApi,
	projectRef,
	REPORTER,
} from "./gitlab-api.ts";
import {
	fail,
	hexColor,
	iso,
	RETRY_SLACK_MS,
	type RestApi,
	rest,
	settle,
	sinceRetry,
	validBranch,
	validFilePath,
} from "./rest.ts";
import type { ApplyOptions, ApplyResult, RepoIdentity } from "./types.ts";

// Writing to GitLab (#65), with the instance's token for the host (see
// config.ts): never a person's. Labels, milestones, assignees and state on
// issues and merge requests alike; comments are notes; a pull request is a
// commit on a new branch and a merge request from it. Blocking links, child
// items and Discussions aren't offered (paid features, or not GitLab's).

export const GITLAB_WRITES: OperationKind[] = [
	"issue.create",
	"item.labels",
	"item.milestone",
	"item.assignees",
	"item.state",
	"item.comment",
	"pr.create",
];

interface Item {
	/** The project's path. */
	repo: string;
	kind: "issues" | "merge_requests";
	number: number;
	key: string;
	/** `#12` or `!12`. */
	ref: string;
}

function writeApi(env: Env, repo: RepoIdentity): RestApi {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "gitlab" || !config.writes || !config.token) {
		fail(
			`This instance doesn't write to ${config?.name ?? repo.host}. An admin can turn writes on.`,
		);
	}
	return gitlabApi(config);
}

function item(target: Target, repo: RepoIdentity): Item {
	if (!("key" in target)) fail("This refers to an issue that hasn't been created yet.");
	const ref = parseKey(target.key);
	const number = ref ? Number(ref.item.slice(1)) : NaN;
	if (
		!ref ||
		ref.forge !== "gitlab" ||
		ref.host.toLowerCase() !== repo.host ||
		!Number.isSafeInteger(number) ||
		number < 1
	) {
		fail(`“${target.key}” isn't an issue or merge request on ${repo.host}.`);
	}
	return {
		repo: ref.repo.toLowerCase(),
		kind: ref.item.startsWith("!") ? "merge_requests" : "issues",
		number,
		key: target.key.toLowerCase(),
		ref: ref.item,
	};
}

const short = (target: Item) => `${target.repo}${target.ref}`;

/** The item's API path, in its own project (by path: it may not be the one being written to). */
function itemPath(target: Item, repo: RepoIdentity): string {
	const project = target.repo === repo.name ? projectRef(repo) : projectRef(target.repo);
	return `/projects/${project}/${target.kind}/${target.number}`;
}

function itemUrl(repo: RepoIdentity, target: Item): string {
	return `https://${repo.host}/${target.repo}/-/${target.kind}/${target.number}`;
}

/** People's ids, by username: GitLab assigns by id. */
async function userIds(api: RestApi, usernames: string[]): Promise<number[]> {
	return Promise.all(
		usernames.map(async (username) => {
			const users = await rest<{ id: number; username: string }[]>(
				api,
				`/users?username=${encodeURIComponent(username)}`,
				`look up @${username}`,
			);
			const found = users.find((user) => user.username.toLowerCase() === username.toLowerCase());
			if (!found) fail(`There's nobody called @${username} on ${api.name}.`);
			return found.id;
		}),
	);
}

async function milestoneId(api: RestApi, repo: RepoIdentity, title: string): Promise<number> {
	const milestones = await rest<{ id: number; title: string }[]>(
		api,
		`/projects/${projectRef(repo)}/milestones?include_ancestors=true&per_page=100&title=${encodeURIComponent(title)}`,
		`find the milestone “${title}”`,
	);
	const wanted = title.trim().toLowerCase();
	const found = milestones.find((m) => m.title.trim().toLowerCase() === wanted);
	if (!found) fail(`There's no milestone called “${title}” in ${repo.name}.`);
	return found.id;
}

export function applyGitLab(
	op: Operation,
	repo: RepoIdentity,
	env: Env,
	options: ApplyOptions = {},
): Promise<ApplyResult> {
	const name = hostConfig(env, repo.host)?.name ?? repo.host;
	return settle(name, () => applyOrFail(op, repo, writeApi(env, repo), options));
}

async function applyOrFail(
	op: Operation,
	repo: RepoIdentity,
	api: RestApi,
	options: ApplyOptions,
): Promise<ApplyResult> {
	const project = `/projects/${projectRef(repo)}`;
	switch (op.kind) {
		case "issue.create": {
			if (options.retryOf !== undefined) {
				// The last attempt may have made it already.
				const after = new Date(options.retryOf - RETRY_SLACK_MS).toISOString();
				const recent = await rest<GitLabItem[]>(
					api,
					`${project}/issues?created_after=${encodeURIComponent(after)}&order_by=created_at&per_page=50`,
					`check for the issue in ${repo.name}`,
				);
				const made = recent.find(
					(issue) =>
						issue.title === op.title && sinceRetry(iso(issue.created_at), options.retryOf ?? 0),
				);
				if (made) {
					return {
						ok: true,
						key: itemKey({ host: repo.host, repo: repo.name, item: `#${made.iid}` }),
						url: made.web_url,
						confirmed: false,
					};
				}
			}
			const [assignees, milestone] = await Promise.all([
				userIds(api, op.assignees ?? []),
				op.milestone ? milestoneId(api, repo, op.milestone) : Promise.resolve(null),
			]);
			const issue = await rest<GitLabItem>(
				api,
				`${project}/issues`,
				`create an issue in ${repo.name}`,
				{
					method: "POST",
					body: {
						title: op.title,
						...(op.body ? { description: op.body } : {}),
						...(op.labels?.length ? { labels: op.labels.join(",") } : {}),
						...(assignees.length ? { assignee_ids: assignees } : {}),
						...(milestone !== null ? { milestone_id: milestone } : {}),
					},
				},
			);
			return {
				ok: true,
				key: itemKey({ host: repo.host, repo: repo.name, item: `#${issue.iid}` }),
				url: issue.web_url,
				confirmed: false,
			};
		}

		case "item.labels": {
			const target = item(op.target, repo);
			await rest(api, itemPath(target, repo), `change the labels on ${short(target)}`, {
				method: "PUT",
				body: {
					...(op.add?.length ? { add_labels: op.add.join(",") } : {}),
					...(op.remove?.length ? { remove_labels: op.remove.join(",") } : {}),
				},
			});
			return { ok: true, key: target.key, url: itemUrl(repo, target), confirmed: false };
		}

		case "item.milestone": {
			const target = item(op.target, repo);
			// GitLab takes 0 for none.
			const milestone = op.milestone === null ? 0 : await milestoneId(api, repo, op.milestone);
			await rest(api, itemPath(target, repo), `set the milestone of ${short(target)}`, {
				method: "PUT",
				body: { milestone_id: milestone },
			});
			return { ok: true, key: target.key, url: itemUrl(repo, target), confirmed: false };
		}

		case "item.assignees": {
			const target = item(op.target, repo);
			const current = await rest<GitLabItem>(api, itemPath(target, repo), `read ${short(target)}`);
			const remove = new Set((op.remove ?? []).map((login) => login.toLowerCase()));
			const keep = (current.assignees ?? []).filter(
				(user) => !remove.has(user.username.toLowerCase()) && user.id !== undefined,
			);
			const have = new Set(keep.map((user) => user.username.toLowerCase()));
			const added = await userIds(
				api,
				(op.add ?? []).filter((login) => !have.has(login.toLowerCase())),
			);
			const ids = [...keep.map((user) => user.id as number), ...added];
			await rest(api, itemPath(target, repo), `assign people to ${short(target)}`, {
				method: "PUT",
				// GitLab takes [0] for nobody.
				body: { assignee_ids: ids.length ? ids : [0] },
			});
			return { ok: true, key: target.key, url: itemUrl(repo, target), confirmed: false };
		}

		case "item.state": {
			const target = item(op.target, repo);
			await rest(
				api,
				itemPath(target, repo),
				`${op.state === "closed" ? "close" : "reopen"} ${short(target)}`,
				{ method: "PUT", body: { state_event: op.state === "closed" ? "close" : "reopen" } },
			);
			return { ok: true, key: target.key, url: itemUrl(repo, target), confirmed: false };
		}

		case "item.comment": {
			const target = item(op.target, repo);
			const notes = `${itemPath(target, repo)}/notes`;
			if (options.retryOf !== undefined) {
				const recent = await rest<{ id: number; body?: string; created_at?: string }[]>(
					api,
					`${notes}?order_by=created_at&sort=desc&per_page=30`,
					`check for the comment on ${short(target)}`,
				);
				const made = recent.find(
					(note) => note.body === op.body && sinceRetry(iso(note.created_at), options.retryOf ?? 0),
				);
				if (made) {
					return {
						ok: true,
						key: target.key,
						url: `${itemUrl(repo, target)}#note_${made.id}`,
						confirmed: true,
					};
				}
			}
			const note = await rest<{ id: number }>(api, notes, `comment on ${short(target)}`, {
				method: "POST",
				body: { body: op.body },
			});
			return {
				ok: true,
				key: target.key,
				url: `${itemUrl(repo, target)}#note_${note.id}`,
				confirmed: true,
			};
		}

		case "pr.create": {
			if (!validBranch(op.branch)) fail(`“${op.branch}” can't be a branch name.`);
			const bad = op.files.find((file) => !validFilePath(file.path));
			if (bad) fail(`“${bad.path}” can't be a file's path.`);
			const branchParam = encodeURIComponent(op.branch);
			if (options.retryOf !== undefined) {
				const made = await rest<GitLabItem[]>(
					api,
					`${project}/merge_requests?source_branch=${branchParam}&state=all&per_page=5`,
					`check for the merge request in ${repo.name}`,
				);
				const found = made[0];
				if (found) {
					return {
						ok: true,
						key: itemKey({ host: repo.host, repo: repo.name, item: `!${found.iid}` }),
						url: found.web_url,
						confirmed: false,
					};
				}
			}
			const info = await rest<GitLabProject>(api, project, `read ${repo.name}`);
			const base = op.base ?? info.default_branch ?? "main";
			// An earlier attempt may have made the branch before it was cut off.
			const branch = await rest<unknown>(
				api,
				`${project}/repository/branches/${branchParam}`,
				`check for the branch ${op.branch}`,
				{ allow404: true },
			);
			if (branch === null) {
				await rest(api, `${project}/repository/commits`, `commit the files to ${op.branch}`, {
					method: "POST",
					body: {
						branch: op.branch,
						start_branch: base,
						commit_message: op.title,
						actions: op.files.map((file) => ({
							action: "create",
							file_path: file.path,
							content: file.content,
						})),
					},
				});
			}
			const mr = await rest<GitLabItem>(
				api,
				`${project}/merge_requests`,
				`open a merge request in ${repo.name}`,
				{
					method: "POST",
					body: {
						source_branch: op.branch,
						target_branch: base,
						title: op.title,
						description: op.body,
					},
				},
			);
			return {
				ok: true,
				key: itemKey({ host: repo.host, repo: repo.name, item: `!${mr.iid}` }),
				url: mr.web_url,
				confirmed: false,
			};
		}

		default:
			return fail(`${api.name} can't do this.`);
	}
}

/**
 * Whether this person may push to a project through the instance's token:
 * writes on for the host (and they're one of its `writers`, if it names
 * any), and the token's account is at least a Reporter there. Throws if
 * GitLab can't say.
 */
export async function canWriteGitLab(
	repo: RepoIdentity,
	env: Env,
	pusher?: { id: number; login: string },
): Promise<boolean> {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "gitlab" || !mayWrite(config, pusher?.login ?? null)) return false;
	try {
		const project = await rest<GitLabProject | null>(
			gitlabApi(config),
			`/projects/${projectRef(repo)}`,
			`read ${repo.name}`,
			{ allow404: true },
		);
		return project !== null && accessLevel(project) >= REPORTER;
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
}

export async function repoMetaGitLab(repo: RepoIdentity, env: Env): Promise<RepoMeta> {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "gitlab") throw new Error(`${repo.host} isn't a GitLab host here`);
	const api = gitlabApi(config);
	const project = `/projects/${projectRef(repo)}`;
	const optional = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
	const [info, labels, milestones, members] = await Promise.all([
		rest<GitLabProject>(api, project, `read ${repo.name}`),
		optional(
			rest<{ name: string; color?: string; description?: string | null }[]>(
				api,
				`${project}/labels?include_ancestor_groups=true&per_page=100`,
				"list labels",
			),
			[],
		),
		optional(
			rest<{ title: string; due_date?: string | null }[]>(
				api,
				`${project}/milestones?state=active&include_ancestors=true&per_page=100`,
				"list milestones",
			),
			[],
		),
		optional(
			rest<{ username: string; state?: string }[]>(
				api,
				`${project}/members/all?per_page=100`,
				"list members",
			),
			[],
		),
	]);
	return {
		repo: `${repo.host}/${repo.name}`,
		labels: labels.map((label): Label => ({
			name: label.name,
			color: hexColor(label.color),
			...(label.description ? { description: label.description } : {}),
		})),
		milestones: milestones.map((m): Milestone => ({
			title: m.title,
			dueOn: iso(m.due_date ?? null),
		})),
		assignees: members.filter((m) => m.state !== "blocked").map((m) => m.username),
		discussionCategories: [],
		// GitLab notifies participants, not watchers, and doesn't count them.
		watchers: 0,
		defaultBranch: info.default_branch ?? "main",
		writable: Boolean(config.writes && config.token && accessLevel(info) >= REPORTER),
	};
}

/** File names in a directory on the default branch, sorted. Empty if it doesn't exist. */
export async function listDirectoryGitLab(
	repo: RepoIdentity,
	dir: string,
	env: Env,
): Promise<string[]> {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "gitlab") return [];
	const entries = await rest<{ name: string; type: string }[] | null>(
		gitlabApi(config),
		`/projects/${projectRef(repo)}/repository/tree?path=${encodeURIComponent(dir)}&per_page=100`,
		`list ${dir}`,
		{ allow404: true },
	);
	return (entries ?? [])
		.filter((entry) => entry.type === "blob")
		.map((entry) => entry.name)
		.sort();
}
