import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// The review queue, milestone and stale finder (#43) on the playground's
// "tracking" board, searched in the browser like lists: pull requests come
// out of the queue as cards, the milestone shows its progress and risks,
// and the stale finder's quick actions stage changes (and unstage them).

interface Shape {
	type: string;
	ref?: string;
	widget?: string;
	config?: Record<string, unknown>;
	provenance?: { via: string; source: string };
}

function shapes(page: Page): Promise<(Shape & { id: string })[]> {
	return page.evaluate(() => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return [...board.doc.getMap("shapes").entries()].map(([id, shape]) => ({
			id,
			...((shape as import("yjs").Map<unknown>).toJSON() as Shape),
		}));
	});
}

function changes(page: Page): Promise<{ op: Record<string, unknown>; status: string }[]> {
	return page.evaluate(() => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return [...board.doc.getMap("changes").values()].map(
			(change) => (change as import("yjs").Map<unknown>).toJSON() as never,
		);
	});
}

const widget = (page: Page, title: string) =>
	page
		.locator(".react-flow__node-widget")
		.filter({ has: page.getByRole("heading", { name: title, exact: true }) });

const row = (scope: Locator, text: string) => scope.locator(".widget-row", { hasText: text });

// Room for the whole board, quick actions and all.
test.use({ viewport: { width: 1440, height: 960 } });

test.beforeEach(async ({ page }) => {
	await openScenario(page, "tracking");
	// Make room: the controls cover the right of the board.
	await page.getByLabel("Playground controls").evaluate((el) => {
		(el as HTMLElement).style.display = "none";
	});
	await expect(
		row(widget(page, "Waiting on your review"), "Drop the legacy URL parser"),
	).toBeVisible();
});

test("the review queue puts the oldest first, with age, size, CI and reviews", async ({ page }) => {
	const queue = widget(page, "Waiting on your review");
	await expect(queue.locator(".widget-count")).toHaveText("6");
	const titles = await queue.locator(".widget-row-title").allTextContents();
	expect(titles[0]).toBe("Drop the legacy URL parser");
	expect(titles.at(-1)).toBe("Retry provider detection on timeouts");
	// Approved, and not asked of you: not in your queue.
	await expect(row(queue, "Bump sharp")).toHaveCount(0);
	await expect(queue.locator(".review-stat").first()).toHaveText("Oldest 12d");
	const preload = row(queue, "Preload the LCP image");
	await expect(preload.locator(".review-age")).toHaveText("5d");
	await expect(preload.locator(".review-size")).toHaveText("M");
	await expect(preload.locator(".review-ci")).toHaveAttribute("data-ci", "failing");
	await expect(row(queue, "Drop the legacy URL parser")).toHaveAttribute(
		"data-standing",
		"changes",
	);
	// The team's queue is the team's.
	await expect(widget(page, "Waiting on @acme/maintainers").locator(".widget-count")).toHaveText(
		"3",
	);
});

test("a pull request drags out of the queue as a card", async ({ page }) => {
	const queue = widget(page, "Waiting on your review");
	const pull = row(queue, "Export the transformer types");
	const box = await pull.boundingBox();
	if (!box) throw new Error("no row");
	await page.mouse.move(box.x + 40, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(box.x + 60, box.y + 30, { steps: 4 });
	// Somewhere empty: below the milestone, to the right of the card there.
	const milestone = await widget(page, "5.0").boundingBox();
	if (!milestone) throw new Error("no milestone");
	await page.mouse.move(milestone.x + milestone.width - 40, milestone.y + milestone.height + 40, {
		steps: 12,
	});
	await expect(page.locator(".widget-ghost")).toBeVisible();
	await page.mouse.up();
	const all = await shapes(page);
	const card = all.find((s) => s.type === "card" && s.ref?.endsWith("#463"));
	const source = all.find((s) => s.widget === "review" && s.config?.scope === "me");
	expect(card?.provenance).toEqual({ via: "list", source: source?.id });
	await expect(pull.locator(".widget-row-marker")).toBeVisible();
});

test("the milestone shows progress, pace, a burn-up and what's at risk", async ({ page }) => {
	const milestone = widget(page, "5.0");
	await expect(milestone.locator(".milestone-ring")).toHaveAttribute("aria-label", "63% done");
	await expect(milestone.locator(".milestone-done")).toHaveText("10 of 16 done");
	await expect(milestone.locator(".milestone-due-line")).toContainText("Due in 18 days");
	await expect(milestone.locator(".milestone-forecast")).toContainText("on track");
	const risks = milestone.getByRole("list", { name: "At risk" });
	await expect(risks.locator(".widget-row")).toHaveCount(3);
	await expect(row(risks, "Remove the deprecated layout values")).toContainText("Blocked");
	await expect(row(risks, "Rewrite provider detection")).toContainText("Quiet 21d");
	// It's on the board already: its row shows the pin.
	await expect(
		row(risks, "Remove the deprecated layout values").locator(".widget-row-marker"),
	).toBeVisible();
	// Scrub the chart to read a day.
	await milestone.locator(".milestone-plot").hover({ position: { x: 120, y: 40 } });
	await expect(milestone.locator(".milestone-tip")).toContainText("done");
});

test("the stale finder groups by age, and its quick actions stage changes", async ({ page }) => {
	const finder = widget(page, "Quiet for 30 days+");
	await expect(finder.locator(".widget-count")).toHaveText("8");
	await expect(finder.locator(".stale-group-title")).toHaveText([
		"30 days – 2 months",
		"2–4 months",
		"4 months+",
	]);
	const imgix = row(finder, "Imgix: respect fit=facearea");
	await expect(imgix).toContainText("quiet 52 days");

	await imgix.hover();
	await imgix.getByRole("button", { name: /as not planned/ }).click();
	await expect(imgix.locator(".stale-staged")).toHaveText("Closing");
	await expect(imgix).toHaveAttribute("data-closing", "true");
	expect(await changes(page)).toEqual([
		expect.objectContaining({
			status: "staged",
			op: expect.objectContaining({
				kind: "item.state",
				state: "closed",
				reason: "not_planned",
				target: { key: "fake.tack/acme/imagekit#287" },
			}),
		}),
	]);

	await imgix.hover();
	await imgix.getByRole("button", { name: /still wanted/ }).click();
	await expect(imgix.locator(".stale-staged")).toHaveText(["Closing", "Pinging"]);
	const comment = (await changes(page)).find((c) => c.op.kind === "item.comment");
	expect(comment?.op.body).toMatch(/^@priya: this issue has been quiet for 52 days/);

	const cli = row(finder, "A CLI for generating srcsets");
	await cli.hover();
	await cli.getByRole("button", { name: /Label/ }).click();
	expect((await changes(page)).find((c) => c.op.kind === "item.labels")?.op).toMatchObject({
		add: ["stale"],
		target: { key: "fake.tack/acme/imagekit#301" },
	});

	// Unstaged from the row.
	await imgix.getByRole("button", { name: /Unstage: closing/ }).click();
	await expect(imgix.locator(".stale-staged")).toHaveText(["Pinging"]);
	expect((await changes(page)).some((c) => c.op.kind === "item.state")).toBe(false);

	// A whole group at once.
	const group = finder.getByRole("group", { name: "30 days – 2 months" });
	await group.hover();
	await group.getByRole("button", { name: "Close all 4" }).click();
	expect((await changes(page)).filter((c) => c.op.kind === "item.state")).toHaveLength(4);
});

test("zoomed out, each reads as one big number", async ({ page }) => {
	await page.locator(".react-flow__pane").click({ position: { x: 720, y: 60 } });
	// Below cards' compact zoom (0.45).
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press("-");
		// Each step animates; the next starts from where it ends.
		await page.waitForTimeout(250);
	}
	await expect(page.locator(".widget[data-compact]")).toHaveCount(4);
	await expect(widget(page, "Waiting on your review").locator(".kind-far-number")).toHaveText(
		"6",
	);
	await expect(widget(page, "Quiet for 30 days+").locator(".kind-far-number")).toHaveText("8");
	await expect(widget(page, "5.0").locator(".milestone-far")).toContainText("10 of 16 done");
});

test("the widget tool adds each kind, set up from the board's repository", async ({ page }) => {
	const before = (await shapes(page)).filter((s) => s.type === "widget").length;

	// A milestone offers the repository's milestones right in its body.
	await page.keyboard.press("w");
	await page
		.getByRole("group", { name: "Widgets" })
		.getByRole("button", { name: /^Milestone/ })
		.click();
	const fresh = widget(page, "Milestone");
	await expect(fresh.getByText("Which milestone?")).toBeVisible();
	await page.keyboard.press("Escape");
	await fresh.getByRole("listitem").filter({ hasText: "5.1" }).click();
	await expect(widget(page, "5.1").getByText("Nothing in this milestone yet")).toBeVisible();

	// A stale finder starts from a ready-made search.
	await page.keyboard.press("w");
	await page
		.getByRole("group", { name: "Widgets" })
		.getByRole("button", { name: /^Stale finder/ })
		.click();
	const panel = page.getByRole("dialog", { name: "Edit stale finder" });
	await expect(panel).toBeVisible();
	await panel.getByRole("button", { name: "Open issues in imagekit" }).click();
	await panel.getByRole("radio", { name: "2 months" }).click();
	await panel.getByRole("button", { name: "Done" }).click();
	const quiet = page
		.locator(".react-flow__node-widget")
		.filter({ has: page.getByRole("heading", { name: "Quiet for 2 months+" }) });
	await expect(row(quiet, "Art direction with the picture element")).toBeVisible();
	await expect(row(quiet, "Imgix")).toHaveCount(0);

	expect((await shapes(page)).filter((s) => s.type === "widget").length).toBe(before + 2);
});

test("the gallery shows every review queue, milestone and stale finder state", async ({ page }) => {
	await page.goto("/play/widgets");
	for (const state of [
		"review-live",
		"review-repo",
		"review-loading",
		"review-unconfigured",
		"review-clear",
		"review-stale",
		"review-signed-out",
		"review-rate-limited",
		"review-far",
		"milestone-live",
		"milestone-late",
		"milestone-overdue",
		"milestone-done",
		"milestone-loading",
		"milestone-unconfigured",
		"milestone-empty",
		"milestone-error",
		"milestone-far",
		"stale-live",
		"stale-view-only",
		"stale-loading",
		"stale-unconfigured",
		"stale-clear",
		"stale-invalid",
		"stale-far",
		"review-config",
		"milestone-config",
		"milestone-config-loading",
		"stale-config",
	]) {
		await expect(page.locator(`figure[data-state="${state}"]`)).toBeVisible();
	}
	for (const text of [
		"Whose reviews?",
		"All caught up",
		"Sign in to see this queue",
		"Which milestone?",
		"Nothing in this milestone yet",
		"Couldn't load this milestone",
		"What should it look through?",
		"Nothing's gone quiet",
	]) {
		await expect(page.getByText(text).first()).toBeVisible();
	}
	await expect(page.locator('[data-state="milestone-late"] .milestone-forecast')).toHaveAttribute(
		"data-late",
		"true",
	);
	await expect(page.locator('[data-state="milestone-done"] .milestone-ring')).toHaveAttribute(
		"data-complete",
		"true",
	);
	await expect(page.locator(".widget[data-compact]")).toHaveCount(3);
	// The stale finder's quick actions work in the gallery too.
	const live = page.locator('[data-state="stale-live"]');
	const cli = row(live, "A CLI for generating srcsets");
	await cli.hover();
	await cli.getByRole("button", { name: /as not planned/ }).click();
	await expect(cli.locator(".stale-staged")).toHaveText("Closing");
});
