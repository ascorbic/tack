import type { Page } from "@playwright/test";
import type { BoardInfo } from "../src/shared/boards.ts";
import { expect, settleCanvas, test } from "./fixtures.ts";

// Weekly digests (#68), against the dev server (which has email, through
// Miniflare): the owner turns them on from the board's menu, someone asks
// for it by email, the links in emails, and the playground's week.

const run = Date.now().toString(36);
let n = 0;
const login = (name: string) => `e2e-digest-${name}-${run}-${++n}`;

test.beforeEach(async ({ page }) => {
	// Each answer waits briefly for the board's cards to arrive, as a digest does.
	test.slow();
	await page.route("https://github.com/**", (route) => route.abort());
});

async function newBoard(page: Page, owner: string): Promise<BoardInfo> {
	await page.goto(`/auth/dev?login=${owner}&return_to=/`);
	const response = await page.request.post("/api/boards", {
		data: { title: "Digest board", template: "tack:retro" },
	});
	expect(response.ok()).toBe(true);
	const board = (await response.json()) as BoardInfo;
	await page.goto(`/b/${board.id}/${board.slug}`);
	await expect(page.locator(".react-flow__node").first()).toBeVisible();
	await settleCanvas(page);
	return board;
}

async function openDigest(page: Page) {
	const item = page.getByRole("menuitem", { name: "Weekly digest…" });
	// The menu can be opened before the page knows who's signed in: try again.
	await expect(async () => {
		if (!(await item.isVisible())) await page.getByRole("button", { name: "Board menu" }).click();
		await expect(item).toBeVisible({ timeout: 1000 });
	}).toPass();
	await item.click();
	const dialog = page.getByRole("dialog", { name: "Weekly digest" });
	await expect(dialog.getByLabel("The next digest so far")).toBeVisible();
	return dialog;
}

test("the owner turns on digests, and someone asks for it by email", async ({ page }) => {
	await newBoard(page, login("owner"));
	const dialog = await openDigest(page);
	await expect(dialog.getByRole("switch", { name: /Email people who ask for it/ })).toBeChecked();

	// A Discussion somewhere the app can't post: said in words.
	await dialog.getByRole("switch", { name: /Post a GitHub Discussion/ }).check();
	await dialog.getByLabel("Repository").fill("fake.tack/demo/digests");
	await dialog.getByLabel("Category").fill("Announcements");
	await dialog.getByRole("button", { name: "Turn on digests" }).click();
	await expect(dialog.getByRole("alert")).toContainText("can’t post Discussions", {
		timeout: 15_000,
	});

	// Email only: on, with when the next one goes.
	await dialog.getByRole("switch", { name: /Post a GitHub Discussion/ }).uncheck();
	await dialog.getByRole("radio", { name: "Fri" }).click();
	await dialog.getByRole("button", { name: "Turn on digests" }).click();
	await expect(dialog.getByRole("status")).toContainText("Saved", { timeout: 15_000 });
	await expect(dialog).toContainText(/Next: Friday/);

	// Asking for it: a link to confirm first.
	await dialog.getByLabel(/Email it to me/).fill("owner@example.com");
	await dialog.getByRole("button", { name: "Send a link" }).click();
	await expect(dialog).toContainText("for a link to confirm", { timeout: 15_000 });
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog.getByLabel(/Email it to me/)).toBeVisible({ timeout: 15_000 });

	await dialog.getByRole("button", { name: "Turn off digests" }).click();
	await expect(dialog.getByRole("button", { name: "Turn on digests" })).toBeVisible({
		timeout: 15_000,
	});
});

test("someone who isn't the owner sees where it goes, not its settings", async ({ page }) => {
	const board = await newBoard(page, login("owner"));
	const turnedOn = await page.request.put(`/api/boards/${board.id}/digest`, {
		data: { discussion: null, email: true, weekday: 1, hour: 9, timeZone: "Europe/London" },
	});
	expect(turnedOn.ok()).toBe(true);
	await page.goto(
		`/auth/dev?login=${login("member")}&return_to=${encodeURIComponent(`/b/${board.id}/${board.slug}`)}`,
	);
	await expect(page.locator(".react-flow__node").first()).toBeVisible();
	await settleCanvas(page);
	const dialog = await openDigest(page);
	await expect(dialog).toContainText("Mondays at 9:00 (Europe/London)");
	await expect(dialog.getByRole("switch")).toHaveCount(0);
	await expect(dialog.getByLabel(/Email it to me/)).toBeVisible();
});

test("a link from an email that's expired or used says so", async ({ page }) => {
	await page.goto("/digest?confirm=not-a-real-token");
	await expect(page.getByRole("heading", { name: "That didn’t work" })).toBeVisible();
	await page.goto("/digest?unsubscribe=1&token=not-a-real-token");
	await expect(page.getByRole("heading", { name: "Stop this digest?" })).toBeVisible();
	await page.getByRole("button", { name: "Stop emailing me" }).click();
	await expect(page.getByRole("heading", { name: "That didn’t work" })).toBeVisible();
});

test("the playground's week previews its digest", async ({ page }) => {
	await page.goto("/play?scenario=digest");
	const dialog = page.getByRole("dialog", { name: "Weekly digest" });
	const preview = dialog.getByRole("article", { name: "Your email, so far" });
	await expect(preview).toContainText("Move image tests off the shared runners", {
		timeout: 15_000,
	});
	await expect(preview).toContainText("Turn on retries for image downloads");
	await dialog.getByRole("radio", { name: "Discussion" }).click();
	await expect(dialog.locator(".digest-markdown")).toContainText("A weekly digest from Tack");
});
