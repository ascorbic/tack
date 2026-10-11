import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Widgets (#37, #38, #39) on the playground's "Widgets" board, whose lists
// search a fake repository in the browser: rows are pulled out as cards,
// rows and cards light each other up, and cards dropped on a list stage
// what makes them match.

interface Shape {
	type: string;
	ref?: string;
	widget?: string;
	config?: { q?: string; title?: string };
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

const list = (page: Page, title: string) =>
	page
		.locator(".react-flow__node-widget")
		.filter({ has: page.getByRole("heading", { name: title }) });

const row = (widget: Locator, text: string) => widget.locator(".widget-row", { hasText: text });

/** Drag with the mouse in steps, as a person would. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
	const box = await from.boundingBox();
	if (!box) throw new Error("nothing to drag");
	await page.mouse.move(box.x + 40, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(box.x + 60, box.y + 30, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 12 });
	await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
	await openScenario(page, "widgets");
	// Make room: the controls cover the right of the board.
	await page.getByLabel("Playground controls").evaluate((el) => {
		(el as HTMLElement).style.display = "none";
	});
	await expect(row(list(page, "Open bugs"), "Netlify provider")).toBeVisible();
});

test("lists show their search's matches, with a marker for what's on the board", async ({
	page,
}) => {
	const bugs = list(page, "Open bugs");
	await expect(bugs.locator(".widget-count")).toHaveText("6");
	await expect(bugs.locator(".widget-chip").first()).toHaveText("repo:acme/imagekit");
	// #431 is on the board already.
	await expect(row(bugs, "Cloudinary URLs").locator(".widget-row-marker")).toBeVisible();
	await expect(row(bugs, "Netlify provider").locator(".widget-row-marker")).toHaveCount(0);
	// A search for words that finds nothing says to check it, not to wait.
	await expect(list(page, "Mentions flaky").getByText("Nothing matches this search")).toBeVisible();
});

test("a list's settings open wholly on screen, beside it, even on the right-hand edge", async ({
	page,
}) => {
	// At 1280×800 the "Needs triage" list is in the right-hand column: its
	// panel used to open as a sliver off the right edge, above the top bar.
	const triage = list(page, "Needs triage");
	await triage.getByRole("button", { name: "Edit list" }).click();
	const panel = page.getByRole("dialog", { name: "Edit list" });
	await expect(panel).toBeVisible();
	const canvas = (await page.locator(".react-flow").boundingBox())!;
	const box = (await panel.boundingBox())!;
	const widget = (await triage.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(canvas.x);
	expect(box.y).toBeGreaterThanOrEqual(canvas.y);
	expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width);
	expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height);
	// To its left, since there's no room on its right.
	expect(box.x + box.width).toBeLessThanOrEqual(widget.x);
	await expect(panel.getByRole("button", { name: "Done" })).toBeInViewport();

	// It follows the list as the board pans.
	const before = (await triage.boundingBox())!;
	await page.mouse.move(20, 300);
	await page.mouse.wheel(0, 120);
	await expect.poll(async () => (await triage.boundingBox())?.y !== before.y).toBe(true);
	const moved = (await panel.boundingBox())!;
	const after = (await triage.boundingBox())!;
	expect(moved.x + moved.width).toBeLessThanOrEqual(after.x);
	expect(moved.y).toBeGreaterThanOrEqual(canvas.y);
});

test("pointing at a row lights its card, and the other way round", async ({ page }) => {
	const bugs = list(page, "Open bugs");
	await row(bugs, "Cloudinary URLs").hover();
	await expect(page.locator(".card-link[data-linked]")).toHaveCount(1);
	await page.mouse.move(5, 400);
	await expect(page.locator(".card-link[data-linked]")).toHaveCount(0);

	await page.locator(".react-flow__node-card", { hasText: "imagekit #431" }).hover();
	await expect(row(bugs, "Cloudinary URLs")).toHaveAttribute("data-linked", "true");
});

test("rows drag out onto the board as cards from the list", async ({ page }) => {
	const bugs = list(page, "Open bugs");
	const before = (await shapes(page)).filter((s) => s.type === "card").length;
	const widget = (await shapes(page)).find((s) => s.config?.title === "Open bugs");
	await drag(page, row(bugs, "Netlify provider"), { x: 640, y: 680 });

	await expect
		.poll(async () => (await shapes(page)).filter((s) => s.type === "card").length)
		.toBe(before + 1);
	const card = (await shapes(page)).find((s) => s.ref === "fake.tack/acme/imagekit#430");
	expect(card?.provenance).toEqual({ via: "list", source: widget?.id });
	// The list keeps its row, which now shows it's on the board.
	await expect(row(bugs, "Netlify provider").locator(".widget-row-marker")).toBeVisible();
	await expect(page.locator(".widget-ghost")).toHaveCount(0);
});

test("a clicked row, or Enter on one, adds its card beside the list, then shows it", async ({
	page,
}) => {
	const bugs = list(page, "Open bugs");
	const cards = async () => (await shapes(page)).filter((s) => s.type === "card");
	const before = (await cards()).length;
	const widget = (await shapes(page)).find((s) => s.config?.title === "Open bugs");

	// A click is a button press, not a drag: the card lands beside the list.
	const netlify = row(bugs, "Netlify provider");
	await expect(netlify).toHaveAttribute("role", "button");
	await netlify.click();
	await expect.poll(async () => (await cards()).length).toBe(before + 1);
	const card = (await shapes(page)).find((s) => s.ref === "fake.tack/acme/imagekit#430");
	expect(card?.provenance).toEqual({ via: "list", source: widget?.id });
	await expect(netlify.locator(".widget-row-marker")).toBeVisible();
	await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);

	// Clicked again, it's already there: shown, not added twice.
	await netlify.click();
	await page.waitForTimeout(200);
	expect((await cards()).length).toBe(before + 1);

	// The keyboard does the same: Tab to a row, Enter.
	const next = bugs
		.locator(".widget-row[data-activatable]")
		.filter({ hasNot: page.locator(".widget-row-marker") })
		.first()
		.getByRole("button", { name: /Enter to add it/ });
	await next.focus();
	await page.keyboard.press("Enter");
	await expect.poll(async () => (await cards()).length).toBe(before + 2);
	// And one undo takes it back off.
	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(async () => (await cards()).length).toBe(before + 1);
});

test("a row dropped back on its list goes home", async ({ page }) => {
	const bugs = list(page, "Open bugs");
	const before = (await shapes(page)).length;
	const box = await bugs.boundingBox();
	await drag(page, row(bugs, "Netlify provider"), {
		x: (box?.x ?? 0) + 150,
		y: (box?.y ?? 0) + 300,
	});
	await expect(page.locator(".widget-ghost")).toHaveCount(0);
	expect((await shapes(page)).length).toBe(before);
});

test("cards dropped on a list stage what makes them match, then push into it", async ({ page }) => {
	const firstIssues = list(page, "Good first issues");
	const card = page.locator(".react-flow__node-card", { hasText: "Benchmarks in CI" });
	const start = await card.boundingBox();
	const target = await firstIssues.boundingBox();
	if (!start || !target) throw new Error("no boxes");

	await page.mouse.move(start.x + 40, start.y + 14);
	await page.mouse.down();
	await page.mouse.move(start.x + 60, start.y + 30, { steps: 4 });
	await page.mouse.move(target.x + 180, target.y + 200, { steps: 14 });
	// While it's over the list, the list says what dropping it would do.
	await expect(firstIssues.locator(".widget-drop")).toContainText("Add good first issue");
	await page.mouse.up();

	const confirm = page.getByRole("dialog", { name: "Make #425 match" });
	await expect(confirm).toBeVisible();
	// The card glides back where it was.
	await expect
		.poll(async () => Math.round((await card.boundingBox())?.y ?? 0))
		.toBe(Math.round(start.y));
	await confirm.getByRole("button", { name: "Stage 1 change" }).click();
	await expect(confirm).toHaveCount(0);
	await expect(page.locator(".toast")).toContainText("Staged 1 change so #425 matches");
	expect((await changes(page)).map((c) => c.op)).toEqual([
		{
			kind: "item.labels",
			target: { key: "fake.tack/acme/imagekit#425" },
			add: ["good first issue"],
		},
	]);

	// Pushing it from the changes panel (to the playground's pretend forge)
	// brings it into the list.
	await page.getByRole("button", { name: /^Changes/ }).click();
	await page
		.getByRole("complementary", { name: "Pending changes" })
		.getByRole("button", { name: "Review and push 1" })
		.click();
	await page.getByRole("button", { name: "Push 1 change" }).click();
	await expect(row(firstIssues, "Benchmarks in CI")).toBeVisible();
});

test("a list that searches for words says why cards can't be dropped on it", async ({ page }) => {
	const flaky = list(page, "Mentions flaky");
	const card = page.locator(".react-flow__node-card", { hasText: "Benchmarks in CI" });
	const start = await card.boundingBox();
	const target = await flaky.boundingBox();
	if (!start || !target) throw new Error("no boxes");
	await page.mouse.move(start.x + 40, start.y + 14);
	await page.mouse.down();
	await page.mouse.move(start.x + 60, start.y + 30, { steps: 4 });
	await page.mouse.move(target.x + 180, target.y + 120, { steps: 14 });
	await expect(flaky.locator(".widget-drop")).toContainText("Can't make it match");
	await page.mouse.up();
	await expect(page.getByRole("dialog", { name: "Can't make it match" })).toContainText("“flaky”");
	await page
		.getByRole("dialog", { name: "Can't make it match" })
		.getByRole("button", { name: "OK" })
		.click();
	expect(await changes(page)).toEqual([]);
});

test("the widget tool adds lists, ready-made or to set up", async ({ page }) => {
	const before = (await shapes(page)).filter((s) => s.type === "widget").length;
	await page.keyboard.press("w");
	const picker = page.getByRole("group", { name: "Widgets" });
	await picker.getByRole("button", { name: "Open pull requests" }).click();
	await expect(list(page, "Open pull requests")).toBeVisible();
	await expect(row(list(page, "Open pull requests"), "Cache provider detection")).toBeVisible();
	// In free space, not on top of the lists already in the middle of the view.
	await settleCanvas(page);
	const added = (await list(page, "Open pull requests").boundingBox())!;
	for (const other of await page
		.locator(".react-flow__node-widget, .react-flow__node-section")
		.filter({ hasNot: page.getByRole("heading", { name: "Open pull requests" }) })
		.all()) {
		const box = (await other.boundingBox())!;
		const overlaps =
			added.x < box.x + box.width &&
			box.x < added.x + added.width &&
			added.y < box.y + box.height &&
			box.y < added.y + added.height;
		expect(overlaps, "the new list covers another shape").toBe(false);
	}

	// A blank one opens its panel to be set up.
	await page.keyboard.press("w");
	await page.getByRole("group", { name: "Widgets" }).getByRole("button", { name: /^List/ }).click();
	const panel = page.getByRole("dialog", { name: "Edit list" });
	await expect(panel).toBeVisible();
	await panel.getByLabel("Search").fill("repo:acme/imagekit is:open label:docs");
	await panel.getByLabel("Search").press("Enter");
	await expect(list(page, "Open items labelled docs in imagekit")).toBeVisible();
	expect((await shapes(page)).filter((s) => s.type === "widget").length).toBe(before + 2);
});

test("a search in plain words gets a suggestion of what it meant", async ({ page }) => {
	await page.keyboard.press("w");
	await page.getByRole("group", { name: "Widgets" }).getByRole("button", { name: /^List/ }).click();
	const panel = page.getByRole("dialog", { name: "Edit list" });
	await panel.getByLabel("Search").fill("bugs in imagekit");
	await panel.getByLabel("Search").press("Enter");
	// Read as GitHub reads it, it's three words, everywhere: nothing, ever.
	await expect(panel.locator(".query-hint")).toContainText("Did you mean");
	await expect(panel.getByLabel("Suggestion")).toContainText("repo:acme/imagekitlabel:bug");
	await expect(panel.locator(".query-hint")).toContainText("“bugs” as the bug label");
	const words = list(page, "Items mentioning “bugs in imagekit”");
	await expect(words.getByText("Nothing matches this search")).toBeVisible();

	await panel.getByRole("button", { name: "Use this" }).click();
	await expect(panel.getByLabel("Search")).toHaveValue("repo:acme/imagekit label:bug");
	await expect(panel.locator(".query-hint")).toHaveCount(0);
	const bugs = list(page, "Items labelled bug in imagekit");
	await expect(row(bugs, "Netlify provider")).toBeVisible();
});

test("the gallery shows every widget state", async ({ page }) => {
	await page.goto("/play/widgets");
	await expect(page.getByRole("heading", { name: "Widgets", exact: true })).toBeVisible();
	await expect(page.locator(".widget-list")).toHaveCount(19);
	for (const text of [
		"What should this list show?",
		"Nothing matches, yet",
		"Nothing matches this search",
		"Sign in to see this list",
		"GitHub needs a breather",
		"GitHub couldn't read this search",
		"Couldn't load this list",
		"Drop to make it match",
		"Already matches",
		"Can't make it match",
	]) {
		await expect(page.getByText(text).first()).toBeVisible();
	}
	await expect(page.locator(".widget-list[data-stale]")).toHaveCount(1);
	const listPanels = page.locator(
		'section:has(> h2:text-is("Setting up")), section:has(> h2:text-is("Drop to match"))',
	);
	await expect(listPanels.locator(".widget-config")).toHaveCount(7);
	await page.getByRole("button", { name: "Simulate an update" }).click();
	await expect(
		page.locator('[data-state="live-update"] .widget-row[data-motion="enter"]'),
	).toHaveCount(1);
});

test("a short widget's empty state fits, without its illustration", async ({ page }) => {
	const flaky = list(page, "Mentions flaky");
	await expect(flaky.locator(".widget-empty-title")).toHaveText("Nothing matches this search");
	await expect(flaky.locator(".widget-empty-icon")).toBeHidden();
	const fits = await flaky.evaluate((node) => {
		const body = node.querySelector<HTMLElement>(".widget-body")!;
		return body.scrollHeight <= body.clientHeight;
	});
	expect(fits).toBe(true);
});

test("a list's whole search shows when you point at its chips, to copy or run on GitHub", async ({
	page,
}) => {
	const bugs = list(page, "Open bugs");
	await bugs.locator(".widget-query").hover();
	const peek = bugs.getByRole("tooltip");
	await expect(peek).toBeVisible();
	const q = (await shapes(page)).find((s) => s.config?.title === "Open bugs")?.config?.q ?? "";
	await expect(peek).toContainText(q);
	await expect(peek.getByRole("button", { name: "Copy" })).toBeVisible();
});
