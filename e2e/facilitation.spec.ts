import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Facilitation (#50), silent mode (#49) and dot voting (#48) on the
// playground, where a pretend board server (play/facilitation.ts) keeps the
// clock, the timer, spotlight and silent mode's hidden text.

const play = (page: Page, name: string) =>
	page.getByLabel("Playground controls").getByRole("button", { name, exact: true });

/** The playground's document, as JSON, as everyone connected would have it. */
function docJson(page: Page): Promise<string> {
	return page.evaluate(() =>
		JSON.stringify(
			(
				window as unknown as { tackPlayground: { doc: import("yjs").Doc } }
			).tackPlayground.doc.toJSON(),
		),
	);
}

test.describe("facilitating a retro", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "retro"));

	test("a shared timer counts down, pauses, gains time and rings at zero", async ({ page }) => {
		await page.getByRole("button", { name: "Facilitate" }).click();
		const menu = page.getByRole("dialog", { name: "Facilitate" });
		await menu.getByRole("textbox", { name: "What it’s for (optional)" }).fill("Warm-up");
		await menu.getByRole("button", { name: "1 minutes", exact: true }).click();
		const timer = page.getByRole("timer");
		await expect(timer).toHaveAttribute("data-state", "running");
		await expect(timer).toContainText(/0:5\d|1:00/);
		await expect(timer).toContainText("Warm-up");

		await timer.hover();
		await timer.getByRole("button", { name: "Pause" }).click();
		await expect(timer).toHaveAttribute("data-state", "paused");
		await expect(timer).toContainText("Paused");
		await timer.getByRole("button", { name: "Resume" }).click();
		await timer.getByRole("button", { name: "Add a minute" }).click();
		await expect(timer).toContainText(/1:5\d|2:00/);

		// Time passes on the server's clock: everyone reaches zero together.
		await play(page, "+1 minute").click();
		await play(page, "+1 minute").click();
		await expect(timer).toHaveAttribute("data-state", "done");
		await expect(timer).toContainText("Time’s up");
		// After a while it settles into a small chip, out of the way.
		await play(page, "+1 minute").click();
		await expect(timer).toHaveAttribute("data-state", "settled");
		await timer.hover();
		await timer.getByRole("button", { name: "Stop the timer" }).click();
		await expect(page.getByRole("timer")).toHaveCount(0);
	});

	test("someone else's timer shows for you too", async ({ page }) => {
		await play(page, "10s timer").click();
		await expect(page.getByRole("timer")).toBeVisible();
		await expect(page.getByRole("timer")).toHaveAttribute("data-state", /running|final/);
	});

	test("stamps go on shapes, count, and come off again", async ({ page }) => {
		const note = page.locator(".react-flow__node", { hasText: "Reviews were fast" });
		await page.keyboard.press("m");
		await expect(page.getByRole("radiogroup", { name: "Stamp" })).toBeVisible();
		await page.getByRole("radio", { name: "Stamp ❤️" }).click();
		// The tool is a stamp in the dock's own line, with the one it makes as a badge.
		const tool = page
			.getByRole("toolbar", { name: "Tools" })
			.getByRole("button", { name: "Stamp" });
		await expect(tool.locator("svg")).toBeVisible();
		await expect(tool.locator(".tool-stamp-emoji")).toHaveText("❤️");
		await note.click();
		const stamp = page.getByRole("button", { name: /^❤️ 1: .*\(including you\)/ });
		await expect(stamp).toBeVisible();
		await expect(stamp).toHaveAttribute("aria-pressed", "true");
		// Inside the sticky's bottom-right corner, not spilling onto the next shape.
		const [mark, shape] = [(await stamp.boundingBox())!, (await note.boundingBox())!];
		expect(mark.y + mark.height).toBeLessThanOrEqual(shape.y + shape.height);
		expect(mark.x + mark.width).toBeLessThanOrEqual(shape.x + shape.width);
		expect(mark.x + mark.width).toBeGreaterThan(shape.x + shape.width / 2);
		await note.click();
		await expect(stamp).toHaveCount(0);
		// Seeded stamps from other people count up.
		await expect(
			page.getByRole("button", { name: /^🎉 2: Priya Shah, Kai Andersen/ }),
		).toBeVisible();
	});

	test("the keyboard reaches all of it", async ({ page }) => {
		// ⇧T opens the menu at the timer, ready to type what it's for.
		await page.keyboard.press("Shift+T");
		const menu = page.getByRole("dialog", { name: "Facilitate" });
		await expect(menu.getByRole("textbox", { name: "What it’s for (optional)" })).toBeFocused();
		// Escape gives focus back to the button.
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Facilitate" })).toBeFocused();
		// ⇧F opens it, with focus in it.
		await page.keyboard.press("Shift+F");
		await expect(menu).toBeVisible();
		await expect(menu.locator(":focus")).toHaveCount(1);
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		// ⇧S spotlights you, and stops.
		await page.locator(".react-flow__pane").click({ position: { x: 300, y: 600 } });
		await page.keyboard.press("Shift+S");
		await expect(page.locator(".spotlight-pill")).toBeVisible();
		await page.keyboard.press("Shift+S");
		await expect(page.locator(".spotlight-pill")).toHaveCount(0);
		// With the stamp tool on, numbers pick a stamp.
		await page.keyboard.press("m");
		await page.keyboard.press("3");
		await expect(
			page.getByRole("radiogroup", { name: "Stamp" }).getByRole("radio").nth(2),
		).toBeChecked();
	});

	test("emotes float up from your cursor, and people high-five", async ({ page }) => {
		await page.mouse.move(400, 500);
		await page.keyboard.press("e");
		const wheel = page.getByRole("menu", { name: "Emotes" });
		await expect(wheel.getByRole("menuitem")).toHaveCount(8);
		await page.keyboard.press("4");
		await expect(page.locator(".emote-float")).toHaveCount(1);
		await page.keyboard.press("Escape");
		await expect(wheel).toHaveCount(0);

		await play(page, "Two high-five").click();
		await expect(page.locator(".high-five-clap")).toBeVisible({ timeout: 5000 });
	});

	test("spotlight brings you along, you can break out and rejoin", async ({ page }) => {
		await play(page, "Someone spotlights").click();
		const pill = page.locator(".spotlight-pill");
		await expect(pill).toContainText("is spotlighting");
		await pill.getByRole("button", { name: "Break out" }).click();
		await expect(pill.getByRole("button", { name: "Rejoin" })).toBeVisible();
		await pill.getByRole("button", { name: "Rejoin" }).click();
		await expect(pill.getByRole("button", { name: "Break out" })).toBeVisible();
		await play(page, "Stop their spotlight").click();
		await expect(pill).toHaveCount(0);

		await page.getByRole("button", { name: "Facilitate" }).click();
		await page
			.getByRole("dialog", { name: "Facilitate" })
			.getByRole("button", { name: "Spotlight me" })
			.click();
		await expect(pill).toContainText("You’re spotlighting");
		await pill.getByRole("button", { name: "Stop" }).click();
		await expect(pill).toHaveCount(0);
	});
});

test.describe("silent mode", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "silent"));

	test("others' stickies lie face down, their text nowhere in the document, until the reveal", async ({
		page,
	}) => {
		await expect(page.getByRole("img", { name: /’s sticky, face down/ })).toHaveCount(6);
		await expect(page.locator(".sticky[data-hidden]")).toHaveCount(2);
		await expect(page.locator(".sticky[data-hidden]").first()).toContainText(
			/Docs search|cut a release/,
		);
		const before = await docJson(page);
		for (const hidden of ["Flaky tests", "Docs search finds the wrong page", "Types are slow"]) {
			expect(before).not.toContain(hidden);
		}
		await expect(
			page.getByRole("group", { name: /Silent mode, started by Priya Shah/ }),
		).toBeVisible();

		await page.getByRole("button", { name: "Reveal 8" }).click();
		await expect(page.getByRole("img", { name: /face down/ })).toHaveCount(0);
		await expect(page.locator(".sticky", { hasText: "Flaky tests" })).toBeVisible();
		const after = await docJson(page);
		expect(after).toContain("Flaky tests");
		expect(after).toContain("Docs search finds the wrong page");
		await expect(page.locator(".toast", { hasText: "revealed" })).toBeVisible();
	});

	test("what you write in a silent section stays yours", async ({ page }) => {
		// Someone puts the parking lot in silent mode (from its header: Silent mode).
		await play(page, "Make a section silent").click();
		await expect(page.getByRole("group", { name: /Silent mode, started by/ })).toHaveCount(2);

		const lot = (await page.locator(".section", { hasText: "Parking lot" }).boundingBox())!;
		await page.keyboard.press("s");
		// By its left edge: the playground's panel covers the rest.
		await page.mouse.click(lot.x + 60, lot.y + lot.height / 2);
		await page.keyboard.type("My secret parking idea");
		await page.keyboard.press("Escape");
		const mine = page.locator(".sticky[data-hidden]", { hasText: "My secret parking idea" });
		await expect(mine).toBeVisible();
		expect(await docJson(page)).not.toContain("My secret parking idea");

		// People write too: face down for you.
		await play(page, "People write silently").click();
		await expect(page.getByRole("img", { name: /face down/ }).nth(7)).toBeVisible({
			timeout: 10_000,
		});
	});
});

test.describe("dot voting", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "vote"));

	test("place dots up to your limit, see the results, and close the vote", async ({ page }) => {
		const bar = page.getByRole("region", { name: "Vote on “Next quarter”" });
		await expect(bar).toContainText(/closes in 2d [34]h/);
		await expect(bar.getByRole("img", { name: "3 of 3 dots left" })).toBeVisible();
		await bar.getByRole("button", { name: "Place dots" }).click();
		const card = page.locator(".react-flow__node", { hasText: "A Svelte 5 adapter" });
		for (let i = 0; i < 3; i++) await card.click();
		await expect(bar.getByRole("img", { name: "0 of 3 dots left" })).toBeVisible();
		await card.click();
		// Said in place of the tool's hint, not stacked over it in a toast.
		await expect(page.locator(".toolbar-dock").getByRole("status")).toHaveText(
			"No dots left: click one of yours to move it",
		);
		await expect(page.locator(".toast", { hasText: "No dots left" })).toHaveCount(0);
		await expect(page.locator(".toolbar-dock")).not.toContainText("Click shapes to put");
		// Take one back by clicking it.
		await page.getByRole("button", { name: "Take this dot back" }).first().click();
		await expect(bar.getByRole("img", { name: "1 of 3 dots left" })).toBeVisible();
		await bar.getByRole("button", { name: "Done" }).click();

		await bar.getByRole("button", { name: "Results" }).click();
		const results = page.getByRole("dialog", { name: "Vote results" });
		const rows = results.locator(".tally-row");
		// #512: two dots from Priya and one from Tom, and 13 👍 from others (Priya's counted once).
		await expect(rows.first()).toContainText("Responsive art direction");
		await expect(rows.first().getByLabel("16 votes")).toBeVisible();
		await expect(rows.first()).toContainText("👍 13");
		await results.getByRole("button", { name: "Close vote" }).click();
		await expect(results).toContainText("Closed");
		await expect(results.getByRole("button", { name: "Reopen…" })).toBeVisible();
	});

	test("a vote open for days closes when its time comes", async ({ page }) => {
		const bar = page.getByRole("region", { name: "Vote on “Next quarter”" });
		await play(page, "+1 day").click();
		await play(page, "+1 day").click();
		await expect(bar).toContainText(/closes in \d+h/);
		await play(page, "+1 day").click();
		await expect(bar).toContainText("Vote closed");
	});

	test("a vote starts from a section's header", async ({ page }) => {
		await page
			.locator(".section-title", { hasText: "Next quarter" })
			.click({ position: { x: 12, y: 8 } });
		await expect(page.getByRole("button", { name: "Silent mode" })).toBeVisible();
		// One open vote per section at a time: close the one that's running.
		await expect(page.getByRole("button", { name: "Vote", exact: true })).toHaveCount(0);
		await page
			.getByRole("region", { name: "Vote on “Next quarter”" })
			.getByRole("button", { name: "Close vote" })
			.click();
		await page
			.locator(".section-title", { hasText: "Next quarter" })
			.click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Vote", exact: true }).click();
		const form = page.getByRole("dialog", { name: "Dot vote on “Next quarter”" });
		await form.getByRole("button", { name: "More dots" }).click();
		await form.getByText("Tomorrow").click();
		await form.getByText("Hide results until it closes").click();
		await form.getByRole("button", { name: "Start voting" }).click();
		const bar = page.locator(".vote-bar[data-open=true]");
		await expect(bar).toContainText("results hidden");
		await expect(bar.getByRole("img", { name: "4 of 4 dots left" })).toBeVisible();
	});
});

test("on a board without sections, silent mode makes one in view", async ({ page }) => {
	await openScenario(page, "empty");
	await page.getByRole("button", { name: "Facilitate" }).click();
	await page
		.getByRole("dialog", { name: "Facilitate" })
		.getByRole("button", { name: "Start on a section…" })
		.click();
	const hint = page.getByRole("status").filter({ hasText: "No sections yet" });
	await hint.getByRole("button", { name: "Make one here" }).click();
	const section = page.locator(".react-flow__node-section", { hasText: "Silent writing" });
	await expect(section).toBeVisible();
	await expect(section.locator(".section-silent")).toBeVisible();
});
