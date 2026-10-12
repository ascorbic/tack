import type { Locator, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// The public demo (tack.social/try, #75), as the dev server serves it at
// /play/try: the guided first run done by doing each step, the scenario
// picker, Reset, the board kept across a reload, and nothing ever leaving
// the browser.

async function open(page: Page, query = "") {
	await page.goto(`/play/try${query}`);
	await expect(page.locator(".react-flow__renderer")).toBeVisible();
	await settleCanvas(page);
}

const coach = (page: Page) => page.locator(".try-coach");
const sticky = (page: Page, text: string) =>
	page.locator(".react-flow__node-sticky", { hasText: text }).first();

async function centre(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("not on screen");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag `from` over `onto` and hold it there, which makes a stack. */
async function stackOnto(page: Page, from: Locator, onto: Locator) {
	const start = await centre(from);
	const end = await centre(onto);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 2, start.y + 2);
	await page.mouse.move(end.x, end.y, { steps: 14 });
	await expect(page.locator(".react-flow__node.stack-target")).toHaveCount(1);
	await page.mouse.move(end.x + 2, end.y + 1);
	await page.mouse.up();
}

/** Every request the page made that left it, beyond the dev server. */
function outbound(page: Page): string[] {
	const out: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.protocol === "data:" || url.protocol === "blob:") return;
		if (url.hostname !== "localhost") out.push(request.url());
	});
	return out;
}

test.beforeEach(async ({ page }) => {
	// Whole sessions, reloads and all: longer than a single interaction.
	test.setTimeout(90_000);
	// A first visit: nothing kept from another test.
	await page.addInitScript(() => {
		if (!sessionStorage.getItem("try-test")) {
			sessionStorage.setItem("try-test", "1");
			localStorage.clear();
		}
	});
});

test("the guided first run: stack, issues, push, vote", async ({ page }) => {
	const out = outbound(page);
	await open(page);
	await expect(page.getByRole("button", { name: /This is a demo/ })).toBeVisible();

	// 1. Stack two stickies: the step says which, and rings them.
	await expect(coach(page)).toContainText("Step 1 of 4");
	await expect(coach(page)).toContainText("Stack two stickies");
	await expect(page.locator(".try-ring")).toHaveCount(2);
	await stackOnto(
		page,
		sticky(page, "Flaky e2e tests on Safari"),
		sticky(page, "CI takes 20 minutes on a good day"),
	);
	await expect(coach(page)).toContainText("Step 2 of 4", { timeout: 10_000 });

	// 2. The stack as a parent issue with sub-issues, staged. The new stack
	// is selected, so its actions are there already, and the step points
	// at the one to use.
	await expect(page.getByRole("toolbar", { name: "Stage changes" })).toBeVisible();
	await expect(page.locator(".try-ring")).toHaveCount(1);
	await page
		.getByRole("toolbar", { name: "Stage changes" })
		.getByRole("button", { name: /^Make a parent issue from this stack/ })
		.click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /^Stage/ })
		.click();
	await expect(coach(page)).toContainText("Step 3 of 4", { timeout: 10_000 });

	// 3. Pushed to the demo forge, named as such, and landed.
	await expect(page.locator(".changes-button")).toHaveAttribute(
		"data-tooltip",
		"Changes staged for the demo forge",
	);
	await page.locator(".changes-button").click();
	const panel = page.getByRole("complementary", { name: "Pending changes" });
	await panel.getByRole("button", { name: /^Review and push/ }).click();
	const sheet = page.locator(".push-dialog");
	await expect(sheet.getByRole("heading", { name: "Push to the demo forge" })).toBeVisible();
	await sheet.getByRole("button", { name: /^Push \d+ changes/ }).click();
	await expect(sheet.getByText(/^All \d+ changes are on the demo forge/)).toBeVisible({
		timeout: 20_000,
	});
	// The step's done once you've seen it land and closed the sheet.
	await expect(coach(page)).toContainText("Step 3 of 4");
	await sheet.getByRole("button", { name: "Done" }).click();
	await expect(coach(page)).toContainText("Step 4 of 4", { timeout: 10_000 });

	// 4. A dot of your own.
	const bar = page.getByRole("region", { name: /^Vote on/ });
	await bar.getByRole("button", { name: "Place dots" }).click();
	await page.locator(".react-flow__node", { hasText: "Offline edits survive a refresh" }).click();
	const finale = page.getByRole("region", { name: "That’s Tack." });
	await expect(finale).toBeVisible({ timeout: 10_000 });
	await expect(finale.getByRole("link", { name: "Get your own" })).toBeVisible();
	await expect(finale.getByRole("link", { name: "Take the tour" })).toHaveCount(0);
	await finale.getByRole("button", { name: "Keep playing" }).click();
	await expect(finale).toHaveCount(0);

	expect(out).toEqual([]);
});

test("the tour can be skipped, and started again from the demo note", async ({ page }) => {
	await open(page);
	await coach(page).getByRole("button", { name: "Skip tour" }).click();
	await expect(coach(page)).toHaveCount(0);
	await page.reload();
	await settleCanvas(page);
	await expect(coach(page)).toHaveCount(0);

	await page.getByRole("button", { name: /This is a demo/ }).click();
	await expect(page.getByText("Everything here happens in your browser")).toBeVisible();
	await page.getByRole("button", { name: "Show me around again" }).click();
	await expect(coach(page)).toContainText("Step 1 of 4");
});

test("a board is kept across a reload, until it's reset", async ({ page }) => {
	await open(page);
	await coach(page).getByRole("button", { name: "Skip tour" }).click();
	const note = sticky(page, "Release notes are thin");
	await note.click();
	await page.keyboard.press("Delete");
	await expect(sticky(page, "Release notes are thin")).toHaveCount(0);
	// Saved a moment after the change.
	await page.waitForTimeout(800);
	await page.reload();
	await settleCanvas(page);
	await expect(sticky(page, "Self-hosting docs skip the GitHub App step")).toBeVisible();
	await expect(sticky(page, "Release notes are thin")).toHaveCount(0);

	await page.getByRole("button", { name: "Reset" }).click();
	const confirm = page.getByRole("dialog", { name: "Start “Planning session” again?" });
	await confirm.getByRole("button", { name: "Reset board" }).click();
	await expect(sticky(page, "Release notes are thin")).toBeVisible();
	await page.reload();
	await settleCanvas(page);
	await expect(sticky(page, "Release notes are thin")).toBeVisible();
});

test("the scenario picker switches boards, and the address says which", async ({ page }) => {
	await open(page);
	await coach(page).getByRole("button", { name: "Skip tour" }).click();
	await page.getByRole("button", { name: /Planning session/ }).click();
	const menu = page.getByRole("menu", { name: "Boards to try" });
	await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
	await menu.getByRole("menuitemradio", { name: /Retro/ }).click();
	await expect(page).toHaveURL(/scenario=retro/);
	await settleCanvas(page);
	await expect(sticky(page, "Stacks shipped and people love them")).toBeVisible();

	await page.getByRole("button", { name: /Retro/ }).click();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/scenario=triage/);
	await settleCanvas(page);
	await expect(
		page.locator(".react-flow__node", { hasText: "srcset widths off by one" }),
	).toBeVisible();

	// Straight to one by its address.
	await open(page, "?scenario=retro");
	await expect(sticky(page, "Pair on reviews on Fridays")).toBeVisible();
});

test("nothing can leave the browser: requests elsewhere are refused", async ({ page }) => {
	await open(page);
	const refused = await page.evaluate(async () => {
		const tries = [
			fetch("https://example.com/").then(
				() => "sent",
				(error: Error) => error.message,
			),
			fetch(location.href, { method: "POST" }).then(
				() => "sent",
				(error: Error) => error.message,
			),
		];
		let socket = "opened";
		try {
			new WebSocket("wss://example.com/");
		} catch (error) {
			socket = (error as Error).message;
		}
		return [...(await Promise.all(tries)), socket, String(navigator.sendBeacon("/x", "y"))];
	});
	expect(refused[0]).toContain("never connects out");
	expect(refused[1]).toContain("never connects out");
	expect(refused[2]).toContain("never connects out");
	expect(refused[3]).toBe("false");
	// Links to the pretend forge stay on the board, and say why.
	await coach(page).getByRole("button", { name: "Skip tour" }).click();
	await page.evaluate(() => {
		const link = document.createElement("a");
		link.href = "https://fake.tack/ascorbic/tack/issues/212";
		link.textContent = "a forge link";
		document.querySelector(".react-flow")?.append(link);
		link.click();
	});
	await expect(
		page.getByRole("status").filter({ hasText: "only exists in this browser" }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/play\/try/);
});
