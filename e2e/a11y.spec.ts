import AxeBuilder from "@axe-core/playwright";
import { type Page, devices } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// Accessibility (#61), checked by axe in both themes over the main pages,
// a real board, and every /play gallery and the boards they're tried on:
// any serious or critical violation fails. See docs/accessibility.md for
// what's covered, what's excluded and why, and what axe can't check.

test.use({ reducedMotion: "reduce" });

/**
 * Transient states the galleries show mid-way that aren't meant to be read:
 * a row's placeholder while it's dragged out, a highlight fading away once
 * it's been seen, and the shapes dimmed while another's path is traced.
 * Everything else is held to WCAG AA.
 */
const TRANSIENT = ["[data-lifted]", ".since-ring[data-fading]", ".depmap-node[data-dim]"];

const run = Date.now().toString(36);

// A phone (#67), in the project's Chromium rather than the device's own WebKit.
const { defaultBrowserType: _browser, ...iPhone } = devices["iPhone 13"];

async function expectAccessible(page: Page): Promise<void> {
	// Fonts change text metrics and so what axe measures.
	await page.evaluate(() => document.fonts.ready);
	let builder = new AxeBuilder({ page }).withTags([
		"wcag2a",
		"wcag2aa",
		"wcag21a",
		"wcag21aa",
		"best-practice",
	]);
	for (const selector of TRANSIENT) builder = builder.exclude(selector);
	const { violations } = await builder.analyze();
	const serious = violations.filter(
		(violation) => violation.impact === "serious" || violation.impact === "critical",
	);
	const report = serious.map((violation) => ({
		rule: violation.id,
		impact: violation.impact,
		help: violation.help,
		nodes: violation.nodes.slice(0, 5).map((node) => ({
			target: node.target.join(" "),
			why: node.failureSummary?.split("\n").slice(1).join(" ").trim(),
		})),
		more: Math.max(0, violation.nodes.length - 5),
	}));
	expect(report, "serious or critical accessibility violations").toEqual([]);
}

const GALLERIES = [
	"/play/cards",
	"/play/auth",
	"/play/boards",
	"/play/actions",
	"/play/ai",
	"/play/changes",
	"/play/inbox",
	"/play/widgets",
	"/play/facilitation",
	"/play/comments",
	"/play/history",
	"/play/lists",
	"/play/templates",
	"/play/mobile",
];

const SCENARIOS = [
	"planning",
	"ai",
	"retro",
	"decisions",
	"widgets",
	"roadmap",
	"tracking",
	"lists",
	"actions",
	"inbox",
	"comments",
	"history",
	"empty",
];

for (const scheme of ["light", "dark"] as const) {
	test.describe(`${scheme} theme`, () => {
		test.use({ colorScheme: scheme });

		test.beforeEach(async ({ page }) => {
			// Hermetic: GitHub avatars fail to load, and fall back to initials.
			await page.route("https://github.com/**", (route) => route.abort());
		});

		for (const path of GALLERIES) {
			test(`gallery ${path}`, async ({ page }) => {
				await page.goto(path);
				await expect(page.locator("main, .gallery").first()).toBeVisible();
				// Galleries fetch nothing that matters; let lazy states settle.
				await page.waitForTimeout(800);
				await expectAccessible(page);
			});
		}

		for (const scenario of SCENARIOS) {
			test(`playground ?scenario=${scenario}`, async ({ page }) => {
				await page.goto(`/play?scenario=${scenario}`);
				await expect(page.locator(".react-flow__renderer")).toBeVisible();
				await settleCanvas(page);
				await page.waitForTimeout(500);
				await expectAccessible(page);
			});
		}

		test.describe("on a phone", () => {
			test.use(iPhone);

			test("a board, and a card open in its sheet", async ({ page }) => {
				// Two passes of axe, over a whole board: more than the default 30 s under load.
				test.slow();
				await page.goto("/play?scenario=comments");
				await expect(page.locator(".react-flow__renderer")).toBeVisible({ timeout: 20_000 });
				await settleCanvas(page);
				await expectAccessible(page);
				await page.locator(".react-flow__node-card").filter({ hasText: "Drop Node 18" }).tap();
				await expect(page.getByRole("dialog", { name: "Card" })).toBeVisible();
				await page.waitForTimeout(500);
				await expectAccessible(page);
			});
		});

		test("home page and a board, signed in", async ({ page }) => {
			const login = `e2e-a11y-${scheme}-${run}`;
			await page.goto(`/auth/dev?login=${login}&return_to=/`);
			await expect(page.getByRole("heading", { name: "Your boards will live here" })).toBeVisible();
			await expectAccessible(page);

			const board = await page.evaluate(async () => {
				const response = await fetch("/api/boards", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ title: "Accessible retro", template: "tack:retro" }),
				});
				return (await response.json()) as { id: string; slug: string };
			});
			await page.goto("/");
			await expect(page.getByRole("link", { name: "Accessible retro" })).toBeVisible();
			await expectAccessible(page);

			await page.goto(`/b/${board.id}/${board.slug}`);
			await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible({ timeout: 15_000 });
			await settleCanvas(page);
			await expectAccessible(page);
		});

		test("home page and setup, signed out", async ({ page }) => {
			await page.goto("/");
			await expect(page.locator("main").first()).toBeVisible();
			await page.waitForTimeout(500);
			await expectAccessible(page);
			await page.goto("/setup");
			await expect(page.locator("main").first()).toBeVisible();
			await page.waitForTimeout(500);
			await expectAccessible(page);
		});
	});
}
