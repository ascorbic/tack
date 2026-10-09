import { routePartykitRequest } from "partyserver";
import { handleClientError } from "./server/clientErrors.ts";
import { handleWebhook } from "./server/webhooks.ts";

export { Board } from "./server/board.ts";
export { Repo } from "./server/repo.ts";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		const webhook = /^\/webhooks\/([a-z]+)$/.exec(url.pathname);
		if (webhook?.[1] && request.method === "POST") {
			return handleWebhook(request, env, webhook[1]);
		}

		if (url.pathname === "/api/client-errors") return handleClientError(request);

		// Board sync: /parties/board/:name
		const party = await routePartykitRequest(request, env);
		if (party) return party;

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
