import type { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { MAX_BODY_BYTES, RateLimiter, handleClientError } from "../src/server/clientErrors.ts";
import { startWorker } from "./harness.ts";

const ENDPOINT = "https://tack.example/api/client-errors";

function report(body: unknown, headers: Record<string, string> = {}) {
	return new Request(ENDPOINT, {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "content-type": "application/json", ...headers },
	});
}

const valid = {
	source: "boundary",
	name: "TypeError",
	message: "Cannot read properties of undefined (reading 'title')",
	stack: "TypeError: Cannot read properties of undefined\n    at CardView (CardView.tsx:12:3)",
	componentStack: "\n    at CardView\n    at CardNode",
	path: "/b/abc123/planning?invite=secret#frag",
};

function logged(spy: { mock: { calls: unknown[][] } }) {
	return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("handleClientError", () => {
	it("logs a structured client.error event, without query strings or IPs", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await handleClientError(
			report(valid, { "user-agent": "Test/1.0", "cf-connecting-ip": "203.0.113.9" }),
			new RateLimiter(),
		);
		expect(response.status).toBe(204);
		const entry = logged(error);
		expect(entry).toMatchObject({
			level: "error",
			event: "client.error",
			source: "boundary",
			name: "TypeError",
			message: valid.message,
			path: "/b/abc123/planning",
			userAgent: "Test/1.0",
		});
		expect(JSON.stringify(entry)).not.toContain("203.0.113.9");
		expect(JSON.stringify(entry)).not.toContain("secret");
	});

	it("truncates long fields", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await handleClientError(report({ ...valid, message: "x".repeat(5000) }), new RateLimiter());
		expect(logged(error).message).toHaveLength(1000);
	});

	it("refuses oversized reports", async () => {
		const big = JSON.stringify({ ...valid, stack: "x".repeat(MAX_BODY_BYTES) });
		expect((await handleClientError(report(big), new RateLimiter())).status).toBe(413);
	});

	it("refuses invalid reports", async () => {
		const limiter = new RateLimiter();
		expect((await handleClientError(report("not json"), limiter)).status).toBe(400);
		expect((await handleClientError(report({ message: "no source" }), limiter)).status).toBe(400);
		expect((await handleClientError(report({ ...valid, source: "made-up" }), limiter)).status).toBe(
			400,
		);
	});

	it("refuses other origins and methods", async () => {
		const limiter = new RateLimiter();
		const foreign = report(valid, { origin: "https://evil.example" });
		expect((await handleClientError(foreign, limiter)).status).toBe(403);
		expect((await handleClientError(new Request(ENDPOINT), limiter)).status).toBe(405);
	});

	it("rate limits each client", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const limiter = new RateLimiter(
			{ limit: 2, windowMs: 60_000 },
			{ limit: 100, windowMs: 60_000 },
		);
		const send = (ip: string) =>
			handleClientError(report(valid, { "cf-connecting-ip": ip }), limiter);
		expect((await send("a")).status).toBe(204);
		expect((await send("a")).status).toBe(204);
		expect((await send("a")).status).toBe(429);
		expect((await send("b")).status).toBe(204);
	});

	it("rate limits across clients, and resets each window", () => {
		const limiter = new RateLimiter({ limit: 1, windowMs: 1000 }, { limit: 2, windowMs: 1000 });
		expect(limiter.allow("a", 0)).toBe(true);
		expect(limiter.allow("a", 500)).toBe(false);
		expect(limiter.allow("b", 500)).toBe(true);
		expect(limiter.allow("c", 500)).toBe(false);
		expect(limiter.allow("a", 1000)).toBe(true);
	});
});

describe("POST /api/client-errors", () => {
	let mf: Miniflare;
	beforeAll(() => {
		mf = startWorker();
	});
	afterAll(() => mf.dispose());

	it("is routed by the Worker", async () => {
		const response = await mf.dispatchFetch(ENDPOINT, {
			method: "POST",
			body: JSON.stringify(valid),
			headers: { "content-type": "application/json" },
		});
		expect(response.status).toBe(204);
		expect((await mf.dispatchFetch(ENDPOINT)).status).toBe(405);
	});
});
