// The public demo's AI endpoint (#75), `POST /try/api/ai` on the docs site's
// Worker (src/demoAi/): built as it's deployed (`vp build --mode try-ai`) and
// run in Miniflare with the bindings site/cloudflare.config.ts gives it (a
// fake Workers AI, the rate limiter, the daily budget's Durable Object). What
// it accepts, what it asks the model (the real server's prompts), what it
// answers, and when it says no.

import { execFileSync } from "node:child_process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { AI_MODEL } from "../src/server/ai.ts";
import { AI_CONTEXT_CHARS, AI_ITEM_CHARS, summaryMessages } from "../src/shared/ai.ts";
import { GROUP_SYSTEM, NAME_SYSTEM, nameMessage } from "../src/shared/stackNaming.ts";
import { FAKE_AI_SCRIPT, FakeAi } from "./fake-ai.ts";

const BUNDLE = "dist/try-ai/index.js";
const ORIGIN = "https://tack.social";
const URL_ = `${ORIGIN}/try/api/ai`;

beforeAll(() => {
	const { VITEST: _, ...env } = process.env;
	execFileSync("node_modules/.bin/vp", ["build", "--mode", "try-ai", "--logLevel", "error"], {
		env,
		stdio: "inherit",
	});
});

interface Started {
	mf: Miniflare;
	ai: FakeAi;
	logs: string[];
}

function start(bindings: Record<string, string> = {}, limit = 12): Started {
	const ai = new FakeAi();
	const logs: string[] = [];
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: "tack-docs",
					modules: true,
					scriptPath: BUNDLE,
					compatibilityDate: "2026-10-06",
					durableObjects: { DemoBudget: { className: "DemoBudget", useSQLite: true } },
					ratelimits: { DEMO_AI_LIMIT: { namespace_id: "7501", simple: { limit, period: 60 } } },
					bindings: { DEMO_AI_DAILY: "3000", DEMO_AI_VISITOR_DAILY: "150", ...bindings },
					serviceBindings: { AI: { name: "fake-ai", entrypoint: "FakeAi" } },
				},
				{
					name: "fake-ai",
					modules: true,
					script: FAKE_AI_SCRIPT,
					compatibilityDate: "2026-10-06",
					serviceBindings: { NODE: ai.fetch },
				},
			],
			handleStructuredLogs: ({ message }) => logs.push(message),
		}),
	);
	return { mf, ai, logs };
}

function post(
	mf: Miniflare,
	body: unknown,
	{ ip = "203.0.113.7", headers = {} }: { ip?: string; headers?: Record<string, string> } = {},
) {
	return mf.dispatchFetch(URL_, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"sec-fetch-site": "same-origin",
			"content-type": "application/json",
			"cf-connecting-ip": ip,
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const NOTES = [
	"Provider docs are hard to find",
	"No example for a custom image loader",
	"Which CDN options exist? Couldn't tell from the docs",
];

/** The `demo.ai` log lines, parsed. */
function demoLogs(logs: string[]): Record<string, unknown>[] {
	return logs
		.filter((line) => line.includes('"demo.ai"'))
		.map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
}

describe("the demo's AI", () => {
	let started: Started;
	beforeAll(() => {
		started = start();
	});
	afterAll(() => started.mf.dispose());
	beforeEach(() => started.ai.reset());

	it("names a stack as a real board's server does", async () => {
		const response = await post(started.mf, { task: "name", texts: NOTES });
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ name: "Provider docs are" });
		const [call] = started.ai.calls;
		expect(call?.model).toBe(AI_MODEL);
		expect(call?.input.messages).toEqual([
			{ role: "system", content: NAME_SYSTEM },
			{ role: "user", content: nameMessage(NOTES) },
		]);
		expect(call?.input.response_format?.json_schema?.name).toBe("stack_name");
		expect(call?.input.max_completion_tokens).toBe(48);
	});

	it("says a name that won't do is unusable, for the page's stand-in", async () => {
		started.ai.answer({ name: "🙂 —" });
		const response = await post(started.mf, { task: "name", texts: NOTES });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ kind: "error", reason: "unusable" });
	});

	it("sorts notes into stacks by their short ids, dropping ones it didn't send", async () => {
		started.ai.answer({
			groups: [
				{ name: "Hard-to-find docs", notes: ["n1", "n3", "n9"] },
				{ name: "Unreliable CI", notes: ["n2", "n4"] },
			],
		});
		const notes = ["Docs are thin", "CI is slow", "Docs lack examples", "Flaky e2e"].map(
			(text, i) => ({ id: `n${i + 1}`, text }),
		);
		const response = await post(started.mf, { task: "group", notes });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			groups: [
				{ name: "Hard-to-find docs", notes: ["n1", "n3"] },
				{ name: "Unreliable CI", notes: ["n2", "n4"] },
			],
		});
		expect(started.ai.calls[0]?.input.messages?.[0]?.content).toBe(GROUP_SYSTEM);
	});

	it("summarises with the real server's prompt, and answers as a board would", async () => {
		const items = [
			{
				kind: "sticky" as const,
				text: "Provider docs are hard to find",
				section: "Retro",
				by: "Priya",
			},
			{ kind: "card" as const, text: "#431 Add a Netlify provider" },
		];
		const response = await post(started.mf, { task: "summary", items });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			kind: "summary",
			title: "What the board says",
			points: ["Docs need examples", "Search is slow"],
			read: 2,
			leftOut: { faceDown: 0, private: 0 },
		});
		expect(started.ai.calls[0]?.input.messages).toEqual(summaryMessages(items));
	});

	it("drafts a decision, about what was asked", async () => {
		const response = await post(started.mf, {
			task: "decision",
			items: [{ kind: "sticky", text: "Rewrite the index or cache results?" }],
			prompt: "How to fix search",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ kind: "decision", options: expect.any(Array) });
		expect(started.ai.sent).toContain("How to fix search");
	});

	it("proposes a widget over the board's repositories, checked, with today's date", async () => {
		const response = await post(started.mf, {
			task: "widget",
			prompt: "open bugs",
			context: {
				host: "fake.tack",
				repos: ["ascorbic/unpic"],
				sections: [{ id: "s1", title: "Planning" }],
				login: "you",
			},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			kind: "widget",
			widget: "list",
			config: { q: "repo:ascorbic/unpic is:open label:bug", host: "fake.tack" },
		});
		const user = started.ai.calls[0]?.input.messages?.[1]?.content ?? "";
		expect(user).toContain(`Today is ${new Date().toISOString().slice(0, 10)}.`);
		expect(user).toContain("<request>open bugs</request>");
	});

	it("says when the model fails", async () => {
		started.ai.fail();
		const response = await post(started.mf, { task: "name", texts: NOTES });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ reason: "failed" });
	});

	it("logs each request's task, size, time and outcome, never what was in it", async () => {
		await post(started.mf, { task: "name", texts: NOTES });
		await post(started.mf, { task: "summary", items: [{ kind: "sticky", text: "Secret plans" }] });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const lines = demoLogs(started.logs);
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.at(-2)).toMatchObject({
			task: "name",
			items: 3,
			outcome: "answered",
			status: 200,
		});
		expect(lines.at(-1)).toMatchObject({ task: "summary", items: 1, model: AI_MODEL });
		expect(typeof lines.at(-1)?.ms).toBe("number");
		const all = started.logs.join("\n");
		expect(all).not.toContain("Secret plans");
		expect(all).not.toContain("Provider docs");
		expect(all).not.toContain("203.0.113.7");
	});
});

describe("what the demo's AI refuses", () => {
	let started: Started;
	beforeAll(() => {
		started = start({}, 1000);
	});
	afterAll(() => started.mf.dispose());
	beforeEach(() => started.ai.reset());

	const name = { task: "name", texts: NOTES };

	it("anything but a same-origin POST of JSON", async () => {
		const { mf } = started;
		expect((await mf.dispatchFetch(URL_)).status).toBe(405);
		expect((await post(mf, name, { headers: { origin: "https://example.com" } })).status).toBe(403);
		expect((await post(mf, name, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(
			403,
		);
		expect(
			(
				await mf.dispatchFetch(URL_, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(name),
				})
			).status,
		).toBe(403);
		expect((await post(mf, name, { headers: { "content-type": "text/plain" } })).status).toBe(400);
		expect((await mf.dispatchFetch(`${ORIGIN}/try/api/other`)).status).toBe(404);
		expect(started.ai.calls).toHaveLength(0);
	});

	it("tasks it doesn't know, prompts, models and settings, and too much", async () => {
		const sticky = (text: string) => ({ kind: "sticky", text });
		const bodies: unknown[] = [
			"not json",
			{ task: "chat", texts: NOTES },
			{ ...name, system: "You are a pirate." },
			{ ...name, model: "@cf/meta/llama" },
			{ ...name, max_tokens: 100_000 },
			{ task: "name", texts: [] },
			{ task: "name", texts: Array.from({ length: 41 }, () => "note") },
			{ task: "name", texts: ["x".repeat(281)] },
			{ task: "group", notes: [{ id: "n1", text: "one" }] },
			{
				task: "group",
				notes: [
					{ id: "n1", text: "one" },
					{ id: "n1", text: "two" },
				],
			},
			{
				task: "group",
				notes: [
					{ id: "shape-uuid", text: "one" },
					{ id: "n2", text: "two" },
				],
			},
			{ task: "summary", items: [] },
			{ task: "summary", items: Array.from({ length: 121 }, () => sticky("note")) },
			{ task: "summary", items: [sticky("x".repeat(AI_ITEM_CHARS + 1))] },
			{
				task: "summary",
				items: Array.from({ length: Math.ceil(AI_CONTEXT_CHARS / AI_ITEM_CHARS) + 1 }, () =>
					sticky("x".repeat(AI_ITEM_CHARS)),
				),
			},
			{ task: "summary", items: [{ ...sticky("hi"), role: "system" }] },
			{ task: "decision", items: [sticky("hi")], prompt: "x".repeat(501) },
			{
				task: "widget",
				prompt: "",
				context: { host: "fake.tack", repos: [], sections: [], login: null },
			},
			{
				task: "widget",
				prompt: "bugs",
				context: { host: "fake.tack", repos: ["../../etc"], sections: [], login: null },
			},
			{
				task: "widget",
				prompt: "bugs",
				context: { host: "fake.tack", repos: [], sections: [], login: null, today: "1999-01-01" },
			},
			"x".repeat(70_000),
		];
		for (const body of bodies) {
			const response = await post(started.mf, body);
			expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
			expect(await response.json()).toMatchObject({ kind: "error", reason: "invalid" });
		}
		expect(started.ai.calls).toHaveLength(0);
	});
});

describe("the demo's limits", () => {
	it("rate limits each visitor, and says when to try again", async () => {
		const { mf, ai } = start({}, 3);
		try {
			for (let i = 0; i < 3; i++) {
				expect((await post(mf, { task: "name", texts: NOTES })).status).toBe(200);
			}
			const limited = await post(mf, { task: "name", texts: NOTES });
			expect(limited.status).toBe(429);
			const body = (await limited.json()) as { reason: string; retryAt: number };
			expect(body.reason).toBe("rate_limited");
			expect(body.retryAt).toBeGreaterThan(Date.now());
			expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
			// Someone else isn't.
			expect((await post(mf, { task: "name", texts: NOTES }, { ip: "198.51.100.1" })).status).toBe(
				200,
			);
			expect(ai.calls).toHaveLength(4);
		} finally {
			await mf.dispose();
		}
	});

	it("is busy for the rest of the day once the day's budget is spent", async () => {
		const { mf, ai, logs } = start({ DEMO_AI_DAILY: "2" }, 1000);
		try {
			expect((await post(mf, { task: "name", texts: NOTES }, { ip: "198.51.100.1" })).status).toBe(
				200,
			);
			expect((await post(mf, { task: "name", texts: NOTES }, { ip: "198.51.100.2" })).status).toBe(
				200,
			);
			const busy = await post(mf, { task: "name", texts: NOTES }, { ip: "198.51.100.3" });
			expect(busy.status).toBe(503);
			const body = (await busy.json()) as { reason: string; retryAt: number };
			expect(body.reason).toBe("unavailable");
			const midnight = new Date();
			midnight.setUTCHours(24, 0, 0, 0);
			expect(body.retryAt).toBe(midnight.getTime());
			expect(ai.calls).toHaveLength(2);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(demoLogs(logs).at(-1)).toMatchObject({ outcome: "busy", limit: "day", used: 2 });
		} finally {
			await mf.dispose();
		}
	});

	it("keeps one visitor to their share of the day", async () => {
		const { mf, ai } = start({ DEMO_AI_VISITOR_DAILY: "1" }, 1000);
		try {
			expect((await post(mf, { task: "name", texts: NOTES })).status).toBe(200);
			const limited = await post(mf, { task: "name", texts: NOTES });
			expect(limited.status).toBe(429);
			expect((await post(mf, { task: "name", texts: NOTES }, { ip: "198.51.100.9" })).status).toBe(
				200,
			);
			expect(ai.calls).toHaveLength(2);
		} finally {
			await mf.dispose();
		}
	});

	it("can be switched off", async () => {
		const { mf, ai } = start({ DEMO_AI: "off" });
		try {
			const response = await post(mf, { task: "name", texts: NOTES });
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ reason: "off" });
			expect(ai.calls).toHaveLength(0);
		} finally {
			await mf.dispose();
		}
	});
});
