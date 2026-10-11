import { expect, openScenario, test } from "./fixtures.ts";

// AI (#64) on the playground's "AI" board, with the pretend model that
// answers in the browser: asking for a widget, previewed live and placed;
// summarising a section into a text block; drafting a decision linked to
// its cards; and each undone in one step. On a real board without Workers AI
// (the dev server), nothing about it is offered.

const run = Date.now().toString(36);

// Room for the Retro section and the panel that hangs below it.
test.use({ viewport: { width: 1440, height: 960 } });

test("ask for a widget in words, see it previewed, and place it", async ({ page }) => {
	await openScenario(page, "ai");
	const widgets = page.locator(".react-flow__node-widget");
	await expect(widgets).toHaveCount(0);
	await page.keyboard.press("w");
	const picker = page.getByRole("group", { name: "Widgets" });
	await picker.getByLabel("Ask for a widget: describe it").fill("Open bugs in acme/imagekit");
	await page.keyboard.press("Enter");

	const ask = page.getByRole("group", { name: "Ask for a widget" });
	await expect(ask.getByText("List widget")).toBeVisible();
	await expect(ask.locator(".ai-ask-config")).toContainText("repo:acme/imagekit is:open label:bug");
	// The preview is the widget itself, with the fake repository's open bugs.
	const preview = ask.getByRole("img", { name: "Preview" });
	await expect(preview.locator(".widget-row").first()).toBeVisible();
	expect(await preview.locator(".widget-row").count()).toBeGreaterThan(2);
	// Nothing's on the board until it's placed.
	await expect(widgets).toHaveCount(0);

	// Enter places it (focus went to Place on board).
	await page.keyboard.press("Enter");
	await expect(widgets).toHaveCount(1);
	await expect(widgets.first()).toContainText("Open bugs in acme/imagekit");
	await expect(ask).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+z");
	await expect(widgets).toHaveCount(0);
});

test("asking again after a failure, and going back to pick one", async ({ page }) => {
	await openScenario(page, "ai");
	await page.getByRole("radiogroup", { name: "AI answers" }).getByText("Unusable").click();
	await page.getByRole("button", { name: "Widget", exact: true }).click();
	const picker = page.getByRole("group", { name: "Widgets" });
	await picker.getByLabel("Ask for a widget: describe it").fill("Something clever");
	await page.keyboard.press("Enter");
	const ask = page.getByRole("group", { name: "Ask for a widget" });
	await expect(ask.getByText("The AI didn’t come up with anything usable")).toBeVisible();
	await page.getByRole("radiogroup", { name: "AI answers" }).getByText("Live").click();
	await ask.getByRole("button", { name: "Try again" }).click();
	await expect(ask.getByRole("button", { name: "Place on board" })).toBeVisible();
	await ask.getByLabel("Describe a widget").press("Escape");
	await expect(page.getByRole("group", { name: "Widgets" })).toBeVisible();
});

test("summarise a section into a text block beside it, leaving out a private card", async ({
	page,
}) => {
	await openScenario(page, "ai");
	const texts = page.locator(".react-flow__node-text");
	await expect(texts).toHaveCount(0);
	await page.locator(".section-title", { hasText: "Retro" }).click({ position: { x: 12, y: 8 } });
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await bar.getByRole("button", { name: "Summarise with AI" }).click();
	const panel = page.getByRole("dialog");
	const summary = panel.getByLabel("Summary");
	await expect(summary).toHaveValue(/Retro, summarised/);
	await expect(panel).toContainText("Left out 1 private card");
	// Never the private card's repository: it's a placeholder you can't read.
	await expect(summary).not.toHaveValue(/vault/);
	await summary.fill("Docs and CI hurt\n\n• Provider docs are hard to find");
	await panel.getByRole("button", { name: /Place summary/ }).click();

	await expect(texts).toHaveCount(1);
	await expect(texts.first()).toContainText("Docs and CI hurt");
	await expect(page.locator(".toast")).toContainText("Placed a summary of the “Retro” section");
	await page.locator(".toast").getByRole("button", { name: /Undo/ }).click();
	await expect(texts).toHaveCount(0);
});

test("draft a decision from a section, linked to its cards", async ({ page }) => {
	await openScenario(page, "ai");
	const decisions = page.locator(".react-flow__node-decision");
	await page.locator(".section-title", { hasText: "Retro" }).click({ position: { x: 12, y: 8 } });
	await page.keyboard.press("Alt+Shift+KeyD");
	const panel = page.getByRole("dialog");
	const title = panel.getByLabel("Decision", { exact: true });
	await expect(title).not.toHaveValue("");
	await title.fill("Fix the docs or CI first?");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(decisions).toHaveCount(1);
	await expect(decisions.first()).toContainText("Fix the docs or CI first?");
	await expect(page.locator(".toast")).toContainText("linked to 3 cards");
	await page.keyboard.press("ControlOrMeta+z");
	await expect(decisions).toHaveCount(0);
});

test("AI isn't offered where the instance doesn't have it", async ({ page }) => {
	await page.goto(
		`/auth/dev?login=e2e-ai-${run}&return_to=${encodeURIComponent(`/?board=e2e-ai-${run}`)}`,
	);
	await expect(page).toHaveURL(/\/b\/e2e-ai-/, { timeout: 15_000 });
	const me = await page.evaluate(() => fetch("/api/me").then((r) => r.json()));
	expect(me.ai).toMatchObject({ state: "unavailable" });
	await page.locator(".react-flow__renderer").click({ position: { x: 300, y: 300 } });
	await page.keyboard.press("w");
	const picker = page.getByRole("group", { name: "Widgets" });
	await expect(picker.getByRole("button", { name: /^List/ })).toBeVisible();
	await expect(picker.getByLabel("Ask for a widget: describe it")).toHaveCount(0);
});

test("the gallery shows every AI state", async ({ page }) => {
	await page.goto("/play/ai");
	await expect(page.getByRole("heading", { name: "AI", exact: true })).toBeVisible();
	for (const state of ["idle", "asking", "ready", "unusable", "rate_limited", "failed"]) {
		await expect(
			page.locator(`.ai-gallery-asks figure[data-state="${state}"]`).first(),
		).toBeVisible();
	}
	for (const state of ["loading", "ready", "empty", "rate_limited", "failed"]) {
		await expect(
			page.locator(`.ai-gallery-drafts figure[data-state="${state}"]`).first(),
		).toBeVisible();
	}
	// Proposals preview with the fake repository's results.
	await expect(page.locator(".ai-preview-frame .widget-row").first()).toBeVisible();
	await expect(page.getByText("Those stickies are face down: reveal them first.")).toBeVisible();
});
