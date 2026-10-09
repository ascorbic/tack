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
	},
	lint: {
		ignorePatterns: [".claude/worktrees/**", ".cloudflare/**", ".wrangler/**", "dist/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		useTabs: true,
		ignorePatterns: [".claude/worktrees/**", ".cloudflare/**", ".wrangler/**", "dist/**"],
	},
});
