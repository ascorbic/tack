import { routePartykitRequest } from "partyserver";
import { handleAi } from "./server/ai/routes.ts";
import { handleAuth } from "./server/auth/routes.ts";
import { authorizeBoardConnection, handleBoards } from "./server/boards/routes.ts";
import { handlePeople } from "./server/boards/people.ts";
import { handleTemplates } from "./server/boards/templates.ts";
import { handleClientError } from "./server/clientErrors.ts";
import { handleEmbeds } from "./server/embeds/routes.ts";
import { handleExports } from "./server/exports.ts";
import { redeliverFailedWebhooks } from "./server/github/redeliver.ts";
import { handleSetup } from "./server/github/setup.ts";
import { handleNotifications } from "./server/notifications.ts";
import { handlePush } from "./server/push/routes.ts";
import { handleHistory } from "./server/history.ts";
import { handleItemSearch } from "./server/itemSearch.ts";
import { handleRelated } from "./server/related.ts";
import { handleSnapshots } from "./server/snapshots.ts";
import { handleWebhook } from "./server/webhooks.ts";
import { handleSandbox } from "./server/widgets/sandbox.ts";
import { isCrossSite } from "./server/auth/http.ts";
import { configureForges } from "./server/forges/config.ts";
import { log } from "./server/log.ts";
import { withSecurityHeaders } from "./server/securityHeaders.ts";

export { Board } from "./server/board.ts";
export { Directory } from "./server/directory.ts";
export { Instance } from "./server/instance.ts";
export { Repo } from "./server/repo.ts";

/** Methods that never change anything, so another site may send them. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Every route, behind the checks that apply to all of them (#60): only
 * webhooks (signed, from the forge) may change anything from another site,
 * and only this site may open a live connection with the viewer's cookie.
 * See the access table in AGENTS.md and docs/security-review.md.
 */
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);

	const webhook = /^\/webhooks\/([a-z]+)$/.exec(url.pathname);
	if (webhook?.[1] && request.method === "POST") {
		return handleWebhook(request, env, webhook[1]);
	}

	const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
	if ((upgrade || !SAFE_METHODS.has(request.method)) && isCrossSite(request)) {
		log.warn("auth.rejected", { path: url.pathname, method: request.method, upgrade });
		return Response.json({ error: "forbidden" }, { status: 403 });
	}

	if (url.pathname === "/api/client-errors") return handleClientError(request);

	// Custom widgets' sandbox (#66): a page with no data, framed by the board.
	const sandbox = handleSandbox(request);
	if (sandbox) return sandbox;

	// Sign-in, setup and instance settings.
	const identity = (await handleAuth(request, env)) ?? (await handleSetup(request, env));
	if (identity) return identity;

	// What's related to a card, as the viewer may see it (Expand related).
	const related = await handleRelated(request, env);
	if (related) return related;

	// Searching for issues and pull requests to add, as the viewer (the card tool).
	const search = await handleItemSearch(request, env);
	if (search) return search;

	// AI: a widget from a description, summaries and drafted decisions (#64).
	const ai = await handleAi(request, env);
	if (ai) return ai;

	// The board's history: its timeline, and segments of it to replay.
	const history = await handleHistory(request, env);
	if (history) return history;

	// Pushing staged changes, the audit log, and what repositories offer to write with.
	const push = await handlePush(request, env);
	if (push) return push;

	// Board snapshots for backlink comments: uploads, and the public images.
	const snapshot = await handleSnapshots(request, env);
	if (snapshot) return snapshot;

	// Public boards outside Tack: images for READMEs, link preview images,
	// and boards' pages with their link preview meta tags.
	const embed = await handleEmbeds(request, env, ctx);
	if (embed) return embed;

	// Comment notifications: mentions and replies (the top bar's inbox).
	const notifications = await handleNotifications(request, env);
	if (notifications) return notifications;

	// Importing boards from their JSON, and backing them up to a branch (#59).
	const exported = await handleExports(request, env);
	if (exported) return exported;

	// Templates, and carrying action items over between boards.
	const templates = await handleTemplates(request, env);
	if (templates) return templates;

	// The board index, membership and visibility.
	const boards = await handleBoards(request, env);
	if (boards) return boards;

	// People to invite to boards, and checking their logins against GitHub.
	const people = await handlePeople(request, env);
	if (people) return people;

	// Board sync: /parties/board/:id, checked per board (viewers get read-only connections).
	const party = await routePartykitRequest(request, env, {
		onBeforeConnect: (req, lobby) => authorizeBoardConnection(req, env, lobby),
		onBeforeRequest: () => new Response("Not found", { status: 404 }),
	});
	if (party) return party;

	return new Response("Not found", { status: 404 });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Which forge hosts keys may name: GitHub's, and those TACK_FORGES configures.
		configureForges(env);
		// CSP and the other security headers on everything the Worker answers.
		return withSecurityHeaders(request, await route(request, env, ctx));
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		configureForges(env);
		// GitHub doesn't retry failed webhook deliveries; ask it to. Logged as
		// `github.redelivery`.
		ctx.waitUntil(redeliverFailedWebhooks(env));
	},
} satisfies ExportedHandler<Env>;
