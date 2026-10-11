// Rate limits, one way for every call to a forge (#60).
//
// GitHub has two kinds (https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api):
//
// - **Primary**: a budget per token (or per IP, signed out) and resource
//   (`core`, `search`, `graphql`…). `x-ratelimit-remaining` counts down and
//   `x-ratelimit-reset` says when it refills (seconds since the epoch). Once
//   it's 0, every call fails with 403 or 429 until then.
// - **Secondary**: too much at once (concurrency, points per minute, content
//   creation). A 403 or 429, usually with `retry-after` (seconds); without
//   one, wait at least a minute, and longer each time it happens again.
//
// `forgeFetch` is `fetch` for forge APIs: it notes every limit it sees in a
// per-isolate gate keyed by token and resource, and while one holds, it
// answers for GitHub (a 429 with `retry-after`) without calling it, so
// nothing anywhere keeps knocking on a door GitHub has shut. Callers read
// any response with `rateLimitOf`, so they all agree on when to try again
// (`retryAt`), and pass that on: the push engine, the widget runner, comment
// commands and polling all wait for it rather than for their own timers.

import { log } from "../log.ts";

/** GitHub's advice for a secondary limit with no `retry-after`: at least a minute. */
export const SECONDARY_WAIT_MS = 60_000;
/** Secondary limits again soon after the last double the wait, up to this. */
export const SECONDARY_MAX_MS = 15 * 60_000;
/** Strikes older than this are forgotten. */
const STRIKE_MEMORY_MS = 15 * 60_000;
/** No limit lasts longer than GitHub's hourly window (and a clock may be off). */
export const MAX_WAIT_MS = 60 * 60_000;
/** Marks responses the gate made up, rather than GitHub. */
export const GATED_HEADER = "x-tack-rate-limit";

export type LimitKind = "primary" | "secondary";

export interface RateLimit {
	/** When to try again, ms since the epoch. */
	retryAt: number;
	kind: LimitKind;
	/** GitHub's resource (`core`, `search`, `graphql`…), or `*` for a secondary limit. */
	resource: string;
}

/** The resource a call to this URL counts against, before GitHub says. */
export function resourceOf(url: string | URL): string {
	const path = typeof url === "string" ? new URL(url).pathname : url.pathname;
	if (path === "/graphql" || path.endsWith("/graphql")) return "graphql";
	if (path.startsWith("/search/code")) return "code_search";
	if (path.startsWith("/search/")) return "search";
	return "core";
}

/**
 * Whether this response is a rate limit, and when to try again. `message` is
 * the body's message when the caller has read it (secondary limits without
 * headers only say so in words). A successful response that used the last of
 * the budget (`remaining: 0`) is a limit too: the call worked, the next won't.
 */
export function rateLimitOf(
	response: Pick<Response, "status" | "headers">,
	options: { message?: string; url?: string | URL; now?: number } = {},
): RateLimit | null {
	const now = options.now ?? Date.now();
	const { status, headers } = response;
	const resource =
		headers.get("x-ratelimit-resource") ?? (options.url ? resourceOf(options.url) : "core");
	const refused = status === 403 || status === 429;
	const remaining = headers.get("x-ratelimit-remaining");
	const after = Number(headers.get("retry-after"));
	const clamp = (at: number) => Math.min(Math.max(at, now + 1000), now + MAX_WAIT_MS);

	// The gate's own answers carry the exact time it's waiting for.
	const gated = Number(headers.get(GATED_HEADER));
	if (refused && gated > now) return { retryAt: gated, kind: "primary", resource };
	if (refused && Number.isFinite(after) && after > 0) {
		return {
			retryAt: clamp(now + after * 1000),
			kind: remaining === "0" ? "primary" : "secondary",
			resource: remaining === "0" ? resource : "*",
		};
	}
	if (remaining === "0") {
		const reset = Number(headers.get("x-ratelimit-reset"));
		const retryAt = reset > 0 ? reset * 1000 : now + SECONDARY_WAIT_MS;
		// A success with nothing left only matters until the reset.
		if (!refused && retryAt <= now) return null;
		return { retryAt: clamp(retryAt), kind: "primary", resource };
	}
	if (status === 429 || (status === 403 && /rate limit|abuse/i.test(options.message ?? ""))) {
		return { retryAt: clamp(now + SECONDARY_WAIT_MS), kind: "secondary", resource: "*" };
	}
	return null;
}

/** Whether a GraphQL body's errors say it was rate limited. */
export function graphqlRateLimited(errors: readonly { type?: string }[] | undefined): boolean {
	return (errors ?? []).some((error) => error.type === "RATE_LIMITED");
}

/**
 * A wait after a failure that doesn't say when (a timeout, a 5xx): `base`,
 * then three times as long each attempt, up to `max`, with up to a fifth
 * either way of jitter so retries from many places don't arrive together.
 */
export function backoffMs(
	attempt: number,
	base: number,
	max: number,
	random = Math.random,
): number {
	const wait = Math.min(max, base * 3 ** Math.max(0, attempt - 1));
	return Math.round(wait * (0.8 + random() * 0.4));
}

/** Who's calling, as GitHub counts it: a token, the app, or this isolate's IP. */
export function bucketOf(authorization: string | null | undefined): string {
	const token = authorization?.replace(/^(bearer|token)\s+/i, "").trim();
	if (!token) return "anonymous";
	// App JWTs change every few minutes but share the app's limits.
	if (/^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token)) return "app";
	return `t:${fnv1a(token)}`;
}

/** A short, non-reversible name for a token: the gate never keeps tokens themselves. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/**
 * Limits seen in this isolate, by bucket and resource. A secondary limit
 * holds every resource for its bucket.
 */
export class RateLimitGate {
	private until = new Map<string, number>();
	private strikes = new Map<string, { count: number; at: number }>();

	constructor(private readonly now: () => number = Date.now) {}

	/** When the limit on this bucket and resource lifts, if one holds now. */
	blockedUntil(bucket: string, resource: string): number | null {
		const now = this.now();
		let latest: number | null = null;
		for (const key of [`${bucket}|${resource}`, `${bucket}|*`]) {
			const at = this.until.get(key);
			if (at === undefined) continue;
			if (at <= now) this.until.delete(key);
			else latest = Math.max(latest ?? 0, at);
		}
		return latest;
	}

	/** Remember a limit. Returns when it lifts, after any escalation. */
	note(bucket: string, limit: RateLimit): number {
		const now = this.now();
		let retryAt = limit.retryAt;
		if (limit.kind === "secondary") {
			const last = this.strikes.get(bucket);
			const count = last && now - last.at < STRIKE_MEMORY_MS ? last.count + 1 : 1;
			this.strikes.set(bucket, { count, at: now });
			const escalated = Math.min(SECONDARY_WAIT_MS * 2 ** (count - 1), SECONDARY_MAX_MS);
			retryAt = Math.max(retryAt, now + (count > 1 ? escalated : 0));
		}
		const key = `${bucket}|${limit.resource}`;
		this.until.set(key, Math.max(this.until.get(key) ?? 0, retryAt));
		this.prune(now);
		return retryAt;
	}

	/** Forget everything (tests). */
	clear(): void {
		this.until.clear();
		this.strikes.clear();
	}

	private prune(now: number): void {
		if (this.until.size < 500) return;
		for (const [key, at] of this.until) if (at <= now) this.until.delete(key);
		for (const [key, strike] of this.strikes) {
			if (now - strike.at >= STRIKE_MEMORY_MS) this.strikes.delete(key);
		}
	}
}

/** The gate every forge call in this isolate goes through. */
export const gate = new RateLimitGate();

/** A 429 the gate answers with, as GitHub would, while a limit holds. */
export function gatedResponse(retryAt: number, resource: string, now = Date.now()): Response {
	const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
	return new Response(
		JSON.stringify({ message: "API rate limit exceeded (waiting for GitHub's limit to lift)" }),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(seconds),
				"x-ratelimit-resource": resource,
				[GATED_HEADER]: String(retryAt),
			},
		},
	);
}

/**
 * `fetch` for forge APIs. While a limit holds for the call's token and
 * resource, it answers 429 without calling; otherwise it calls, and notes
 * any limit the answer reports (logged as `forge.rate_limited`).
 */
export async function forgeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const url = typeof input === "string" ? new URL(input) : input;
	const headers = new Headers(init.headers);
	const bucket = bucketOf(headers.get("authorization"));
	const resource = resourceOf(url);
	const blocked = gate.blockedUntil(bucket, resource);
	if (blocked !== null) return gatedResponse(blocked, resource);
	const response = await fetch(url, init);
	await noteLimit(response, bucket, url);
	return response;
}

/** Note any limit a response reports, for its bucket. */
async function noteLimit(response: Response, bucket: string, url: URL): Promise<void> {
	let message = "";
	if (response.status === 403 || response.status === 429) {
		message = await response
			.clone()
			.text()
			.catch(() => "");
	}
	const limit = rateLimitOf(response, { message, url });
	if (!limit) return;
	const retryAt = gate.note(bucket, limit);
	log.warn("forge.rate_limited", {
		host: url.host,
		resource: limit.resource,
		kind: limit.kind,
		status: response.status,
		retryAt: new Date(retryAt).toISOString(),
		// Which token, without the token: "anonymous", "app", or a hash.
		bucket,
	});
}

/** Note a limit the caller found in a body (GraphQL's `RATE_LIMITED` with a 200). */
export function noteBodyLimit(
	authorization: string | null,
	response: Pick<Response, "status" | "headers">,
	url: string | URL,
): number {
	// GraphQL's points ran out; without a reset header, wait as for a secondary limit.
	const limit = rateLimitOf(response, { url }) ?? {
		retryAt: Date.now() + SECONDARY_WAIT_MS,
		kind: "primary" as const,
		resource: resourceOf(url),
	};
	return gate.note(bucketOf(authorization), limit);
}
