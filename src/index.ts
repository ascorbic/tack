import { routePartykitRequest } from "partyserver";
import { handleAuth } from "./server/auth/routes.ts";
import { authorizeBoardConnection, handleBoards } from "./server/boards/routes.ts";
import { handleClientError } from "./server/clientErrors.ts";
import { redeliverFailedWebhooks } from "./server/github/redeliver.ts";
import { handleSetup } from "./server/github/setup.ts";
import { handleNotifications } from "./server/notifications.ts";
import { handlePush } from "./server/push/routes.ts";
import { handleRelated } from "./server/related.ts";
import { handleSnapshots } from "./server/snapshots.ts";
import { handleWebhook } from "./server/webhooks.ts";

export { Board } from "./server/board.ts";
export { Directory } from "./server/directory.ts";
export { Instance } from "./server/instance.ts";
export { Repo } from "./server/repo.ts";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		const webhook = /^\/webhooks\/([a-z]+)$/.exec(url.pathname);
		if (webhook?.[1] && request.method === "POST") {
			return handleWebhook(request, env, webhook[1]);
		}

		if (url.pathname === "/api/client-errors") return handleClientError(request);

		// Sign-in, setup and instance settings.
		const identity = (await handleAuth(request, env)) ?? (await handleSetup(request, env));
		if (identity) return identity;

		// What's related to a card, as the viewer may see it (Expand related).
		const related = await handleRelated(request, env);
		if (related) return related;

		// Pushing staged changes, the audit log, and what repositories offer to write with.
		const push = await handlePush(request, env);
		if (push) return push;

		// Board snapshots for backlink comments: uploads, and the public images.
		const snapshot = await handleSnapshots(request, env);
		if (snapshot) return snapshot;

		// Comment notifications: mentions and replies (the top bar's inbox).
		const notifications = await handleNotifications(request, env);
		if (notifications) return notifications;

		// The board index, membership and visibility.
		const boards = await handleBoards(request, env);
		if (boards) return boards;

		// Board sync: /parties/board/:id, checked per board (viewers get read-only connections).
		const party = await routePartykitRequest(request, env, {
			onBeforeConnect: (req, lobby) => authorizeBoardConnection(req, env, lobby),
			onBeforeRequest: () => new Response("Not found", { status: 404 }),
		});
		if (party) return party;

		return new Response("Not found", { status: 404 });
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		// GitHub doesn't retry failed webhook deliveries; ask it to. Logged as
		// `github.redelivery`.
		ctx.waitUntil(redeliverFailedWebhooks(env));
	},
} satisfies ExportedHandler<Env>;
