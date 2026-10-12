import { defineConfig, devices } from "@playwright/test";

// Smoke tests over the /play workbench, in a real browser against the dev
// server. Kept apart from `vp test` so the unit and integration tests stay
// fast: run them with `pnpm e2e`.

// E2E_PORT lets parallel worktrees each run their own dev server.
const PORT = Number(process.env.E2E_PORT ?? 5205);
const CI = Boolean(process.env.CI);

// Safari, opt-in (E2E_WEBKIT=1, or `pnpm e2e:webkit`), over the specs that
// cover what Safari does its own way (touch, focus in frames, IndexedDB,
// pasting, dragging), so CI's default run stays Chromium only.
// E2E_WEBKIT=all runs every spec in it.
const WEBKIT = process.env.E2E_WEBKIT;
const WEBKIT_SPECS =
	WEBKIT === "all"
		? "**/*.spec.ts"
		: ["mobile", "try", "embed", "embeds", "images", "links", "canvas", "stacks", "cards"].map(
				(name) => `**/${name}.spec.ts`,
			);

export default defineConfig({
	testDir: ".",
	outputDir: "./test-results",
	fullyParallel: true,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	// CI never writes baselines: a missing one is reported, not invented.
	updateSnapshots: CI ? "none" : "missing",
	reporter: CI
		? [["github"], ["html", { outputFolder: "./report", open: "never" }]]
		: [["list"], ["html", { outputFolder: "./report", open: "never" }]],
	use: {
		baseURL: `http://localhost:${PORT}`,
		viewport: { width: 1280, height: 800 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
			caret: "hide",
			// Allow a little antialiasing noise, but not a changed word on a card.
			maxDiffPixels: 40,
		},
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
		},
		...(WEBKIT
			? [
					{
						name: "webkit",
						testMatch: WEBKIT_SPECS,
						use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
					},
				]
			: []),
	],
	webServer: {
		command: `pnpm dev --port ${PORT} --strictPort`,
		cwd: "..",
		url: `http://localhost:${PORT}/play`,
		reuseExistingServer: !CI,
		timeout: 120_000,
		stdout: "ignore",
		stderr: "pipe",
		// Sign-in for e2e/auth.spec.ts, without GitHub. Only used where there's
		// no .dev.vars (as in CI): the Cloudflare plugin prefers that file.
		env: { TACK_SECRET: "e2e-only-secret", TACK_DEV_AUTH: "1" },
	},
});
