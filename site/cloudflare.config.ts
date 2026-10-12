import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "../src/demoAi/index.ts" with { type: "cf-worker" };

// The docs site: static files, served by Workers static assets; requests
// that don't match a file get the site's 404 page. The one exception is the
// public demo's AI (`/try/api/*`), which runs Worker code: src/demoAi/,
// bundled by `vp build --mode try-ai` at the repository's root
// (scripts/build-output.ts). See "The demo's AI" in AGENTS.md.
const NAME = "tack-docs";

export default defineConfig({
	worker: {
		name: NAME,
		entrypoint,
		compatibilityDate: "2026-10-06",
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "404-page",
			runWorkerFirst: ["/try/api/*"],
		},
		env: {
			// Workers AI: Gemma 4 26B A4B, as a real Tack asks (src/server/ai.ts).
			AI: bindings.ai(),
			// Each visitor (by IP address) may ask this often; past it, the demo
			// uses its stand-in for a minute.
			DEMO_AI_LIMIT: bindings.rateLimit({
				namespace: "7501",
				simple: { limit: 12, period: 60 },
			}),
			// Requests a day, from everyone and from one visitor: past them, the
			// demo's AI is "busy" until midnight UTC (src/demoAi/budget.ts).
			DemoBudget: bindings.durableObject({ worker: NAME, exportName: "DemoBudget" }),
			DEMO_AI_DAILY: bindings.text("3000"),
			DEMO_AI_VISITOR_DAILY: bindings.text("150"),
			// `off` switches the demo's AI off: the page uses its stand-in.
			DEMO_AI: bindings.text("on"),
		},
		exports: {
			DemoBudget: exports.durableObject({ storage: "sqlite" }),
		},
		observability: {
			enabled: true,
		},
	},
});
