import { routePartykitRequest } from "partyserver";
import { requireInstanceAccess } from "./server/auth/access.ts";
import { handleAuth } from "./server/auth/routes.ts";
import { handleClientError } from "./server/clientErrors.ts";
import { handleSetup } from "./server/github/setup.ts";
import { handleWebhook } from "./server/webhooks.ts";

export { Board } from "./server/board.ts";
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

		// Board sync: /parties/board/:name
		const party = await routePartykitRequest(request, env, {
			onBeforeConnect: (req) => requireInstanceAccess(req, env),
			onBeforeRequest: (req) => requireInstanceAccess(req, env),
		});
		if (party) return party;

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
