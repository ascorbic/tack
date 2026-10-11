import type { AiStatus } from "../shared/auth.ts";
import { fakePileAi } from "../shared/fakePileAi.ts";
import type { PileAi } from "../shared/pileNamer.ts";
import {
	GROUP_SCHEMA,
	GROUP_SYSTEM,
	NAME_SCHEMA,
	NAME_SYSTEM,
	answerOf,
	groupMessage,
	nameMessage,
} from "../shared/pileNaming.ts";

// Workers AI, for piles' names and "Group these" (#73). The prompts and
// reading the answers are shared (src/shared/pileNaming.ts); this is just
// the asking.
//
// The model: Gemma 4 26B A4B (Google's mixture-of-experts instruction model,
// 4B parameters active per token), as of October 2026 a current, fast and
// cheap general instruction model on Workers AI that takes a JSON schema as
// structured output. Naming a pile is a few hundred tokens in and a handful
// out; a general instruct model writes better theme names than the coding-
// and agent-tuned ones, and its context (256k) is far more than sixty
// stickies need. Thinking is off: it adds latency and tokens for nothing
// here. GLM-4.7 Flash (`@cf/zai-org/glm-4.7-flash`) takes the same request
// and answer, if this one's ever retired.

export const PILE_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** Most tokens an answer may take: a name is a few, a grouping of sixty stickies a few hundred. */
const MAX_TOKENS = { name: 48, group: 1500 } as const;

interface AiRunner {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Whether this Worker has Workers AI to ask (it doesn't in local dev). */
export function hasAi(env: Env): boolean {
	const binding = (env as { AI?: unknown }).AI as Partial<AiRunner> | undefined;
	return !!binding && typeof binding.run === "function";
}

/**
 * Whether AI suggestions are on (`TACK_AI` in cloudflare.config.ts), and with
 * what: `workers-ai` (the default) when the Worker has its AI binding, the
 * fake in local dev, or off (`TACK_AI=off`, or no binding to ask).
 */
export function aiStatus(env: Env): AiStatus {
	const raw = (env as { TACK_AI?: unknown }).TACK_AI;
	const setting = (typeof raw === "string" ? raw : "workers-ai").trim().toLowerCase();
	if (setting === "off" || setting === "") {
		return { state: "off", provider: null, model: PILE_MODEL };
	}
	if (setting === "fake") return { state: "on", provider: "fake", model: "fake" };
	return hasAi(env)
		? { state: "on", provider: "workers-ai", model: PILE_MODEL }
		: { state: "unavailable", provider: null, model: PILE_MODEL };
}

/** What names piles here, or null when suggestions are off. */
export function pileAi(env: Env): PileAi | null {
	const status = aiStatus(env);
	if (status.provider === "fake") return fakePileAi();
	return status.provider === "workers-ai" ? workersAi(env) : null;
}

/** Workers AI as piles' namer asks it, or null if this Worker has none. */
export function workersAi(env: Env): PileAi | null {
	if (!hasAi(env)) return null;
	const binding = (env as unknown as { AI: AiRunner }).AI;
	const ask = async (
		system: string,
		user: string,
		schema: object,
		name: string,
		maxTokens: number,
	): Promise<unknown> => {
		const result = await binding.run(PILE_MODEL, {
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
			max_completion_tokens: maxTokens,
			temperature: 0.2,
			chat_template_kwargs: { enable_thinking: false },
		});
		return answerOf(result);
	};
	return {
		name: (texts) =>
			ask(NAME_SYSTEM, nameMessage(texts), NAME_SCHEMA, "pile_name", MAX_TOKENS.name),
		group: (notes) =>
			ask(GROUP_SYSTEM, groupMessage(notes), GROUP_SCHEMA, "pile_groups", MAX_TOKENS.group),
	};
}
