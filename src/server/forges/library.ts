import type { RateLimitedError } from "forges";
import type { MissingReason } from "./types.ts";
import { forgeFetch } from "./rateLimit.ts";

// Adapters built on the `forges` library (forges.link) call forge APIs
// through it, and it through `fetchForLibrary`: every request still goes
// through `forgeFetch`, so the one rate-limit gate covers them too.
//
// The library waits out a rate limit itself when the forge names a wait of
// up to a minute (`retry-after`), then tries once more. Tack never waits
// inside a request or an alarm: callers read the limit's end and come back
// then. So a limited answer reaches the library with its wait as a reset time
// instead, which it reports as `RateLimitedError.resetAt` without sleeping.
//
// Errors are told apart by name: the library's error classes are exported
// only from its root, which would bundle every forge's provider.

/** `fetch` for the library: `forgeFetch`, with limits it will report rather than wait out. */
export async function fetchForLibrary(input: string, init: RequestInit = {}): Promise<Response> {
	const response = await forgeFetch(input, init);
	const after = response.headers.get("retry-after");
	if ((response.status !== 429 && response.status !== 403) || after === null) return response;
	const seconds = Number(after);
	const resetAt = Number.isFinite(seconds)
		? Date.now() + seconds * 1000
		: Date.parse(after) || Date.now() + 60_000;
	const headers = new Headers(response.headers);
	headers.delete("retry-after");
	headers.set("x-ratelimit-remaining", "0");
	headers.set("x-ratelimit-reset", String(Math.ceil(resetAt / 1000)));
	return new Response(response.body, { status: response.status, headers });
}

const FORBIDDEN = new Set([
	"TokenRevokedError",
	"AuthenticationRequiredError",
	"InsufficientScopeError",
	"ForbiddenError",
]);

const nameOf = (error: unknown) => (error instanceof Error ? error.name : "");

/** Why an item couldn't be read, from what the library threw. */
export function missingOf(error: unknown): MissingReason {
	const name = nameOf(error);
	if (name === "NotFoundError") return "not_found";
	if (name === "UnsupportedOperationError") return "unsupported";
	return FORBIDDEN.has(name) ? "forbidden" : "error";
}

/** When to try again after what the library threw, if it was a rate limit that says. */
export function retryAtOf(error: unknown): number | undefined {
	return nameOf(error) === "RateLimitedError"
		? (error as RateLimitedError).resetAt?.getTime()
		: undefined;
}
