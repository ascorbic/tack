// Who reacted to a card's item, for the tooltip on its reaction count:
//
//   GET /api/boards/:id/reactors?key=github.com/o/r#12    a `ReactorsResult`, or a `QueryError`
//
// Asked only when someone hovers or focuses the count, never with the card's
// data. Anyone who can open the board may ask, about an item they can read,
// as with Expand related (related.ts): the forge is asked with the viewer's
// own token where they have one, else the app's, and an item in a
// repository the viewer can't read answers as if it weren't there. Reactions
// on GitHub are public to anyone who can read the item, so nothing more is
// filtered. Forges that can't say (all but GitHub and the fake forge) answer
// `unsupported`, and the client shows the count alone.

import { BOARD_ID } from "../shared/boards.ts";
import type { ReactorsResult } from "../shared/reactions.ts";
import { itemOf, parseRepoKey, repoKeyOf } from "../shared/refs.ts";
import type { QueryError } from "../shared/widgets.ts";
import { json } from "./auth/http.ts";
import { lookupRequest } from "./auth/session.ts";
import { roleFor, visitorKey } from "./boards/access.ts";
import { forge } from "./forges/index.ts";
import { viewerToken } from "./identity.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";
import { mayRead } from "./push/routes.ts";
import { NO_ACCESS, decodeParam, queryErrorResponse, repoRoute } from "./related.ts";

export async function handleReactors(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/api\/boards\/([^/]+)\/reactors$/.exec(url.pathname);
	if (!match) return null;
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
	const board = decodeParam(match[1] ?? "");
	if (!board || !BOARD_ID.test(board)) return json({ error: "not_found" }, { status: 404 });

	const { configured, session } = env.TACK_SECRET
		? await lookupRequest(request, env)
		: { configured: false, session: null };
	const viewer = session?.viewer ?? null;
	const visitor = { user: viewer, allowed: !configured || (session?.allowed ?? false) };
	const policy = await directory(env).accessPolicy(board);
	if (!policy || !roleFor(policy, visitorKey(visitor))) {
		return json({ error: "not_found" }, { status: 404 });
	}

	const key = (url.searchParams.get("key") ?? "").toLowerCase();
	const parsed = parseRepoKey(repoKeyOf(key));
	const adapter = parsed ? forge(parsed.forge) : null;
	if (!parsed || !itemOf(key) || key.length > 300) {
		return queryErrorResponse({ kind: "error", reason: "invalid", message: "That isn’t an item." });
	}
	if (!adapter?.reactors) {
		return queryErrorResponse({
			kind: "error",
			reason: "unsupported",
			message: "This forge can’t say who reacted.",
		});
	}

	const token = viewer ? await viewerToken(env, viewer).catch(() => null) : null;
	const source = await repoRoute(env, repoKeyOf(key));
	if (!source || !(await mayRead(env, source, viewer, token))) {
		// As if it weren't there: private repositories aren't revealed.
		return queryErrorResponse(NO_ACCESS);
	}

	let result: ReactorsResult | QueryError;
	try {
		result = await adapter.reactors(key, env, { token });
	} catch (cause) {
		log.warn("reactors.failed", { board, key, reason: "error", error: cause });
		return queryErrorResponse({
			kind: "error",
			reason: "error",
			message: "Couldn’t ask the forge.",
		});
	}
	if (result.kind === "error") {
		log.info("reactors.failed", { board, key, reason: result.reason });
		return queryErrorResponse(result);
	}
	log.info("reactors.fetched", {
		board,
		key,
		as: token ? "viewer" : "app",
		groups: result.groups.length,
	});
	// Kept a little by the browser too: hovering back and forth asks once.
	return Response.json(result, { headers: { "cache-control": "private, max-age=60" } });
}
