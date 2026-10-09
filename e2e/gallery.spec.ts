import { existsSync } from "node:fs";
import { expect, test } from "./fixtures.ts";

// Visual regression over the card gallery, which shows every card state.
// Baselines are per platform (`*-darwin.png`, `*-linux.png`): update them
// with `pnpm e2e:update`, and see AGENTS.md for refreshing the Linux ones CI
// compares against.

test.use({ reducedMotion: "reduce" });

const CARDS: [caption: string, state: string, chip: string][] = [
	["Issue, open", "open", "Open"],
	["Pull request, open", "open", "Open"],
	["Pull request, merged", "merged", "Merged"],
	["Pull request, draft", "draft", "Draft"],
	["Issue, closed as completed", "closed", "Closed"],
	["Issue, closed as not planned", "closed", "Not planned"],
	["Long title, many labels", "open", "Open"],
	["Minimal", "open", "Open"],
];

test.beforeEach(async ({ page }) => {
	await page.goto("/play/cards");
	await expect(page.getByRole("heading", { name: "Card gallery" })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
});

test("every card state renders", async ({ page }) => {
	const cards = page.locator("section", { hasText: /^Cards/ }).locator("figure");
	await expect(cards).toHaveCount(CARDS.length);
	for (const [i, [caption, state, chip]] of CARDS.entries()) {
		const figure = cards.nth(i);
		await expect(figure.locator("figcaption")).toHaveText(caption);
		await expect(figure.locator(".card")).toHaveAttribute("data-state", state);
		await expect(figure.locator(".chip.state")).toHaveText(chip);
		await expect(figure.locator(".card-title")).not.toBeEmpty();
	}

	await expect(page.locator(".card.compact")).toHaveCount(4);
	await expect(page.locator(".card[data-selected=true]")).toHaveCount(1);
	await expect(page.locator(".card.loading")).toHaveCount(1);
	await expect(page.locator(".card.missing")).toHaveCount(4);
	await expect(page.locator(".gallery .sticky")).toHaveCount(5);
});

test("simulated updates land on every card", async ({ page }) => {
	await page.getByRole("button", { name: "Simulate an update" }).click();
	// The first round of updates adds two comments to every card.
	const first = page
		.locator("section", { hasText: /^Cards/ })
		.locator("figure")
		.first();
	await expect(first.locator(".count").first()).toHaveText("16");
	await expect(page.locator(".gallery-grid .card-pulse")).toHaveCount(CARDS.length + 5);
});

test("the gallery looks right", async ({ page }) => {
	// Every web font is loaded, so text doesn't render in a fallback.
	for (const font of ["Geist Variable", "Geist Mono Variable", "Bricolage Grotesque Variable"]) {
		expect(await page.evaluate((f) => document.fonts.check(`16px "${f}"`), font), font).toBe(true);
	}

	// CI compares against Linux baselines. Until one has been generated for a
	// platform (see AGENTS.md), say so rather than fail on its absence.
	const baseline = test.info().snapshotPath("cards.png", { kind: "screenshot" });
	if (!existsSync(baseline) && test.info().config.updateSnapshots === "none") {
		test.info().annotations.push({ type: "warning", description: `No baseline at ${baseline}` });
		return;
	}
	await expect(page).toHaveScreenshot("cards.png", { fullPage: true });
});
