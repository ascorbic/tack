import type { Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// History (#47) on /play?scenario=history: three days of a retro, recorded
// by the same HistoryLog the board's Durable Object runs. Opening it,
// scrubbing and playing, filtering to a section, and bringing back what was
// removed, as an edit you can undo.

async function openHistory(page: Page) {
	await openScenario(page, "history");
	await page.getByRole("button", { name: "History", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "History" });
	await expect(panel.locator(".history-entry-row").first()).toBeVisible();
	return panel;
}

const live = (page: Page, id: string) =>
	page.evaluate(
		(shape) =>
			(
				window as unknown as {
					tackPlayground: { doc: { getMap(n: string): Map<string, unknown> } };
				}
			).tackPlayground.doc
				.getMap("shapes")
				.has(shape),
		id,
	);

const stickyTexts = (page: Page) =>
	page.locator(".react-flow__node-sticky").evaluateAll((nodes) => nodes.map((n) => n.textContent));

test("opens on the live board, and scrubs back through who changed what", async ({ page }) => {
	const panel = await openHistory(page);
	// The board as the retro left it: 3 sections, 9 stickies and 2 cards.
	await expect(page.locator(".react-flow__minimap-node")).toHaveCount(14);
	const dock = page.getByRole("region", { name: "History scrubber" });
	await expect(dock).toContainText("Now");
	await expect(page.locator(".canvas")).toHaveAttribute("data-history", "now");
	await expect(panel).toContainText("Kai Andersen");
	await expect(panel).toContainText("Cards show their GitHub details as they are now");

	// Kai's sorting, two days ago: the flaky CI sticky is gone, ghosted where it was.
	await panel.locator(".history-entry", { hasText: "removed a sticky" }).click();
	await expect(page.locator(".canvas")).toHaveAttribute("data-history", "past");
	await expect(dock).toContainText("2 days ago");
	await expect(page.locator(".replay-mark[data-op=remove]")).toHaveCount(1);
	await expect(page.locator(".replay-mark-flag").first()).toContainText("Kai Andersen");

	// A step back, before Kai removed it: there it is.
	await page.keyboard.press("ArrowLeft");
	await expect.poll(() => stickyTexts(page).then((t) => t.join())).toContain("Flaky CI on Windows");

	// The track is a slider: Home is where history starts, End is now.
	const track = page.getByRole("slider", { name: "Point in history" });
	await track.focus();
	await page.keyboard.press("Home");
	await expect(track).toHaveAttribute("aria-valuenow", "0");
	await page.keyboard.press("End");
	await expect(dock).toContainText("The live board");

	// Nothing can be edited meanwhile: there are no tools.
	await expect(page.getByRole("toolbar", { name: "Tools" })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dock).toHaveCount(0);
	await expect(page.locator(".canvas")).not.toHaveAttribute("data-history");
});

test("plays, pauses and changes speed", async ({ page }) => {
	await openHistory(page);
	const dock = page.getByRole("region", { name: "History scrubber" });
	await dock.getByRole("button", { name: "Speed: 1×" }).click();
	await expect(dock.getByRole("button", { name: "Speed: 2×" })).toBeVisible();
	await dock.getByRole("button", { name: "Play" }).click();
	await expect(dock).toHaveAttribute("data-playing", "true");
	const track = page.getByRole("slider", { name: "Point in history" });
	const first = Number(await track.getAttribute("aria-valuenow"));
	await expect
		.poll(async () => Number(await track.getAttribute("aria-valuenow")))
		.toBeGreaterThan(first);
	await page.keyboard.press(" ");
	await expect(dock).not.toHaveAttribute("data-playing");
});

test("filters to one section's history", async ({ page }) => {
	const panel = await openHistory(page);
	const all = await panel.locator(".history-entry-row").count();
	await panel.getByText("A section", { exact: true }).click();
	await panel.getByRole("combobox").selectOption({ label: "What hurts" });
	await expect.poll(() => panel.locator(".history-entry-row").count()).toBeLessThan(all);
	await expect(panel).toContainText("Tom Okafor");
	await expect(panel).not.toContainText("added 2 cards");
});

test("brings back what a step removed, as an edit you can undo", async ({ page }) => {
	const panel = await openHistory(page);
	expect(await live(page, "parking")).toBe(false);
	// Yesterday Priya cleared the parking lot: a section and the two stickies in it.
	await panel.getByRole("button", { name: "Bring back 3" }).click();
	await expect(page.locator(".toast[data-leaving=false]")).toContainText("Brought back");
	await expect(page.getByRole("region", { name: "History scrubber" })).toHaveCount(0);
	await expect.poll(() => stickyTexts(page).then((t) => t.join())).toContain("Monorepo?");
	await expect(page.locator(".react-flow__node-section", { hasText: "Parking lot" })).toHaveCount(
		1,
	);
	await page.keyboard.press("ControlOrMeta+z");
	await expect(page.locator(".react-flow__node-section", { hasText: "Parking lot" })).toHaveCount(
		0,
	);
});

test("restores a shape selected in the past", async ({ page }) => {
	const panel = await openHistory(page);
	await panel.locator(".history-entry", { hasText: "added 2 cards" }).click();
	await page.locator(".react-flow__controls-fitview").click();
	await settleCanvas(page);
	await page.locator(".react-flow__node-sticky", { hasText: "Flaky CI on Windows" }).click();
	await page
		.getByRole("toolbar", { name: "Restore" })
		.getByRole("button", { name: "Bring back" })
		.click();
	await expect(page.locator(".toast[data-leaving=false]")).toContainText("Brought back a sticky");
	await expect(
		page.locator(".react-flow__node-sticky.selected", { hasText: "Flaky CI on Windows" }),
	).toHaveCount(1);
});

test("shows history to viewers, without bringing anything back", async ({ page }) => {
	await openScenario(page, "history");
	await page.getByLabel("View only").check();
	await page.getByRole("button", { name: "History", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "History" });
	await expect(panel.locator(".history-entry-row").first()).toBeVisible();
	await expect(panel.getByRole("button", { name: /^Bring back/ })).toHaveCount(0);
});

test("on a real board: records who did what, and brings back a deleted sticky", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.route("https://github.com/**", (route) => route.abort());
	const login = `e2e-history-${Date.now().toString(36)}`;
	await page.goto(`/auth/dev?login=${login}&name=History%20Tester&return_to=/`);
	await page.getByRole("button", { name: "Create your first board" }).click();
	// It opens the template picker: start blank.
	await page.getByRole("option", { name: /^Blank board/ }).click();
	await page.getByRole("button", { name: "Create board" }).click();
	await expect(page.getByRole("textbox", { name: "Board title" })).toBeFocused();
	await page.keyboard.type("History");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/history$/);
	await expect(page.locator(".react-flow__renderer")).toBeVisible();
	await page.evaluate(() => {
		const data = new DataTransfer();
		const shapes = [
			{ id: "a", props: { type: "sticky", x: 0, y: 0, text: "Keep me" } },
			{ id: "b", props: { type: "sticky", x: 300, y: 0, text: "Delete me" } },
		];
		data.setData("application/x-tack+json", JSON.stringify({ tack: 1, shapes }));
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
	});
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(2);
	await settleCanvas(page);
	// Reading history writes what's waiting, so the paste is a step of its own.
	const button = page.locator(".topbar .history-button");
	await button.click();
	const panel = page.getByRole("complementary", { name: "History" });
	await expect(panel).toContainText("History Tester added 2 stickies");
	await page.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);

	await page.locator(".react-flow__node-sticky", { hasText: "Delete me" }).click({
		position: { x: 20, y: 12 },
	});
	await page.keyboard.press("Backspace");
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(1);
	await button.click();
	const removal = panel.locator(".history-entry-row", { hasText: "removed a sticky" });
	await expect(removal).toBeVisible();
	await removal.getByRole("button", { name: "Bring back" }).click();
	await expect(page.locator(".toast[data-leaving=false]")).toContainText("Brought back a sticky");
	await expect(page.locator(".react-flow__node-sticky", { hasText: "Delete me" })).toHaveCount(1);
});

test("says so when history can't be loaded", async ({ page }) => {
	await openScenario(page, "history");
	await page.getByLabel("History server").getByText("Failing").click();
	await page.getByRole("button", { name: "History", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "History" });
	await expect(panel.getByRole("alert")).toContainText("Couldn’t load");
	await page.getByLabel("History server").getByText("Live").click();
	await panel.getByRole("button", { name: "Try again" }).click();
	await expect(panel.locator(".history-entry-row").first()).toBeVisible();
});
