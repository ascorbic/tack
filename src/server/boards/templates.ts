// Templates (#53) and carrying action items over (#52).
//
//   GET    /api/templates              templates saved on this instance, newest first
//   POST   /api/templates              save a board as a template { board, title, description?, keepContent? }
//   DELETE /api/templates/:id          delete one (whoever saved it, or an admin)
//   POST   /api/boards/:id/carry       carry its open action items to another board { to, shapes? }
//
// Making a board from a template is `POST /api/boards` with `template` (and
// `repos`, and `carryFrom` to bring last time's open action items along):
// see `createBoard`, which the board routes call.

import { getServerByName } from "partyserver";
import * as v from "valibot";
import {
	BOARD_ID,
	type BoardInfo,
	type BoardResult,
	type CarryResponse,
	type CreateBoardRequest,
	type CreatedBoard,
	canEdit,
} from "../../shared/boards.ts";
import { builtInTemplate } from "../../shared/builtInTemplates.ts";
import {
	TEMPLATE_DESCRIPTION_MAX,
	TEMPLATE_MAX_BYTES,
	TEMPLATE_REPOS_MAX,
	TEMPLATE_TITLE_MAX,
	type TemplateContent,
	cleanRepos,
	collectsActions,
	summarise,
	templateThumbnail,
} from "../../shared/templates.ts";
import { isCrossSite, json } from "../auth/http.ts";
import type { Board } from "../board.ts";
import { log } from "../log.ts";
import { boards, directory } from "../namespaces.ts";
import type { Visitor } from "./access.ts";
import { invalid, notAllowed, parse, respond, safeDecode, visitorFor } from "./http.ts";

const Id = v.pipe(v.string(), v.maxLength(64));

const SaveBody = v.object({
	board: Id,
	title: v.pipe(v.string(), v.maxLength(TEMPLATE_TITLE_MAX * 4)),
	description: v.optional(v.pipe(v.string(), v.maxLength(TEMPLATE_DESCRIPTION_MAX * 4))),
	keepContent: v.optional(v.boolean()),
});

const CarryBody = v.object({
	to: Id,
	shapes: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(128))), v.maxLength(200))),
});

/** Request fields for starting a board from a template, checked by the board routes. */
export const TemplateFields = {
	template: v.optional(v.pipe(v.string(), v.maxLength(64))),
	repos: v.optional(
		v.pipe(v.array(v.pipe(v.string(), v.maxLength(300))), v.maxLength(TEMPLATE_REPOS_MAX * 2)),
	),
	carryFrom: v.optional(Id),
};

function tidy(text: string | undefined, max: number): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

export async function handleTemplates(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	const carry = /^\/api\/boards\/([^/]+)\/carry$/.exec(path);
	if (path !== "/api/templates" && !path.startsWith("/api/templates/") && !carry) return null;

	const method = request.method;
	if (method !== "GET" && isCrossSite(request)) {
		log.warn("auth.rejected", { path });
		return json({ error: "forbidden" }, { status: 403 });
	}
	const visitor = await visitorFor(request, env);

	if (carry) {
		if (method !== "POST") return notAllowed();
		const from = carry[1] ? safeDecode(carry[1]) : null;
		if (!from || !BOARD_ID.test(from)) return json({ error: "not_found" }, { status: 404 });
		const body = await parse(request, CarryBody);
		if (!body) return invalid();
		return respond(await carryOver(env, visitor, from, body.to, body.shapes));
	}

	const index = directory(env);
	if (path === "/api/templates") {
		if (method === "GET") return respond(await index.listTemplates(visitor));
		if (method !== "POST") return notAllowed();
		const body = await parse(request, SaveBody);
		if (!body || !BOARD_ID.test(body.board)) return invalid();
		const title = tidy(body.title, TEMPLATE_TITLE_MAX);
		if (!title) return invalid();
		return respond(await saveTemplate(env, visitor, { ...body, title }), 201);
	}

	const id = safeDecode(path.slice("/api/templates/".length));
	if (!id || !BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });
	if (method === "DELETE") return respond(await index.deleteTemplate(visitor, id));
	return notAllowed();
}

async function saveTemplate(
	env: Env,
	visitor: Visitor,
	body: { board: string; title: string; description?: string; keepContent?: boolean },
): Promise<BoardResult<unknown>> {
	const index = directory(env);
	// Check before loading the board: only its editors may save it.
	const board = await index.get(visitor, body.board);
	if (!board.ok) return board;
	if (!canEdit(board.value.role)) return { ok: false, error: "forbidden" };
	const stub = await getServerByName<Env, Board>(boards(env), body.board);
	const { json: encoded, repos } = await stub.templateContent({
		keepContent: body.keepContent ?? false,
	});
	if (encoded.length > TEMPLATE_MAX_BYTES) {
		log.warn("template.rejected", {
			board: body.board,
			reason: "too_large",
			bytes: encoded.length,
		});
		return { ok: false, error: "too_large" };
	}
	const content = JSON.parse(encoded) as TemplateContent;
	return index.saveTemplate(visitor, {
		board: body.board,
		title: body.title,
		description: tidy(body.description, TEMPLATE_DESCRIPTION_MAX),
		content: encoded,
		repos,
		summary: summarise(content),
		thumbnail: templateThumbnail(content),
		collectsActions: collectsActions(content),
	});
}

/** A template's content by id: a built-in, or one saved on this instance. */
async function templateFor(
	env: Env,
	visitor: Visitor,
	id: string,
): Promise<BoardResult<{ content: TemplateContent }>> {
	const builtIn = builtInTemplate(id);
	if (builtIn) return { ok: true, value: { content: builtIn.content } };
	if (!BOARD_ID.test(id)) return { ok: false, error: "not_found" };
	return directory(env).templateContent(visitor, id);
}

/**
 * `POST /api/boards`: make a board, laid out from a template if one's
 * given, with last time's open action items carried over if asked. The
 * board is made even if laying it out or carrying over fails (it's logged):
 * an empty board beats an error after the fact.
 */
export async function createBoard(
	env: Env,
	visitor: Visitor,
	request: CreateBoardRequest,
): Promise<BoardResult<CreatedBoard>> {
	const index = directory(env);
	const template = request.template ? await templateFor(env, visitor, request.template) : null;
	if (template && !template.ok) return template;
	const created = await index.create(visitor, {
		title: request.title,
		visibility: request.visibility,
	});
	if (!created.ok) return created;
	const board: CreatedBoard = { ...(created.value as BoardInfo) };

	if (template?.ok && request.template) {
		try {
			const stub = await getServerByName<Env, Board>(boards(env), board.id);
			const seeded = await stub.seed({
				template: request.template.startsWith("tack:") ? request.template : "saved",
				content: template.value.content,
				repos: cleanRepos(request.repos),
				by: {
					name: visitor.user?.name ?? visitor.user?.login ?? "Someone",
					...(visitor.user ? { login: visitor.user.login } : {}),
				},
			});
			board.seeded = seeded !== null;
		} catch (error) {
			log.error("board.seed.failed", { board: board.id, template: request.template, error });
			board.seeded = false;
		}
	}

	if (request.carryFrom && BOARD_ID.test(request.carryFrom)) {
		const carried = await carryOver(env, visitor, request.carryFrom, board.id);
		board.carried = carried.ok ? carried.value.carried : 0;
	}
	// The index has its thumbnail now.
	const fresh = await index.get(visitor, board.id);
	return { ok: true, value: fresh.ok ? { ...(fresh.value as BoardInfo), ...pick(board) } : board };
}

function pick(board: CreatedBoard): Pick<CreatedBoard, "seeded" | "carried"> {
	return {
		...(board.seeded !== undefined ? { seeded: board.seeded } : {}),
		...(board.carried !== undefined ? { carried: board.carried } : {}),
	};
}

/**
 * Carry open action items from one board to another: anyone who can open
 * the first may, if they can edit the second. Their links come along, and
 * each item remembers where it came from.
 */
async function carryOver(
	env: Env,
	visitor: Visitor,
	from: string,
	to: string,
	only?: string[],
): Promise<BoardResult<CarryResponse>> {
	if (from === to) return { ok: false, error: "invalid" };
	const index = directory(env);
	const [source, target] = await Promise.all([index.get(visitor, from), index.get(visitor, to)]);
	if (!source.ok) return source;
	if (!target.ok) return target;
	if (!canEdit(target.value.role)) return { ok: false, error: "forbidden" };
	try {
		const items = await (
			await getServerByName<Env, Board>(boards(env), from)
		).carryOut({
			userId: visitor.user?.id ?? null,
			...(only ? { only } : {}),
		});
		const result =
			items.length === 0
				? { added: [], skipped: 0 }
				: await (
						await getServerByName<Env, Board>(boards(env), to)
					).carryIn({
						items,
						from: { board: from, title: source.value.title },
						...(visitor.user ? { by: visitor.user.login } : {}),
					});
		return {
			ok: true,
			value: {
				carried: result.added.length,
				skipped: result.skipped,
				board: target.value as BoardInfo,
			},
		};
	} catch (error) {
		log.error("actions.carry.failed", { from, to, error });
		throw error;
	}
}
