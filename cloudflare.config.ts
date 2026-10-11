import { bindings, defineConfig, exports, triggers } from "cf/config";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/** Whether `vp dev` should ask the real Workers AI (`TACK_DEV_AI=workers-ai`) rather than a fake. */
function realAiInDev(): boolean {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	return env?.TACK_DEV_AI === "workers-ai";
}

// Weekly digests by email (#68) go out through Cloudflare Email Service,
// from this address: "Tack <tack@example.com>", on a domain onboarded to
// Email Service's sending (see the self-hosting docs, "Email"). Empty turns
// email off, and leaves out the binding, so new instances deploy without it.
const EMAIL_FROM = "";

// Previews don't inherit production settings, so this returns the complete
// config for each. Each Preview gets its own isolated Durable Object
// namespaces automatically. Previews get no secrets: webhooks only go to
// production, and without a token cards are fetched unauthenticated. Without
// TACK_SECRET, sign-in and setup are unavailable and boards work anonymously.
// The Worker's name. To run a second instance on the same account, change it
// here only: the Durable Object bindings below follow it, so the two never
// share storage.
const NAME = "tack";

export default defineConfig(({ isPreview, mode }) => ({
	worker: {
		name: NAME,
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
				// Board images, link preview images, and public boards' meta tags (#56, #57).
				"/embed/*",
				"/og/*",
				"/b/*",
				// Custom widgets' sandbox page, with its own headers (#66).
				"/sandbox/*",
			],
		},
		env: {
			Board: bindings.durableObject({ worker: NAME, exportName: "Board" }),
			Repo: bindings.durableObject({ worker: NAME, exportName: "Repo" }),
			Instance: bindings.durableObject({ worker: NAME, exportName: "Instance" }),
			Directory: bindings.durableObject({ worker: NAME, exportName: "Directory" }),
			// The app's own files, for serving public boards' pages with their
			// link preview meta tags (src/server/embeds/routes.ts).
			ASSETS: bindings.assets(),
			// Short names the app also answers to in comment commands (#58),
			// besides its GitHub App slug: `@tack add to roadmap`. Comma-separated;
			// empty for the slug alone. Empty by default: a short alias like `tack`
			// is someone's real GitHub login, and every command would notify them.
			TACK_COMMAND_ALIAS: bindings.text(""),
			// AI suggestions (#73): naming stacks of stickies from what they say,
			// and sorting a selection into named stacks. On by default: they ask
			// Workers AI through the AI binding below (src/server/ai.ts), which
			// counts against the account's Workers AI allocation (a free daily
			// amount, then billed). `off` turns them off (stacks are "Untitled
			// stack" until someone names them); without the binding they're off
			// too, and /setup says so. Local dev has no Workers AI (a binding
			// there always reaches the remote, billed service and needs a
			// Cloudflare login), so it uses `fake`, a stand-in that answers from
			// the stickies' words; start it with TACK_DEV_AI=workers-ai to ask the
			// real thing.
			TACK_AI: bindings.text(mode === "development" && !realAiInDev() ? "fake" : "on"),
			...(mode !== "development" || realAiInDev()
				? { AI: bindings.ai(realAiInDev() ? { dev: { remote: true } } : undefined) }
				: {}),
			// Digest emails (#68): who they're from, and Email Service's binding.
			// Dev always has both, to try it locally: Miniflare keeps what's
			// sent (the local explorer shows it).
			TACK_EMAIL_FROM: bindings.text(
				EMAIL_FROM || (mode === "development" ? "Tack <tack@example.com>" : ""),
			),
			...(EMAIL_FROM || mode === "development" ? { TACK_EMAIL: bindings.sendEmail() } : {}),
			// The one secret an instance needs. A declared secret is required: the
			// first deploy fails without it (give it with `--secrets-file`, or the
			// Deploy to Cloudflare button asks for it), and later deploys keep it.
			...(isPreview ? {} : { TACK_SECRET: bindings.secret() }),
			// Optional secrets, declared only in dev so .dev.vars can set them.
			// In production they're set on the Worker when wanted (deploys keep
			// secrets that aren't declared), so a new instance doesn't need them:
			// GITHUB_WEBHOOK_SECRET, a second webhook secret (apps set up by hand,
			// test webhooks); GITHUB_TOKEN, for reading public repositories
			// without the app; TACK_FORGES, the forges besides GitHub (GitLab,
			// Forgejo, Tangled) with their tokens and webhook secrets, as JSON
			// (src/server/forges/config.ts). TACK_DEV_AUTH is fake sign-in
			// (`/auth/dev`): never set it in production.
			...(mode === "development"
				? {
						GITHUB_WEBHOOK_SECRET: bindings.secret(),
						GITHUB_TOKEN: bindings.secret(),
						TACK_FORGES: bindings.secret(),
						TACK_DEV_AUTH: bindings.secret(),
					}
				: {}),
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
