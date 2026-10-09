// The board index API, and the access check for live board connections.
//
//   GET    /api/boards                         the home page: recent, mine, shared, archived, open
//   POST   /api/boards                         create a board { title?, visibility? }
//   POST   /api/boards/legacy                  find or adopt a pre-index board { name } (`/?board=name`)
//   GET    /api/boards/:id                     a board, and the viewer's role on it
//   PATCH  /api/boards/:id                     rename, change visibility, archive { title?, visibility?, instanceRole?, archived? }
//   GET    /api/boards/:id/members             who's on it
//   POST   /api/boards/:id/members             invite by GitHub login { logins, role }
//   PATCH  /api/boards/:id/members/:login      change a role, or hand over ownership { role }
//   DELETE /api/boards/:id/members/:login      remove someone, or leave

import * as v from "valibot";
import { BOARD_ID, type BoardError, type BoardResult, MAX_TITLE } from "../../shared/boards.ts";
import { isCrossSite, json } from "../auth/http.ts";
import { lookupRequest } from "../auth/session.ts";
import { ACCESS_HEADER, type ConnectionAccess } from "../board.ts";
import { log } from "../log.ts";
import { directory } from "../namespaces.ts";
import { type Visitor, visitorKey } from "./access.ts";

const STATUS: Record<BoardError, number> = {
	sign_in_required: 401,
	forbidden: 403,
	owner_required: 403,
	not_found: 404,
	invalid: 400,
	invalid_login: 422,
};

const Title = v.pipe(v.string(), v.maxLength(MAX_TITLE * 4));
const Visibility = v.picklist(["private", "instance", "public"]);
const MemberRole = v.picklist(["editor", "viewer"]);

const CreateBody = v.object({ title: v.optional(Title), visibility: v.optional(Visibility) });
const UpdateBody = v.object({
	title: v.optional(Title),
	visibility: v.optional(Visibility),
	instanceRole: v.optional(MemberRole),
	archived: v.optional(v.boolean()),
});
const LegacyBody = v.object({ name: v.pipe(v.string(), v.maxLength(64)) });
const InviteBody = v.object({
	logins: v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.minLength(1), v.maxLength(50)),
	role: MemberRole,
});
const MemberBody = v.object({ role: v.picklist(["owner", "editor", "viewer"]) });

export async function handleBoards(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path !== "/api/boards" && !path.startsWith("/api/boards/")) return null;

	const method = request.method;
	if (method !== "GET" && isCrossSite(request)) {
		log.warn("auth.rejected", { path });
		return json({ error: "forbidden" }, { status: 403 });
	}

	const visitor = await visitorFor(request, env);
	const index = directory(env);

	if (path === "/api/boards") {
		if (method === "GET") return json(await index.list(visitor));
		if (method === "POST") {
			const body = await parse(request, CreateBody);
			if (!body) return invalid();
			return respond(await index.create(visitor, body), 201);
		}
		return notAllowed();
	}

	if (path === "/api/boards/legacy") {
		if (method !== "POST") return notAllowed();
		const body = await parse(request, LegacyBody);
		if (!body) return invalid();
		return respond(await index.claimLegacy(visitor, body.name));
	}

	const match = /^\/api\/boards\/([^/]+)(\/members(?:\/([^/]+))?)?$/.exec(path);
	const id = match?.[1] && safeDecode(match[1]);
	if (!match || !id || !BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });
	const [, , members, rawLogin] = match;

	if (!members) {
		if (method === "GET") return respond(await index.get(visitor, id));
		if (method === "PATCH") {
			const body = await parse(request, UpdateBody);
			if (!body) return invalid();
			return respond(await index.update(visitor, id, body));
		}
		return notAllowed();
	}

	if (!rawLogin) {
		if (method === "GET") return respond(await index.members(visitor, id));
		if (method === "POST") {
			const body = await parse(request, InviteBody);
			if (!body) return invalid();
			return respond(await index.invite(visitor, id, body));
		}
		return notAllowed();
	}

	const login = safeDecode(rawLogin);
	if (!login) return json({ error: "not_found" }, { status: 404 });
	if (method === "PATCH") {
		const body = await parse(request, MemberBody);
		if (!body) return invalid();
		return respond(await index.updateMember(visitor, id, login, body.role));
	}
	if (method === "DELETE") return respond(await index.removeMember(visitor, id, login));
	return notAllowed();
}

/**
 * Before a live connection reaches a board: check the visitor's role on it,
 * and pass it on to the board's object, which enforces it (viewers get
 * read-only connections). Only boards in the index can be opened.
 */
export async function authorizeBoardConnection(
	request: Request,
	env: Env,
	lobby: { className: string; name: string },
): Promise<Request | Response> {
	if (lobby.className !== "Board") return new Response("Not found", { status: 404 });
	const visitor = await visitorFor(request, env);
	const result = BOARD_ID.test(lobby.name)
		? await directory(env).join(visitor, lobby.name)
		: ({ ok: false, error: "not_found" } as const);
	if (!result.ok) {
		log.warn("access.denied", {
			path: new URL(request.url).pathname,
			board: lobby.name,
			reason: result.error,
			login: visitor.user?.login,
		});
		return json({ error: result.error }, { status: STATUS[result.error] });
	}
	const access: ConnectionAccess = { ...visitorKey(visitor), role: result.value.role };
	const forwarded = new Request(request);
	forwarded.headers.set(ACCESS_HEADER, JSON.stringify(access));
	return forwarded;
}

/**
 * Who's making a request, for boards: signed in or not, and whether they
 * may use the instance (everyone may before setup, and on Previews).
 */
async function visitorFor(request: Request, env: Env): Promise<Visitor> {
	if (!env.TACK_SECRET) return { user: null, allowed: true };
	const { configured, session } = await lookupRequest(request, env);
	return { user: session?.viewer ?? null, allowed: !configured || (session?.allowed ?? false) };
}

function respond<T>(result: BoardResult<T>, status = 200): Response {
	if (result.ok) return json(result.value, { status });
	return json(
		{ error: result.error, ...(result.logins ? { logins: result.logins } : {}) },
		{ status: STATUS[result.error] },
	);
}

async function parse<S extends v.GenericSchema>(
	request: Request,
	schema: S,
): Promise<v.InferOutput<S> | null> {
	const body = v.safeParse(schema, await request.json().catch(() => null));
	return body.success ? body.output : null;
}

function invalid(): Response {
	return json({ error: "invalid" }, { status: 400 });
}

function notAllowed(): Response {
	return json({ error: "method_not_allowed" }, { status: 405 });
}

function safeDecode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
