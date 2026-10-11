import type { ChangeProblem } from "../../shared/changes.ts";
import type { MissingCard } from "../../shared/cards.ts";
import type { ApplyResult } from "./types.ts";
import { forgeFetch, rateLimitOf } from "./rateLimit.ts";

// Calling the REST APIs of the forges besides GitHub (#65): GitLab, Forgejo
// and Tangled. Every call goes through `forgeFetch` (one rate-limit gate for
// every forge), with a timeout, and failures come back in plain words that
// name the forge, as GitHub's do (`github-write.ts`).

/** Give up on a request that hasn't answered in this long. */
export const TIMEOUT_MS = 20_000;
/** An earlier attempt's creation counts as ours if it's at most this much older than the attempt. */
export const RETRY_SLACK_MS = 60_000;

export type Failure = Extract<ApplyResult, { ok: false }>;

/** A forge's API, as one host's adapter calls it. */
export interface RestApi {
	/** What copy calls the forge: `GitLab`, `Codeberg`, a self-hosted instance's name. */
	name: string;
	/** The API's root, e.g. `https://gitlab.com/api/v4`. */
	base: string;
	headers: Record<string, string>;
}

/** A failure that `apply` returns rather than throws. */
export class WriteFailure extends Error {
	constructor(readonly failure: Failure) {
		super(failure.error);
	}
}

export function fail(
	error: string,
	retryable = false,
	detail?: string,
	problem?: ChangeProblem,
): never {
	throw new WriteFailure({
		ok: false,
		error,
		retryable,
		...(detail ? { detail } : {}),
		...(problem ? { problem } : {}),
	});
}

export interface CallOptions {
	method?: string;
	body?: unknown;
	/** Return null for a 404, rather than failing. */
	allow404?: boolean;
}

/** One request, or a failure that says the forge couldn't be reached. */
export async function send(
	api: RestApi,
	path: string,
	options: CallOptions = {},
): Promise<Response> {
	try {
		return await forgeFetch(`${api.base}${path}`, {
			method: options.method ?? "GET",
			headers: {
				accept: "application/json",
				"user-agent": "tack",
				...api.headers,
				...(options.body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		fail(
			timedOut
				? `${api.name} didn't answer in time. Tack will check whether it went through before trying again.`
				: `Couldn't reach ${api.name}.`,
			true,
		);
	}
}

/**
 * Call the API for JSON. `what` finishes "Couldn't …" in error messages,
 * e.g. "add labels to group/project#12".
 */
export async function rest<T>(
	api: RestApi,
	path: string,
	what: string,
	options: CallOptions = {},
): Promise<T> {
	const response = await send(api, path, options);
	if (response.ok) {
		if (response.status === 204) return null as T;
		const body = await response.text();
		return (body ? JSON.parse(body) : null) as T;
	}
	if (response.status === 404 && options.allow404) return null as T;
	throw new WriteFailure(await failureFrom(api, response, what));
}

/** What an error response says, in the shapes GitLab and Forgejo use. */
export async function messageOf(response: Response): Promise<string> {
	const body = await response
		.json<{ message?: unknown; error?: unknown; errors?: unknown }>()
		.catch(() => null);
	const parts: string[] = [];
	const add = (value: unknown) => {
		if (typeof value === "string") parts.push(value);
		else if (Array.isArray(value)) for (const v of value) add(v);
		else if (value && typeof value === "object") {
			for (const [field, v] of Object.entries(value)) {
				if (typeof v === "string") parts.push(`${field} ${v}`);
				else add(v);
			}
		}
	};
	add(body?.message);
	add(body?.error);
	add(body?.errors);
	return parts.filter(Boolean).join("; ");
}

/**
 * A refusal in plain words, with what to do. The forge's own words go in
 * `detail`, for whoever needs to look it up.
 */
export async function failureFrom(
	api: RestApi,
	response: Response,
	what: string,
): Promise<Failure> {
	const message = await messageOf(response);
	const status = response.status;
	const detail = `${api.name} said (${status})${message ? `: ${message}` : ""}`;
	const limit = rateLimitOf(response, { message });
	if (limit || status === 429) {
		const retryAt = limit?.retryAt ?? Date.now() + 60_000;
		return {
			ok: false,
			error: `${api.name} is rate limiting Tack until ${new Date(retryAt).toISOString().slice(11, 16)} UTC, so it'll try again then.`,
			retryable: true,
			retryAt,
			detail,
		};
	}
	if (status >= 500) {
		return {
			ok: false,
			error: `${api.name} had a problem on its side and couldn't ${what}. Tack will try again.`,
			retryable: true,
			detail,
		};
	}
	return { ok: false, error: explain(api.name, status, message, what), retryable: false, detail };
}

export function explain(forge: string, status: number, message: string, what: string): string {
	if (status === 401) {
		return `${forge} didn't accept Tack's token. An admin needs to give this instance a new one.`;
	}
	if (status === 403) {
		return `${forge} didn't let Tack ${what}. The account behind Tack's token needs to be able to write there.`;
	}
	if (status === 404) return `Couldn't ${what}: it's been deleted or moved, or Tack can't see it.`;
	if (status === 409 || status === 422 || status === 400) {
		if (/assignee|user/i.test(message)) {
			return `Couldn't ${what}: someone can't be assigned there. People need access to the repository to be assigned.`;
		}
		if (/milestone/i.test(message)) {
			return `Couldn't ${what}: that milestone is closed or gone. Pick another, then retry.`;
		}
		if (/label/i.test(message)) {
			return `Couldn't ${what}: ${forge} wouldn't take one of the labels. Check it still exists.`;
		}
		if (/already (exists|been taken|related|linked)|has already been taken/i.test(message)) {
			return `Couldn't ${what}: it's already there.`;
		}
		return `Couldn't ${what}: ${forge} said something in it isn't valid.`;
	}
	return `Couldn't ${what} (${forge} answered ${status}).`;
}

/** Run a write, turning anything thrown into a result: `apply` never throws for forge errors. */
export async function settle(forge: string, run: () => Promise<ApplyResult>): Promise<ApplyResult> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof WriteFailure) return error.failure;
		return {
			ok: false,
			error: `Something went wrong writing to ${forge}: ${error instanceof Error ? error.message : String(error)}`,
			retryable: false,
		};
	}
}

/** Why an item couldn't be read, from the response that said so. */
export function missingReason(response: Response): MissingCard["reason"] {
	if (response.status === 404) return "not_found";
	const rateLimited = response.status === 429 || rateLimitOf(response) !== null;
	if ((response.status === 401 || response.status === 403) && !rateLimited) return "forbidden";
	return "error";
}

/** Whether a creation `retryOf` asked about happened at about the right time. */
export function sinceRetry(createdAt: string | null | undefined, retryOf: number): boolean {
	return Boolean(createdAt) && Date.parse(createdAt ?? "") >= retryOf - RETRY_SLACK_MS;
}

/** A path's segments, each encoded, so nothing in a name can change which API path is called. */
export function segments(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * A time as cards keep them, ISO 8601 in UTC, so they compare as strings:
 * Forgejo answers with offsets (`+02:00`), GitLab's webhooks with `UTC`.
 */
export function iso(value: string): string;
export function iso(value: string | null | undefined): string | null;
export function iso(value: string | null | undefined): string | null {
	if (!value) return null;
	const time = Date.parse(value.replace(/ UTC$/, "Z").replace(/^(\d{4}-\d\d-\d\d) /, "$1T"));
	return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** `#a1b2c3` or `a1b2c3` to `a1b2c3`, as cards keep colours; anything else is grey. */
export function hexColor(color: string | null | undefined): string {
	const hex = (color ?? "").replace(/^#/, "").toLowerCase();
	if (/^[0-9a-f]{6}$/.test(hex)) return hex;
	if (/^[0-9a-f]{3}$/.test(hex))
		return hex
			.split("")
			.map((c) => c + c)
			.join("");
	return "cccccc";
}

/** The ref name rules a branch must follow (as `check-ref-format` has them). */
export function validBranch(name: string): boolean {
	if (name.length > 200 || /^[/-]|\.\.|\/\/|@\{|\.lock$|\/$|\.$|[\s~^:?*[\\]/.test(name)) {
		return false;
	}
	return !name.split("").some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

export function validFilePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!path.startsWith("/") &&
		!path.endsWith("/") &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
	);
}
