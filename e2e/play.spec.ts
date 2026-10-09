import { drag, expect, nodePosition, openScenario, test } from "./fixtures.ts";

// Smoke tests over the /play workbench: each scenario renders, and the board
// responds to forge events, people, tools and drags.

const SCENARIOS: Record<
	string,
	{ cards: number; stickies: number; texts: number; decisions?: number }
> = {
	planning: { cards: 8, stickies: 4, texts: 0 },
	triage: { cards: 9, stickies: 0, texts: 0 },
	stress: { cards: 500, stickies: 0, texts: 0 },
	brainstorm: { cards: 0, stickies: 30, texts: 7 },
	arrange: { cards: 4, stickies: 6, texts: 0 },
	decisions: { cards: 4, stickies: 0, texts: 0, decisions: 4 },
	empty: { cards: 0, stickies: 0, texts: 0 },
};

test.describe("scenarios render", () => {
	for (const [scenario, expected] of Object.entries(SCENARIOS)) {
		test(scenario, async ({ page }) => {
			await openScenario(page, scenario);
			const decisions = expected.decisions ?? 0;
			const total = expected.cards + expected.stickies + expected.texts + decisions;
			await expect(page.locator(".react-flow__node-decision")).toHaveCount(decisions);

			// The minimap draws every shape, even those culled from the canvas.
			await expect(page.locator(".react-flow__minimap-node")).toHaveCount(total);

			const cards = page.locator(".react-flow__node-card");
			if (expected.cards > 100) {
				// Off-screen shapes aren't rendered at all.
				await expect(cards.first()).toBeVisible();
				expect(await cards.count()).toBeLessThan(expected.cards);
			} else if (expected.stickies > 20) {
				// A wall of stickies runs off the screen, so only some render.
				const stickies = page.locator(".react-flow__node-sticky");
				await expect(stickies.first()).toBeVisible();
				expect(await stickies.count()).toBeLessThanOrEqual(expected.stickies);
				await expect(page.locator(".react-flow__node-text").first()).toBeVisible();
			} else {
				await expect(cards).toHaveCount(expected.cards);
				await expect(page.locator(".react-flow__node-sticky")).toHaveCount(expected.stickies);
				await expect(page.locator(".react-flow__node-text")).toHaveCount(expected.texts);
			}

			// A new board shows the first-run guide, and only a new board.
			await expect(page.getByRole("heading", { name: "A blank board" })).toHaveCount(
				total === 0 ? 1 : 0,
			);

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

	test("installing the app upgrades not-live cards in place", async ({ page }) => {
		const lazy = page.locator(".react-flow__node-card .card[data-live=false]");
		await expect(lazy).toHaveCount(2);
		const marker = lazy.first().locator(".liveness[data-live=false]");
		await expect(marker).toHaveText(/Not live/);
		// The tooltip says why, and offers the fix.
		await marker.focus();
		await expect(marker.getByRole("tooltip")).toBeVisible();
		await expect(marker.getByRole("link", { name: /Install the app/ })).toHaveAttribute(
			"href",
			/^\/setup\/install\?state=%2Fplay/,
		);

		await page.getByRole("button", { name: "App installed" }).click();
		await expect(lazy).toHaveCount(0);
		await expect(page.locator(".liveness[data-live=true]")).toHaveCount(2);
		await expect(page.locator(".liveness[data-live=true]").first()).toHaveText("Live");
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
	// By title: the PR that closes this issue mentions it too.
	const node = page.locator(".react-flow__node-card", {
		has: page.locator(".card-title", { hasText: "Drop Node 18 support" }),
	});
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
	// Within snapping distance (6px) of the drop: it may have snapped to a
	// neighbour's edge (see canvas.spec.ts).
	expect(Math.abs(after.x - (before.x + 220))).toBeLessThanOrEqual(6);
	expect(Math.abs(after.y - (before.y + 130))).toBeLessThanOrEqual(6);

	// Committed to the document, so it stays put rather than snapping back.
	await page.waitForTimeout(400);
	expect(await nodePosition(node)).toEqual(after);
});

test("the text tool places text that sizes to fit", async ({ page }) => {
	await openScenario(page, "empty");
	await page.keyboard.press("t");
	await expect(page.getByRole("button", { name: "Text", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.mouse.click(420, 300);

	const field = page.getByRole("textbox", { name: "Text" });
	await expect(field).toBeFocused();
	const block = page.locator(".react-flow__node-text");
	await page.keyboard.type("Hi");
	const narrow = (await block.boundingBox())?.width ?? 0;
	await page.keyboard.type(" there, everyone");
	await expect.poll(async () => (await block.boundingBox())?.width ?? 0).toBeGreaterThan(narrow);

	// Bigger, from the toolbar above it, without leaving the text.
	await page.getByRole("radio", { name: "Extra large" }).click();
	await expect(block.locator(".text-block")).toHaveAttribute("data-size", "xl");
	await expect(field).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(block.locator(".text-block-text")).toHaveText("Hi there, everyone");
});

test("text left empty is removed", async ({ page }) => {
	await openScenario(page, "empty");
	await page.keyboard.press("t");
	await page.mouse.click(420, 300);
	await expect(page.getByRole("textbox", { name: "Text" })).toBeFocused();
	await page.keyboard.press("Escape");
	await page.mouse.click(700, 600);
	await expect(page.locator(".react-flow__node-text")).toHaveCount(0);
});

test("the toolbar recolours a sticky and switches its typeface", async ({ page }) => {
	await openScenario(page, "planning");
	const sticky = page.locator(".react-flow__node-sticky").first();
	await sticky.click();
	const toolbar = page.getByRole("toolbar", { name: "Shape options" });
	await expect(toolbar).toBeVisible();

	await toolbar.getByRole("radio", { name: "purple" }).click();
	await expect(sticky.locator(".sticky")).toHaveAttribute("data-color", "purple");
	await toolbar.getByRole("radio", { name: "Handwriting" }).click();
	await expect(sticky.locator(".sticky-text")).toHaveAttribute("data-font", "hand");
	await expect(toolbar.getByRole("radio", { name: "Handwriting" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
});

test("slash opens cursor chat, and not while typing", async ({ page }) => {
	await openScenario(page, "empty");
	await page.mouse.move(500, 300);
	await page.keyboard.press("/");
	const chat = page.getByRole("textbox", { name: /Cursor chat/ });
	await expect(chat).toBeFocused();
	await page.keyboard.type("over here");
	await page.keyboard.press("Enter");
	await expect(chat).toHaveCount(0);
	// The message stays a moment after sending.
	await expect(page.locator(".cursor-chat-text")).toHaveText("over here");

	// In a sticky, "/" is just a character.
	await page.keyboard.press("s");
	await page.mouse.click(300, 300);
	const note = page.getByRole("textbox", { name: "Sticky note" });
	await expect(note).toBeFocused();
	await page.keyboard.type("a/b");
	await expect(note).toHaveValue("a/b");
	await expect(page.getByRole("textbox", { name: /Cursor chat/ })).toHaveCount(0);
});

test("clicking an avatar follows them until you pan", async ({ page }) => {
	await openScenario(page, "planning");
	await page.getByRole("button", { name: "Someone joins" }).click();
	await page
		.getByLabel("People here")
		.getByRole("button", { name: /^Follow / })
		.click();
	const pill = page.locator(".follow-pill");
	await expect(pill).toContainText("Following");

	// Your own pan stops following.
	await page.mouse.move(400, 400);
	await page.mouse.wheel(0, 200);
	await expect(pill).toHaveCount(0);
});
