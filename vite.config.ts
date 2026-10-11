import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
	// Tests run in Node against the built Worker in Miniflare (see
	// test/harness.ts), so the Cloudflare plugin is only for dev and build. The
	// inspector is off so several dev servers can run side by side.
	plugins: process.env.VITEST ? [] : [react(), cloudflare({ inspectorPort: false })],
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
});
