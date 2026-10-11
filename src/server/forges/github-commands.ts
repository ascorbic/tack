// Comment commands on GitHub (#58): reading `issue_comment` deliveries for
// commands addressed to the app, and answering as the app's bot, with a
// reaction on the comment and a reply on the item.

import { type Command, commandNames, findCommand } from "../../shared/commands.ts";
import { itemKey } from "../../shared/refs.ts";
import { installationToken } from "../github/tokens.ts";
import { instance } from "../namespaces.ts";
import { failureFrom } from "./github-write.ts";
import type { CommandReaction, CommentCommand, ReplyResult, RepoIdentity } from "./types.ts";
import { forgeFetch } from "./rateLimit.ts";

const HOST = "github.com";
const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

/** The part of an `issue_comment` payload commands read. */
export interface IssueCommentPayload {
	action?: string;
	issue?: { number: number; html_url?: string; pull_request?: unknown };
	comment?: {
		id: number;
		html_url: string;
		body?: string | null;
		user?: { login: string; id: number; type?: string } | null;
		created_at?: string;
		updated_at?: string;
	};
	changes?: { body?: { from?: string } };
}

/**
 * Commands in comments last written longer ago than this are ignored
 * (`stale`), so a replayed delivery can't run one again once the `Repo` has
 * forgotten it (it remembers commands for 30 days, and deliveries' digests
 * for three). GitHub delivers within seconds and redelivers for three days.
 */
export const COMMAND_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

// The app's slug never changes once it's set up, so each isolate asks once.
let slug: string | null = null;

async function appSlug(env: Env): Promise<string | null> {
	if (!env.TACK_SECRET) return null;
	slug ??= (await instance(env).appInfo())?.slug ?? null;
	return slug;
}

/** What the app answers to: its slug, and `TACK_COMMAND_ALIAS`. */
export async function appCommandNames(env: Env): Promise<string[]> {
	return commandNames(await appSlug(env), env.TACK_COMMAND_ALIAS);
}

export type CommentReading =
	| { type: "command"; command: Omit<CommentCommand, "origin"> }
	| {
			type: "ignored";
			reason: "action" | "bot" | "no_command" | "already_a_command" | "malformed" | "stale";
	  };

/**
 * Whether a comment is a command for the app. Bots are never listened to
 * (the app's own replies included), and an edited comment only counts if
 * it didn't have a command before the edit: fixing a typo in a command
 * that already ran mustn't run it again. Each comment runs at most once
 * however often it's edited (the `Repo` remembers its id).
 */
export function readIssueComment(
	repo: RepoIdentity,
	payload: IssueCommentPayload,
	names: readonly string[],
): CommentReading {
	const { action, issue, comment } = payload;
	if (action !== "created" && action !== "edited") return { type: "ignored", reason: "action" };
	if (!issue || !comment?.user) return { type: "ignored", reason: "malformed" };
	const user = comment.user;
	if (user.type === "Bot" || /\[bot\]$/i.test(user.login))
		return { type: "ignored", reason: "bot" };
	const written = Date.parse(comment.updated_at ?? comment.created_at ?? "");
	if (Number.isFinite(written) && Date.now() - written > COMMAND_MAX_AGE_MS) {
		return { type: "ignored", reason: "stale" };
	}
	const command: Command | null = findCommand(comment.body ?? "", names);
	if (!command) return { type: "ignored", reason: "no_command" };
	if (action === "edited" && findCommand(payload.changes?.body?.from ?? "", names)) {
		return { type: "ignored", reason: "already_a_command" };
	}
	const item = `#${issue.number}`;
	return {
		type: "command",
		command: {
			command,
			comment: { id: String(comment.id), url: comment.html_url },
			author: { id: user.id, login: user.login },
			item: {
				key: itemKey({ host: HOST, repo: repo.name, item }),
				ref: item,
				kind: issue.pull_request ? "pull" : "issue",
			},
			edited: action === "edited",
		},
	};
}

function headers(token: string): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		"content-type": "application/json",
		"user-agent": "tack",
		"x-github-api-version": "2022-11-28",
		authorization: `Bearer ${token}`,
	};
}

async function call(token: string, path: string, init: { method: string; body?: unknown }) {
	return forgeFetch(`${API}${path}`, {
		method: init.method,
		headers: headers(token),
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

async function appToken(env: Env, repo: RepoIdentity): Promise<string | null> {
	return installationToken(env, `${HOST}/${repo.name}`);
}

/** React to a comment as the app. Returns the reaction's id, to take it back later. */
export async function reactGitHub(
	repo: RepoIdentity,
	comment: string,
	content: CommandReaction,
	env: Env,
): Promise<string | null> {
	const token = await appToken(env, repo);
	if (!token) return null;
	const response = await call(token, `/repos/${repo.name}/issues/comments/${comment}/reactions`, {
		method: "POST",
		body: { content },
	});
	if (!response.ok) throw new Error(`GitHub ${response.status} reacting to a comment`);
	const reaction = await response.json<{ id?: number }>();
	return reaction.id === undefined ? null : String(reaction.id);
}

/** Take back a reaction the app left. */
export async function unreactGitHub(
	repo: RepoIdentity,
	comment: string,
	reaction: string,
	env: Env,
): Promise<void> {
	const token = await appToken(env, repo);
	if (!token) return;
	const response = await call(
		token,
		`/repos/${repo.name}/issues/comments/${comment}/reactions/${reaction}`,
		{ method: "DELETE" },
	);
	if (!response.ok && response.status !== 404) {
		throw new Error(`GitHub ${response.status} removing a reaction`);
	}
}

/**
 * Comment on an item as the app. `retryOf` (when the first attempt was made)
 * says an earlier attempt may have gone through unanswered: if the app
 * already left this reply since then, that's the one.
 */
export async function replyGitHub(
	repo: RepoIdentity,
	item: string,
	body: string,
	env: Env,
	options: { retryOf?: number } = {},
): Promise<ReplyResult> {
	const token = await appToken(env, repo);
	if (!token) return { ok: false, error: "The app isn't installed here.", retryable: false };
	const number = item.replace(/^#/, "");
	const path = `/repos/${repo.name}/issues/${number}/comments`;
	try {
		if (options.retryOf !== undefined) {
			const since = new Date(options.retryOf - 60_000).toISOString();
			const recent = await call(token, `${path}?since=${encodeURIComponent(since)}&per_page=100`, {
				method: "GET",
			});
			if (recent.ok) {
				const comments =
					await recent.json<{ body?: string; html_url: string; user?: { type?: string } }[]>();
				const made = comments.find(
					(comment) => comment.user?.type === "Bot" && comment.body?.trim() === body.trim(),
				);
				if (made) return { ok: true, url: made.html_url };
			}
		}
		const response = await call(token, path, { method: "POST", body: { body } });
		if (!response.ok) {
			const failure = await failureFrom(response, `reply on ${repo.name}${item}`);
			return {
				ok: false,
				error: failure.error,
				retryable: failure.retryable,
				...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
			};
		}
		return { ok: true, url: (await response.json<{ html_url: string }>()).html_url };
	} catch {
		return { ok: false, error: "Couldn't reach GitHub.", retryable: true };
	}
}
