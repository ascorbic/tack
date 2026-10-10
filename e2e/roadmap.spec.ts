import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// The timeline, release draft and dependency map (#43) on the playground's
// "Timeline, release and dependencies" board, whose widgets read a fake
// repository in the browser: items drag out as cards, release notes copy,
// and the dependency map puts what blocks what on the board.

interface Shape {
	type: string;
	ref?: string;
	widget?: string;
	label?: string;
	color?: string;
	from?: { shape?: string };
	to?: { shape?: string };
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

const widget = (page: Page, kind: string) =>
	page.locator(`.react-flow__node-widget:has(.widget-${kind})`);
const key = (n: number) => `fake.tack/acme/imagekit#${n}`;

/** Drag with the mouse in steps, as a person would. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
	const box = await from.boundingBox();
	if (!box) throw new Error("nothing to drag");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 20, box.y + 20, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 12 });
	await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
	await openScenario(page, "roadmap");
	await page.getByLabel("Playground controls").evaluate((el) => {
		(el as HTMLElement).style.display = "none";
	});
	await expect(widget(page, "timeline").locator(".timeline-dot").first()).toBeVisible();
});

test("the timeline plots what was opened, says what each is, and drags them out as cards", async ({
	page,
}) => {
	const timeline = widget(page, "timeline");
	await expect(timeline.getByRole("heading", { name: "Opened in the last month" })).toBeVisible();
	const count = Number(await timeline.locator(".widget-count").textContent());
	await expect(timeline.locator(".timeline-dot")).toHaveCount(count);
	await expect(timeline.locator(".timeline-today")).toBeVisible();

	const dot = timeline.getByRole("button", { name: /#430 Netlify provider/ });
	await dot.hover();
	await expect(timeline.getByRole("tooltip")).toContainText(
		"Netlify provider ignores quality=auto",
	);

	const self = (await shapes(page)).find((s) => s.widget === "timeline");
	await drag(page, dot, { x: 900, y: 700 });
	await expect
		.poll(async () => (await shapes(page)).find((s) => s.ref === key(430))?.provenance)
		.toEqual({ via: "list", source: self?.id });
	// It's on the board now: its dot says so.
	await expect(dot).toHaveAttribute("data-on-board", "true");
});

test("the release draft sorts what's merged, and copies its notes", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const release = widget(page, "release");
	await expect(release.locator(".release-version-next")).toHaveText("v5.4.0");
	await expect(release.locator(".release-section-title")).toContainText([
		/Features\s*3/,
		/Fixes\s*4/,
		/Docs\s*2/,
		/Other\s*1/,
	]);
	// The bot's dependency bump is left out.
	await expect(release.getByText("Bump vite")).toHaveCount(0);

	await release.getByRole("button", { name: "Preview notes" }).click();
	await expect(release.getByLabel("Release notes")).toContainText("### Fixes");
	await release.getByRole("button", { name: "Copy notes" }).click();
	await expect(release.getByRole("button", { name: "Copied" })).toBeVisible();
	await expect(page.locator(".toast")).toContainText("Copied the notes for v5.4.0");
	const notes = await page.evaluate(() => navigator.clipboard.readText());
	expect(notes).toContain("## What's changed");
	expect(notes).toContain("- Add an ImageKit provider (#446) by @ana");
	expect(notes).toContain("Thanks to @kai, @ana, @priya");
});

test("the dependency map shows what blocks what, and puts it on the board", async ({ page }) => {
	const map = widget(page, "dependencies");
	await expect(map.locator(".depmap-node")).toHaveCount(12);
	await expect(map.locator(".depmap-flag", { hasText: "A cycle" })).toBeVisible();
	await expect(map.locator(".depmap-node[data-cycle]")).toHaveCount(3);
	await expect(map.locator(".depmap-node[data-critical]")).toHaveCount(4);

	// Pointing at an item lights its chain and dims the rest.
	await map.getByRole("button", { name: /#413/ }).hover();
	await expect(map.locator(".depmap-node[data-dim]")).toHaveCount(8);

	// The section's cards are all on the board: laying the map out connects them.
	const connectors = async () =>
		(await shapes(page)).filter((s) => s.type === "connector" && s.label === "blocks").length;
	expect(await connectors()).toBe(0);
	await map.getByRole("button", { name: "Put the map on the board" }).click();
	await expect.poll(connectors).toBe(11);
	await map.getByRole("button", { name: "Put the map on the board" }).click();
	await page.waitForTimeout(300);
	expect(await connectors()).toBe(11);
});

test("a blocker outside the section goes onto the board from its popover", async ({ page }) => {
	const map = widget(page, "dependencies");
	await expect(map.locator(".depmap-node")).toHaveCount(12);
	// Take #426 off the board: it's still in the map, as what #413 blocks.
	await page.evaluate((ref) => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		const shapes = board.doc.getMap("shapes");
		for (const [id, shape] of shapes.entries()) {
			if ((shape as import("yjs").Map<unknown>).get("ref") === ref) shapes.delete(id);
		}
	}, key(426));
	const outside = map.locator(".depmap-node[data-outside]", { hasText: "#426" });
	await expect(outside).toBeVisible();
	await outside.click();
	const pop = map.getByRole("dialog", { name: "#426: dependencies" });
	await expect(pop).toContainText("Blocked by");
	await pop.getByRole("button", { name: "Add to the board" }).click();
	await expect.poll(async () => (await shapes(page)).some((s) => s.ref === key(426))).toBe(true);
	const card = (await shapes(page)).find((s) => s.ref === key(426));
	// Connected to #413 and #408, which are on the board.
	await expect
		.poll(
			async () =>
				(await shapes(page)).filter(
					(s) => s.type === "connector" && (s.from?.shape === card?.id || s.to?.shape === card?.id),
				).length,
		)
		.toBe(2);
});

test("the widget tool adds a timeline, which opens its panel to be set up", async ({ page }) => {
	await page.keyboard.press("w");
	await page
		.getByRole("group", { name: "Widgets" })
		.getByRole("button", { name: /^Timeline/ })
		.click();
	const panel = page.getByRole("dialog", { name: "Edit timeline" });
	await expect(panel).toBeVisible();
	await panel.getByLabel("What to follow").fill("repo:acme/imagekit");
	await panel.getByLabel("What to follow").press("Enter");
	await panel.getByRole("radio", { name: "Merged" }).click();
	await panel.getByRole("button", { name: "Done" }).click();
	const merged = page
		.locator(".react-flow__node-widget")
		.filter({ has: page.getByRole("heading", { name: "Merged in the last 2 weeks" }) });
	await expect(merged.locator(".timeline-dot").first()).toBeVisible();
});

test("the gallery shows every timeline, release draft and dependency map state", async ({
	page,
}) => {
	await page.goto("/play/widgets");
	await expect(page.locator(".widget-timeline")).toHaveCount(8);
	await expect(page.locator(".widget-release")).toHaveCount(9);
	await expect(page.locator(".widget-dependencies")).toHaveCount(9);
	for (const text of [
		"What should this timeline follow?",
		"Nothing closed in this range, yet",
		"Which repository is releasing?",
		"All caught up",
		"What should this map?",
		"Nothing here blocks anything",
		"Sign in to see this map",
		"Asking about 6 more…",
	]) {
		await expect(page.getByText(text).first()).toBeVisible();
	}
	// A crowd zooms in when clicked, and back out from its chip.
	const busy = page.locator('figure[data-state="Timeline: a busy quarter, clustered"]');
	await busy.locator(".timeline-cluster").first().click();
	await expect(busy.locator(".timeline-unzoom")).toBeVisible();
	await busy.locator(".timeline-unzoom").click();
	await expect(busy.locator(".timeline-unzoom")).toHaveCount(0);
	await expect(page.locator('section[data-kind="roadmap-config"] .widget-config')).toHaveCount(3);
});
