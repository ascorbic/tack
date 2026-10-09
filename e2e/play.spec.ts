import { drag, expect, nodePosition, openScenario, test } from "./fixtures.ts";

// Smoke tests over the /play workbench: each scenario renders, and the board
// responds to forge events, people, tools and drags.

const SCENARIOS = {
	planning: { cards: 6, stickies: 4 },
	triage: { cards: 9, stickies: 0 },
	stress: { cards: 500, stickies: 0 },
	empty: { cards: 0, stickies: 0 },
};

test.describe("scenarios render", () => {
	for (const [scenario, expected] of Object.entries(SCENARIOS)) {
		test(scenario, async ({ page }) => {
			await openScenario(page, scenario);
			const total = expected.cards + expected.stickies;

			// The minimap draws every shape, even those culled from the canvas.
			await expect(page.locator(".react-flow__minimap-node")).toHaveCount(total);

			const cards = page.locator(".react-flow__node-card");
			if (expected.cards > 100) {
				// Off-screen shapes aren't rendered at all.
				await expect(cards.first()).toBeVisible();
				expect(await cards.count()).toBeLessThan(expected.cards);
			} else {
				await expect(cards).toHaveCount(expected.cards);
				await expect(page.locator(".react-flow__node-sticky")).toHaveCount(expected.stickies);
			}

			// Every rendered card loaded, with a state.
			await expect(page.locator(".card.loading")).toHaveCount(0);
			await expect(page.locator(".card.missing")).toHaveCount(0);
			await expect(page.locator(".card[data-state]")).toHaveCount(await cards.count());
		});
	}
});

test.describe("forge events", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "planning"));

	test("merging a PR updates its card", async ({ page }) => {
		const merged = page.locator(".react-flow__node-card .card[data-state=merged]");
		await expect(merged).toHaveCount(1);
		await page.getByRole("button", { name: "Merge a PR" }).click();
		await expect(merged).toHaveCount(2);
		await expect(merged.locator(".chip.state", { hasText: "Merged" })).toHaveCount(2);
		// The updated card pulses to show the change landed.
		await expect(page.locator(".card-pulse")).toHaveCount(1);
	});

	test("closing an issue updates its card", async ({ page }) => {
		const closed = page.locator(".card[data-state=closed]");
		await expect(closed).toHaveCount(1);
		await page.getByRole("button", { name: "Close an issue" }).click();
		await expect(closed).toHaveCount(2);
		await expect(closed.locator(".chip.state", { hasText: /^Closed$/ })).toHaveCount(1);
	});

	test("editing a title and labels updates the card", async ({ page }) => {
		await page.getByRole("button", { name: "Edit a title" }).click();
		await expect(page.locator(".card-title", { hasText: "(edited)" })).toHaveCount(1);
		await page.getByRole("button", { name: "Toggle a label" }).click();
		await expect(page.locator(".chip.label", { hasText: "needs review" })).toHaveCount(1);
	});
});

test("a person joins and their cursor appears", async ({ page }) => {
	await openScenario(page, "planning");
	const avatars = page.getByLabel("People here").locator(".avatar");
	await expect(avatars).toHaveCount(1);
	await expect(page.locator(".cursor")).toHaveCount(0);

	await page.getByRole("button", { name: "Someone joins" }).click();

	const cursor = page.locator(".cursor");
	await expect(cursor).toHaveCount(1);
	await expect(cursor.locator(".cursor-name")).not.toBeEmpty();
	await expect(avatars).toHaveCount(2);
	// They wander about.
	const start = await cursor.evaluate((el) => (el as HTMLElement).style.transform);
	await expect
		.poll(() => cursor.evaluate((el) => (el as HTMLElement).style.transform))
		.not.toBe(start);

	await page.getByRole("button", { name: "Someone leaves" }).click();
	await expect(cursor).toHaveCount(0);
	await expect(avatars).toHaveCount(1);
});

test("the sticky tool places a sticky to type into", async ({ page }) => {
	await openScenario(page, "empty");
	const stickies = page.locator(".react-flow__node-sticky");
	await expect(stickies).toHaveCount(0);

	await page.keyboard.press("s");
	await expect(page.getByRole("button", { name: "Sticky note" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.mouse.click(520, 360);

	await expect(stickies).toHaveCount(1);
	const text = page.getByRole("textbox", { name: "Sticky note" });
	await expect(text).toBeFocused();
	await page.keyboard.type("Ship it on Friday");
	await expect(text).toHaveValue("Ship it on Friday");

	await page.keyboard.press("Escape");
	await expect(text).toHaveCount(0);
	const sticky = stickies.locator(".sticky");
	await expect(sticky).toHaveAttribute("data-editing", "false");
	await expect(sticky.locator(".sticky-text")).toHaveText("Ship it on Friday");
	// Placing a sticky hands back to the select tool.
	await expect(page.getByRole("button", { name: "Select" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("dragging a card commits its position", async ({ page }) => {
	await openScenario(page, "planning");
	const node = page.locator(".react-flow__node-card", { hasText: "Drop Node 18 support" });
	const before = await nodePosition(node);
	const box = await node.boundingBox();
	if (!box) throw new Error("card has no box");

	// Pick it up by its header: the title is a link.
	await drag(page, { x: box.x + 40, y: box.y + 14 }, { x: 220, y: 130 }, async () => {
		await expect(node).toHaveClass(/\bdragging\b/);
	});

	// Regression: the node must not stay in its dragging state after the drop.
	await expect(node).not.toHaveClass(/\bdragging\b/);
	const after = await nodePosition(node);
	expect(Math.abs(after.x - (before.x + 220))).toBeLessThanOrEqual(2);
	expect(Math.abs(after.y - (before.y + 130))).toBeLessThanOrEqual(2);

	// Committed to the document, so it stays put rather than snapping back.
	await page.waitForTimeout(400);
	expect(await nodePosition(node)).toEqual(after);
});
