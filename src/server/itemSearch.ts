// Searching for issues and pull requests to put on a board, for the card
// tool (C):
//
//   GET /api/boards/:id/search?host=github.com&q=repo:o/r migration   a `SearchResult`, or a `QueryError`
//
// Anyone who can open the board may search. The forge is asked with the
// viewer's own token, so results are what they can see; without one (signed
// out, or a preview) only public items come back, as for a widget's public
// searches (src/server/widgets/runner.ts).

import { BOARD_ID } from "../shared/boards.ts";
import { DEFAULT_HOST, forgeForHost } from "../shared/refs.ts";
import { mentionsMe } from "../shared/search.ts";
import type { QueryError, SearchResult } from "../shared/widgets.ts";
import { json } from "./auth/http.ts";
import { lookupRequest } from "./auth/session.ts";
import { roleFor, visitorKey } from "./boards/access.ts";
import { forge } from "./forges/index.ts";
import { viewerToken } from "./identity.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";
import { withoutPrivateLinks } from "./visibility.ts";

/** Results the card tool shows: a short list to pick from, not a report. */
export const ITEM_SEARCH_LIMIT = 10;
const MAX_QUERY = 256;

const STATUS: Record<QueryError["reason"], number> = {
	signed_out: 401,
	no_access: 404,
	rate_limited: 429,
	invalid: 400,
	unsupported: 404,
	error: 502,
};

export async function handleItemSearch(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/api\/boards\/([^/]+)\/search$/.exec(url.pathname);
	if (!match) return null;
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
	const board = decode(match[1] ?? "");
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

	const host = (url.searchParams.get("host") || DEFAULT_HOST).toLowerCase();
	const q = (url.searchParams.get("q") ?? "").trim();
	if (!q || q.length > MAX_QUERY) {
		return error({ kind: "error", reason: "invalid", message: "Type something to search for." });
	}
	const forgeId = forgeForHost(host);
	const adapter = forgeId ? forge(forgeId) : null;
	if (!adapter?.search) {
		return error({ kind: "error", reason: "unsupported", message: `Tack can’t search ${host}.` });
	}

	const token = viewer ? await viewerToken(env, viewer).catch(() => null) : null;
	if (!token && mentionsMe(q)) {
		return error({
			kind: "error",
			reason: "signed_out",
			message: "Sign in to see what “@me” means for you.",
		});
	}
	// Without a token of their own, only what anyone may see. Forges without
	// private repositories (no `canRead`) need no limiting.
	const limited = !token && adapter.canRead !== undefined;
	let result: SearchResult | QueryError;
	try {
		result = await adapter.search(
			{ kind: "search", host, q: limited ? `${q} is:public` : q, limit: ITEM_SEARCH_LIMIT },
			env,
			{ token, ...(viewer && token ? { viewer: viewer.login } : {}) },
		);
	} catch (cause) {
		log.warn("search.items.failed", { board, host, reason: "error", error: cause });
		return error({ kind: "error", reason: "error", message: "Couldn’t ask the forge." });
	}
	if (result.kind === "error") {
		log.info("search.items.failed", { board, host, reason: result.reason });
		return error(result);
	}
	const items = result.items
		.filter((card) => !limited || card.visibility === "public")
		.slice(0, ITEM_SEARCH_LIMIT)
		.map(withoutPrivateLinks);
	log.info("search.items", {
		board,
		host,
		as: token ? "viewer" : "public",
		results: items.length,
		total: result.total,
	});
	const body: SearchResult = {
		kind: "search",
		total: Math.max(items.length, result.total - (result.items.length - items.length)),
		items,
		...(result.incomplete ? { incomplete: true } : {}),
	};
	return Response.json(body, { headers: { "cache-control": "private, max-age=15" } });
}

function error(result: QueryError): Response {
	return json(result, { status: STATUS[result.reason] });
}

function decode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
