import type { Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

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

	test("a short secret vote hides cursors until its time runs out", async ({ page }) => {
		await page.getByRole("button", { name: "Someone joins" }).click();
		const cursors = page.locator(".cursors-layer .cursor");
		await expect(cursors.first()).toBeVisible();
		await play(page, "Secret vote, 2 minutes").click();
		const note = page.locator(".vote-cursors-note");
		await expect(note).toHaveText("Cursors hidden while voting");
		await expect(cursors).toHaveCount(0);
		await play(page, "+1 minute").click();
		await expect(cursors).toHaveCount(0);
		// Its time runs out on the server's clock: they're back straight away.
		await play(page, "+1 minute").click();
		await expect(page.locator(".vote-bar[data-open=false]")).toBeVisible();
		await expect(note).toHaveCount(0);
		await expect(cursors.first()).toBeVisible();
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
		const stamp = page.getByRole("button", { name: "❤️ 1: You" });
		await expect(stamp).toBeVisible();
		await expect(stamp).toHaveAttribute("aria-pressed", "true");
		// Inside the sticky's bottom-right corner, not spilling onto the next shape,
		// once it's landed: it springs in, and overshoots on the way.
		await page.evaluate(() =>
			Promise.all(
				document
					.getAnimations()
					.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
					.map((animation) => animation.finished.catch(() => {})),
			),
		);
		const [mark, shape] = [(await stamp.boundingBox())!, (await note.boundingBox())!];
		expect(mark.y + mark.height).toBeLessThanOrEqual(shape.y + shape.height);
		expect(mark.x + mark.width).toBeLessThanOrEqual(shape.x + shape.width);
		expect(mark.x + mark.width).toBeGreaterThan(shape.x + shape.width / 2);
		await note.click();
		await expect(stamp).toHaveCount(0);
		// Seeded stamps from other people count up.
		const party = page.getByRole("button", { name: /^🎉 2: Priya Shah and Kai Andersen/ });
		await expect(party).toBeVisible();
		// Pointing at one names who stamped it.
		await party.hover();
		await expect(page.getByRole("tooltip")).toHaveText("🎉Priya Shah and Kai Andersen");
	});

	test("a selected sticky takes a stamp, and its stamps stay on top of it", async ({ page }) => {
		const note = page.locator(".react-flow__node", { hasText: "Reviews were fast" });
		const selected = page.locator(".react-flow__node.selected");
		await note.click();
		await expect(note).toHaveClass(/selected/);
		// Picking up the stamp puts the selection down, so a click is the stamp's.
		await page
			.getByRole("toolbar", { name: "Tools" })
			.getByRole("button", { name: "Stamp" })
			.click();
		await expect(selected).toHaveCount(0);
		await page.getByRole("radio", { name: "Stamp ❤️" }).click();
		await note.click();
		const stamp = page.getByRole("button", { name: "❤️ 1: You" });
		await expect(stamp).toBeVisible();
		// It stamped the sticky rather than opening it to type in.
		await expect(note.locator("textarea")).toHaveCount(0);
		await stamp.click();
		await expect(stamp).toHaveCount(0);

		// Several selected, by shortcut: each click stamps the one clicked.
		const docs = page.locator(".react-flow__node", { hasText: "Docs site redesign" });
		await page.keyboard.press("v");
		await note.click();
		await docs.click({ modifiers: ["Shift"] });
		await expect(selected).toHaveCount(2);
		await page.keyboard.press("m");
		await expect(selected).toHaveCount(0);
		await note.click();
		await docs.click();
		await expect(page.getByRole("button", { name: "❤️ 1: You" })).toHaveCount(2);

		// Selecting a stamped shape lifts it over the others: its stamps rise
		// with it, still there to add to.
		await page.keyboard.press("v");
		await page.locator(".react-flow__node", { hasText: "The 5.0 beta" }).click();
		await expect(selected).toHaveCount(1);
		await page.getByRole("button", { name: /^🎉 2: Priya Shah and Kai Andersen/ }).click();
		await expect(page.getByRole("button", { name: /^🎉 3: You, / })).toBeVisible();
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

	test("a raised hand fades as it's about to go down", async ({ page }) => {
		await page.mouse.move(400, 500);
		await page.keyboard.press("e");
		await page.keyboard.press("8");
		const hand = page.locator(".emote-my-hand .emote-hand-glyph");
		await expect(hand).toBeVisible();
		const opacity = () => hand.evaluate((el) => Number(getComputedStyle(el).opacity));
		// Once it's popped up, it's fully there, until its last two seconds.
		await expect.poll(opacity).toBe(1);
		await expect.poll(opacity, { timeout: 5_500 }).toBeLessThan(0.9);
		await expect(hand).toHaveCount(0, { timeout: 3_000 });
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
		const card = page.locator(".react-flow__node", { hasText: "An emdash image plugin" });
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

	test("a selected card takes dots, and they show over it", async ({ page }) => {
		const bar = page.getByRole("region", { name: "Vote on “Next quarter”" });
		const card = page.locator(".react-flow__node", { hasText: "An emdash image plugin" });
		await card.click();
		await expect(card).toHaveClass(/selected/);
		await bar.getByRole("button", { name: "Place dots" }).click();
		await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
		await card.click();
		await expect(bar.getByRole("img", { name: "2 of 3 dots left" })).toBeVisible();
		await bar.getByRole("button", { name: "Done" }).click();
		// Selected again, it doesn't cover its dots.
		await card.click();
		await expect(card).toHaveClass(/selected/);
		const dots = page.locator(".vote-dots-anchor[data-lifted]");
		await expect(dots).toHaveCount(1);
		// Dots don't take clicks outside voting, so let one for a moment to see
		// what's on top where it is.
		const covered = await dots.evaluate((anchor) => {
			const dot = anchor.querySelector<HTMLElement>(".vote-dot")!;
			const box = dot.getBoundingClientRect();
			dot.style.pointerEvents = "auto";
			const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
			dot.style.pointerEvents = "";
			return top !== dot;
		});
		expect(covered).toBe(false);
	});

	test("a closed vote keeps out of the way while another's open", async ({ page }) => {
		const closed = page.getByRole("region", { name: "Vote on “Release name”" });
		await expect(closed).toHaveAttribute("data-compact", "true");
		await expect(closed).not.toContainText("people voted");
		await closed.getByRole("button", { name: /Release name/ }).click();
		await expect(page.getByRole("dialog", { name: "Vote results" })).toContainText("Release name");
		await closed.getByRole("button", { name: "Put this vote away" }).click();
		await expect(closed).toHaveCount(0);
	});

	test("a vote open for days closes when its time comes", async ({ page }) => {
		const bar = page.getByRole("region", { name: "Vote on “Next quarter”" });
		await play(page, "+1 day").click();
		await play(page, "+1 day").click();
		await expect(bar).toContainText(/closes in \d+h/);
		await play(page, "+1 day").click();
		await expect(bar).toContainText("Vote closed");
		// Its ranks land on the cards at the same moment, not at a later tick.
		await expect(page.getByRole("img", { name: /^1st of \d+: 16 votes$/ })).toBeVisible({
			timeout: 2000,
		});
		// The latest to close shows in full; older ones stay small.
		await expect(bar).not.toHaveAttribute("data-compact");
		await expect(page.getByRole("region", { name: "Vote on “Release name”" })).toHaveAttribute(
			"data-compact",
			"true",
		);
	});

	test("fitting the board keeps it clear of the vote's bar", async ({ page }) => {
		// Wide and short, so the board's height decides how it fits.
		await page.setViewportSize({ width: 1600, height: 640 });
		await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
		await page.keyboard.press("Shift+Digit1");
		await settleCanvas(page);
		const dock = await page.locator(".facilitation-dock").boundingBox();
		const tops = await page
			.locator(".react-flow__node")
			.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
		expect(Math.min(...tops)).toBeGreaterThan(dock!.y + dock!.height);
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

	test("a vote can run for a few minutes, counting down by the second", async ({ page }) => {
		await page
			.locator(".section-title", { hasText: "Next quarter" })
			.click({ position: { x: 12, y: 8 } });
		await page
			.getByRole("region", { name: "Vote on “Next quarter”" })
			.getByRole("button", { name: "Close vote" })
			.click();
		await page
			.locator(".section-title", { hasText: "Next quarter" })
			.click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Vote", exact: true }).click();
		const form = page.getByRole("dialog", { name: "Dot vote on “Next quarter”" });
		await form.getByText("Custom").click();
		await form.getByRole("spinbutton", { name: "Minutes until the vote closes" }).fill("3");
		await form.getByRole("button", { name: "Start voting" }).click();
		await expect(page.locator(".vote-bar[data-open=true]")).toContainText(/closes in (2:5\d|3:00)/);
	});
});

// Playwright's clock has to be installed before the page loads.
test("when a timed vote's time is up, the bar, results and ranks all close at once", async ({
	page,
}) => {
	await page.clock.install();
	await openScenario(page, "vote");
	await page
		.getByRole("region", { name: "Vote on “Next quarter”" })
		.getByRole("button", { name: "Close vote" })
		.click();
	await page
		.locator(".section-title", { hasText: "Next quarter" })
		.click({ position: { x: 12, y: 8 } });
	await page.getByRole("button", { name: "Vote", exact: true }).click();
	const form = page.getByRole("dialog", { name: "Dot vote on “Next quarter”" });
	await form.getByText("Custom").click();
	await form.getByRole("spinbutton", { name: "Minutes until the vote closes" }).fill("1");
	await form.getByRole("button", { name: "Start voting" }).click();
	const bar = page.locator(".vote-bar[data-open=true]");
	await bar.getByRole("button", { name: "Place dots" }).click();
	const card = page.locator(".react-flow__node", { hasText: "An emdash image plugin" });
	await card.click();
	await bar.getByRole("button", { name: "Done" }).click();
	const rank = page.getByRole("img", { name: "1st of 1: 1 vote" });
	await expect(rank).toHaveCount(0);

	// Stop time, then let exactly a minute pass: only a wake-up at the
	// vote's end (not the next of the ranks' 30-second ticks) closes it.
	await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 500);
	await page.clock.runFor(60_000);
	const closed = page.getByRole("region", { name: "Vote on “Next quarter”" }).first();
	await expect(closed).toContainText("Vote closed");
	await expect(rank).toBeVisible();
	const results = page.getByRole("dialog", { name: "Vote results" });
	await expect(results).toContainText("Closed");
	await expect(results.getByRole("button", { name: "Reopen…" })).toBeVisible();
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
