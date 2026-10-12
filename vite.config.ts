import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite-plus";
import { headersFile, inlineHashes, tryHeadersFile } from "./src/server/securityHeaders.ts";

/**
 * The static assets' security headers (#60): a `_headers` file beside them,
 * whose Content-Security-Policy allows index.html's inline script by hash.
 * Built only, so the dev server (whose HTML Vite rewrites) is unaffected.
 */
function securityHeaders(): Plugin {
	return {
		name: "tack:security-headers",
		apply: "build",
		enforce: "post",
		applyToEnvironment: (environment) => environment.name === "client",
		async generateBundle(_options, bundle) {
			const html = bundle["index.html"];
			if (html?.type !== "asset") return;
			const hashes = await inlineHashes(String(html.source));
			this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(hashes) });
		},
	};
}

/**
 * The public demo, tack.social/try (#75): the playground's simulated board as
 * a static page of its own, with no Worker at all. `vp build --mode try`
 * writes it to dist/try/, which the docs site's build copies in
 * (site/scripts/try.ts); `vp dev --mode try` serves it on its own at /try/.
 */
const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);
const TRY_ROOT = here("./src/client/try");
const TRY_OUT = here("./dist/try");

/** The demo's headers, beside its files: it may reach nothing but them. */
function tryHeaders(): Plugin {
	return {
		name: "tack:try-headers",
		apply: "build",
		enforce: "post",
		async generateBundle(_options, bundle) {
			const html = bundle["index.html"];
			if (html?.type !== "asset") return;
			const hashes = await inlineHashes(String(html.source));
			this.emitFile({ type: "asset", fileName: "_headers", source: tryHeadersFile(hashes) });
		},
	};
}

export default defineConfig(({ mode }) => ({
	// Tests run in Node against the built Worker in Miniflare (see
	// test/harness.ts), so the Cloudflare plugin is only for dev and build. The
	// inspector is off so several dev servers can run side by side.
	plugins: process.env.VITEST
		? []
		: mode === "try"
			? [react(), tryHeaders()]
			: [react(), cloudflare({ inspectorPort: false }), securityHeaders()],
	// The demo: its own page, served from /try/, with no public files.
	...(mode === "try" && {
		root: TRY_ROOT,
		base: "/try/",
		publicDir: false,
		build: { outDir: TRY_OUT, emptyOutDir: true },
	}),
	test: {
		globalSetup: "./test/global-setup.ts",
		// Playwright's smoke tests run separately, with `pnpm e2e`.
		include: ["test/**/*.test.ts"],
		// Integration tests each start a Miniflare runtime, which can take a
		// few seconds on a loaded machine. Fail on real hangs, not on load.
		testTimeout: 20_000,
		hookTimeout: 30_000,
	},
	lint: {
		// The docs site (site/) is Astro's: its modules import Astro's virtual
		// modules, whose types only exist once Astro has generated them, so it
		// builds and checks itself (`pnpm --filter site build`). It's still
		// formatted with everything else.
		ignorePatterns: [
			".claude/worktrees/**",
			".cloudflare/**",
			".wrangler/**",
			"dist/**",
			"site/**",
		],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		useTabs: true,
		// wrangler.jsonc is generated from cloudflare.config.ts (scripts/wrangler-config.ts).
		ignorePatterns: [
			".claude/worktrees/**",
			".cloudflare/**",
			".wrangler/**",
			"dist/**",
			"wrangler.jsonc",
		],
	},
}));
