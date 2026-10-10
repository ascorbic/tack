import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Boards end to end against the dev server: create one from the home page,
// rename it, share it, and open it as a viewer and signed out. The dev
// server runs with TACK_DEV_AUTH (see playwright.config.ts), so /auth/dev
// signs people in without GitHub. Logins are unique per run, so each run
// starts from an empty home page.

const run = Date.now().toString(36);
const OWNER = `e2e-owner-${run}`;
const FRIEND = `e2e-friend-${run}`;

test.beforeEach(async ({ page }) => {
	// Keep the tests hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

async function signInAs(page: Page, login: string, returnTo = "/") {
	await page.goto(`/auth/dev?login=${login}&return_to=${encodeURIComponent(returnTo)}`);
}

async function newPage(browser: Browser, login?: string): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	if (login) await signInAs(page, login);
	return page;
}

test.describe.serial("a board's life", () => {
	let boardUrl = "";

	test("create, open, rename and share", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await signInAs(page, OWNER);
		await expect(page.getByRole("heading", { name: "Your boards will live here" })).toBeVisible();

		// Creating opens the new board with its title ready to type over.
		await page.getByRole("button", { name: "Create your first board" }).click();
		await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/untitled-board$/);
		const title = page.getByRole("textbox", { name: "Board title" });
		// The first load of a board can be slow on a cold dev server.
		await expect(title).toBeFocused({ timeout: 15_000 });
		await page.keyboard.type("E2E roadmap");
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/e2e-roadmap$/);
		await expect(page.getByRole("button", { name: "E2E roadmap" })).toBeVisible();
		await expect(page).toHaveTitle("E2E roadmap · Tack");
		await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
		boardUrl = page.url();

		// Share: invite a friend to view, and keep it to invited people only.
		await page.getByRole("button", { name: "Share" }).click();
		const dialog = page.getByRole("dialog", { name: /Share/ });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("listitem").filter({ hasText: "(you)" })).toContainText("Owner");
		await dialog.getByLabel("GitHub usernames to invite").fill(`@${FRIEND}`);
		await dialog.getByLabel("Invite as").selectOption("viewer");
		await dialog.getByRole("button", { name: "Invite", exact: true }).click();
		const friend = dialog.getByRole("listitem").filter({ hasText: FRIEND });
		await expect(friend).toContainText("hasn’t signed in yet");
		await expect(friend.getByRole("combobox")).toHaveValue("viewer");

		await dialog.getByLabel("Who can open this board").selectOption("private");
		await expect(dialog).toContainText("Only the people above can open this board.");

		await dialog.getByRole("button", { name: "Copy link" }).click();
		await expect(dialog.getByRole("button", { name: "Link copied" })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(boardUrl);

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// Home lists it.
		await page.getByRole("link", { name: "Tack: all boards" }).click();
		await expect(page.getByRole("link", { name: "E2E roadmap" })).toBeVisible();
	});

	test("a viewer can look but not edit", async ({ browser }) => {
		const page = await newPage(browser, FRIEND);
		await page.goto(boardUrl);
		await expect(page.getByText("View only")).toBeVisible();
		await expect(page.locator(".react-flow__renderer")).toBeVisible();
		// Viewers can comment (#51), so they get the hand and the comment tool, and nothing else.
		const tools = page.getByRole("toolbar", { name: "Tools" });
		await expect(tools.getByRole("button", { name: "Comment" })).toBeVisible();
		await expect(tools.getByRole("button")).toHaveCount(3);
		// No tool shortcuts that would change the board: sections (F), connectors (X), stickies (S).
		for (const key of ["f", "x", "s"]) {
			await page.locator(".react-flow__pane").click({ position: { x: 400, y: 300 } });
			await page.keyboard.press(key);
			await expect(page.locator("main.canvas")).toHaveAttribute("data-tool", "select");
		}
		// The title isn't renameable either.
		await expect(page.getByRole("heading", { name: "E2E roadmap" })).toBeVisible();
		await expect(page.getByRole("button", { name: "E2E roadmap" })).toHaveCount(0);
		await page.context().close();
	});

	test("signed out, private boards ask you to sign in, and public ones open read-only", async ({
		browser,
		page,
	}) => {
		const stranger = await newPage(browser);
		await stranger.goto(boardUrl);
		await expect(stranger.getByRole("heading", { name: "Sign in to Tack" })).toBeVisible();

		await signInAs(page, OWNER, new URL(boardUrl).pathname);
		await page.getByRole("button", { name: "Share" }).click();
		await page.getByLabel("Who can open this board").selectOption("public");
		await expect(page.getByRole("dialog")).toContainText("no sign-in needed");
		// The dev server has no GitHub App, so everyone counts as on the
		// instance: make that view-only too, as the public always is.
		await page.getByLabel("What people on this Tack can do").selectOption("viewer");
		await expect(page.getByRole("dialog")).toContainText("People on this Tack can view.");

		await stranger.reload();
		await expect(stranger.getByText("View only")).toBeVisible();
		await expect(stranger.getByRole("toolbar", { name: "Tools" })).toHaveCount(0);
		await stranger.context().close();
	});
});

test("old ?board= links find their board", async ({ page }) => {
	await signInAs(page, OWNER, `/?board=e2e-legacy-${run}`);
	await expect(page).toHaveURL(new RegExp(`/b/e2e-legacy-${run}/e2e-legacy-${run}$`));
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
});

test("unknown boards say so", async ({ page }) => {
	await signInAs(page, OWNER, "/b/no-such-board/whatever");
	await expect(page.getByRole("heading", { name: "This board isn’t here" })).toBeVisible();
});
