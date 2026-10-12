import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// A section selected on its own has one bar: its colour, how it shows
// what's in it, facilitation, and what it can become, above every shape
// (never under the widget over it), over its title or wherever there's
// room, with what doesn't fit in a "…" menu.

const TITLE = "Drop these on a list";
const bar = (page: Page) => page.getByRole("toolbar", { name: "Stage changes" });

/** Move the widgets board's section (and what's in it) to `y`, and size it. */
async function placeSection(page: Page, patch: { y: number; h?: number; w?: number }) {
	await page.evaluate(
		([title, patch]) => {
			const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			const shapes = doc.getMap("shapes") as import("yjs").Map<import("yjs").Map<unknown>>;
			for (const [id, shape] of shapes) {
				if (shape.get("title") !== title) continue;
				const dy = patch.y - Number(shape.get("y"));
				doc.transact(() => {
					for (const [, child] of shapes) {
						if (child.get("parent") === id) child.set("y", Number(child.get("y")) + dy);
					}
					for (const [key, value] of Object.entries(patch)) shape.set(key, value);
				});
			}
		},
		[TITLE, patch] as const,
	);
	await settleCanvas(page);
}

async function selectSection(page: Page) {
	await page.locator(".section-title", { hasText: TITLE }).click({ position: { x: 12, y: 8 } });
	await expect(bar(page)).toBeVisible();
	// It arrives with a short spring; wait for it to land.
	await page.waitForTimeout(400);
}

/** Whether what's on top at the middle of `locator` is inside `inside`. */
async function onTop(page: Page, locator: Locator, inside: string): Promise<boolean> {
	const rect = await locator.boundingBox();
	if (!rect) return false;
	return page.evaluate(({ x, y, inside }) => !!document.elementFromPoint(x, y)?.closest(inside), {
		x: rect.x + rect.width / 2,
		y: rect.y + rect.height / 2,
		inside,
	});
}

async function wholly(page: Page, locator: Locator) {
	const rect = (await locator.boundingBox())!;
	const view = page.viewportSize()!;
	expect(rect.x).toBeGreaterThanOrEqual(0);
	expect(rect.y).toBeGreaterThanOrEqual(56);
	expect(rect.x + rect.width).toBeLessThanOrEqual(view.width);
	expect(rect.y + rect.height).toBeLessThanOrEqual(view.height);
}

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
	await openScenario(page, "widgets");
	await page.addStyleTag({ content: ".play-panel { display: none !important; }" });
});

test("a section just under a widget has one bar, over the widget, with its tools and actions", async ({
	page,
}) => {
	// 30 under "Good first issues": its title and tools used to hide behind it.
	await placeSection(page, { y: 430 });
	await selectSection(page);

	// One bar for it, and nothing of it left in its header.
	await expect(page.locator(".react-flow [role=toolbar]")).toHaveCount(1);
	await expect(page.locator(".section-header button")).toHaveCount(0);
	const toolbar = bar(page);
	await expect(toolbar).toHaveAttribute("data-section", "true");
	const colour = toolbar.getByRole("button", { name: /^Colour/ });
	for (const control of [
		colour,
		toolbar.getByRole("radio", { name: "Mini cards" }),
		toolbar.getByRole("button", { name: "Silent mode" }),
		toolbar.getByRole("button", { name: "Vote", exact: true }),
		toolbar.getByRole("button", { name: "Make inbox" }),
		toolbar.getByRole("button", { name: "Make a parent issue from this section" }),
		toolbar.getByRole("button", { name: "Fit to contents" }),
	]) {
		await expect(control).toBeVisible();
		expect(await onTop(page, control, ".selection-actions")).toBe(true);
	}
	expect(await onTop(page, toolbar, ".selection-actions")).toBe(true);
	await wholly(page, toolbar);
	// Over its title, not over what's in it.
	const title = (await page.locator(".section-title", { hasText: TITLE }).boundingBox())!;
	const at = (await toolbar.boundingBox())!;
	expect(at.y + at.height).toBeLessThanOrEqual(title.y);
	await expect(page.locator(".selection-bar")).toHaveAttribute("data-side", "above");

	// The colours, over the widget too, and one of them picked.
	await colour.click();
	const blue = page.getByRole("menuitemradio", { name: "Blue" });
	await expect(blue).toBeVisible();
	expect(await onTop(page, blue, ".bar-menu")).toBe(true);
	await blue.click();
	await expect(page.getByRole("menu", { name: "Section colour" })).toHaveCount(0);
	await expect(page.locator(".section", { hasText: TITLE })).toHaveAttribute("data-color", "blue");
	await expect(colour).toHaveAccessibleName("Colour: Blue");
});

test("with no room under it, the bar is still over its title, wholly on screen", async ({
	page,
}) => {
	await placeSection(page, { y: 600 });
	await selectSection(page);
	const toolbar = bar(page);
	await wholly(page, toolbar);
	expect(await onTop(page, toolbar, ".selection-actions")).toBe(true);
	await expect(page.locator(".selection-bar")).toHaveAttribute("data-side", "above");
	// A panel opens from it, on screen.
	await toolbar.getByRole("button", { name: "Make a parent issue from this section" }).click();
	const panel = page.getByRole("dialog", { name: "Make a parent issue from this section" });
	await expect(panel).toBeVisible();
	await wholly(page, panel);
});

test("a section taller than the view keeps its bar pinned on screen as the board pans", async ({
	page,
}) => {
	await placeSection(page, { y: 430, h: 1800 });
	await selectSection(page);
	// Its title goes off the top of the view.
	await page.mouse.move(640, 700);
	await page.mouse.wheel(0, 600);
	await page.mouse.wheel(0, 600);
	await settleCanvas(page);
	const title = (await page.locator(".section-title", { hasText: TITLE }).boundingBox())!;
	expect(title.y + title.height).toBeLessThan(56);
	await expect(page.locator(".selection-bar")).toHaveAttribute("data-side", "top");
	const toolbar = bar(page);
	await wholly(page, toolbar);
	expect(
		await onTop(page, toolbar.getByRole("button", { name: /^Colour/ }), ".selection-actions"),
	).toBe(true);
});

test("a small section's bar has every word, as wide as the window lets it be", async ({ page }) => {
	await placeSection(page, { y: 540, w: 300 });
	await selectSection(page);
	const toolbar = bar(page);
	// Wider than the section: the screen decides, not the selection.
	for (const [name, word] of [
		["Silent mode", "Silent"],
		["Make inbox", "Inbox"],
		["Make a parent issue from this section", "Make parent issue"],
		["Fit to contents", "Fit"],
		["Summarise with AI", "Summarise"],
		["Draft a decision with AI", "Decide"],
	] as const) {
		await expect(toolbar.getByRole("button", { name })).toHaveText(word);
	}
	await expect(toolbar.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
	const section = (await page.locator(".section", { hasText: TITLE }).boundingBox())!;
	expect((await toolbar.boundingBox())!.width).toBeGreaterThan(section.width);
	await wholly(page, toolbar);
});

test("what doesn't fit across a narrow window goes in its … menu, with its word, and works from there", async ({
	page,
}) => {
	await page.setViewportSize({ width: 760, height: 800 });
	await placeSection(page, { y: 540, w: 300 });
	await selectSection(page);
	const toolbar = bar(page);
	// The main action and the settings stay; what matters least goes first.
	await expect(toolbar.getByRole("button", { name: /^Colour/ })).toBeVisible();
	await expect(
		toolbar.getByRole("button", { name: "Make a parent issue from this section" }),
	).toBeVisible();
	await expect(toolbar.getByRole("button", { name: "Silent mode" })).toHaveText("Silent");
	await expect(toolbar.getByRole("button", { name: "Draft a decision with AI" })).toHaveCount(0);
	// One row, on screen.
	expect((await toolbar.boundingBox())!.height).toBeLessThan(56);
	await wholly(page, toolbar);

	await toolbar.getByRole("button", { name: "More", exact: true }).click();
	const menu = page.getByRole("menu", { name: "More for this section" });
	await expect(menu.getByRole("menuitem", { name: "Draft a decision with AI" })).toHaveText(
		"Decide",
	);
	await wholly(page, menu);
	// From the keyboard: Escape back to "…", down into it again, and Decide opens its panel.
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(toolbar.getByRole("button", { name: "More", exact: true })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: "Draft a decision with AI" }).click();
	await expect(menu).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Draft a decision with AI" })).toBeVisible();
});

test("the keyboard moves along the whole bar, and Escape goes back to the section", async ({
	page,
}) => {
	await placeSection(page, { y: 540 });
	await selectSection(page);
	await page.keyboard.press("F6");
	const toolbar = bar(page);
	await expect(toolbar.getByRole("button", { name: /^Colour/ })).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(toolbar.getByRole("radio", { name: "Cards", exact: true })).toBeFocused();
	await page.keyboard.press("End");
	await expect(toolbar.locator("[data-bar-item]").last()).toBeFocused();
	// One tab stop in it.
	await expect(toolbar.locator("[data-bar-item][tabindex='0']")).toHaveCount(1);
	await page.keyboard.press("Home");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menu", { name: "Section colour" })).toBeVisible();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await expect(page.locator(".section", { hasText: TITLE })).not.toHaveAttribute(
		"data-color",
		"yellow",
	);
	await expect(toolbar.getByRole("button", { name: /^Colour/ })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.locator(".react-flow__node-section.selected")).toBeFocused();
});
