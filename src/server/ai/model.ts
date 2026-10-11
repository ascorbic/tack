import type { AnswerFormat, ChatMessage } from "../../shared/ai.ts";
import { parseAnswer } from "../../shared/ai.ts";
import { askModel } from "../ai.ts";

// Asking Workers AI for the board's AI (#64): widgets, summaries and
// decisions. Whether AI is on, which model and the request itself are the
// instance's one Workers AI module (src/server/ai.ts, shared with stacks'
// names, #73); this adds what these answers need on top: a time limit, the
// conversation so far (a widget that didn't check out is asked for again,
// told why), and reading the JSON out of what comes back.

/** How long the model gets to answer. */
const TIMEOUT_MS = 30_000;

export type Answer =
	| { ok: true; value: unknown; text: string; ms: number }
	| { ok: false; error: "failed" | "unparseable"; ms: number; cause?: unknown; text?: string };

/**
 * Ask the model, for an answer shaped like `format`: `messages` are the
 * system prompt, the request, then any turns since. Never throws.
 */
export async function ask(
	env: Env,
	messages: readonly ChatMessage[],
	format: AnswerFormat,
	{ maxTokens = 1200 }: { maxTokens?: number } = {},
): Promise<Answer> {
	const started = Date.now();
	const [system, user, ...followUp] = messages;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const raw = await Promise.race([
			askModel(env, {
				system: system?.content ?? "",
				user: user?.content ?? "",
				followUp,
				schema: format.schema,
				schemaName: format.name,
				maxTokens,
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
			}),
		]);
		const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
		const value = parseAnswer(raw);
		const ms = Date.now() - started;
		if (value === null) return { ok: false, error: "unparseable", ms, text };
		return { ok: true, value, text, ms };
	} catch (cause) {
		return { ok: false, error: "failed", ms: Date.now() - started, cause };
	} finally {
		clearTimeout(timer);
	}
}
