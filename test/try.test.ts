import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { PlayAi } from "../src/client/play/ai.ts";
import { withRemote } from "../src/client/play/stacks.ts";
import { HintStore } from "../src/client/try/hints.ts";
import { DemoAi, type Fallback, wantsRealAi } from "../src/client/try/ai.ts";
import { staysHere } from "../src/client/try/network.ts";
import { fakeStackAi } from "../src/shared/fakeStackAi.ts";
import { forgeName, forgeNameOf, nameForge } from "../src/shared/refs.ts";
import { addShape, nextZ } from "../src/shared/shapes.ts";
import { readName } from "../src/shared/stackNaming.ts";

// The public demo's pure parts (#75): what counts as staying in the browser,
// and the pretend forge named as such in copy. (On the page, end to end, in
// e2e/try.spec.ts.)

const FILES = "https://tack.social/try/";

describe("staying in the browser", () => {
	it("allows the demo's own files and data it made", () => {
		expect(staysHere("https://tack.social/try/assets/geist.woff2", FILES)).toBe(true);
		expect(staysHere("assets/index.css", FILES)).toBe(true);
		expect(staysHere("/try/", FILES)).toBe(true);
		expect(staysHere("data:image/png;base64,AAAA", FILES)).toBe(true);
		expect(staysHere("blob:https://tack.social/0b7c", FILES)).toBe(true);
	});

	it("refuses anywhere else, the rest of its own site included", () => {
		expect(staysHere("https://example.com/try/", FILES)).toBe(false);
		expect(staysHere("https://tack.social/api/boards", FILES)).toBe(false);
		expect(staysHere("/start/tour/", FILES)).toBe(false);
		expect(staysHere("https://tack.social.example.com/try/", FILES)).toBe(false);
		expect(staysHere("//example.com/try/x", FILES)).toBe(false);
		expect(staysHere("wss://tack.social/try/", FILES)).toBe(false);
		expect(staysHere("http://[", FILES)).toBe(false);
	});
});

describe("the demo forge", () => {
	it("is what copy calls the pretend forge, and what it names when nothing says", () => {
		expect(forgeNameOf([])).toBe("GitHub");
		nameForge("fake.tack", "the demo forge", { byDefault: true });
		expect(forgeName("fake.tack")).toBe("the demo forge");
		expect(forgeNameOf(["fake.tack/ascorbic/tack#1"])).toBe("the demo forge");
		expect(forgeNameOf([])).toBe("the demo forge");
		expect(forgeName("github.com")).toBe("GitHub");
	});
});

describe("the demo's cards", () => {
	it("are all public, so the stand-in namer can name stacks of them", async () => {
		const { TRY_SCENARIOS } = await import("../src/client/try/scenarios.ts");
		const cards = Object.values(TRY_SCENARIOS).flatMap((scenario) => scenario.cards);
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.filter((card) => card.visibility !== "public")).toEqual([]);
	});
});

describe("the demo's AI, through the guard", () => {
	it("may post to its endpoint, exactly, and nowhere else", () => {
		expect(staysHere("https://tack.social/try/api/ai", FILES, "POST")).toBe(true);
		expect(staysHere("api/ai", FILES, "POST")).toBe(true);
		expect(staysHere("https://tack.social/try/api/ai?x=1", FILES, "POST")).toBe(false);
		expect(staysHere("https://tack.social/try/api/ai/", FILES, "POST")).toBe(false);
		expect(staysHere("https://tack.social/try/api/other", FILES, "POST")).toBe(false);
		expect(staysHere("https://tack.social/api/ai", FILES, "POST")).toBe(false);
		expect(staysHere("https://example.com/try/api/ai", FILES, "POST")).toBe(false);
		expect(staysHere("https://tack.social/try/", FILES, "POST")).toBe(false);
		expect(staysHere("https://tack.social/try/api/ai", FILES, "PUT")).toBe(false);
		expect(staysHere("https://tack.social/try/api/ai", FILES, "DELETE")).toBe(false);
	});
});

describe("the demo's AI, falling back", () => {
	const body = { task: "name" as const, texts: ["CI is slow", "Flaky e2e"] };

	function demo(answer: (call: number) => Response | Promise<Response>) {
		let calls = 0;
		let now = 1_000_000;
		const fallbacks: Fallback[] = [];
		const ai = new DemoAi({
			endpoint: "https://tack.social/try/api/ai",
			fetch: async () => answer(++calls),
			now: () => now,
			onFallback: (why) => fallbacks.push(why),
		});
		return {
			ai,
			fallbacks,
			calls: () => calls,
			later: (ms: number) => {
				now += ms;
			},
		};
	}

	it("answers with the real model's answer", async () => {
		const { ai, fallbacks } = demo(() => Response.json({ name: "Unreliable CI" }));
		expect(await ai.ask(body, 1000)).toEqual({ name: "Unreliable CI" });
		expect(fallbacks).toEqual([]);
	});

	it("leaves it to the stand-in until a rate limit lifts", async () => {
		const { ai, fallbacks, calls, later } = demo(() =>
			Response.json(
				{ kind: "error", reason: "rate_limited", retryAt: 1_000_000 + 60_000 },
				{ status: 429 },
			),
		);
		expect(await ai.ask(body, 1000)).toBeNull();
		expect(await ai.ask(body, 1000)).toBeNull();
		expect(calls()).toBe(1);
		later(60_000);
		expect(await ai.ask(body, 1000)).toBeNull();
		expect(calls()).toBe(2);
		expect(fallbacks).toEqual(["rate_limited", "rate_limited", "rate_limited"]);
	});

	it("leaves it to the stand-in for the rest of a busy day", async () => {
		const { ai, fallbacks, calls, later } = demo(() =>
			Response.json(
				{ kind: "error", reason: "unavailable", retryAt: 1_000_000 + 3_600_000 },
				{ status: 503 },
			),
		);
		expect(await ai.ask(body, 1000)).toBeNull();
		later(3_000_000);
		expect(await ai.ask(body, 1000)).toBeNull();
		expect(calls()).toBe(1);
		expect(fallbacks).toEqual(["busy", "busy"]);
	});

	it("stops asking when the endpoint isn't there", async () => {
		for (const response of [
			() =>
				new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
			() => new Response("Not found", { status: 404 }),
			() => Response.json({ kind: "error", reason: "off" }, { status: 404 }),
			() => Response.json({ kind: "error", reason: "forbidden" }, { status: 403 }),
		]) {
			const { ai, fallbacks, calls, later } = demo(response);
			expect(await ai.ask(body, 1000)).toBeNull();
			later(86_400_000);
			expect(await ai.ask(body, 1000)).toBeNull();
			expect(calls()).toBe(1);
			expect(fallbacks).toEqual(["unreachable", "unreachable"]);
		}
	});

	it("tries again after the model fails, and after a while offline", async () => {
		const failed = demo(() => Response.json({ kind: "error", reason: "failed" }, { status: 502 }));
		expect(await failed.ai.ask(body, 1000)).toBeNull();
		expect(await failed.ai.ask(body, 1000)).toBeNull();
		expect(failed.calls()).toBe(2);
		expect(failed.fallbacks).toEqual(["failed", "failed"]);

		const offline = demo(() => Promise.reject(new TypeError("Failed to fetch")));
		expect(await offline.ai.ask(body, 1000)).toBeNull();
		expect(await offline.ai.ask(body, 1000)).toBeNull();
		expect(offline.calls()).toBe(1);
		offline.later(30_000);
		expect(await offline.ai.ask(body, 1000)).toBeNull();
		expect(offline.calls()).toBe(2);
	});

	it("gives up on a slow answer, but not when the person stops asking", async () => {
		const never = (signal?: AbortSignal | null) =>
			new Promise<Response>((_, reject) =>
				signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
			);
		const fallbacks: Fallback[] = [];
		const ai = new DemoAi({
			endpoint: "https://tack.social/try/api/ai",
			fetch: (_input, init) => never(init?.signal),
			onFallback: (why) => fallbacks.push(why),
		});
		expect(await ai.ask(body, 20)).toBeNull();
		expect(fallbacks).toEqual(["timeout"]);
		const stop = new AbortController();
		const asking = ai.ask(body, 10_000, stop.signal);
		stop.abort();
		await expect(asking).rejects.toThrow();
	});

	it("is what the published demo asks, and /play/try only when told", () => {
		expect(wantsRealAi("try", "")).toBe(true);
		expect(wantsRealAi("try", "?ai=offline")).toBe(false);
		expect(wantsRealAi("development", "")).toBe(false);
		expect(wantsRealAi("development", "?scenario=retro&ai=live")).toBe(true);
	});

	it("names stacks and sorts them, with the stand-in when it can't", async () => {
		const standIn = fakeStackAi(0);
		const answers: (Record<string, unknown> | null)[] = [{ name: "Unreliable CI" }, null];
		const stacks = withRemote({ ask: async () => answers.shift() ?? null }, standIn);
		expect(readName(await stacks.name(["CI is slow", "Flaky e2e"]))).toBe("Unreliable CI");
		expect(readName(await stacks.name(["CI is slow", "Flaky e2e"]))).toBe("Unreliable CI");
		const notes = [
			{ id: "n1", text: "Docs are thin" },
			{ id: "n2", text: "Docs lack examples" },
		];
		expect(await stacks.group(notes)).toEqual(await standIn.group(notes));
	});

	it("summarises with the real model, and the stand-in when it doesn't answer", async () => {
		const doc = new Y.Doc();
		for (const [i, text] of ["Provider docs are hard to find", "CI takes 20 minutes"].entries()) {
			addShape(doc, `s${i}`, { type: "sticky", text, x: i * 220, y: 0, z: nextZ(doc) });
		}
		const sent: unknown[] = [];
		const answers: (Record<string, unknown> | null)[] = [
			{ kind: "summary", title: "Docs and CI", summary: "Both are slow.", points: ["Docs", "CI"] },
			null,
		];
		const ai = new PlayAi();
		ai.doc = doc;
		ai.remote = {
			ask: async (request) => {
				sent.push(request);
				return answers.shift() ?? null;
			},
		};
		const real = await ai.ask({ task: "summary", shapes: ["s0", "s1"] });
		expect(real).toMatchObject({ kind: "summary", title: "Docs and CI", read: 2 });
		expect(sent[0]).toEqual({
			task: "summary",
			items: [
				{ kind: "sticky", text: "Provider docs are hard to find" },
				{ kind: "sticky", text: "CI takes 20 minutes" },
			],
		});
		const standIn = await ai.ask({ task: "summary", shapes: ["s0", "s1"] });
		expect(standIn).toMatchObject({ kind: "summary", read: 2 });
		expect(standIn).not.toMatchObject({ title: "Docs and CI" });
	});

	it("checks the real model's widget, and proposes the stand-in's if it doesn't check out", async () => {
		const ai = new PlayAi();
		ai.doc = new Y.Doc();
		ai.remote = {
			ask: async () => ({ kind: "widget", widget: "nonsense", config: {}, explanation: "?" }),
		};
		const answer = await ai.ask({ task: "widget", prompt: "open bugs in ascorbic/unpic" });
		expect(answer).toMatchObject({ kind: "widget", widget: expect.not.stringMatching("nonsense") });
	});

	it("says so quietly, once, not over and over", () => {
		let now = 0;
		const hints = new HintStore(() => now);
		hints.show("rate_limited");
		expect(hints.getSnapshot()?.why).toBe("rate_limited");
		hints.hide();
		hints.show("rate_limited");
		expect(hints.getSnapshot()).toBeNull();
		hints.show("busy");
		expect(hints.getSnapshot()?.why).toBe("busy");
		now += 120_000;
		hints.show("rate_limited");
		expect(hints.getSnapshot()?.why).toBe("rate_limited");
	});
});
