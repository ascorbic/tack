import type { Browser, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// The M4 exit (#54) through the UI: a retro made from the template on the
// dev server, by two people in their own browsers taking turns: silent
// writing that the other never receives, the reveal, a dot vote, a comment
// that mentions the other, the winner as an action item staged as an issue
// on the fake forge and pushed, and its open action items carried into the
// next retro. The days and time zones in between are test/m4-exit.test.ts's
// (the server's clock can't be moved here); the vote window running out is
// e2e/facilitation.spec.ts's, on the playground.

test.use({ reducedMotion: "reduce" });

const run = Date.now().toString(36);
const REPO = "fake.tack/demo/app";

/** Someone in their own browser, signed in as themselves. */
async function person(browser: Browser, login: string, name: string) {
	const context = await browser.newContext({ reducedMotion: "reduce" });
	// Hermetic: GitHub avatars fail to load, and fall back to initials.
	await context.route("https://github.com/**", (route) => route.abort());
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const signIn = async (returnTo = "/") => {
		await page.goto(
			`/auth/dev?login=${login}&name=${encodeURIComponent(name)}&return_to=${encodeURIComponent(returnTo)}`,
		);
	};
	return { context, page, errors, signIn };
}

/** The board's document as JSON, from the dev-only `tackBoard` hook. */
function docJson(page: Page): Promise<string> {
	return page.evaluate(() =>
		JSON.stringify(
			(window as unknown as { tackBoard: { doc: import("yjs").Doc } }).tackBoard.doc.toJSON(),
		),
	);
}

const section = (page: Page, title: string) => page.locator(".section", { hasText: title });
const sticky = (page: Page, text: string) =>
	page.locator(".react-flow__node-sticky", { hasText: text });
const faceDown = (page: Page) => page.getByRole("img", { name: /’s sticky, face down/ });

/** Write a sticky in a section, below its prompt, with the sticky tool: the first top left, the next bottom right. */
async function writeSticky(page: Page, title: string, text: string, n: 0 | 1) {
	const box = (await section(page, title).first().boundingBox())!;
	await page.keyboard.press("s");
	await page.mouse.click(
		box.x + box.width * (n ? 0.62 : 0.12),
		box.y + box.height * (n ? 0.72 : 0.3),
	);
	await page.keyboard.type(text);
	await page.keyboard.press("Escape");
}

async function facilitate(page: Page, step: string) {
	await page.getByRole("button", { name: /^Facilitate/ }).click();
	await page
		.getByRole("dialog", { name: "Facilitate" })
		.getByRole("button", { name: `Start: ${step}` })
		.click();
}

test("a retro, taking turns: silent writing, the reveal, votes, comments, action items, carried over", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const lena = await person(browser, `e2e-m4-lena-${run}`, "Lena");
	const priya = await person(browser, `e2e-m4-priya-${run}`, "Priya");

	// Lena makes the retro from its template.
	await lena.signIn();
	await lena.page.getByRole("button", { name: "Create your first board" }).click();
	const picker = lena.page.getByRole("dialog", { name: "New board" });
	await picker.locator('[data-template="tack:retro"]').click();
	await picker.getByLabel("Name").fill(`Retro ${run}`);
	await picker.getByRole("button", { name: "Create board" }).click();
	await expect(lena.page).toHaveURL(/\/b\/[a-z0-9]{10}\/retro-/, { timeout: 15_000 });
	const boardPath = new URL(lena.page.url()).pathname;
	await expect(lena.page.getByRole("button", { name: /^Facilitate/ })).toHaveAttribute(
		"data-ready",
		"true",
		{ timeout: 15_000 },
	);
	await lena.page.waitForTimeout(800);
	await settleCanvas(lena.page);

	// Silent writing in To improve, from the Facilitate menu; Lena writes first.
	await facilitate(lena.page, "Write: what to improve");
	await expect(lena.page.locator(".section-silent")).toBeVisible();
	await writeSticky(lena.page, "To improve", "Too many meetings on Thursdays", 0);
	await expect(lena.page.locator(".sticky[data-hidden]")).toContainText("Too many meetings");
	await lena.page.waitForTimeout(1500);

	// Priya, later: Lena's sticky is face down, its text nowhere she can reach.
	await priya.signIn(boardPath);
	await expect(faceDown(priya.page)).toHaveCount(1, { timeout: 15_000 });
	expect(await docJson(priya.page)).not.toContain("Too many meetings");
	await settleCanvas(priya.page);
	await writeSticky(priya.page, "To improve", "Flaky CI ate a day every week", 1);
	await expect(priya.page.locator(".sticky[data-hidden]")).toContainText("Flaky CI");
	await priya.page.waitForTimeout(1500);

	// Lena sees Priya's face down, and reveals them all.
	await expect(faceDown(lena.page)).toHaveCount(1);
	expect(await docJson(lena.page)).not.toContain("Flaky CI");
	await lena.page.getByRole("button", { name: "Reveal 2" }).click();
	await expect(faceDown(lena.page)).toHaveCount(0);
	await expect(sticky(lena.page, "Flaky CI ate a day every week")).toBeVisible();
	await expect(sticky(priya.page, "Too many meetings on Thursdays")).toBeVisible();

	// The dot vote, from the menu; Priya votes on her own and Lena's.
	await facilitate(lena.page, "Dot vote on what to improve");
	const bar = (page: Page) => page.getByRole("region", { name: "Vote on “To improve”" });
	await expect(bar(priya.page)).toBeVisible();
	await bar(priya.page).getByRole("button", { name: "Place dots" }).click();
	await sticky(priya.page, "Flaky CI").click();
	await sticky(priya.page, "Flaky CI").click();
	await sticky(priya.page, "Too many meetings").click();
	await expect(bar(priya.page).getByRole("img", { name: "0 of 3 dots left" })).toBeVisible();
	await bar(priya.page).getByRole("button", { name: "Done" }).click();
	await bar(lena.page).getByRole("button", { name: "Place dots" }).click();
	await sticky(lena.page, "Flaky CI").click();
	await bar(lena.page).getByRole("button", { name: "Done" }).click();
	await bar(lena.page).getByRole("button", { name: "Close vote" }).click();
	await bar(lena.page).getByRole("button", { name: "Results" }).click();
	const results = lena.page.getByRole("dialog", { name: "Vote results" });
	await expect(results.locator(".tally-row").first()).toContainText("Flaky CI");
	await expect(results.locator(".tally-row").first().getByLabel("3 votes")).toBeVisible();
	await lena.page.keyboard.press("Escape");

	// Priya asks Lena about the winner, in a comment that mentions her.
	await priya.page.keyboard.press("Escape");
	await expect(priya.page.locator(".react-flow__node.selected")).toHaveCount(0);
	await priya.page.keyboard.press("b");
	const box = (await sticky(priya.page, "Flaky CI").boundingBox())!;
	await priya.page.mouse.click(box.x + 30, box.y + 30);
	const composer = priya.page
		.locator(".comment-popover")
		.getByRole("combobox", { name: "Add a comment" });
	await composer.fill(`@e2e-m4-lena-${run} could we quarantine the flaky ones first? `);
	await composer.press("Enter");
	await expect(priya.page.locator(".comment-pin[data-thread]")).toHaveCount(1);
	await priya.page.keyboard.press("Escape");
	await priya.page.keyboard.press("Escape");
	// And she's done for the day.
	expect(priya.errors).toEqual([]);
	await priya.context.close();

	// Lena, back later: the mention's in her inbox.
	await lena.page.reload();
	const bell = lena.page.getByRole("button", { name: "Notifications: 1 unread" });
	await expect(bell).toBeVisible({ timeout: 15_000 });
	await bell.click();
	await expect(lena.page.getByRole("dialog", { name: "Notifications" })).toContainText(
		"mentioned you",
	);
	await lena.page.keyboard.press("Escape");

	// Lena makes the winner an action item, Priya's, staged as an issue and pushed.
	await sticky(lena.page, "Flaky CI").click();
	await lena.page.getByRole("button", { name: "Make an action item" }).click();
	const action = lena.page.locator(".action-item", { hasText: "Flaky CI" });
	await expect(action).toBeVisible();
	await action.getByRole("button", { name: /owner/i }).click();
	const owners = lena.page.getByRole("dialog", { name: "Owner" });
	await owners.getByRole("combobox").fill(`e2e-m4-priya-${run}`);
	await owners.getByRole("combobox").press("Enter");
	await expect(action.getByRole("button", { name: /owner/i })).toHaveText("Priya");
	await action.getByRole("button", { name: "Link an issue, or make one" }).click();
	const issue = lena.page.getByRole("dialog", { name: "Issue" });
	await issue.getByRole("combobox", { name: "Repository" }).fill(REPO);
	await issue.getByRole("combobox", { name: "Repository" }).press("Enter");
	await expect(issue).toContainText(`Assigned to @e2e-m4-priya-${run}`);
	await issue.getByRole("button", { name: "Stage issue" }).click();
	await expect(action.getByRole("button", { name: /New issue in/ })).toBeVisible();
	await lena.page.getByRole("button", { name: /^Changes/ }).click();
	await lena.page.getByRole("button", { name: /^Review and push/ }).click();
	await lena.page.getByRole("button", { name: /^Push \d+ change/ }).click();
	const sheet = lena.page.locator(".push-dialog");
	await expect(sheet.locator(".push-meter-title")).toHaveText(/on the test forge/, {
		timeout: 30_000,
	});
	await sheet.getByRole("button", { name: "Done" }).click();
	await lena.page.keyboard.press("Escape");
	await expect(action.getByRole("button", { name: /^Linked to/ })).toBeVisible({
		timeout: 15_000,
	});
	// Saved with the board before the next one is made from it.
	await lena.page.waitForTimeout(2500);

	// Next week's retro brings the open action item along.
	await lena.page.goto("/");
	await lena.page.getByRole("button", { name: "New board" }).click();
	await picker.locator('[data-template="tack:retro"]').click();
	await picker.getByLabel("Name").fill(`Next retro ${run}`);
	await picker.getByLabel("Bring open action items from").selectOption({ label: `Retro ${run}` });
	await picker.getByRole("button", { name: "Create board" }).click();
	await expect(lena.page).toHaveURL(/\/next-retro-/, { timeout: 15_000 });
	const carried = lena.page.locator(".action-item", { hasText: "Flaky CI" });
	await expect(carried).toContainText(`From Retro ${run}`, { timeout: 15_000 });
	await expect(carried.getByRole("button", { name: /owner/i })).toHaveText("Priya");

	expect(lena.errors).toEqual([]);
	await lena.context.close();
});
