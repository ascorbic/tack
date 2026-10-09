import type { Locator, Page } from "@playwright/test";
import { drag, expect, nodePosition, openScenario, test } from "./fixtures.ts";

// Canvas interaction on the /play "arrange" scenario: selection, undo and
// redo, the clipboard, snapping and the shortcut sheet.

const sticky = (page: Page, text: string): Locator =>
	page.locator(".react-flow__node-sticky", { hasText: text });
const selected = (page: Page) => page.locator(".react-flow__node.selected");
const shapes = (page: Page) => page.locator(".react-flow__node");

async function centre(node: Locator): Promise<{ x: number; y: number }> {
	const box = await node.boundingBox();
	if (!box) throw new Error("node has no box");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drag a selection marquee. It must start on empty canvas: if a toolbar (or
 * anything else) is under the start point, the drag would hit that instead,
 * so fail clearly rather than flake.
 */
async function marquee(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	const onCanvas = await page.evaluate(
		({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".react-flow__pane")),
		from,
	);
	expect(onCanvas, `marquee starts on empty canvas at ${from.x},${from.y}`).toBe(true);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
}

test.beforeEach(async ({ page }) => openScenario(page, "arrange"));

test("shift-click and shift-marquee add to the selection", async ({ page }) => {
	const ship = await centre(sticky(page, "Ship the Astro"));
	await page.mouse.click(ship.x, ship.y);
	await page.keyboard.down("Shift");
	const docs = await centre(sticky(page, "Docs before features"));
	await page.mouse.click(docs.x, docs.y);
	await page.keyboard.up("Shift");
	await expect(selected(page)).toHaveCount(2);

	// Clicking one shape in the selection narrows to it, without editing it.
	await page.mouse.click(docs.x, docs.y);
	await expect(selected(page)).toHaveCount(1);
	await expect(page.getByRole("textbox")).toHaveCount(0);

	// A plain marquee replaces the selection; with Shift it adds.
	await page.keyboard.press("Escape");
	// Let the deselect land before starting a marquee that builds on it.
	await expect(selected(page)).toHaveCount(0);
	await marquee(page, { x: 20, y: 300 }, { x: 120, y: 790 });
	await expect(selected(page)).toHaveCount(2);
	// The arrange toolbar springs in above the new selection. Wait for it to
	// settle so it can't be under the next marquee's start point mid-animation.
	const arrange = page.getByRole("toolbar", { name: "Arrange selection" });
	await expect(arrange).toBeVisible();
	await arrange.evaluate((el) =>
		Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
	);
	await page.keyboard.down("Shift");
	// Start below the arrange toolbar, which sits over (20, 300).
	await marquee(page, { x: 20, y: 320 }, { x: 560, y: 420 });
	await page.keyboard.up("Shift");
	await expect(selected(page)).toHaveCount(4);
	await expect(page.getByRole("toolbar", { name: "Arrange selection" })).toBeVisible();
});

test("copy, paste, undo and redo", async ({ page }) => {
	const count = await shapes(page).count();
	const ship = await centre(sticky(page, "Ship the Astro"));
	await page.mouse.click(ship.x, ship.y);
	await page.keyboard.press("ControlOrMeta+c");
	await page.keyboard.press("ControlOrMeta+v");
	await expect(shapes(page)).toHaveCount(count + 1);
	await expect(sticky(page, "Ship the Astro")).toHaveCount(2);
	// The copy is selected, on top of and offset from the original.
	await expect(selected(page)).toHaveCount(1);

	await page.keyboard.press("ControlOrMeta+d");
	await expect(shapes(page)).toHaveCount(count + 2);

	await page.keyboard.press("ControlOrMeta+z");
	await page.keyboard.press("ControlOrMeta+z");
	await expect(shapes(page)).toHaveCount(count);
	await page.keyboard.press("ControlOrMeta+Shift+z");
	await expect(shapes(page)).toHaveCount(count + 1);
});

test("deleting stickies with words offers an undo", async ({ page }) => {
	const count = await shapes(page).count();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(selected(page)).toHaveCount(count);
	await page.keyboard.press("Backspace");
	await expect(shapes(page)).toHaveCount(0);
	const toast = page.getByRole("status").locator(".toast");
	await expect(toast).toContainText(`Deleted ${count} shapes`);
	await toast.getByRole("button", { name: /Undo/ }).click();
	await expect(shapes(page)).toHaveCount(count);
	await expect(selected(page)).toHaveCount(count);
});

test("nudging moves by 1px, or 10px with Shift, as one undo step", async ({ page }) => {
	const node = sticky(page, "Cut scope");
	const before = await nodePosition(node);
	const at = await centre(node);
	await page.mouse.click(at.x, at.y);
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Shift+ArrowDown");
	await expect.poll(() => nodePosition(node)).toEqual({ x: before.x + 1, y: before.y + 10 });
	await page.waitForTimeout(600);
	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(() => nodePosition(node)).toEqual(before);
});

test("dragging snaps to a neighbour's edge, with a guide", async ({ page }) => {
	// "Benchmark" sits 7px right of "Ship the Astro"'s left edge.
	const node = sticky(page, "Benchmark");
	const target = await nodePosition(sticky(page, "Ship the Astro"));
	const from = await centre(node);
	await drag(page, from, { x: -5, y: 40 }, async () => {
		await expect(page.locator(".guide[data-axis=x]").first()).toBeVisible();
	});
	expect((await nodePosition(node)).x).toBe(target.x);
	// Guides fade away after the drop.
	await expect(page.locator(".guide")).toHaveCount(0);
});

test("undo leaves someone else's work alone", async ({ page }) => {
	// Paste text to make a sticky, then have someone type into it.
	await page.mouse.move(700, 450);
	await page.evaluate(() => {
		const data = new DataTransfer();
		data.setData("text/plain", "Mine:");
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	});
	await expect(sticky(page, "Mine:")).toHaveCount(1);
	await page.getByRole("button", { name: "Edit my last shape" }).click();
	await expect(sticky(page, "and I added this")).toHaveCount(1, { timeout: 10_000 });

	await page.keyboard.press("ControlOrMeta+z");
	await page.waitForTimeout(300);
	await expect(sticky(page, "Mine: and I added this")).toHaveCount(1);
});

test("? opens a searchable shortcut sheet", async ({ page }) => {
	await page.keyboard.press("?");
	const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByText("Cursor chat")).toBeVisible();
	await page.keyboard.type("zoom");
	await expect(sheet.locator(".sheet-row")).toHaveCount(5);
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
});
