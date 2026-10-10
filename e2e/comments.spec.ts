import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Comments (#51) and "since you were here" (#46) on the playground's retro
// boards, against pretend servers with simulated people and time passing.

const play = (page: Page, name: string) =>
	page.getByLabel("Playground controls").getByRole("button", { name, exact: true });
const pins = (page: Page) => page.locator(".comment-pin[data-thread]");
const popover = (page: Page) => page.locator(".comment-popover");

/** Where a shape is on the board, from the playground's document. */
function moveShape(page: Page, id: string, dx: number) {
	return page.evaluate(
		({ id, dx }) => {
			const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			const shape = board.doc.getMap("shapes").get(id) as import("yjs").Map<unknown>;
			shape.set("x", (shape.get("x") as number) + dx);
		},
		{ id, dx },
	);
}

test.describe("comments", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "comments"));

	test("threads show as pins, unread ones marked, and open into a conversation", async ({
		page,
	}) => {
		// Four open threads; the resolved one is out of the way.
		await expect(pins(page)).toHaveCount(4);
		await expect(page.locator(".comment-pin[data-unread]")).toHaveCount(3);
		await expect(page.getByRole("button", { name: /^Comments: 4 open, 3 unread/ })).toBeVisible();

		await page.getByRole("button", { name: /Comment by Priya Shah, 2 replies, unread/ }).click();
		await expect(popover(page).locator(".comment-message")).toHaveCount(3);
		// New since you last read it: marked, and read now.
		await expect(popover(page).locator(".comment-message[data-fresh]")).toHaveCount(1);
		await expect(page.locator(".comment-pin[data-unread]")).toHaveCount(2);

		// Reply, mentioning someone from the list.
		const reply = popover(page).getByRole("combobox", { name: "Reply" });
		await reply.fill("On it @k");
		await expect(page.getByRole("listbox", { name: "People to mention" })).toContainText(
			"Kai Andersen",
		);
		await reply.press("Enter");
		await expect(reply).toHaveValue("On it @kai ");
		await reply.press("Enter");
		await expect(popover(page).locator(".comment-message")).toHaveCount(4);
		await expect(
			popover(page).locator(".comment-message").last().locator(".comment-mention"),
		).toHaveText("@kai");
		await expect(popover(page).locator(".comment-message[data-pending]")).toHaveCount(0);

		// Resolve it: the pin goes, with a way back.
		await popover(page).getByRole("button", { name: "Resolve" }).click();
		await expect(pins(page)).toHaveCount(3);
		await page.getByRole("button", { name: "Undo" }).click();
		await expect(pins(page)).toHaveCount(4);
	});

	test("the comment tool pins a comment to whatever's clicked, and it follows", async ({
		page,
	}) => {
		await page.keyboard.press("b");
		await expect(page.locator(".canvas")).toHaveAttribute("data-tool", "comment");
		const sticky = page.locator(".react-flow__node", { hasText: "Pairing on the Astro adapter" });
		const box = (await sticky.boundingBox())!;
		await page.mouse.click(box.x + 40, box.y + 40);
		const composer = popover(page).getByRole("combobox", { name: "Add a comment" });
		await composer.fill("Let’s do this again next quarter");
		await composer.press("Enter");
		await expect(pins(page)).toHaveCount(5);
		// Nothing was selected or moved by the click.
		await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

		const pin = page.locator(".comment-pin[aria-label^='Comment by']").last();
		const before = (await pin.boundingBox())!;
		await moveShape(page, "retro-sticky-pairing", 120);
		await expect
			.poll(async () => ((await pin.boundingBox())?.x ?? 0) - before.x)
			.toBeGreaterThan(80);

		// Escape puts the tool down.
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await expect(page.locator(".canvas")).toHaveAttribute("data-tool", "select");
	});

	test("the panel lists open, resolved and mentioning threads, and goes to them", async ({
		page,
	}) => {
		await page.getByRole("button", { name: /^Comments:/ }).click();
		const panel = page.getByRole("complementary", { name: "Comments" });
		await expect(panel.getByRole("tab", { name: /Open/ })).toHaveAttribute("aria-selected", "true");
		await expect(panel.locator(".comments-list > li")).toHaveCount(4);
		await panel.getByRole("tab", { name: /Resolved/ }).click();
		await expect(panel.locator(".comments-list > li")).toHaveCount(1);
		await panel.getByRole("tab", { name: /Mentions/ }).click();
		await expect(panel.locator(".comments-list > li")).toHaveCount(1);
		await panel.locator(".comments-item").first().click();
		await expect(popover(page)).toContainText("can you review it?");
	});

	test("mentions land in the inbox, and open their thread", async ({ page }) => {
		// Priya mentioned you a few hours ago.
		await expect(page.getByRole("button", { name: "Notifications: 1 unread" })).toBeVisible();
		await play(page, "Someone mentions you").click();
		const bell = page.getByRole("button", { name: "Notifications: 2 unread" });
		await expect(bell).toBeVisible();
		await bell.click();
		const dialog = page.getByRole("dialog", { name: "Notifications" });
		await expect(dialog).toContainText("mentioned you");
		// (The playground's controls sit over it, so by keyboard.)
		await dialog.locator("li button").first().focus();
		await page.keyboard.press("Enter");
		await expect(popover(page)).toContainText("what do you think?");
		await expect(page.getByRole("button", { name: "Notifications: 1 unread" })).toBeVisible();
	});

	test("viewers can comment; signed-out visitors can't", async ({ page }) => {
		await page.getByLabel("View only").check();
		const tools = page.getByRole("toolbar", { name: "Tools" });
		await expect(tools.getByRole("button")).toHaveCount(3);
		await expect(tools.getByRole("button", { name: "Comment" })).toBeVisible();
		// A viewer can reply, but not resolve someone else's thread.
		await page.getByRole("button", { name: /Comment by Jo Rivera/ }).click();
		await expect(popover(page).getByRole("combobox", { name: "Reply" })).toBeVisible();
		await expect(popover(page).getByRole("button", { name: "Resolve" })).toHaveCount(0);
		await page.keyboard.press("Escape");

		await page.getByLabel(/Signed in/).uncheck();
		await expect(tools).toHaveCount(0);
		await page.getByRole("button", { name: /Comment by Jo Rivera/ }).click();
		await expect(popover(page)).toContainText("Sign in to reply.");
	});
});

test.describe("since you were here", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "since"));

	test("the digest says what changed, highlights it, and marks it all seen", async ({ page }) => {
		const panel = page.getByRole("complementary", { name: "Since you were here" });
		await expect(panel).toBeVisible();
		await expect(panel).toContainText("Away 3 days");
		await expect(panel.getByRole("region", { name: "On the board" })).toContainText(
			"added 2 stickies",
		);
		await expect(panel.getByRole("region", { name: "On GitHub" })).toContainText("closed");
		await expect(panel.getByRole("region", { name: "On GitHub" })).toContainText("merged");
		await expect(panel.getByRole("region", { name: "Pushed" })).toContainText("pushed 3 changes");
		await expect(panel.getByRole("region", { name: "Comments" })).toContainText("mentions you");
		await expect(page.locator(".since-ring").first()).toBeVisible();

		// Step through the changes on the board.
		await panel.getByRole("button", { name: "Next change" }).click();
		await expect(panel.getByRole("group", { name: "Changes on the board" })).toContainText("1 of");

		await panel.getByRole("button", { name: "Mark all as seen" }).click();
		await expect(panel).toHaveCount(0);
		await expect(page.locator(".since-ring")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^Since you were here/ })).toHaveCount(0);
	});

	test("highlights fade once they've been on screen", async ({ page }) => {
		const rings = page.locator(".since-ring");
		const count = await rings.count();
		expect(count).toBeGreaterThan(0);
		// Go to one (it may be off screen), and look.
		const panel = page.getByRole("complementary", { name: "Since you were here" });
		await panel.getByRole("button", { name: "Next change" }).click();
		await expect.poll(() => rings.count(), { timeout: 10_000 }).toBeLessThan(count);
	});
});

test.describe("gallery", () => {
	test("every comment and since-you-were-here state renders", async ({ page }) => {
		await page.goto("/play/comments");
		await expect(page.getByRole("heading", { name: "Comments and catching up" })).toBeVisible();
		for (const state of [
			"read",
			"unread",
			"replies",
			"open",
			"resolved",
			"arrived",
			"preview",
			"sending",
			"deleted",
			"editing",
			"mentions",
			"viewer",
			"signed-out",
			"archived",
			"composing",
			"panel-open",
			"panel-mentions",
			"panel-resolved",
			"panel-empty",
			"panel-loading",
			"button-unread",
			"since-button",
			"notifications",
			"notifications-empty",
			"digest",
			"digest-comments",
			"digest-quiet",
			"digest-more",
			"ring-new",
			"ring-changed",
			"ring-moved",
			"ring-closed",
			"ring-fading",
		]) {
			await expect(page.locator(`figure[data-state="${state}"]`).first()).toBeVisible();
		}
		await expect(page.locator('figure[data-state="composing"] .comment-mentions li')).toHaveCount(
			1,
		);
		await expect(page.locator('figure[data-state="digest-quiet"]')).toContainText("All quiet");
		await expect(page.locator('figure[data-state="digest-more"]')).toContainText("1240 more");
		await expect(page.locator('figure[data-state="panel-empty"]')).toContainText(
			"No open comments",
		);
	});
});
