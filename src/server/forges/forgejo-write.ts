import type { Operation, OperationKind, Target } from "../../shared/changes.ts";
import type { Label, Milestone, RepoMeta } from "../../shared/push.ts";
import { itemKey, parseKey } from "../../shared/refs.ts";
import { hostConfig, mayWrite } from "./config.ts";
import { type ForgejoIssue, type ForgejoRepository, forgejoApi } from "./forgejo-api.ts";
import {
	fail,
	hexColor,
	iso,
	type RestApi,
	rest,
	segments,
	settle,
	sinceRetry,
	RETRY_SLACK_MS,
	validBranch,
	validFilePath,
} from "./rest.ts";
import type { ApplyOptions, ApplyResult, RepoIdentity } from "./types.ts";

// Writing to Forgejo (#65), with the instance's token for the host (see
// config.ts): never a person's. Sub-issues and Discussions aren't Forgejo
// things; blocked-by is its issue dependencies (which a repository may have
// turned off, in which case Forgejo refuses and says so).

export const FORGEJO_WRITES: OperationKind[] = [
	"issue.create",
	"item.labels",
	"item.milestone",
	"item.assignees",
	"item.state",
	"item.blockedBy",
	"item.comment",
	"pr.create",
];

interface Item {
	repo: string;
	number: number;
	key: string;
}

/** The API to write with, if this instance writes to the host at all. */
function writeApi(env: Env, repo: RepoIdentity): RestApi {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "forgejo" || !config.writes || !config.token) {
		fail(
			`This instance doesn't write to ${config?.name ?? repo.host}. An admin can turn writes on.`,
		);
	}
	return forgejoApi(config);
}

function item(target: Target, repo: RepoIdentity): Item {
	if (!("key" in target)) fail("This refers to an issue that hasn't been created yet.");
	const ref = parseKey(target.key);
	const number = ref?.item.startsWith("#") ? Number(ref.item.slice(1)) : NaN;
	if (
		!ref ||
		ref.forge !== "forgejo" ||
		ref.host.toLowerCase() !== repo.host ||
		!Number.isSafeInteger(number) ||
		number < 1
	) {
		fail(`“${target.key}” isn't an issue or pull request on ${repo.host}.`);
	}
	return { repo: ref.repo.toLowerCase(), number, key: target.key.toLowerCase() };
}

const short = (target: Item) => `${target.repo}#${target.number}`;

function issueUrl(repo: RepoIdentity, number: number): string {
	return `https://${repo.host}/${repo.name}/issues/${number}`;
}

function keyFor(repo: RepoIdentity, number: number): string {
	return itemKey({ host: repo.host, repo: repo.name, item: `#${number}` });
}

/** Labels by name (case aside), the repository's and its organisation's. */
async function labelIds(api: RestApi, repo: string, names: string[]): Promise<number[]> {
	if (names.length === 0) return [];
	const [owner] = repo.split("/");
	const [own, org] = await Promise.all([
		rest<{ id: number; name: string }[]>(
			api,
			`/repos/${segments(repo)}/labels?limit=100`,
			`list the labels in ${repo}`,
		),
		rest<{ id: number; name: string }[] | null>(
			api,
			`/orgs/${encodeURIComponent(owner ?? "")}/labels?limit=100`,
			`list the labels of ${owner}`,
			{ allow404: true },
		).catch(() => null),
	]);
	const all = [...(own ?? []), ...(org ?? [])];
	return names.map((name) => {
		const wanted = name.trim().toLowerCase();
		const found = all.find((label) => label.name.trim().toLowerCase() === wanted);
		if (!found) fail(`There's no label called “${name}” in ${repo}.`);
		return found.id;
	});
}

async function milestoneId(api: RestApi, repo: string, title: string): Promise<number> {
	const milestones = await rest<{ id: number; title: string }[]>(
		api,
		`/repos/${segments(repo)}/milestones?state=all&limit=100`,
		`list the milestones in ${repo}`,
	);
	const wanted = title.trim().toLowerCase();
	const found = milestones.find((m) => m.title.trim().toLowerCase() === wanted);
	if (!found) fail(`There's no milestone called “${title}” in ${repo}.`);
	return found.id;
}

/** Text as base64, for the contents API. */
function base64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function applyForgejo(
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
	const path = `/repos/${segments(repo.name)}`;
	switch (op.kind) {
		case "issue.create": {
			if (options.retryOf !== undefined) {
				// The last attempt may have made it already.
				const since = new Date(options.retryOf - RETRY_SLACK_MS).toISOString();
				const recent = await rest<ForgejoIssue[]>(
					api,
					`${path}/issues?state=all&type=issues&limit=50&since=${encodeURIComponent(since)}`,
					`check for the issue in ${repo.name}`,
				);
				const made = recent.find(
					(issue) =>
						issue.title === op.title && sinceRetry(iso(issue.created_at), options.retryOf ?? 0),
				);
				if (made) {
					return { ok: true, key: keyFor(repo, made.number), url: made.html_url, confirmed: false };
				}
			}
			const [labels, milestone] = await Promise.all([
				labelIds(api, repo.name, op.labels ?? []),
				op.milestone ? milestoneId(api, repo.name, op.milestone) : Promise.resolve(null),
			]);
			const issue = await rest<ForgejoIssue>(
				api,
				`${path}/issues`,
				`create an issue in ${repo.name}`,
				{
					method: "POST",
					body: {
						title: op.title,
						...(op.body ? { body: op.body } : {}),
						...(labels.length ? { labels } : {}),
						...(op.assignees?.length ? { assignees: op.assignees } : {}),
						...(milestone !== null ? { milestone } : {}),
					},
				},
			);
			return { ok: true, key: keyFor(repo, issue.number), url: issue.html_url, confirmed: false };
		}

		case "item.labels": {
			const target = item(op.target, repo);
			const url = `/repos/${segments(target.repo)}/issues/${target.number}/labels`;
			const [add, remove] = await Promise.all([
				labelIds(api, target.repo, op.add ?? []),
				labelIds(api, target.repo, op.remove ?? []).catch(() => []),
			]);
			// Adding is idempotent: labels already there stay as they are.
			if (add.length) {
				await rest(api, url, `add labels to ${short(target)}`, {
					method: "POST",
					body: { labels: add },
				});
			}
			for (const id of remove) {
				await rest(api, `${url}/${id}`, `remove a label from ${short(target)}`, {
					method: "DELETE",
					allow404: true,
				});
			}
			return { ok: true, key: target.key, url: issueUrl(repo, target.number), confirmed: false };
		}

		case "item.milestone": {
			const target = item(op.target, repo);
			// Forgejo takes 0 for none.
			const milestone =
				op.milestone === null ? 0 : await milestoneId(api, target.repo, op.milestone);
			await rest(
				api,
				`/repos/${segments(target.repo)}/issues/${target.number}`,
				`set the milestone of ${short(target)}`,
				{ method: "PATCH", body: { milestone } },
			);
			return { ok: true, key: target.key, url: issueUrl(repo, target.number), confirmed: false };
		}

		case "item.assignees": {
			const target = item(op.target, repo);
			const url = `/repos/${segments(target.repo)}/issues/${target.number}`;
			const issue = await rest<ForgejoIssue>(api, url, `read ${short(target)}`);
			const remove = new Set((op.remove ?? []).map((login) => login.toLowerCase()));
			const logins = new Map(
				(issue.assignees ?? [])
					.map((a) => a.login)
					.filter((login) => !remove.has(login.toLowerCase()))
					.map((login) => [login.toLowerCase(), login]),
			);
			for (const login of op.add ?? []) logins.set(login.toLowerCase(), login);
			await rest(api, url, `assign people to ${short(target)}`, {
				method: "PATCH",
				body: { assignees: [...logins.values()] },
			});
			return { ok: true, key: target.key, url: issueUrl(repo, target.number), confirmed: false };
		}

		case "item.state": {
			const target = item(op.target, repo);
			await rest(
				api,
				`/repos/${segments(target.repo)}/issues/${target.number}`,
				`${op.state === "closed" ? "close" : "reopen"} ${short(target)}`,
				{ method: "PATCH", body: { state: op.state } },
			);
			return { ok: true, key: target.key, url: issueUrl(repo, target.number), confirmed: false };
		}

		case "item.blockedBy": {
			const target = item(op.target, repo);
			const blocker = item(op.blockedBy, repo);
			const [owner, name] = blocker.repo.split("/");
			await rest(
				api,
				`/repos/${segments(target.repo)}/issues/${target.number}/dependencies`,
				`mark ${short(target)} as blocked by ${short(blocker)}`,
				{ method: "POST", body: { owner, repo: name, index: blocker.number } },
			);
			// Cards don't show what blocks them: Forgejo's answer is the confirmation.
			return { ok: true, key: target.key, url: issueUrl(repo, target.number), confirmed: true };
		}

		case "item.comment": {
			const target = item(op.target, repo);
			const url = `/repos/${segments(target.repo)}/issues/${target.number}/comments`;
			if (options.retryOf !== undefined) {
				const since = new Date(options.retryOf - RETRY_SLACK_MS).toISOString();
				const recent = await rest<{ body?: string; html_url?: string }[]>(
					api,
					`${url}?since=${encodeURIComponent(since)}`,
					`check for the comment on ${short(target)}`,
				);
				const made = recent.find((comment) => comment.body === op.body);
				if (made) {
					return {
						ok: true,
						key: target.key,
						url: made.html_url ?? issueUrl(repo, target.number),
						confirmed: true,
					};
				}
			}
			const comment = await rest<{ html_url?: string }>(api, url, `comment on ${short(target)}`, {
				method: "POST",
				body: { body: op.body },
			});
			return {
				ok: true,
				key: target.key,
				url: comment.html_url ?? issueUrl(repo, target.number),
				confirmed: true,
			};
		}

		case "pr.create": {
			if (!validBranch(op.branch)) fail(`“${op.branch}” can't be a branch name.`);
			const bad = op.files.find((file) => !validFilePath(file.path));
			if (bad) fail(`“${bad.path}” can't be a file's path.`);
			const pulls = `${path}/pulls`;
			if (options.retryOf !== undefined) {
				const open = await rest<{ number: number; html_url: string; head?: { ref?: string } }[]>(
					api,
					`${pulls}?state=all&limit=50`,
					`check for the pull request in ${repo.name}`,
				);
				const made = open.find((pull) => pull.head?.ref === op.branch);
				if (made) {
					return { ok: true, key: keyFor(repo, made.number), url: made.html_url, confirmed: false };
				}
			}
			const info = await rest<ForgejoRepository>(api, path, `read ${repo.name}`);
			const base = op.base ?? info.default_branch ?? "main";
			const branch = await rest<unknown>(
				api,
				`${path}/branches/${encodeURIComponent(op.branch)}`,
				`check for the branch ${op.branch}`,
				{ allow404: true },
			);
			// An earlier attempt may have made the branch before it was cut off.
			if (branch === null) {
				await rest(api, `${path}/contents`, `commit the files to ${op.branch}`, {
					method: "POST",
					body: {
						branch: base,
						new_branch: op.branch,
						message: op.title,
						files: op.files.map((file) => ({
							operation: "create",
							path: file.path,
							content: base64(file.content),
						})),
					},
				});
			}
			const pull = await rest<{ number: number; html_url: string }>(
				api,
				pulls,
				`open a pull request in ${repo.name}`,
				{ method: "POST", body: { head: op.branch, base, title: op.title, body: op.body } },
			);
			return { ok: true, key: keyFor(repo, pull.number), url: pull.html_url, confirmed: false };
		}

		default:
			return fail(`${api.name} can't do this.`);
	}
}

/**
 * Whether this person may push to a repository through the instance's
 * token: writes on for the host (and they're one of its `writers`, if it
 * names any), and the token's account can write there. Throws if Forgejo
 * can't say.
 */
export async function canWriteForgejo(
	repo: RepoIdentity,
	env: Env,
	pusher?: { id: number; login: string },
): Promise<boolean> {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "forgejo" || !mayWrite(config, pusher?.login ?? null)) return false;
	try {
		const info = await rest<ForgejoRepository>(
			forgejoApi(config),
			`/repos/${segments(repo.name)}`,
			`read ${repo.name}`,
			{ allow404: true },
		);
		return Boolean(info?.permissions?.push);
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
}

export async function repoMetaForgejo(repo: RepoIdentity, env: Env): Promise<RepoMeta> {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "forgejo") throw new Error(`${repo.host} isn't a Forgejo host here`);
	const api = forgejoApi(config);
	const path = `/repos/${segments(repo.name)}`;
	const [owner] = repo.name.split("/");
	const optional = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
	const [info, labels, orgLabels, milestones, assignees] = await Promise.all([
		rest<ForgejoRepository>(api, path, `read ${repo.name}`),
		optional(
			rest<{ name: string; color: string; description?: string }[]>(
				api,
				`${path}/labels?limit=100`,
				"list labels",
			),
			[],
		),
		optional(
			rest<{ name: string; color: string; description?: string }[] | null>(
				api,
				`/orgs/${encodeURIComponent(owner ?? "")}/labels?limit=100`,
				"list labels",
				{ allow404: true },
			),
			null,
		),
		optional(
			rest<{ title: string; due_on?: string | null }[]>(
				api,
				`${path}/milestones?state=open&limit=100`,
				"list milestones",
			),
			[],
		),
		optional(rest<{ login: string }[]>(api, `${path}/assignees`, "list assignees"), []),
	]);
	return {
		repo: `${repo.host}/${repo.name}`,
		labels: [...labels, ...(orgLabels ?? [])].map((label): Label => ({
			name: label.name,
			color: hexColor(label.color),
			...(label.description ? { description: label.description } : {}),
		})),
		milestones: milestones.map((m): Milestone => ({ title: m.title, dueOn: iso(m.due_on) })),
		assignees: assignees.map((a) => a.login),
		discussionCategories: [],
		watchers: info.watchers_count ?? 0,
		defaultBranch: info.default_branch ?? "main",
		writable: Boolean(config.writes && config.token && info.permissions?.push),
	};
}

/** File names in a directory on the default branch, sorted. Empty if it doesn't exist. */
export async function listDirectoryForgejo(
	repo: RepoIdentity,
	dir: string,
	env: Env,
): Promise<string[]> {
	const config = hostConfig(env, repo.host);
	if (config?.forge !== "forgejo") return [];
	const entries = await rest<{ name: string; type: string }[] | { name: string } | null>(
		forgejoApi(config),
		`/repos/${segments(repo.name)}/contents/${segments(dir)}`,
		`list ${dir}`,
		{ allow404: true },
	);
	return Array.isArray(entries)
		? entries
				.filter((entry) => entry.type === "file")
				.map((entry) => entry.name)
				.sort()
		: [];
}
