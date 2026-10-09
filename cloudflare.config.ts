import { bindings, defineWorker, exports } from "@cloudflare/vite-plugin/experimental-config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineWorker({
	name: "tack",
	entrypoint,
	compatibilityDate,
	compatibilityFlags,
	assets: {
		notFoundHandling: "single-page-application",
		runWorkerFirst: ["/parties/*", "/webhooks/*", "/api/*"],
	},
	env: {
		Board: bindings.durableObject({ workerName: "tack", exportName: "Board" }),
		Repo: bindings.durableObject({ workerName: "tack", exportName: "Repo" }),
		GITHUB_WEBHOOK_SECRET: bindings.secret(),
		GITHUB_TOKEN: bindings.secret(),
	},
	exports: {
		Board: exports.durableObject({ storage: "sqlite" }),
		Repo: exports.durableObject({ storage: "sqlite" }),
	},
	observability: {
		enabled: true,
	},
});
