import type { Browser, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// Running a session on a real board, as a facilitator and a participant in
// separate browsers, signed in with /auth/dev: whoever starts something runs
// it (the server says who's who, and puts right what others mayn't do), the
// Facilitate menu starts everything and lists what's running, and a closed
// vote's result is shown to the room.

const run = Date.now().toString(36);
const LEAD = `e2e-lead-${run}`;
const GUEST = `e2e-guest-${run}`;

async function signIn(
	browser: Browser,
	baseURL: string | undefined,
	login: string,
	name: string,
): Promise<Page> {
	const context = await browser.newContext({ baseURL });
	const page = await context.newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	await page.goto(
		`/auth/dev?login=${login}&name=${encodeURIComponent(name)}&return_to=${encodeURIComponent("/")}`,
	);
	return page;
}

/** A blank board with two sections, as its owner. */
async function makeBoard(page: Page): Promise<string> {
	await page.getByRole("button", { name: "Create your first board" }).click();
	await page.getByRole("option", { name: /^Blank board/ }).click();
	await page.getByRole("button", { name: "Create board" }).click();
	await expect(page.getByRole("textbox", { name: "Board title" })).toBeFocused({
		timeout: 15_000,
	});
	await page.keyboard.type("Session");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/session$/);
	await page.evaluate(() => {
		const data = new DataTransfer();
		const shapes = [
			{
				id: "brainstorm",
				props: { type: "section", x: 0, y: 0, w: 560, h: 300, title: "Brainstorm" },
			},
			{
				id: "now",
				props: { type: "section", x: 640, y: 0, w: 560, h: 300, title: "Now" },
			},
			{ id: "a", props: { type: "sticky", x: 680, y: 80, parent: "now", text: "Docs" } },
			{ id: "b", props: { type: "sticky", x: 920, y: 80, parent: "now", text: "Tests" } },
		];
		data.setData("application/x-tack+json", JSON.stringify({ tack: 1, shapes }));
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
	});
	await expect(page.locator(".react-flow__node-section")).toHaveCount(2);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Shift+1");
	await settleCanvas(page);
	return page.url();
}

async function openBoard(page: Page, url: string) {
	await page.goto(url);
	await expect(page.locator(".react-flow__renderer")).toBeVisible();
	await expect(page.locator(".react-flow__node-section")).toHaveCount(2);
	await settleCanvas(page);
}

const menu = (page: Page) => page.getByRole("dialog", { name: "Facilitate" });

async function openMenu(page: Page) {
	if (!(await menu(page).isVisible()))
		await page.getByRole("button", { name: "Facilitate" }).click();
	await expect(menu(page)).toBeVisible();
}

/** Click an empty part of a section (its lower left). */
async function clickSection(page: Page, title: string) {
	const section = page.locator(".react-flow__node-section", { hasText: title });
	const box = (await section.boundingBox())!;
	await page.mouse.click(box.x + 24, box.y + box.height - 24);
}

test.describe.serial("running a session", () => {
	let lead: Page;
	let guest: Page;

	test.beforeAll(async ({ browser, baseURL }) => {
		lead = await signIn(browser, baseURL, LEAD, "Lena Lead");
		const url = await makeBoard(lead);
		guest = await signIn(browser, baseURL, GUEST, "Gus Guest");
		await openBoard(guest, url);
		// Both see each other.
		await expect(lead.getByRole("group", { name: "People here" })).toContainText("GG");
	});

	test.afterAll(async () => {
		await lead?.context().close();
		await guest?.context().close();
	});

	test("the timer is the facilitator's to change, and others hear when it does", async () => {
		await openMenu(lead);
		await menu(lead).getByRole("textbox", { name: "What it’s for (optional)" }).fill("Brainstorm");
		await menu(lead).getByRole("button", { name: "5 minutes", exact: true }).click();
		const theirs = guest.getByRole("timer");
		await expect(theirs).toContainText("Brainstorm");
		await theirs.hover();
		await expect(theirs.getByRole("button", { name: "Pause" })).toHaveCount(0);
		await expect(theirs.getByRole("button", { name: "Stop the timer" })).toHaveCount(0);
		await openMenu(guest);
		await expect(menu(guest)).toContainText(
			"Lena Lead’s timer is running: they, or the board’s owner, can change it",
		);
		await guest.keyboard.press("Escape");

		const mine = lead.getByRole("timer");
		await mine.hover();
		await mine.getByRole("button", { name: "Pause" }).click();
		await expect(guest.locator(".toast", { hasText: "Lena Lead paused the timer" })).toBeVisible();
		await expect(theirs).toContainText("Paused");
	});

	test("a vote on a section starts from the menu, and only its starter closes it", async () => {
		await openMenu(lead);
		await menu(lead).getByRole("button", { name: "On a section…", exact: true }).click();
		await expect(lead.getByRole("status").filter({ hasText: "Click a section" })).toBeVisible();
		await clickSection(lead, "Now");
		const start = lead.getByRole("dialog", { name: "Dot vote on “Now”" });
		await start.getByRole("button", { name: "Start voting" }).click();

		const bar = guest.getByRole("region", { name: "Vote on “Now”" });
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("button", { name: "Close vote" })).toHaveCount(0);
		await expect(
			lead
				.getByRole("region", { name: "Vote on “Now”" })
				.getByRole("button", { name: "Close vote" }),
		).toBeVisible();
		await bar.getByRole("button", { name: "Results" }).click();
		const tally = guest.getByRole("dialog", { name: "Vote results" });
		await expect(tally).toBeVisible();
		await expect(tally.getByRole("button", { name: /Delete vote/ })).toHaveCount(0);
		await expect(tally.getByRole("button", { name: /^Close vote/ })).toHaveCount(0);
		await tally.getByRole("button", { name: "Close results" }).click();
	});

	test("silent mode starts from the menu, and only its starter reveals", async () => {
		// Picking "Now" selected it, so the menu would offer that one: deselect.
		await lead.keyboard.press("Escape");
		await openMenu(lead);
		await menu(lead).getByRole("button", { name: "Start on a section…" }).click();
		await clickSection(lead, "Brainstorm");
		// The room is told what to do, and how to get there.
		const toast = guest.locator(".toast", { hasText: "silent mode" });
		await expect(toast).toContainText("add stickies there");
		await expect(toast.getByRole("button", { name: "Go there" })).toBeVisible();
		const header = (page: Page) =>
			page
				.locator(".react-flow__node-section", { hasText: "Brainstorm" })
				.locator(".section-silent");
		await expect(header(guest)).toContainText("Lena will reveal");
		await expect(header(guest).getByRole("button", { name: /Reveal/ })).toHaveCount(0);
		// Nothing written yet: the facilitator can just end it.
		await expect(header(lead).getByRole("button", { name: "End silent mode" })).toBeVisible();
	});

	test("Running now lists all of it, with its controls", async () => {
		await openMenu(lead);
		const running = menu(lead).getByRole("region", { name: "Running now" });
		await expect(running).toContainText("Brainstorm");
		await expect(running).toContainText("paused");
		await expect(running).toContainText("Voting on “Now”");
		await expect(running).toContainText("“Brainstorm” is silent");
		await expect(running.getByRole("button", { name: "End" })).toBeVisible();
		await lead.keyboard.press("Escape");
		await expect(lead.getByRole("button", { name: "Facilitate" })).toBeFocused();

		await openMenu(guest);
		const theirs = menu(guest).getByRole("region", { name: "Running now" });
		await expect(theirs).toContainText("Voting on “Now”");
		await expect(theirs.getByRole("button", { name: /^(Reveal|End)$/ })).toHaveCount(0);
		await expect(theirs.getByRole("button", { name: "Close" })).toHaveCount(0);
		await expect(theirs.getByRole("button", { name: "Pause" })).toHaveCount(0);
		await guest.keyboard.press("Escape");
	});

	test("closing the vote shows everyone how it came out", async () => {
		// Gus puts a dot on "Tests".
		const bar = guest.getByRole("region", { name: "Vote on “Now”" });
		await bar.getByRole("button", { name: "Place dots" }).click();
		await guest.locator(".react-flow__node", { hasText: "Tests" }).click();
		await expect(bar).toContainText(/2 left|1 voted/);
		await guest.keyboard.press("Escape");

		await lead
			.getByRole("region", { name: "Vote on “Now”" })
			.getByRole("button", { name: "Close vote" })
			.click();
		// Gus's results open by themselves, and the shapes keep their ranks.
		await expect(guest.getByRole("dialog", { name: "Vote results" })).toBeVisible();
		await expect(guest.getByRole("img", { name: /^1st of 1: 1 vote/ })).toBeVisible();
		await expect(lead.getByRole("img", { name: /^1st of 1: 1 vote/ })).toBeVisible();
	});

	test("deleting a vote asks first", async () => {
		const tally = lead.getByRole("dialog", { name: "Vote results" });
		if (!(await tally.isVisible())) {
			await lead
				.getByRole("region", { name: "Vote on “Now”" })
				.getByRole("button", { name: "Results" })
				.click();
		}
		await tally.getByRole("button", { name: "Delete vote…" }).click();
		const confirm = tally.getByRole("group", { name: "Delete this vote?" });
		await confirm.getByRole("button", { name: "Keep it" }).click();
		await expect(confirm).toHaveCount(0);
		await tally.getByRole("button", { name: "Delete vote…" }).click();
		await confirm.getByRole("button", { name: "Delete vote" }).click();
		await expect(lead.getByRole("region", { name: "Vote on “Now”" })).toHaveCount(0);
		await expect(guest.getByRole("region", { name: "Vote on “Now”" })).toHaveCount(0);
		await expect(guest.getByRole("img", { name: /^1st of/ })).toHaveCount(0);
	});

	test("the facilitator can take over or end someone else's spotlight", async () => {
		await guest.keyboard.press("Shift+S");
		await expect(lead.locator(".spotlight-pill")).toContainText("Gus");
		await openMenu(lead);
		await expect(menu(lead)).toContainText("Gus Guest is spotlighting");
		await menu(lead).getByRole("button", { name: "End theirs" }).click();
		await expect(menu(lead)).toContainText("Bring everyone to what you’re looking at");
		await lead.keyboard.press("Escape");
	});
});
