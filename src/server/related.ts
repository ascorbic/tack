// What's related to a card, for Expand related (#42):
//
//   GET /api/boards/:id/related?key=github.com/o/r#12    a `RelatedResult`, or a `QueryError`
//
// Anyone who can open the board may ask, about an item they can read. The
// forge is asked with the viewer's own token where they have one, so it
// leaves out what they can't see; without one, the app's token reads it and
// every item from a repository that isn't public is checked against the
// viewer, as the board filters cards (#10). Items they can't read are left
// out entirely, not even their keys: unlike a card already on the board, a
// related item's existence is news.

import { isMissing, type Card } from "../shared/cards.ts";
import { itemOf, parseRepoKey, repoKeyOf } from "../shared/refs.ts";
import type { QueryError, RelatedResult } from "../shared/widgets.ts";
import { BOARD_ID } from "../shared/boards.ts";
import { json } from "./auth/http.ts";
import { lookupRequest } from "./auth/session.ts";
import { roleFor, visitorKey } from "./boards/access.ts";
import { forge, type RepoIdentity } from "./forges/index.ts";
import { type Viewer, viewerToken } from "./identity.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";
import { mayRead } from "./push/routes.ts";
import { resolveRepo } from "./routing.ts";
import { withoutPrivateLinks } from "./visibility.ts";

const STATUS: Record<QueryError["reason"], number> = {
	signed_out: 401,
	no_access: 404,
	rate_limited: 429,
	invalid: 400,
	unsupported: 404,
	error: 502,
};

/** Repository identities, so a burst of expansions resolves each once. */
const routes = new Map<string, { repo: RepoIdentity; until: number }>();
const ROUTE_TTL_MS = 5 * 60_000;
const ROUTE_LIMIT = 500;

export async function handleRelated(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/api\/boards\/([^/]+)\/related$/.exec(url.pathname);
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

	const key = (url.searchParams.get("key") ?? "").toLowerCase();
	const parsed = parseRepoKey(repoKeyOf(key));
	const adapter = parsed ? forge(parsed.forge) : null;
	if (!parsed || !itemOf(key) || key.length > 300) {
		return error({ kind: "error", reason: "invalid", message: "That isn’t an item." });
	}
	if (!adapter?.related) {
		return error({
			kind: "error",
			reason: "unsupported",
			message: "This forge can’t say what’s related.",
		});
	}

	const token = viewer ? await viewerToken(env, viewer).catch(() => null) : null;
	const source = await route(env, repoKeyOf(key));
	if (!source || !(await mayRead(env, source, viewer, token))) {
		// As if it weren't there: private repositories aren't revealed.
		return error(NO_ACCESS);
	}

	let result: RelatedResult | QueryError;
	try {
		result = await adapter.related(key, env, { token });
	} catch (cause) {
		log.warn("related.failed", { board, key, reason: "error", error: cause });
		return error({ kind: "error", reason: "error", message: "Couldn’t ask the forge." });
	}
	if (result.kind === "error") {
		log.info("related.failed", { board, key, reason: result.reason });
		return error(result);
	}
	const visible = await readable(env, result, viewer, token);
	log.info("related.fetched", {
		board,
		key,
		as: token ? "viewer" : "app",
		items: visible.cards.length,
		hidden: result.cards.length - visible.cards.length,
	});
	return Response.json(visible, { headers: { "cache-control": "private, max-age=15" } });
}

const NO_ACCESS: QueryError = {
	kind: "error",
	reason: "no_access",
	message: "It doesn’t exist, or you can’t see it.",
};

function error(result: QueryError): Response {
	return json(result, { status: STATUS[result.reason] });
}

/** Just the items the viewer may read, everywhere they're named. */
async function readable(
	env: Env,
	result: RelatedResult,
	viewer: Viewer | null,
	token: string | null,
): Promise<RelatedResult> {
	const cards = result.cards.filter((entry): entry is Card => !isMissing(entry));
	const privateRepos = [
		...new Set(cards.filter((card) => card.visibility !== "public").map((c) => repoKeyOf(c.key))),
	];
	const allowed = new Set(
		(
			await Promise.all(
				privateRepos.map(async (repoKey) => {
					const repo = await route(env, repoKey);
					return repo && (await mayRead(env, repo, viewer, token)) ? repoKey : null;
				}),
			)
		).filter((repoKey): repoKey is string => repoKey !== null),
	);
	const shown = cards
		.filter((card) => card.visibility === "public" || allowed.has(repoKeyOf(card.key)))
		.map(withoutPrivateLinks);
	const keys = new Set(shown.map((card) => card.key));
	const only = (list: string[]) => list.filter((key) => keys.has(key));
	const { parent, closes, ...rest } = result;
	return {
		...rest,
		...(parent && keys.has(parent) ? { parent } : {}),
		subIssues: only(result.subIssues),
		blockedBy: only(result.blockedBy),
		blocking: only(result.blocking),
		linkedPulls: only(result.linkedPulls),
		...(closes ? { closes: only(closes) } : {}),
		cards: shown,
	};
}

async function route(env: Env, repoKey: string): Promise<RepoIdentity | null> {
	const known = routes.get(repoKey);
	if (known && known.until > Date.now()) return known.repo;
	const repo = await resolveRepo(env, repoKey).catch(() => "error" as const);
	if (typeof repo === "string") return null;
	if (routes.size >= ROUTE_LIMIT) {
		const oldest = routes.keys().next().value;
		if (oldest !== undefined) routes.delete(oldest);
	}
	routes.set(repoKey, { repo, until: Date.now() + ROUTE_TTL_MS });
	return repo;
}

function decode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
