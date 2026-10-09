import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { compatibilityDate, compatibilityFlags } from "./compatibility.ts";

export default defineConfig({
	// The cloudflare() dev/build plugin and the cloudflareTest() plugin (which
	// runs tests inside workerd) must not be active at the same time.
	plugins: process.env.VITEST
		? [
				cloudflareTest({
					main: "./src/index.ts",
					miniflare: {
						compatibilityDate,
						compatibilityFlags,
						durableObjects: {
							Board: { className: "Board", useSQLite: true },
							Repo: { className: "Repo", useSQLite: true },
						},
						bindings: { GITHUB_WEBHOOK_SECRET: "test-secret", GITHUB_TOKEN: "" },
					},
				}),
			]
		: [react(), cloudflare({ experimental: { newConfig: true } })],
	lint: {
		ignorePatterns: [".cloudflare/**", ".wrangler/**", "dist/**", "worker-configuration.d.ts"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		useTabs: true,
		ignorePatterns: [".cloudflare/**", ".wrangler/**", "dist/**", "worker-configuration.d.ts"],
	},
});
