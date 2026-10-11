import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Getting around a board with the keyboard, and what screen readers hear
// (#61, src/client/navigation.ts): the skip link, reading order, the arrow
// keys, selecting and acting on the shape you're on, and shapes out of view.

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
	await page.route("https://github.com/**", (route) => route.abort());
	await openScenario(page, "retro");
});

/** The shape with keyboard focus. */
function focused(page: Page): Locator {
	return page.locator(".react-flow__node:focus");
}

async function intoBoard(page: Page) {
	await page.keyboard.press("Tab");
	const skip = page.getByRole("link", { name: "Skip to board" });
	await expect(skip).toBeFocused();
	await expect(skip).toBeInViewport();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("main", { name: "Board" })).toBeFocused();
}

test("the skip link leads to the board, summed up, and Tab reads it in order", async ({ page }) => {
	await intoBoard(page);
	await expect(page.getByRole("main", { name: "Board" })).toHaveAccessibleDescription(
		"3 sections, 6 sticky notes and 3 cards. Went well: 3 sticky notes. To improve: 3 sticky notes. Ideas: 3 cards.",
	);

	// Each section, then what's in it, in rows.
	const expected = [
		["section", "Went well, 3 sticky notes"],
		["sticky note", "The 5.0 beta landed on time, by Priya Shah, in Went well"],
		["sticky note", "Reviews were fast this month, by Kai Andersen, in Went well"],
		["sticky note", "Docs site redesign 🎉, by Tom Okafor, in Went well"],
		["section", "To improve, 3 sticky notes"],
	];
	for (const [role, name] of expected) {
		await page.keyboard.press("Tab");
		await expect(focused(page)).toHaveAccessibleName(name as string);
		await expect(focused(page)).toHaveAttribute("aria-roledescription", role as string);
	}
	// A ring shows where you are.
	const ring = await focused(page).evaluate(
		(el) => getComputedStyle(el, "::before").borderTopStyle,
	);
	expect(ring).toBe("solid");
	// Shift-Tab goes back.
	await page.keyboard.press("Shift+Tab");
	await expect(focused(page)).toHaveAccessibleName(
		"Docs site redesign 🎉, by Tom Okafor, in Went well",
	);
});

test("arrow keys go to the nearest shape; Enter selects, then moves and edits it", async ({
	page,
}) => {
	await intoBoard(page);
	// From the board itself, an arrow goes to its first shape.
	await page.keyboard.press("ArrowRight");
	await expect(focused(page)).toHaveAccessibleName("Went well, 3 sticky notes");
	await page.keyboard.press("ArrowRight");
	await expect(focused(page)).toHaveAccessibleName("To improve, 3 sticky notes");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("Tab");
	await expect(focused(page)).toHaveAccessibleName(/^The 5\.0 beta landed/);
	await page.keyboard.press("ArrowRight");
	await expect(focused(page)).toHaveAccessibleName(/^Reviews were fast/);
	await page.keyboard.press("ArrowDown");
	await expect(focused(page)).toHaveAccessibleName(/^Docs site redesign/);
	// Nothing's selected by moving around.
	await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

	// Enter selects it; the arrows then nudge it, said aloud once they settle.
	await page.keyboard.press("Enter");
	const sticky = page.locator(".react-flow__node.selected");
	await expect(sticky).toHaveCount(1);
	await expect(sticky).toBeFocused();
	const before = await sticky.boundingBox();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect(page.locator("[data-announcer] [role=status]")).toHaveText(
		"Moved 1 sticky note 2 right",
	);
	const after = await sticky.boundingBox();
	expect(Math.round((after?.x ?? 0) - (before?.x ?? 0))).toBe(2);

	// Escape deselects, and the keyboard stays where it was.
	await page.keyboard.press("Escape");
	await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
	await expect(focused(page)).toHaveAccessibleName(/^Docs site redesign/);

	// Enter, Enter: selected, then editing its words.
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await expect(page.locator(".react-flow__node.selected textarea")).toBeFocused();
	await page.keyboard.press("Escape");
});

test("Home and End reach shapes out of view, bringing them into it", async ({ page }) => {
	await intoBoard(page);
	await page.keyboard.press("End");
	const last = focused(page);
	await expect(last).toHaveAccessibleName(
		"unpic #477: Blurhash placeholders, open issue, in Ideas",
	);
	await settleCanvas(page);
	await expect(last).toBeInViewport({ ratio: 1 });
	await page.keyboard.press("Home");
	await expect(focused(page)).toHaveAccessibleName("Went well, 3 sticky notes");
});

test("Tab past the last shape leaves the board, and Tab back returns to it", async ({ page }) => {
	await intoBoard(page);
	await page.keyboard.press("End");
	await expect(focused(page)).toHaveAccessibleName(/^unpic #477/);
	await page.keyboard.press("Tab");
	await expect(focused(page)).toHaveCount(0);
	const outside = await page.evaluate(
		() =>
			!document.querySelector(".react-flow__viewport")?.contains(document.activeElement) &&
			document.activeElement !== document.body,
	);
	expect(outside).toBe(true);
	await page.keyboard.press("Shift+Tab");
	await expect(focused(page)).toHaveAccessibleName(/^unpic #477/);
});

test("O opens the item behind the card you're on", async ({ page }) => {
	await intoBoard(page);
	await page.keyboard.press("End");
	await expect(focused(page)).toHaveAccessibleName(/^unpic #477/);
	await page.evaluate(() => {
		window.open = (url) => {
			document.body.dataset.opened = String(url);
			return null;
		};
	});
	await page.keyboard.press("o");
	await expect(page.locator("body")).toHaveAttribute("data-opened", /\/477$/);
});
