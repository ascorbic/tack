// The push API (M2). Shapes in src/shared/push.ts.
//
//   POST /api/boards/:id/push                     push staged changes { ids, as }
//   GET  /api/boards/:id/pushes                   the board's audit log, newest first
//   GET  /api/repos/meta?repo=github.com/o/r      labels, milestones, people, categories…
//   GET  /api/repos/files?repo=github.com/o/r&path=docs/decisions   file names
//
// Pushing needs edit access to the board and a signed-in person; the board's
// object checks the rest (write access to every repository, the app
// installed) and runs the push. Repository metadata needs instance access,
// and for private repositories, read access with the viewer's own token.

import { getServerByName } from "partyserver";
import * as v from "valibot";
import { BOARD_ID, canEdit } from "../../shared/boards.ts";
import type { PushResponse } from "../../shared/push.ts";
import { parseRepoKey } from "../../shared/refs.ts";
import { requireInstanceAccess } from "../auth/access.ts";
import { isCrossSite, json } from "../auth/http.ts";
import { lookupRequest } from "../auth/session.ts";
import type { Board } from "../board.ts";
import { roleFor, visitorKey } from "../boards/access.ts";
import { forge, type RepoIdentity } from "../forges/index.ts";
import { getViewer, type Viewer, viewerToken } from "../identity.ts";
import { log } from "../log.ts";
import { boards, directory } from "../namespaces.ts";
import { resolveRepo } from "../routing.ts";

const PushBody = v.object({
	ids: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
		v.minLength(1),
		v.maxLength(200),
	),
	as: v.picklist(["user", "app"]),
});

const PUSH_STATUS: Record<Extract<PushResponse, { ok: false }>["reason"], number> = {
	signed_out: 401,
	no_write_access: 403,
	not_installed: 403,
	missing_dependency: 422,
	busy: 409,
};

/** How long repository metadata and listings are reused. */
const META_TTL_MS = 60_000;
/** How long a viewer's read access to a private repository is believed. */
const ACCESS_TTL_MS = 60_000;
const CACHE_LIMIT = 500;

export async function handlePush(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const board = /^\/api\/boards\/([^/]+)\/(push|pushes)$/.exec(url.pathname);
	if (board) return boardRoute(request, env, decode(board[1] ?? ""), board[2] as "push" | "pushes");
	if (url.pathname === "/api/repos/meta") return repoRoute(request, env, url, "meta");
	if (url.pathname === "/api/repos/files") return repoRoute(request, env, url, "files");
	return null;
}

async function boardRoute(
	request: Request,
	env: Env,
	id: string | null,
	route: "push" | "pushes",
): Promise<Response> {
	const method = route === "push" ? "POST" : "GET";
	if (request.method !== method) return json({ error: "method_not_allowed" }, { status: 405 });
	if (method === "POST" && isCrossSite(request)) {
		log.warn("auth.rejected", { path: new URL(request.url).pathname });
		return json({ error: "forbidden" }, { status: 403 });
	}
	if (!id || !BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });

	const { configured, session } = env.TACK_SECRET
		? await lookupRequest(request, env)
		: { configured: false, session: null };
	const viewer = session?.viewer ?? null;
	const visitor = { user: viewer, allowed: !configured || (session?.allowed ?? false) };
	const policy = await directory(env).accessPolicy(id);
	const role = policy ? roleFor(policy, visitorKey(visitor)) : null;
	if (!role) return json({ error: "not_found" }, { status: 404 });

	const stub = await getServerByName<Env, Board>(boards(env), id);
	if (route === "pushes") return json(await stub.pushLog());

	if (!canEdit(role)) return json({ error: "forbidden" }, { status: 403 });
	const body = v.safeParse(PushBody, await request.json().catch(() => null));
	if (!body.success) return json({ error: "invalid" }, { status: 400 });
	if (!viewer) {
		const response: PushResponse = {
			ok: false,
			reason: "signed_out",
			message: "Sign in with GitHub to push. Anyone who can edit the board can stage changes.",
		};
		return json(response, { status: PUSH_STATUS.signed_out });
	}
	const result = await stub.push({
		ids: body.output.ids,
		as: body.output.as,
		by: { id: viewer.id, login: viewer.login, name: viewer.name },
	});
	return json(result, { status: result.ok ? 202 : PUSH_STATUS[result.reason] });
}

// --- Repository metadata ---------------------------------------------------------

const cache = new Map<string, { value: unknown; until: number }>();

function cached<T>(key: string): T | undefined {
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (entry.until > Date.now()) return entry.value as T;
	cache.delete(key);
	return undefined;
}

function remember(key: string, value: unknown, ttl: number): void {
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { value, until: Date.now() + ttl });
}

async function repoRoute(
	request: Request,
	env: Env,
	url: URL,
	route: "meta" | "files",
): Promise<Response> {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
	const denied = await requireInstanceAccess(request, env);
	if (denied) return denied;

	const repoKey = url.searchParams.get("repo") ?? "";
	const parsed = parseRepoKey(repoKey);
	const adapter = parsed ? forge(parsed.forge) : null;
	if (!parsed || !adapter || (route === "meta" ? !adapter.repoMeta : !adapter.listDirectory)) {
		return json({ error: "unsupported" }, { status: 404 });
	}
	const path = (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
	if (
		path.length > 512 ||
		path.includes("\\") ||
		path.split("/").some((part) => part === ".." || part === ".")
	) {
		return json({ error: "invalid" }, { status: 400 });
	}

	const repo = await resolveRepo(env, repoKey);
	if (typeof repo === "string") {
		return json({ error: repo }, { status: repo === "error" ? 502 : 404 });
	}
	const viewer = await getViewer(request, env);
	const token = viewer ? await viewerToken(env, viewer).catch(() => null) : null;
	if (!(await mayRead(env, repo, viewer, token))) {
		// As if it weren't there: private repositories aren't revealed.
		return json({ error: "not_found" }, { status: 404 });
	}

	const key = `${route}:${repo.host}/${repo.id}${route === "files" ? `:${path}` : ""}`;
	let value = cached<unknown>(key);
	if (value === undefined) {
		try {
			value =
				route === "meta"
					? // What the forge can write, so the UI only offers that (RepoMeta.writes).
						{
							...(await adapter.repoMeta!(repo, env, { token })),
							writes: adapter.capabilities.writes,
						}
					: await adapter.listDirectory!(repo, path, env, { token });
		} catch (error) {
			log.warn(`repos.${route}.failed`, { repo: repoKey, error });
			return json({ error: "unavailable" }, { status: 502 });
		}
		remember(key, value, META_TTL_MS);
	}
	return Response.json(value, {
		headers: { "cache-control": `private, max-age=${META_TTL_MS / 1000}` },
	});
}

/** Whether the viewer may read a repository: public ones anyone may, private ones need their own token. */
export async function mayRead(
	env: Env,
	repo: RepoIdentity,
	viewer: Viewer | null,
	token: string | null,
): Promise<boolean> {
	const adapter = forge(repo.forge);
	if (!adapter.canRead || repo.private === false) return true;
	if (!viewer || !token) return false;
	const key = `read:${viewer.id}:${repo.host}/${repo.id}`;
	const known = cached<boolean>(key);
	if (known !== undefined) return known;
	const readable = await adapter.canRead(repo, token, env).catch(() => false);
	remember(key, readable, ACCESS_TTL_MS);
	return readable;
}

function decode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
