import type { Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Action items (#52) and templates (#53): ticking, owners, due dates and
// issues on the playground; carrying over; a template's steps; and on the
// real dev server, boards made from templates, saved as templates, and the
// open action items of one retro carried into the next.

const run = Date.now().toString(36);

test.beforeEach(async ({ page }) => {
	// Hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

const item = (page: Page, text: string) => page.locator(".action-item").filter({ hasText: text });

test.describe("action items on the playground", () => {
	test("tick, pick an owner and a due date, and link an issue", async ({ page }) => {
		await openScenario(page, "actions");
		await expect(page.locator(".react-flow__node-action")).toHaveCount(10);
		await expect(page.locator(".action-item[data-due=overdue]")).toHaveCount(2);
		await expect(item(page, "Cache provider lookups")).toHaveAttribute("data-status", "done");

		const plan = item(page, "Write up the caching plan");
		await plan.getByRole("checkbox").click();
		await expect(plan).toHaveAttribute("data-status", "done");
		await plan.getByRole("checkbox").click();
		await expect(plan).toHaveAttribute("data-status", "open");

		await plan.getByRole("button", { name: /^Due/ }).click();
		await page
			.getByRole("dialog", { name: "Due date" })
			.getByRole("button", { name: "Tomorrow" })
			.click();
		await expect(plan.getByRole("button", { name: /^Due/ })).toHaveText("Tomorrow");
		await expect(plan).toHaveAttribute("data-due", "soon");

		await plan.getByRole("button", { name: /^Owner/ }).click();
		const owners = page.getByRole("dialog", { name: "Owner" });
		await owners.getByRole("combobox").fill("kai");
		await owners.getByRole("combobox").press("Enter");
		await expect(plan.getByRole("button", { name: /^Owner/ })).toHaveText("Kai");

		await plan.getByRole("button", { name: "Link an issue, or make one" }).click();
		const issue = page.getByRole("dialog", { name: "Issue" });
		await issue.getByRole("textbox", { name: "Issue" }).fill("#431");
		await issue.getByRole("button", { name: "Link", exact: true }).click();
		await expect(plan.getByRole("button", { name: /^Linked to #431/ })).toBeVisible();
		await expect(page.locator(".toast[data-leaving=false]")).toContainText("Linked to #431");

		// Linked: ticking stages closing the issue, and ticking again takes it back.
		await plan.getByRole("checkbox").click();
		await expect(plan).toHaveAttribute("data-pending", "close");
		await expect(page.locator(".toast[data-leaving=false]")).toContainText("Staged closing #431");
		await plan.getByRole("checkbox").click();
		await expect(plan).not.toHaveAttribute("data-pending", "close");
	});

	test("stage a new issue assigned to the owner, and push it", async ({ page }) => {
		await openScenario(page, "actions");
		const test = item(page, "Pair on the flaky upload test");
		await test.getByRole("button", { name: "Link an issue, or make one" }).click();
		const issue = page.getByRole("dialog", { name: "Issue" });
		await expect(issue).toContainText("Assigned to @kai");
		await issue.getByRole("button", { name: "Stage issue" }).click();
		await expect(test.getByRole("button", { name: /New issue in/ })).toBeVisible();
		await expect(page.locator(".toast[data-leaving=false]")).toContainText("assigned to @kai");

		// Pushed: the item follows the new issue.
		await page.getByRole("button", { name: /^Changes/ }).click();
		await page.getByRole("button", { name: /^Review and push/ }).click();
		await page.getByRole("button", { name: /^Push \d+ change/ }).click();
		await expect(test.getByRole("button", { name: /^Linked to/ })).toBeVisible({ timeout: 10_000 });
	});

	test("stickies become action items, and the open ones carry over", async ({ page }) => {
		await openScenario(page, "actions");
		await page
			.locator(".react-flow__node-sticky")
			.filter({ hasText: "Retire the old docs site" })
			.click();
		await page.getByRole("button", { name: "Make an action item" }).click();
		await expect(item(page, "Retire the old docs site")).toBeVisible();
		await expect(page.locator(".toast[data-leaving=false]")).toContainText("Made an action item");

		await item(page, "Rotate the CDN keys").locator(".action-item-text").click();
		await item(page, "Ask upstream about AVIF")
			.locator(".action-item-text")
			.click({ modifiers: ["Shift"] });
		await page.getByRole("button", { name: "Carry the open ones over to another board" }).click();
		const carry = page.getByRole("dialog", { name: /Carry/ });
		await expect(carry).toContainText("2 open action items");
		await carry.getByRole("option", { name: /Retro, November/ }).click();
		await carry.getByRole("button", { name: "Carry 2 over" }).click();
		await expect(page.locator(".toast[data-leaving=false]")).toContainText(
			"Carried 2 action items over to “Retro, November”",
		);
	});

	test("a template's steps start from the Facilitate menu", async ({ page }) => {
		await openScenario(page, "template-retro");
		await expect(page.locator(".react-flow__minimap-node.minimap-section")).toHaveCount(5);
		await page.getByRole("button", { name: /^Facilitate/ }).click();
		const menu = page.getByRole("dialog", { name: "Facilitate" });
		await expect(menu.getByRole("region", { name: "Ready to start" })).toContainText("0 of 5");
		await menu.getByRole("button", { name: "Start: Write on your own" }).click();
		// One round of silent writing, over all three columns.
		await expect(page.locator(".section-silent")).toBeVisible();
		await expect(page.locator(".timer")).toBeVisible();
		await page.getByRole("button", { name: /^Facilitate/ }).click();
		await expect(menu.getByRole("region", { name: "Ready to start" })).toContainText("1 of 5");
	});

	for (const scenario of ["planning", "triage", "release", "roadmap", "incident"]) {
		test(`the ${scenario} template lays out`, async ({ page }) => {
			await openScenario(page, `template-${scenario}`);
			expect(
				await page.locator(".react-flow__minimap-node.minimap-section").count(),
			).toBeGreaterThan(1);
			await expect(page.locator(".react-flow__node-text").first()).toBeVisible();
		});
	}
});

test("every action item and template state renders", async ({ page }) => {
	await page.goto("/play/templates");
	await expect(page.getByRole("heading", { name: "Action items and templates" })).toBeVisible();
	for (const state of ["later", "soon", "today", "overdue", "done"]) {
		await expect(page.locator(`figure[data-state=${state}] .action-item`)).toHaveAttribute(
			"data-due",
			state === "done" ? "none" : state,
		);
	}
	await expect(page.locator("figure[data-state=pending-close] .action-item")).toHaveAttribute(
		"data-pending",
		"close",
	);
	await expect(page.locator("figure[data-state=failed]")).toContainText("Issue failed");
	await expect(page.locator("figure[data-state=carried]")).toContainText("From Retro, September");
	await expect(page.locator("figure[data-state=due-picker] .calendar-day")).not.toHaveCount(0);
	await expect(page.locator("figure[data-state=carry] .action-option")).toHaveCount(3);
	await expect(page.locator("figure[data-state=prepared-started]")).toContainText("2 of 5");
	await expect(page.locator("figure[data-state=prepared-days]")).toContainText("Dot vote · 3 days");
	await expect(page.locator("figure[data-state^=preview-] svg")).toHaveCount(6);
	await expect(page.locator("figure[data-state=picker-loading] .template-skeleton")).toHaveCount(3);
	await expect(page.locator("figure[data-state=picker-empty]")).toContainText("Nothing yet");
	await expect(
		page.locator("figure[data-state=picker-saved] .template-saved .template-tile"),
	).toHaveCount(2);
	await expect(page.locator("figure[data-state=picker-saved-chosen] .repo-chip")).toHaveCount(2);
	await expect(page.locator("figure[data-state=picker-error]")).toContainText(
		"Couldn’t reach Tack",
	);
	await expect(page.locator("figure[data-state=saved]")).toContainText("Saved as a template");
});

test.describe.serial("templates on real boards", () => {
	const login = `e2e-templates-${run}`;
	let retro = "";

	test("make a retro from its template, with action items", async ({ page }) => {
		await page.goto(`/auth/dev?login=${login}&return_to=/`);
		await page.getByRole("button", { name: "Create your first board" }).click();
		const picker = page.getByRole("dialog", { name: "New board" });
		await expect(picker.getByRole("option", { name: /^Planning session/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await picker.locator('[data-template="tack:retro"]').click();
		await picker.getByLabel("Name").fill(`Retro one ${run}`);
		await picker.getByRole("button", { name: "Create board" }).click();
		await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/retro-one/, { timeout: 15_000 });
		retro = page.url();
		await expect(page.locator(".react-flow__minimap-node.minimap-section")).toHaveCount(5, {
			timeout: 15_000,
		});
		await expect(page.getByRole("button", { name: /^Facilitate/ })).toHaveAttribute(
			"data-ready",
			"true",
		);

		// An action item in Actions, which stays open.
		// Click in the Actions section, under its prompt, once the board has
		// fitted itself to the template.
		await page.waitForTimeout(1000);
		await settleCanvas(page);
		// Click in the Actions section, under its prompt.
		const prompt = page
			.locator(".react-flow__node-text")
			.filter({ hasText: "What will we change?" });
		const box = await prompt.boundingBox();
		if (!box) throw new Error("no Actions section");
		await page.getByRole("button", { name: "Action item", exact: true }).click();
		await page.mouse.click(box.x + 60, box.y + box.height + 120);
		await page.keyboard.type("Fix the flaky deploy");
		await page.keyboard.press("Enter");
		await expect(item(page, "Fix the flaky deploy")).toBeVisible();
		// Saved with the board before moving on.
		await page.waitForTimeout(2500);
	});

	test("the next retro brings its open action items along", async ({ page }) => {
		await page.goto(`/auth/dev?login=${login}&return_to=/`);
		await page.getByRole("button", { name: "New board" }).click();
		const picker = page.getByRole("dialog", { name: "New board" });
		await picker.locator('[data-template="tack:retro"]').click();
		await picker.getByLabel("Name").fill(`Retro two ${run}`);
		await picker
			.getByLabel("Bring open action items from")
			.selectOption({ label: `Retro one ${run}` });
		await picker.getByRole("button", { name: "Create board" }).click();
		await expect(page).toHaveURL(/\/retro-two/, { timeout: 15_000 });
		await expect(item(page, "Fix the flaky deploy")).toContainText(`From Retro one ${run}`, {
			timeout: 15_000,
		});
	});

	test("save a board as a template, start from it, and delete it", async ({ page }) => {
		await page.goto(
			`/auth/dev?login=${login}&return_to=${encodeURIComponent(new URL(retro).pathname)}`,
		);
		await page.getByRole("button", { name: "Board menu" }).click();
		await page.getByRole("menuitem", { name: "Save as template…" }).click();
		const save = page.getByRole("dialog", { name: "Save as template" });
		await save.getByLabel("Name").fill(`Our retro ${run}`);
		await save.getByRole("button", { name: "Save template" }).click();
		await expect(page.locator(".save-template-done")).toContainText("Saved as a template");
		await page.getByRole("link", { name: "Make a board from it" }).click();

		const picker = page.getByRole("dialog", { name: "New board" });
		const tile = picker.locator(".template-tile", { hasText: `Our retro ${run}` });
		await expect(tile).toHaveAttribute("aria-selected", "true");
		await picker.getByRole("button", { name: "Create board" }).click();
		await expect(page).toHaveURL(/\/our-retro/, { timeout: 15_000 });
		await expect(page.locator(".react-flow__minimap-node.minimap-section")).toHaveCount(5, {
			timeout: 15_000,
		});
		// Just the structure: no action items came with it.
		await expect(page.locator(".react-flow__node-action")).toHaveCount(0);

		await page.goto("/");
		await page.getByRole("button", { name: "New board" }).click();
		await picker.locator(".template-tile", { hasText: `Our retro ${run}` }).click();
		await picker.getByRole("button", { name: "Delete template" }).click();
		await picker.getByRole("button", { name: "Delete", exact: true }).click();
		await expect(picker.locator(".template-tile", { hasText: `Our retro ${run}` })).toHaveCount(0);
	});

	test("a triage board reads the repository it's made with", async ({ page }) => {
		await page.goto(`/auth/dev?login=${login}&return_to=/`);
		await page.getByRole("button", { name: "New board" }).click();
		const picker = page.getByRole("dialog", { name: "New board" });
		await picker.locator('[data-template="tack:triage"]').click();
		await expect(picker.getByRole("button", { name: "Create board" })).toBeDisabled();
		await picker.getByLabel(/^Repositor/).fill("fake.tack/acme/widgets");
		await picker.getByLabel(/^Repositor/).press("Enter");
		await expect(picker.locator(".repo-chip")).toHaveText(/acme\/widgets/);
		await picker.getByRole("button", { name: "Create board" }).click();
		await expect(page).toHaveURL(/\/triage/, { timeout: 15_000 });
		await expect(page.getByRole("button", { name: /^Rules/ })).toContainText("2", {
			timeout: 15_000,
		});
	});
});
