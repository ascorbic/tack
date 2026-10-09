import { bindings, defineConfig, exports } from "cf/config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Previews don't inherit production settings, so this returns the complete
// config for each. Each Preview gets its own isolated Durable Object
// namespaces automatically. Previews get no secrets: webhooks only go to
// production, and without a token cards are fetched unauthenticated.
export default defineConfig(({ isPreview }) => ({
	worker: {
		name: "tack",
		entrypoint,
		compatibilityDate,
		compatibilityFlags,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/parties/*", "/webhooks/*", "/api/*"],
		},
		env: {
			Board: bindings.durableObject({ worker: "tack", exportName: "Board" }),
			Repo: bindings.durableObject({ worker: "tack", exportName: "Repo" }),
			...(isPreview
				? {}
				: {
						GITHUB_WEBHOOK_SECRET: bindings.secret(),
						GITHUB_TOKEN: bindings.secret(),
					}),
		},
		exports: {
			Board: exports.durableObject({ storage: "sqlite" }),
			Repo: exports.durableObject({ storage: "sqlite" }),
		},
		observability: {
			enabled: true,
		},
	},
}));
