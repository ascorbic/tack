import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// A list's Discussions mode, on the playground's "Discussions lists" board,
// whose lists search a fake repository's discussions in the browser: switch
// a list over, pick a category, sort by the most upvoted, and read each
// row's category, votes and comments.

const list = (page: Page, title: string) =>
	page
		.locator(".react-flow__node-widget")
		.filter({ has: page.getByRole("heading", { name: title }) });

const titles = (widget: Locator) => widget.locator(".widget-row .widget-row-title");

test.beforeEach(async ({ page }) => {
	await openScenario(page, "discussions");
	// Make room: the controls cover the right of the board.
	await page.getByLabel("Playground controls").evaluate((el) => {
		(el as HTMLElement).style.display = "none";
	});
	await expect(titles(list(page, "Top ideas")).first()).toBeVisible();
});

test("a list switches to discussions, picks a category and sorts by the most upvoted", async ({
	page,
}) => {
	const bugs = list(page, "Open bugs");
	await bugs.getByRole("button", { name: "Edit list" }).click();
	const panel = page.getByRole("dialog", { name: "Edit list" });
	await panel.getByRole("radio", { name: "Discussions" }).click();
	const search = panel.getByRole("textbox", { name: "Search, as written" });
	await expect(search).toHaveValue("repo:acme/unpic is:discussion is:open label:bug");

	// The repository's categories, with their emoji; Ideas takes no answers.
	const categories = panel.getByRole("radiogroup", { name: "Category" });
	await expect(categories.getByRole("radio")).toHaveText([
		"All categories",
		"📣Announcements",
		"💬General",
		"💡Ideas",
		"🙏Q&A",
		"📝RFCs",
		"🙌Show and tell",
	]);
	await categories.getByRole("radio", { name: "Ideas" }).click();
	await expect(panel.getByText("doesn't take answers")).toBeVisible();
	await expect(panel.getByRole("radiogroup", { name: "Answered" })).toHaveCount(0);
	await panel.getByRole("button", { name: "Remove bug" }).click();
	await panel
		.getByRole("radiogroup", { name: "Sort by" })
		.getByRole("radio", { name: "Top" })
		.click();
	await expect(search).toHaveValue("repo:acme/unpic is:discussion is:open category:Ideas");
	await panel.getByRole("button", { name: "Done" }).click();

	// The most upvoted first, each with its category, votes and comments.
	await expect(titles(bugs)).toHaveText([
		"Blurhash placeholders out of the box",
		"A Vite plugin that rewrites <img> at build time",
		"A focal point picker in the docs playground",
		"Detect the CDN from a custom domain's DNS",
		"Art direction: different crops per breakpoint",
	]);
	const first = bugs.locator(".widget-row").first();
	await expect(first.getByRole("img", { name: "Category: Ideas" })).toHaveText("💡");
	await expect(first.locator(".widget-row-upvotes")).toHaveText("Upvotes: 83");
	await expect(first.locator(".widget-row-comments")).toHaveText("Comments: 23");
	await expect(first).toHaveAttribute("data-item", "discussion");
});

test("the controls and the search stay in step, both ways", async ({ page }) => {
	const ideas = list(page, "Top ideas");
	await ideas.getByRole("button", { name: "Edit list" }).click();
	const panel = page.getByRole("dialog", { name: "Edit list" });
	const sort = panel.getByRole("radiogroup", { name: "Sort by" });
	await expect(sort.getByRole("radio", { name: "Top" })).toHaveAttribute("aria-checked", "true");

	// Writing the search moves the controls.
	const search = panel.getByRole("textbox", { name: "Search, as written" });
	await search.fill('repo:acme/unpic is:discussion category:"Q&A" is:open');
	await search.press("Enter");
	const categories = panel.getByRole("radiogroup", { name: "Category" });
	await expect(categories.getByRole("radio", { name: "Q&A" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	// Q&A takes answers: pick the unanswered ones.
	const answered = panel.getByRole("radiogroup", { name: "Answered" });
	await answered.getByRole("radio", { name: "Unanswered", exact: true }).click();
	await expect(search).toHaveValue(
		'repo:acme/unpic is:discussion category:"Q&A" is:open is:unanswered',
	);
	await panel.getByRole("button", { name: "Done" }).click();
	await expect(titles(ideas)).toHaveText([
		"Does unpic work with images behind a signed URL?",
		"Why does provider detection run on every request?",
	]);
	// Answered ones show it on the row: the list of every question.
	await ideas.getByRole("button", { name: "Edit list" }).click();
	await panel
		.getByRole("radiogroup", { name: "Answered" })
		.getByRole("radio", { name: "Answered", exact: true })
		.click();
	await panel.getByRole("button", { name: "Done" }).click();
	await expect(ideas.locator(".widget-row-status").first()).toHaveText("Answered");
});
