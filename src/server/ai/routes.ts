// AI on a board (#64):
//
//   POST /api/boards/:id/ai   an `AiRequest` → an `AiResult`, or an `AiError`
//
// Editors only (what it drafts is for them to place), when AI is on for the
// instance (`TACK_AI`, and the `AI` binding), within the board's budget
// (src/server/ai/limits.ts). The board's object reads what the model may
// (src/server/ai/board.ts); this asks the model and checks its answer
// (src/server/ai/draft.ts): a widget's config strictly against its kind's
// schema, asking again once if it doesn't check out. Nothing here writes anything, to the board or the
// forge: answers go back to the person who asked, to preview and place.
// Prompts, board content and answers are never logged.

import * as v from "valibot";
import {
	AI_ERROR_STATUS,
	type AiError,
	type AiErrorReason,
	AiRequestSchema,
	aiError,
} from "../../shared/ai.ts";
import { BOARD_ID, canEdit } from "../../shared/boards.ts";
import { json } from "../auth/http.ts";
import { visitorFor } from "../boards/http.ts";
import { log } from "../log.ts";
import { boards, directory } from "../namespaces.ts";
import { aiStatus } from "../ai.ts";
import { type Drafted, draft } from "./draft.ts";

/** Bodies bigger than this aren't read. */
const MAX_BODY = 32_000;

export async function handleAi(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/api\/boards\/([^/]+)\/ai$/.exec(url.pathname);
	if (!match) return null;
	if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
	let board: string;
	try {
		board = decodeURIComponent(match[1] ?? "");
	} catch {
		return refuse("not_found");
	}
	if (!BOARD_ID.test(board)) return refuse("not_found");

	const visitor = await visitorFor(request, env);
	const info = await directory(env).get(visitor, board);
	if (!info.ok) {
		const reason: AiErrorReason =
			info.error === "sign_in_required"
				? "sign_in_required"
				: info.error === "forbidden"
					? "forbidden"
					: "not_found";
		return refuse(reason, { board });
	}
	if (!canEdit(info.value.role)) return refuse("forbidden", { board, login: visitor.user?.login });

	const status = aiStatus(env);
	if (status.state !== "on") return refuse(status.state, { board });
	// Local development's stand-in (`TACK_AI=fake`), or Workers AI.
	const fake = status.provider === "fake";

	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY) return refuse("invalid", { board });
	const text = await request.text().catch(() => "");
	if (text.length > MAX_BODY) return refuse("invalid", { board });
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// Refused below.
	}
	const parsed = v.safeParse(AiRequestSchema, body);
	if (!parsed.success) return refuse("invalid", { board });
	const input = parsed.output;

	const user = visitor.user;
	const prepared = await boards(env)
		.getByName(board)
		.aiPrepare({
			task: input.task,
			who: user ? `user:${user.id}` : "guest",
			userId: user?.id ?? null,
			login: user?.login ?? null,
			shapes: input.task === "widget" ? undefined : input.shapes,
			publicOnly: info.value.visibility === "public",
		});
	if (!prepared.ok) {
		return refuse("rate_limited", { board, task: input.task }, { retryAt: prepared.retryAt });
	}

	const started = Date.now();
	const context = { board, task: input.task, model: status.model, login: user?.login };
	let drafted: Drafted;
	if (prepared.task === "widget" && input.task === "widget") {
		drafted = await draft(
			env,
			{ task: "widget", prompt: input.prompt, context: prepared.context },
			{ fake },
		);
	} else if (prepared.task !== "widget") {
		if (prepared.items.length === 0) {
			log.info("ai.refused", { ...context, reason: "empty", leftOut: prepared.leftOut });
			return Response.json(
				aiError("empty", {
					message:
						prepared.leftOut.faceDown > 0
							? "Those stickies are face down: reveal them first."
							: prepared.leftOut.private > 0
								? "There’s nothing there it can read."
								: "There’s nothing written there yet.",
				}),
				{ status: AI_ERROR_STATUS.empty },
			);
		}
		const { items, leftOut } = prepared;
		drafted = await draft(
			env,
			input.task === "decision"
				? { task: "decision", items, leftOut, prompt: input.prompt }
				: { task: "summary", items, leftOut },
			{ fake },
		);
	} else {
		return refuse("invalid", { board });
	}
	const { response, attempts } = drafted;

	const ms = Date.now() - started;
	if (response.kind === "error") {
		log.warn("ai.failed", { ...context, reason: response.reason, attempts, ms });
		return Response.json(response, { status: AI_ERROR_STATUS[response.reason] });
	}
	log.info("ai.answered", {
		...context,
		attempts,
		ms,
		...(response.kind === "widget"
			? { widget: response.widget }
			: { read: response.read, leftOut: response.leftOut }),
	});
	return Response.json(response, { headers: { "cache-control": "no-store" } });
}

function refuse(
	reason: AiErrorReason,
	context: object = {},
	extra: Partial<AiError> = {},
): Response {
	log.info("ai.refused", { ...context, reason });
	const headers: Record<string, string> = {};
	if (extra.retryAt)
		headers["retry-after"] = String(Math.max(1, Math.ceil((extra.retryAt - Date.now()) / 1000)));
	return Response.json(aiError(reason, extra), { status: AI_ERROR_STATUS[reason], headers });
}
