import * as v from "valibot";
import {
	AI_ERROR_STATUS,
	type AiError,
	type AiErrorReason,
	type AiResponse,
	aiError,
} from "../shared/ai.ts";
import {
	DEMO_AI_MAX_BODY,
	DEMO_AI_PATH,
	type DemoAiRequest,
	DemoAiRequestSchema,
} from "../shared/demoAi.ts";
import { readGroups, readName } from "../shared/stackNaming.ts";
import { AI_FALLBACK_MODEL, AI_MODEL, hasAi } from "../server/ai.ts";
import { draft } from "../server/ai/draft.ts";
import { log } from "../server/log.ts";
import { stackAi } from "../server/stacks.ts";
import { type DailyLimits, type DemoBudget, dayOf, nextDay } from "./budget.ts";

// The public demo's AI (tack.social/try), on the docs site's Worker:
//
//   POST /try/api/ai   a `DemoAiRequest` → what the page's stand-in would answer
//
// The demo runs entirely in the browser, but for this: its stacks' names,
// Auto-stack, summaries, decisions and widgets ask Workers AI here, with the
// prompts, answer formats and checks a real board's server uses (#64, #73),
// so what comes back is as good (the models: `DEMO_MODELS`). The page sends only the text the task
// reads (src/shared/demoAi.ts); everything else (the prompt, the model, how
// many tokens) is decided here. Anything that fails, or is refused, is the
// page's cue to use its stand-in instead (src/client/try/ai.ts).
//
// Guarding it: same-origin requests only (`Origin` and `Sec-Fetch-Site`),
// strict validation and size caps, a per-visitor rate limit (the
// `DEMO_AI_LIMIT` rate limiting binding, by IP address), and a daily budget
// in all and per visitor (`DemoBudget`, budget.ts), past which it's "busy"
// until tomorrow. `DEMO_AI=off` switches it off. Each request is logged as
// `demo.ai` with the task, how many items, how long, and the outcome: never
// the content, nor the IP address.

export interface DemoEnv {
	/** Workers AI. */
	AI?: Ai;
	/** Per visitor, by IP address (cloudflare.config.ts sets the rate). */
	DEMO_AI_LIMIT?: RateLimit;
	DemoBudget?: DurableObjectNamespace<DemoBudget>;
	/** Requests a day in all, and from one visitor (numbers, as text). */
	DEMO_AI_DAILY?: string;
	DEMO_AI_VISITOR_DAILY?: string;
	/** `off` switches the demo's AI off: the page uses its stand-in. */
	DEMO_AI?: string;
}

/** The daily limits when the Worker doesn't say. */
export const DEMO_DAILY_DEFAULTS: DailyLimits = { total: 3000, visitor: 150 };

/** How long the model gets: the page gives up a little after, and uses its stand-in. */
const TIMEOUT_MS = { name: 10_000, group: 25_000, draft: 25_000 } as const;

/**
 * Which model answers each task. Names are Gemma 4's (`AI_MODEL`), as on a
 * real board: a short answer it gives in about a second. The rest are
 * GLM-4.7 Flash's (`AI_FALLBACK_MODEL`, the same request): with these larger
 * schemas, Gemma 4 on Workers AI often runs on in whitespace to its token
 * limit (half a minute, then no JSON) or proposes widgets that don't check
 * out, where GLM answered 12 of 12 tries in 5 to 10 s (October 2026).
 */
export const DEMO_MODELS: Record<DemoAiRequest["task"], string> = {
	name: AI_MODEL,
	group: AI_FALLBACK_MODEL,
	summary: AI_FALLBACK_MODEL,
	decision: AI_FALLBACK_MODEL,
	widget: AI_FALLBACK_MODEL,
};

export type Outcome =
	| "answered"
	| "unusable"
	| "failed"
	| "invalid"
	| "forbidden"
	| "rate_limited"
	| "busy"
	| "off";

/** Whether this request is for the demo's AI. */
export function isDemoAi(url: URL): boolean {
	return url.pathname === `/try/${DEMO_AI_PATH}`;
}

export async function handleDemoAi(
	request: Request,
	env: DemoEnv,
	now: () => number = Date.now,
): Promise<Response> {
	const started = now();
	const done = (outcome: Outcome, response: Response, context: object = {}): Response => {
		log[outcome === "failed" ? "warn" : "info"]("demo.ai", {
			outcome,
			status: response.status,
			ms: now() - started,
			...context,
		});
		return response;
	};

	if (request.method !== "POST") {
		return done(
			"invalid",
			Response.json(aiError("invalid"), { status: 405, headers: { allow: "POST", ...NO_STORE } }),
		);
	}
	// Only the demo's own page: browsers send both on a POST, and say where from.
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if (origin !== new URL(request.url).origin || (site !== null && site !== "same-origin")) {
		return done("forbidden", refuse("forbidden", { message: "Only the demo’s own page can ask." }));
	}
	if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
		return done("invalid", refuse("invalid"));
	}
	const off = (env.DEMO_AI ?? "on").trim().toLowerCase() === "off";
	if (off || !hasAi(env as unknown as Env)) return done("off", refuse("off", OFF));

	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > DEMO_AI_MAX_BODY) return done("invalid", refuse("invalid"));
	const text = await readCapped(request, DEMO_AI_MAX_BODY);
	if (text === null) return done("invalid", refuse("invalid"));
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// Refused below.
	}
	const parsed = v.safeParse(DemoAiRequestSchema, body);
	if (!parsed.success) return done("invalid", refuse("invalid"));
	const input = parsed.output;
	const context = { task: input.task, items: itemCount(input) };

	// A visitor's rate, then the day's budget: each says when to try again.
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const limiter = env.DEMO_AI_LIMIT;
	if (!limiter || !env.DemoBudget) return done("off", refuse("off", OFF), context);
	const { success } = await limiter.limit({ key: ip });
	if (!success) {
		return done("rate_limited", refuse("rate_limited", { retryAt: now() + 60_000 }), {
			...context,
			limit: "minute",
		});
	}
	const today = dayOf(now());
	const limits = dailyLimits(env);
	const budget = env.DemoBudget.get(env.DemoBudget.idFromName("budget"));
	const spent = await budget.spend(today, await visitorHash(ip, today), limits);
	if (!spent.ok) {
		const retryAt = nextDay(now());
		return done(
			spent.reason === "busy" ? "busy" : "rate_limited",
			spent.reason === "busy"
				? Response.json(
						aiError("unavailable", {
							message: "The demo’s AI has had a busy day: it’s back tomorrow.",
							retryAt,
						}),
						{ status: 503, headers: { ...NO_STORE, "retry-after": seconds(retryAt, now()) } },
					)
				: refuse("rate_limited", { retryAt }),
			{ ...context, limit: spent.reason === "busy" ? "day" : "visitor", used: spent.used },
		);
	}

	const answered = await answer(env, input);
	const extra = {
		...context,
		model: DEMO_MODELS[input.task],
		attempts: answered.attempts,
		used: spent.used,
	};
	const reply = answered.body;
	if (isError(reply)) {
		return done(
			reply.reason === "unusable" ? "unusable" : "failed",
			Response.json(reply, { status: AI_ERROR_STATUS[reply.reason], headers: NO_STORE }),
			extra,
		);
	}
	return done("answered", Response.json(reply, { headers: NO_STORE }), extra);
}

function isError(answer: Answered): answer is AiError {
	return "kind" in answer && answer.kind === "error";
}

/** An answer, as the page's stand-in would give it: a name, stacks, or a board AI's. */
type Answered = AiResponse | { name: string } | { groups: { name: string; notes: string[] }[] };

/** What the model's asked, and its answer, as the page's stand-in would give it. */
async function answer(
	env: DemoEnv,
	input: DemoAiRequest,
): Promise<{ body: Answered; attempts: number }> {
	const worker = env as unknown as Env;
	if (input.task === "name" || input.task === "group") {
		const ai = stackAi(worker, { name: DEMO_MODELS.name, group: DEMO_MODELS.group });
		if (!ai) return { body: aiError("failed"), attempts: 0 };
		try {
			if (input.task === "name") {
				const name = readName(await within(ai.name(input.texts), TIMEOUT_MS.name));
				return { body: name ? { name } : aiError("unusable"), attempts: 1 };
			}
			const ids = new Map(input.notes.map((note) => [note.id, note.id]));
			const stacks = readGroups(await within(ai.group(input.notes), TIMEOUT_MS.group), ids);
			return {
				body:
					stacks.length > 0
						? { groups: stacks.map((stack) => ({ name: stack.name, notes: stack.ids })) }
						: aiError("unusable"),
				attempts: 1,
			};
		} catch (error) {
			log.warn("ai.model.failed", { error, task: input.task });
			return { body: aiError("failed"), attempts: 1 };
		}
	}
	const leftOut = { faceDown: 0, private: 0 };
	const drafted = await within(
		draft(
			worker,
			input.task === "widget"
				? {
						task: "widget",
						prompt: input.prompt,
						context: { ...input.context, today: dayOf(Date.now()) },
					}
				: input.task === "decision"
					? { task: "decision", items: input.items, leftOut, prompt: input.prompt || undefined }
					: { task: "summary", items: input.items, leftOut },
			{ model: DEMO_MODELS[input.task] },
		),
		TIMEOUT_MS.draft,
	).catch(() => ({ response: aiError("failed"), attempts: 1 }));
	return { body: drafted.response, attempts: drafted.attempts };
}

function itemCount(input: DemoAiRequest): number {
	switch (input.task) {
		case "name":
			return input.texts.length;
		case "group":
			return input.notes.length;
		case "widget":
			return 0;
		default:
			return input.items.length;
	}
}

function dailyLimits(env: DemoEnv): DailyLimits {
	const number = (raw: string | undefined, fallback: number) => {
		const value = Number(raw);
		return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0
			? Math.floor(value)
			: fallback;
	};
	return {
		total: number(env.DEMO_AI_DAILY, DEMO_DAILY_DEFAULTS.total),
		visitor: number(env.DEMO_AI_VISITOR_DAILY, DEMO_DAILY_DEFAULTS.visitor),
	};
}

/** A visitor, for the day's count: a hash of their address and the day, never the address. */
async function visitorHash(ip: string, day: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}:${ip}`));
	return [...new Uint8Array(bytes).slice(0, 12)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** The body as text, or null if it's bigger than `max` characters. */
async function readCapped(request: Request, max: number): Promise<string | null> {
	const text = await request.text().catch(() => null);
	return text !== null && text.length <= max ? text : null;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timed out")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

const OFF = { message: "The demo’s AI is off here: the page’s stand-in answers." };

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function seconds(at: number, now: number): string {
	return String(Math.max(1, Math.ceil((at - now) / 1000)));
}

function refuse(reason: AiErrorReason, extra: Partial<AiError> = {}): Response {
	const headers: Record<string, string> = { ...NO_STORE };
	if (extra.retryAt) headers["retry-after"] = seconds(extra.retryAt, Date.now());
	return Response.json(aiError(reason, extra), { status: AI_ERROR_STATUS[reason], headers });
}
