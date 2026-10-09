import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Pending changes and pushing, over the playground's "Pushing to GitHub"
// scenario (a pretend push server, see src/client/play/push.ts) and the
// changes gallery. Reduced motion makes the pretend server instant.

test.use({ reducedMotion: "reduce" });

const changesButton = (page: Page) => page.getByRole("button", { name: /^Changes/ });
const panel = (page: Page) => page.getByRole("complementary", { name: "Pending changes" });
const sheet = (page: Page) => page.locator(".push-dialog");

async function openPanel(page: Page) {
	await changesButton(page).click();
	await expect(panel(page)).toBeVisible();
}

test.describe("pending changes panel", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "push"));

	test("shows what's staged, grouped by repository, with who staged it", async ({ page }) => {
		await expect(changesButton(page)).toHaveAccessibleName("Changes, 11 staged, some failed");
		await expect(page.locator(".changes-badge")).toHaveText("11");
		await openPanel(page);

		const groups = panel(page).locator(".changes-group");
		await expect(groups).toHaveCount(2);
		await expect(groups.first().locator(".changes-repo")).toContainText("acme/imagekit");
		await expect(groups.nth(1).locator(".changes-repo")).toContainText("lovell/sharp");
		await expect(panel(page).locator(".change-row")).toHaveCount(11);
		await expect(panel(page).getByText("Priya Shah").first()).toBeVisible();

		// The failure says why, and offers a retry.
		const failed = panel(page).locator(".change-row[data-status=failed]");
		await expect(failed).toHaveCount(1);
		await expect(failed.locator(".change-error")).toContainText("Milestone “5.0” is closed");
		await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();

		// The upstream change is left out.
		await expect(panel(page).locator(".change-row[data-included=false]")).toHaveCount(1);
	});

	test("marks the shapes each change is about", async ({ page }) => {
		const flags = page.locator(".staged-flag");
		await expect(flags.filter({ hasText: "New issue in imagekit" })).toHaveCount(2);
		await expect(flags.filter({ hasText: "Will close" })).toHaveCount(1);
		await expect(flags.filter({ hasText: "Blocked by #418" })).toHaveCount(1);
		await expect(page.locator(".staged-label").filter({ hasText: "needs review" })).toHaveCount(1);
		await expect(page.locator(".staged-ghost")).toHaveCount(3);

		// Clicking a mark opens the panel at its change.
		await flags.filter({ hasText: "Will close" }).click();
		await expect(panel(page)).toBeVisible();
		await expect(panel(page).locator(".change-row[data-flash]")).toContainText("Close #377");

		// Hovering a change picks out its shapes.
		await panel(page).locator(".change-row", { hasText: "Close #377" }).hover();
		await expect(page.locator(".staged-marks[data-highlighted]")).toHaveCount(1);
	});

	test("unstaging and leaving out are undoable, and take dependants along", async ({ page }) => {
		await openPanel(page);
		const rows = panel(page).locator(".change-row");

		// Unstaging the migration guide issue takes its sub-issue link with it.
		const guide = rows.filter({ hasText: "Create issue “Write the 5.0 migration guide”" });
		await guide.hover();
		await guide.getByRole("button", { name: /^Unstage/ }).click();
		await expect(rows).toHaveCount(9);
		await expect(page.locator(".toast")).toContainText("Unstaged 2 changes");
		await page.locator(".toast").getByRole("button", { name: /Undo/ }).click();
		await expect(rows).toHaveCount(11);

		// Leaving out the other new issue leaves out nothing else.
		const errors = rows.filter({ hasText: "Create issue “Better errors" });
		await errors.getByRole("checkbox").uncheck();
		await expect(rows.and(page.locator("[data-included=false]"))).toHaveCount(2);
		await expect(panel(page).getByRole("button", { name: "Review and push 9" })).toBeVisible();
	});

	test("view-only people see the list but can't change it", async ({ page }) => {
		await page.getByLabel("View only").check();
		await openPanel(page);
		await expect(panel(page)).toContainText("You can look, but not change it");
		await expect(panel(page).getByRole("button", { name: /^Unstage/ })).toHaveCount(0);
		for (const box of await panel(page).getByRole("checkbox").all())
			await expect(box).toBeDisabled();
		await expect(panel(page).getByRole("button", { name: /Review/ })).toHaveCount(0);
		await expect(panel(page).getByRole("button", { name: "History" })).toBeVisible();
	});

	test("changes staged by someone else arrive live", async ({ page }) => {
		await openPanel(page);
		await page.getByRole("button", { name: "Someone adds labels" }).click();
		await expect(panel(page).locator(".change-row")).toHaveCount(12);
		await expect(page.locator(".changes-badge")).toHaveText("12");
	});
});

test.describe("push sheet", () => {
	test.beforeEach(async ({ page }) => {
		await openScenario(page, "push");
		await openPanel(page);
	});

	test("reviews, pushes and lands every change", async ({ page }) => {
		await panel(page).getByRole("button", { name: "Review and push 10" }).click();
		await expect(sheet(page).getByRole("heading", { name: "Push to GitHub" })).toBeVisible();

		// Previews of what will be written, and who'll hear about it.
		await expect(sheet(page).locator(".push-change")).toHaveCount(11);
		await expect(sheet(page).locator(".preview-thread-title").first()).toContainText(
			"Better errors when the CDN isn’t recognised",
		);
		await expect(sheet(page).locator(".preview-comment")).toContainText("via Tack");
		await expect(sheet(page).locator(".preview-files")).toContainText(
			"docs/decisions/0007-drop-node-18.md",
		);
		await expect(sheet(page).locator(".push-estimate")).toContainText(
			"Notifies ~42 people watching acme/imagekit",
		);
		await expect(sheet(page).locator(".push-repo-warning")).toContainText("isn’t installed here");

		// Push as the bot: the comment preview says so.
		await sheet(page).getByText("Tack’s bot").click();
		await expect(sheet(page).locator(".preview-comment")).toContainText("Tack (bot)");

		await sheet(page).getByRole("button", { name: "Push 10 changes" }).click();
		await expect(sheet(page).locator(".push-meter-title")).toHaveText(
			"All 10 changes are on GitHub",
		);
		await expect(sheet(page).locator(".push-step[data-status=applied]")).toHaveCount(10);
		await expect(sheet(page).locator(".push-ring[data-done]")).toBeVisible();

		// The board caught up: the stickies became cards, labels and states changed.
		await sheet(page).getByRole("button", { name: "Done" }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(page.locator(".react-flow__node-sticky")).toHaveCount(2);
		await expect(page.locator(".card[data-state=closed]")).toHaveCount(2);
		await expect(page.locator(".card .chip.label", { hasText: "needs review" })).toHaveCount(1);
		await expect(page.locator(".changes-badge")).toHaveText("1");

		// And the push is in the history.
		await page.getByRole("button", { name: "History", exact: true }).click();
		const entries = sheet(page).locator(".push-entry");
		await expect(entries).toHaveCount(3);
		await expect(entries.first()).toContainText("pushed 10 changes as Tack’s bot");
	});

	test("refused for repositories without the app, until they're left out", async ({ page }) => {
		const upstream = panel(page).locator(".change-row", { hasText: "Add triage to #4012" });
		await upstream.getByRole("checkbox").check();
		await panel(page).getByRole("button", { name: "Review and push 11" }).click();
		await sheet(page).getByRole("button", { name: "Push 11 changes" }).click();

		const refusal = sheet(page).getByRole("alert");
		await expect(refusal).toContainText("Install the app on these repos");
		await expect(refusal.getByRole("link", { name: "Install the app" })).toHaveAttribute(
			"href",
			/\/setup\/install\?state=/,
		);
		await refusal.getByRole("button", { name: "Leave its changes out" }).click();
		await expect(sheet(page).getByRole("alert")).toHaveCount(0);
		await sheet(page).getByRole("button", { name: "Push 10 changes" }).click();
		await expect(sheet(page).locator(".push-meter-title")).toHaveText(
			"All 10 changes are on GitHub",
		);
	});

	test("failures come back with a reason, and retry", async ({ page }) => {
		await page.getByLabel("Push server").selectOption("some_fail");
		await panel(page).getByRole("button", { name: "Review and push 10" }).click();
		await sheet(page).getByRole("button", { name: "Push 10 changes" }).click();
		await expect(sheet(page).locator(".push-meter-title")).toHaveText("8 landed, 2 didn’t");
		await expect(sheet(page).locator(".push-step[data-status=failed]")).toHaveCount(2);
		await expect(sheet(page).locator(".push-step-error").first()).not.toBeEmpty();

		// The playground's controls are behind the sheet, so fix the server directly.
		await page.evaluate(() => {
			(window as unknown as { tackPush: { mode: string } }).tackPush.mode = "works";
		});
		await sheet(page).getByRole("button", { name: "Retry all 2" }).click();
		await expect(sheet(page).locator(".push-meter-title")).toHaveText(
			"All 10 changes are on GitHub",
		);
	});

	for (const [mode, title] of [
		["signed_out", "Sign in to push"],
		["no_write_access", "You can stage but not push here"],
		["not_installed", "Install the app on these repos"],
		["busy", "Someone else is pushing this board"],
		["offline", "Couldn’t reach Tack"],
	] as const) {
		test(`explains a refusal: ${mode}`, async ({ page }) => {
			await page.getByLabel("Push server").selectOption(mode);
			await panel(page).getByRole("button", { name: "Review and push 10" }).click();
			await sheet(page).getByRole("button", { name: "Push 10 changes" }).click();
			await expect(sheet(page).getByRole("alert")).toContainText(title);
			// Nothing was sent.
			await expect(page.locator(".change-row[data-status=sending]")).toHaveCount(0);
		});
	}

	test("asks signed-out people to sign in before pushing", async ({ page }) => {
		await page.getByLabel(/^Signed in/).uncheck();
		await panel(page).getByRole("button", { name: "Review 10" }).click();
		await expect(sheet(page).getByRole("link", { name: "Sign in to push" })).toHaveAttribute(
			"href",
			/\/auth\/signin\?return_to=/,
		);
	});
});

test.describe("changes gallery", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/play/changes");
		await expect(page.getByRole("heading", { name: "Changes", exact: true }).first()).toBeVisible();
	});

	const section = (page: Page, name: string) =>
		page
			.locator(".gallery > section")
			.filter({ has: page.getByRole("heading", { name, exact: true }) });

	test("every state renders", async ({ page }) => {
		const bar = section(page, "Top bar");
		await expect(bar.locator(".changes-button")).toHaveCount(5);
		// One with a failure, and the push where one failed.
		await expect(bar.locator(".changes-button[data-failed]")).toHaveCount(2);
		await expect(bar.locator(".changes-button[data-pushing]")).toHaveCount(1);

		const panels = section(page, "Changes panel");
		await expect(panels.locator(".changes-panel")).toHaveCount(6);
		await expect(panels.getByRole("heading", { name: "Nothing staged" })).toBeVisible();

		const marks = section(page, "Marks on shapes");
		await expect(marks.locator("figure")).toHaveCount(13);
		await expect(marks.locator(".staged-ghost")).toHaveCount(4);
		await expect(marks.locator(".staged-flag[data-status=failed]")).toHaveCount(1);
		await expect(marks.locator(".staged-flag[data-included=false]")).toHaveCount(1);
		await expect(marks.locator(".staged-label[data-status=sent]")).toHaveCount(1);
		await expect(marks.locator(".staged-marks[data-highlighted]")).toHaveCount(1);

		const sheets = section(page, "Push sheet");
		await expect(sheets.locator(".push-sheet")).toHaveCount(19);
		for (const title of [
			"Sign in to push",
			"You can stage but not push here",
			"Install the app on these repos",
			"A change needs an issue that isn’t in this push",
			"Someone else is pushing this board",
			"Couldn’t reach Tack",
		]) {
			await expect(sheets.locator(".push-refusal strong", { hasText: title })).toHaveCount(1);
		}
		await expect(sheets.locator(".push-ring[data-done]")).toHaveCount(1);
		await expect(sheets.getByText("No pushes yet")).toBeVisible();
		await expect(sheets.getByText("Couldn’t load the history")).toBeVisible();
	});

	test("both themes render side by side", async ({ page }) => {
		await page.getByLabel("Both themes side by side").check();
		await expect(page.locator(".gallery-pane[data-theme=dark] .push-sheet")).toHaveCount(19);
	});
});

test.describe("changes gallery, in motion", () => {
	test.use({ reducedMotion: "no-preference" });

	test.beforeEach(async ({ page }) => {
		await page.goto("/play/changes");
	});

	test("a change lands on its shape, then its mark goes", async ({ page }) => {
		const next = page.getByRole("button", { name: /^Next status/ });
		const landing = page.locator("figure").filter({ hasText: /Landing: / });
		await next.click();
		await expect(landing.locator("figcaption")).toHaveText("Landing: sending");
		await expect(landing.locator(".staged-label[data-status=sending]")).toHaveCount(1);
		await next.click();
		await next.click();
		await expect(landing.locator(".staged-label[data-status=landed]")).toHaveCount(1);
		// Once it's had its moment, an applied change leaves the shape alone.
		await expect(landing.locator(".staged-label")).toHaveCount(0, { timeout: 8000 });
	});
});
