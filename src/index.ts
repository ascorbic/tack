import { routePartykitRequest } from "partyserver";
import { handleWebhook } from "./server/webhooks.ts";

export { Board } from "./server/board.ts";
export { Repo } from "./server/repo.ts";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/webhooks/github" && request.method === "POST") {
			return handleWebhook(request, env);
		}

		// Board sync: /parties/board/:name
		const party = await routePartykitRequest(request, env);
		if (party) return party;

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
