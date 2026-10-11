import { describe, expect, it } from "vite-plus/test";
import {
	MAX_WAIT_MS,
	RateLimitGate,
	SECONDARY_MAX_MS,
	SECONDARY_WAIT_MS,
	backoffMs,
	bucketOf,
	gatedResponse,
	rateLimitOf,
	resourceOf,
} from "../src/server/forges/rateLimit.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

function response(status: number, headers: Record<string, string> = {}) {
	return { status, headers: new Headers(headers) };
}

describe("rateLimitOf", () => {
	it("waits out retry-after on a secondary limit, for every resource", () => {
		const limit = rateLimitOf(response(403, { "retry-after": "30" }), { now: NOW });
		expect(limit).toEqual({ retryAt: NOW + 30_000, kind: "secondary", resource: "*" });
	});

	it("waits for the reset when the primary budget is used up", () => {
		const reset = Math.floor((NOW + 20 * 60_000) / 1000);
		const limit = rateLimitOf(
			response(403, {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": String(reset),
				"x-ratelimit-resource": "search",
			}),
			{ now: NOW },
		);
		expect(limit).toEqual({ retryAt: reset * 1000, kind: "primary", resource: "search" });
	});

	it("counts a success that used the last of the budget, until the reset", () => {
		const reset = Math.floor((NOW + 60_000) / 1000);
		const used = response(200, {
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset": String(reset),
		});
		expect(rateLimitOf(used, { now: NOW })?.retryAt).toBe(reset * 1000);
		expect(rateLimitOf(used, { now: reset * 1000 + 1 })).toBeNull();
		expect(rateLimitOf(response(200, { "x-ratelimit-remaining": "12" }), { now: NOW })).toBeNull();
	});

	it("reads secondary limits that only say so in words, and bare 429s", () => {
		const message = "You have exceeded a secondary rate limit. Please wait a few minutes.";
		expect(rateLimitOf(response(403), { message, now: NOW })?.retryAt).toBe(
			NOW + SECONDARY_WAIT_MS,
		);
		expect(rateLimitOf(response(429), { now: NOW })?.kind).toBe("secondary");
		expect(rateLimitOf(response(403), { message: "Resource not accessible", now: NOW })).toBeNull();
		expect(rateLimitOf(response(404), { now: NOW })).toBeNull();
	});

	it("never waits less than a second, or more than an hour", () => {
		expect(rateLimitOf(response(429, { "retry-after": "86400" }), { now: NOW })?.retryAt).toBe(
			NOW + MAX_WAIT_MS,
		);
		const past = Math.floor((NOW - 5000) / 1000);
		const limit = rateLimitOf(
			response(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(past) }),
			{ now: NOW },
		);
		expect(limit?.retryAt).toBe(NOW + 1000);
	});

	it("knows the resource from the URL when GitHub doesn't say", () => {
		expect(resourceOf("https://api.github.com/graphql")).toBe("graphql");
		expect(resourceOf("https://api.github.com/search/issues?q=x")).toBe("search");
		expect(resourceOf("https://api.github.com/repos/a/b/issues/1")).toBe("core");
	});
});

describe("buckets", () => {
	it("keeps tokens out of its keys, and counts app JWTs as the app", () => {
		const bucket = bucketOf("Bearer ghu_secret_token");
		expect(bucket).not.toContain("secret");
		expect(bucketOf("token ghu_secret_token")).toBe(bucket);
		expect(bucketOf(null)).toBe("anonymous");
		expect(bucketOf("Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjF9.c2ln")).toBe("app");
	});
});

describe("RateLimitGate", () => {
	it("holds a resource until its limit lifts, and secondary limits hold all of them", () => {
		let now = NOW;
		const gate = new RateLimitGate(() => now);
		gate.note("t:a", { retryAt: NOW + 10_000, kind: "primary", resource: "search" });
		expect(gate.blockedUntil("t:a", "search")).toBe(NOW + 10_000);
		expect(gate.blockedUntil("t:a", "core")).toBeNull();
		expect(gate.blockedUntil("t:b", "search")).toBeNull();
		gate.note("t:b", { retryAt: NOW + 5_000, kind: "secondary", resource: "*" });
		expect(gate.blockedUntil("t:b", "core")).toBe(NOW + 5_000);
		expect(gate.blockedUntil("t:b", "graphql")).toBe(NOW + 5_000);
		now = NOW + 10_001;
		expect(gate.blockedUntil("t:a", "search")).toBeNull();
	});

	it("waits longer each time a secondary limit comes back soon", () => {
		let now = NOW;
		const gate = new RateLimitGate(() => now);
		const strike = () =>
			gate.note("t:a", { retryAt: now + 1_000, kind: "secondary", resource: "*" }) - now;
		expect(strike()).toBe(1_000);
		now += 2_000;
		expect(strike()).toBe(SECONDARY_WAIT_MS * 2);
		now += 2_000;
		expect(strike()).toBe(SECONDARY_WAIT_MS * 4);
		for (let i = 0; i < 10; i++) strike();
		expect(strike()).toBe(SECONDARY_MAX_MS);
		// Forgotten after a quiet while.
		now += 60 * 60_000;
		expect(strike()).toBe(1_000);
	});

	it("answers for GitHub while a limit holds", async () => {
		const answer = gatedResponse(NOW + 30_500, "search", NOW);
		expect(answer.status).toBe(429);
		expect(answer.headers.get("retry-after")).toBe("31");
		expect(rateLimitOf(answer, { now: NOW })?.retryAt).toBe(NOW + 30_500);
	});
});

describe("backoffMs", () => {
	it("grows threefold with jitter, up to a cap", () => {
		expect(backoffMs(1, 1000, 60_000, () => 0.5)).toBe(1000);
		expect(backoffMs(3, 1000, 60_000, () => 0.5)).toBe(9000);
		expect(backoffMs(10, 1000, 60_000, () => 0.5)).toBe(60_000);
		expect(backoffMs(1, 1000, 60_000, () => 0)).toBe(800);
		expect(backoffMs(1, 1000, 60_000, () => 1)).toBe(1200);
	});
});
