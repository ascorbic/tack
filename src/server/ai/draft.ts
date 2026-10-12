import {
	type AiError,
	type AiItem,
	type AiLeftOut,
	type AiResponse,
	type ChatMessage,
	DECISION_FORMAT,
	SUMMARY_FORMAT,
	type WidgetContext,
	aiError,
	checkWidget,
	decisionMessages,
	readDecision,
	readSummary,
	retryMessages,
	summaryMessages,
	widgetFormat,
	widgetMessages,
} from "../../shared/ai.ts";
import { draftDecision, proposeWidget, summarise } from "../../shared/fakeBoardAi.ts";
import { log } from "../log.ts";
import { type Answer, ask } from "./model.ts";

// Asking the model for a widget, a summary or a decision, and checking what
// it answers (#64): shared by a board's AI route (src/server/ai/routes.ts),
// which reads the items from the board's own document, and the public
// demo's (src/demoAi/), which is sent them. A widget's config is checked
// strictly against its kind's schema, and asked for again once, told what
// was wrong, if it doesn't check out; a summary or decision that can't be
// read is asked for once more. Prompts and answers are never logged.

/** What to draft, with everything the model will read. */
export type Draftable =
	| { task: "widget"; prompt: string; context: WidgetContext }
	| { task: "summary"; items: AiItem[]; leftOut: AiLeftOut }
	| { task: "decision"; items: AiItem[]; leftOut: AiLeftOut; prompt?: string };

export interface Drafted {
	response: AiResponse;
	/** How many times the model was asked. */
	attempts: number;
}

/**
 * Ask Workers AI (or, with `fake`, local development's stand-in) and check
 * the answer. Never throws: a failure is an `AiError` (`unusable` or `failed`).
 */
export async function draft(
	env: Env,
	input: Draftable,
	{ fake = false }: { fake?: boolean } = {},
): Promise<Drafted> {
	let attempts = 1;
	if (input.task === "widget") {
		const messages = widgetMessages(input.prompt, input.context);
		const format = widgetFormat();
		const asking = (turns: ChatMessage[]): Promise<Answer> =>
			fake
				? Promise.resolve(made(proposeWidget(input.prompt, input.context)))
				: ask(env, turns, format);
		let answer = await asking(messages);
		let check = answer.ok ? checkWidget(answer.value, { host: input.context.host }) : null;
		// Asked again once, told what was wrong, when the answer didn't check out.
		if (!check?.ok) {
			attempts = 2;
			const problems = check && !check.ok ? check.problems : ["That wasn't a JSON object."];
			answer = await asking(
				answer.ok || answer.text
					? retryMessages(messages, answer.ok ? answer.text : (answer.text ?? ""), problems)
					: messages,
			);
			check = answer.ok ? checkWidget(answer.value, { host: input.context.host }) : null;
		}
		const response: AiResponse = check?.ok
			? {
					kind: "widget",
					widget: check.widget,
					config: check.config,
					explanation: check.explanation,
				}
			: failure(answer.ok || answer.error === "unparseable" ? "unusable" : "failed", answer);
		return { response, attempts };
	}
	const summary = input.task === "summary";
	const messages = summary
		? summaryMessages(input.items)
		: decisionMessages(input.items, input.prompt);
	const asking = (): Promise<Answer> =>
		fake
			? Promise.resolve(
					made(summary ? summarise(input.items) : draftDecision(input.items, input.prompt)),
				)
			: ask(env, messages, summary ? SUMMARY_FORMAT : DECISION_FORMAT);
	const reading = (answer: Answer) =>
		answer.ok ? (summary ? readSummary(answer.value) : readDecision(answer.value)) : null;
	let answer = await asking();
	let read = reading(answer);
	if (!read && answer.ok) {
		attempts = 2;
		answer = await asking();
		read = reading(answer);
	}
	const extra = { read: input.items.length, leftOut: input.leftOut };
	const response: AiResponse = !read
		? failure(answer.ok || answer.error === "unparseable" ? "unusable" : "failed", answer)
		: summary
			? { kind: "summary", ...(read as ReturnType<typeof readSummary> & object), ...extra }
			: { kind: "decision", ...(read as ReturnType<typeof readDecision> & object), ...extra };
	return { response, attempts };
}

/** The stand-in's answer, as the model's would come back. */
function made(value: unknown): Answer {
	return { ok: true, value, text: JSON.stringify(value), ms: 0 };
}

function failure(reason: "unusable" | "failed", answer: Answer): AiError {
	if (!answer.ok && answer.cause) log.warn("ai.model.failed", { error: answer.cause });
	return aiError(reason);
}
