import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The landing page's live embeds of the demo (tack.social/try/embed/), as
// the dev server serves them at /play/embed: each feature's loop plays to
// its end and starts again, the first press or key makes the board yours,
// reduced motion shows where the loop ends without playing it, and nothing
// ever asks the demo's AI or keeps anything in the browser.

test.use({ viewport: { width: 960, height: 600 } });

test.beforeEach(() => {
	// Whole loops, on a machine that may be busy.
	test.setTimeout(120_000);
});

/** Every request to the demo's AI, which an embed must never make. */
function askedTheAi(page: Page): string[] {
	const asked: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.includes("/api/ai")) asked.push(request.url());
	});
	return asked;
}

async function open(page: Page, feature: string) {
	await page.goto(`/play/embed?feature=${feature}`);
	await expect(page.locator(".react-flow__renderer")).toBeVisible();
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", /playing|paused/, {
		timeout: 20_000,
	});
}

/** Wait for `n` loops to have played to their end. */
async function loops(page: Page, n: number) {
	await expect(page.locator("html")).toHaveAttribute("data-embed-loops", String(n), {
		timeout: 60_000,
	});
}

test("stacks: a sticky stacked by hand names itself, then Auto-stack makes themes", async ({
	page,
}) => {
	const asked = askedTheAi(page);
	await open(page, "stacks");
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", "playing");
	await expect(page.locator(".cursor", { hasText: "Kai Andersen" })).toBeVisible();
	// No top bar, minimap or toolbar while it plays: the board, and the corner.
	await expect(page.locator(".topbar")).toBeHidden();
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeHidden();
	await expect(page.getByText("Live demo · click to try it")).toBeVisible();

	await expect(page.getByText("Unreliable CI").first()).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("dialog", { name: /^Auto-stack/ })).toBeVisible({
		timeout: 20_000,
	});
	await expect(page.getByText("Hard-to-find docs").first()).toBeVisible({ timeout: 20_000 });
	await loops(page, 1);
	// And again, from the start: the board as it was.
	await expect(page.getByText("Unreliable CI")).toHaveCount(0, { timeout: 10_000 });
	expect(asked).toEqual([]);
});

test("write back: stickies made issues, pushed, and landed as numbered cards", async ({ page }) => {
	const asked = askedTheAi(page);
	await open(page, "push");
	await expect(page.getByRole("button", { name: /^Push 3 changes/ })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("All 3 changes are on the demo forge")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator(".react-flow__node-card", { hasText: "#224" })).toBeVisible({
		timeout: 20_000,
	});
	await loops(page, 1);
	// Numbered the same every time round.
	await expect(page.locator(".react-flow__node-card", { hasText: "#224" })).toBeVisible({
		timeout: 60_000,
	});
	expect(asked).toEqual([]);
});

test("facilitation: the timer runs, dots land and stamps pop", async ({ page }) => {
	await open(page, "facilitation");
	await expect(page.locator(".timer").first()).toContainText(/\d:\d\d/, { timeout: 20_000 });
	await expect(page.locator(".stamp-emoji", { hasText: "🎉" }).first()).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator(".stamp-emoji", { hasText: "➕" }).first()).toBeVisible({
		timeout: 30_000,
	});
	await loops(page, 1);
});

test("widgets: a bug lands in the list, the milestone ticks up, the inbox takes one in", async ({
	page,
}) => {
	await open(page, "widgets");
	await expect(page.getByText("Srcset skips the 2x width on narrow layouts").first()).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("11 of 16 done").first()).toBeVisible({ timeout: 30_000 });
	await expect(
		page.locator(".react-flow__node-card", { hasText: "Support quality per breakpoint" }),
	).toBeVisible({ timeout: 30_000 });
	await loops(page, 1);
});

test("the first press stops the loop where it is, and the board's yours", async ({ page }) => {
	await open(page, "stacks");
	const kai = page.locator(".cursor", { hasText: "Kai Andersen" });
	await expect(kai).toBeVisible();
	await page.waitForTimeout(1200);
	await page.mouse.click(880, 560);
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", "yours");
	await expect(page.getByRole("status").filter({ hasText: "Your turn" })).toBeVisible();
	await expect(page.getByRole("link", { name: /Open the full demo/ })).toHaveAttribute(
		"href",
		"/try/?scenario=planning",
	);
	// The toolbar's there to play with now, and nobody moves on their own.
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
	await page.waitForTimeout(600);
	const at = await kai.boundingBox();
	await page.waitForTimeout(2500);
	const now = await kai.boundingBox();
	expect(Math.abs((now?.x ?? 0) - (at?.x ?? 0))).toBeLessThan(2);
	expect(Math.abs((now?.y ?? 0) - (at?.y ?? 0))).toBeLessThan(2);
	await expect(page.locator("html")).not.toHaveAttribute("data-embed-loops", /.+/);
	// It's a board: a sticky, made here.
	await page.keyboard.press("s");
	await page.mouse.click(700, 420);
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(9);
});

test("a key takes it over too, but tabbing in doesn't", async ({ page }) => {
	await open(page, "facilitation");
	await page.keyboard.press("Tab");
	await page.waitForTimeout(400);
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", "playing");
	await page.keyboard.press("Escape");
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", "yours");
});

test("reduced motion: nothing plays, and the board opens where its loop ends", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const asked = askedTheAi(page);
	await page.goto("/play/embed?feature=stacks");
	await loops(page, 1);
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", "paused");
	await expect(page.getByText("Hard-to-find docs").first()).toBeVisible();
	await expect(page.getByText("Thin release notes").first()).toBeVisible();
	// It stays there: no second loop.
	await page.waitForTimeout(3000);
	await expect(page.locator("html")).toHaveAttribute("data-embed-loops", "1");
	// And it's there to play with.
	await page.mouse.click(880, 560);
	await expect(page.locator(".embed")).toHaveAttribute("data-mode", "yours");
	expect(asked).toEqual([]);
});

test("keeps nothing in the browser", async ({ page, context }) => {
	// What this site keeps in the browser before the embed, read from another page.
	const other = await context.newPage();
	await other.goto("/play/cards");
	const kept = () =>
		other.evaluate(() =>
			Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
		);
	const before = await kept();
	await open(page, "push");
	await expect(page.getByText("All 3 changes are on the demo forge")).toBeVisible({
		timeout: 40_000,
	});
	await page.mouse.click(880, 560);
	await page.keyboard.press("s");
	await page.mouse.click(700, 420);
	await page.waitForTimeout(800);
	await page.close();
	expect(await kept()).toEqual(before);
});
