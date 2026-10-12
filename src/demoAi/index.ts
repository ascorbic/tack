import { type DemoEnv, handleDemoAi, isDemoAi } from "./handler.ts";

// The docs site's Worker, tack.social (site/cloudflare.config.ts): the site
// is static files, served without this; only the public demo's API,
// `/try/api/*` (`runWorkerFirst`), comes here.

export { DemoBudget } from "./budget.ts";

export default {
	async fetch(request: Request, env: DemoEnv): Promise<Response> {
		const url = new URL(request.url);
		if (isDemoAi(url)) return handleDemoAi(request, env);
		return Response.json(
			{ error: "not_found" },
			{ status: 404, headers: { "cache-control": "no-store" } },
		);
	},
} satisfies ExportedHandler<DemoEnv>;
