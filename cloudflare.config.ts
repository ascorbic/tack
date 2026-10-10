import { bindings, defineConfig, exports, triggers } from "cf/config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Previews don't inherit production settings, so this returns the complete
// config for each. Each Preview gets its own isolated Durable Object
// namespaces automatically. Previews get no secrets: webhooks only go to
// production, and without a token cards are fetched unauthenticated. Without
// TACK_SECRET, sign-in and setup are unavailable and boards work anonymously.
export default defineConfig(({ isPreview, mode }) => ({
	worker: {
		name: "tack",
		entrypoint,
		compatibilityDate,
		compatibilityFlags,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: [
				"/parties/*",
				"/webhooks/*",
				"/api/*",
				"/auth/*",
				"/setup/callback",
				"/setup/install",
				"/setup/installed",
				"/snapshots/*",
			],
		},
		env: {
			Board: bindings.durableObject({ worker: "tack", exportName: "Board" }),
			Repo: bindings.durableObject({ worker: "tack", exportName: "Repo" }),
			Instance: bindings.durableObject({ worker: "tack", exportName: "Instance" }),
			Directory: bindings.durableObject({ worker: "tack", exportName: "Directory" }),
			// Short names the app also answers to in comment commands (#58),
			// besides its GitHub App slug: `@tack add to roadmap`. Comma-separated;
			// empty for the slug alone. Empty by default: a short alias like `tack`
			// is someone's real GitHub login, and every command would notify them.
			TACK_COMMAND_ALIAS: bindings.text(""),
			...(isPreview
				? {}
				: {
						GITHUB_WEBHOOK_SECRET: bindings.secret(),
						GITHUB_TOKEN: bindings.secret(),
						TACK_SECRET: bindings.secret(),
					}),
			// Fake sign-in for local development (`/auth/dev`). Only declared in
			// dev, so .dev.vars can set it; never set it in production.
			...(mode === "development" ? { TACK_DEV_AUTH: bindings.secret() } : {}),
		},
		exports: {
			Board: exports.durableObject({ storage: "sqlite" }),
			Repo: exports.durableObject({ storage: "sqlite" }),
			Instance: exports.durableObject({ storage: "sqlite" }),
			Directory: exports.durableObject({ storage: "sqlite" }),
		},
		triggers: [
			// Redeliver failed GitHub webhooks (src/server/github/redeliver.ts).
			triggers.scheduled({ schedule: "*/10 * * * *" }),
		],
		observability: {
			enabled: true,
		},
	},
}));
