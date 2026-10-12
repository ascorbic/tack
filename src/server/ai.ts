import type { AiStatus } from "../shared/auth.ts";

// Workers AI, for the board's AI suggestions: stacks' names and "Group
// these" (#73, src/server/stacks.ts). This module is only the asking:
// whether AI is on (`TACK_AI` and the `AI` binding, cloudflare.config.ts),
// and `askModel`, one structured-output request. What's asked, and reading
// what comes back, belongs to each feature.
//
// The model: Gemma 4 26B A4B (Google's mixture-of-experts instruction model,
// 4B parameters active per token), as of October 2026 a current, fast and
// cheap general instruction model on Workers AI that takes a JSON schema as
// structured output. Naming a stack is a few hundred tokens in and a handful
// out; a general instruct model writes better theme names than the coding-
// and agent-tuned ones, and its context (256k) is far more than sixty
// stickies need. Thinking is off: it adds latency and tokens for nothing
// here. The fallback, if Gemma is ever retired or misbehaves, is GLM-4.7
// Flash (`AI_FALLBACK_MODEL`): it takes the same request (messages, a JSON
// schema, `chat_template_kwargs`) and answers in the same chat-completions
// shape, so switching is changing `AI_MODEL`.

export const AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const AI_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

/**
 * Which model answers each task. Stacks' names are Gemma 4's (`AI_MODEL`): a
 * short answer it gives in about a second. The rest are GLM-4.7 Flash's
 * (`AI_FALLBACK_MODEL`, the same request): with these larger schemas, Gemma 4
 * on Workers AI often runs on in whitespace to its token limit (half a
 * minute, then no JSON) or proposes widgets that don't check out, where GLM
 * answered 12 of 12 tries in 5 to 10 s (October 2026).
 */
export const TASK_MODELS = {
	name: AI_MODEL,
	group: AI_FALLBACK_MODEL,
	summary: AI_FALLBACK_MODEL,
	decision: AI_FALLBACK_MODEL,
	widget: AI_FALLBACK_MODEL,
} as const;

interface AiRunner {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Whether this Worker has Workers AI to ask (it doesn't in local dev, or if the binding's removed). */
export function hasAi(env: Env): boolean {
	const binding = (env as { AI?: unknown }).AI as Partial<AiRunner> | undefined;
	return !!binding && typeof binding.run === "function";
}

/**
 * Whether AI suggestions are on (`TACK_AI` in cloudflare.config.ts), and
 * with what: on (the default) when the Worker has its AI binding, local
 * development's stand-in when it's `fake`, off when it's `off`, and
 * unavailable (off, but not by choice) when there's no binding to ask.
 */
export function aiStatus(env: Env): AiStatus {
	const raw = (env as { TACK_AI?: unknown }).TACK_AI;
	const setting = (typeof raw === "string" ? raw : "on").trim().toLowerCase();
	if (setting === "off" || setting === "false" || setting === "0") {
		return { state: "off", provider: null, model: AI_MODEL };
	}
	if (setting === "fake") return { state: "on", provider: "fake", model: "fake" };
	return hasAi(env)
		? { state: "on", provider: "workers-ai", model: AI_MODEL }
		: { state: "unavailable", provider: null, model: AI_MODEL };
}

export interface ModelRequest {
	/** The instructions. */
	system: string;
	/** What to work on: keep people's text in here, as data, never in `system`. */
	user: string;
	/** Turns after it, if any: an answer, and what was wrong with it (#64). */
	followUp?: readonly { role: "system" | "user" | "assistant"; content: string }[];
	/** A JSON schema the answer must follow, and its name. */
	schema: object;
	schemaName: string;
	/** The most tokens the answer may take. */
	maxTokens: number;
	/** Default 0.2: steady, with a little room. */
	temperature?: number;
	/** Default `AI_MODEL`; `AI_FALLBACK_MODEL` takes the same request. */
	model?: string;
}

/**
 * Ask Workers AI for a structured answer: the answer itself (usually a JSON
 * string, sometimes already parsed), for the caller to read defensively.
 * Throws when there's no binding, or the request fails.
 */
export async function askModel(env: Env, request: ModelRequest): Promise<unknown> {
	if (!hasAi(env)) throw new Error("No Workers AI binding");
	const binding = (env as unknown as { AI: AiRunner }).AI;
	const result = await binding.run(request.model ?? AI_MODEL, {
		messages: [
			{ role: "system", content: request.system },
			{ role: "user", content: request.user },
			...(request.followUp ?? []),
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: request.schemaName, schema: request.schema, strict: true },
		},
		max_completion_tokens: request.maxTokens,
		temperature: request.temperature ?? 0.2,
		chat_template_kwargs: { enable_thinking: false },
	});
	return answerOf(result);
}

/**
 * The answer in a Workers AI result: chat-completions models put it in
 * `choices[0].message.content`, older ones in `response` (a string, or
 * already parsed in JSON mode).
 */
export function answerOf(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const { choices, response } = result as { choices?: unknown; response?: unknown };
	if (Array.isArray(choices)) {
		const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
		if (message?.content !== undefined && message.content !== null) return message.content;
	}
	return response ?? result;
}
