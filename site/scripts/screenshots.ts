// Screenshots of the /play workbench for the docs, in light and dark.
//
// The playground is dev-only, so this needs the app's dev server running
// (`pnpm dev` at the repository root), then:
//
//   pnpm --filter site screenshots [base URL, default http://localhost:5173] [names…]
//
// Install the browser once with `pnpm exec playwright install chromium`.
// The images are committed (src/assets/screenshots/), so building the site
// never needs the app.
import { chromium, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const base = process.argv[2] ?? "http://localhost:5173";
const out = path.resolve(import.meta.dirname, "../src/assets/screenshots");

interface Shot {
	name: string;
	/** The board's name in the top bar, in place of the playground's. */
	title: string;
	/** A path on the app, e.g. /play?scenario=planning. */
	url: string;
	width?: number;
	height?: number;
	/** Run once the board has settled, before the screenshot. */
	prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
	{ name: "planning", title: "unpic 5.0 planning", url: "/play?scenario=planning" },
	{ name: "roadmap", title: "Release 5.0", url: "/play?scenario=roadmap" },
	{ name: "tracking", title: "Maintainer dashboard", url: "/play?scenario=tracking" },
	{ name: "widgets", title: "Maintainer dashboard", url: "/play?scenario=widgets" },
	{ name: "retro", title: "Sprint 14 retro", url: "/play?scenario=retro" },
	{ name: "vote", title: "Next quarter", url: "/play?scenario=vote" },
	{ name: "silent", title: "Sprint 14 retro", url: "/play?scenario=silent" },
	{ name: "comments", title: "Sprint 14 retro", url: "/play?scenario=comments" },
	{ name: "since", title: "Sprint 14 retro", url: "/play?scenario=since" },
	{
		name: "history",
		title: "Sprint 14 retro",
		url: "/play?scenario=history",
		prepare: async (page) => {
			await page.getByTitle(/^History \(/).click();
			await page.waitForTimeout(1200);
			// A few steps back, so the board shows the past and who changed it.
			for (let step = 0; step < 4; step++) {
				await page.keyboard.press("ArrowLeft");
				await page.waitForTimeout(250);
			}
			await page.waitForTimeout(1200);
		},
	},
	{ name: "inbox", title: "Triage", url: "/play?scenario=inbox" },
	{
		name: "rules",
		title: "Triage",
		url: "/play?scenario=rules",
		prepare: async (page) => {
			await page.getByTitle("Rules: automation that places cards").click();
			await page.waitForTimeout(600);
		},
	},
	{
		name: "changes",
		title: "unpic 5.0 planning",
		url: "/play?scenario=push",
		prepare: async (page) => {
			await page.getByRole("button", { name: /^Changes/ }).click();
			await page.waitForTimeout(600);
		},
	},
	{
		name: "push",
		title: "unpic 5.0 planning",
		url: "/play?scenario=push",
		prepare: async (page) => {
			await page.getByRole("button", { name: /^Changes/ }).click();
			await page.getByRole("button", { name: /^Review and push/ }).click();
			// The playground pushes to the fake forge; on an instance it's GitHub.
			await page.evaluate(() => {
				const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					node.textContent = (node.textContent ?? "").replace(/the test forge/gi, "GitHub");
				}
			});
			await page.waitForTimeout(800);
		},
	},
	// Staged changes on the board: the marks on each shape.
	{ name: "writes", title: "unpic 5.0 planning", url: "/play?scenario=push" },
	{ name: "decisions", title: "Architecture decisions", url: "/play?scenario=decisions" },
	{ name: "sections", title: "Roadmap", url: "/play?scenario=sections" },
	{ name: "lists", title: "Roadmap", url: "/play?scenario=lists" },
	{ name: "connectors", title: "Dependencies", url: "/play?scenario=connectors" },
];

/** Hide the playground's own controls: the screenshots show the board as people see it. */
const HIDE_PLAYGROUND = `
	[aria-label="Playground controls"] { display: none !important; }
	*, *::before, *::after { caret-color: transparent !important; }
`;

async function settle(page: Page): Promise<void> {
	await page.locator(".react-flow__renderer").waitFor();
	await page.waitForFunction(() =>
		[...document.querySelectorAll(".react-flow__node")].every(
			(node) => getComputedStyle(node).visibility !== "hidden",
		),
	);
	await page.waitForFunction(() => document.querySelectorAll(".card.loading").length === 0);
	// Let entrances and the initial fit finish.
	await page.waitForTimeout(1500);
}

const only = new Set(process.argv.slice(3));
const browser = await chromium.launch();
await mkdir(out, { recursive: true });
for (const shot of SHOTS) {
	if (only.size > 0 && !only.has(shot.name)) continue;
	for (const theme of ["light", "dark"] as const) {
		const context = await browser.newContext({
			viewport: { width: shot.width ?? 1440, height: shot.height ?? 900 },
			deviceScaleFactor: 2,
			colorScheme: theme,
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		await page.goto(new URL(shot.url, base).href);
		await page.addStyleTag({ content: HIDE_PLAYGROUND });
		await settle(page);
		await page.locator(".board-name").evaluate((element, title) => {
			element.textContent = title;
		}, shot.title);
		await shot.prepare?.(page);
		await page.mouse.move(-10, -10);
		const png = await page.screenshot({ animations: "disabled" });
		// WebP at a little over twice the docs' widest image, to keep the
		// repository light; Astro makes the sizes each page needs from these.
		await sharp(png)
			.resize({ width: 2400 })
			.webp({ quality: 80 })
			.toFile(path.join(out, `${shot.name}-${theme}.webp`));
		console.log(`${shot.name} (${theme})`);
		await context.close();
	}
}
await browser.close();
