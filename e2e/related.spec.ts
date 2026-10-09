import type { Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Expand related (#42) and provenance (#41) on the playground's "Related and
// provenance" board: related items laid out around a card in one undo step,
// clear of everything else, and cards an inbox or rule brought saying so.

test.use({ reducedMotion: "reduce" });

interface Shape {
	id: string;
	type: string;
	ref?: string;
	label?: string;
	provenance?: unknown;
	unmatched?: string;
	from?: { shape?: string };
	to?: { shape?: string };
}

function shapes(page: Page): Promise<Shape[]> {
	return page.evaluate(() => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return [...board.doc.getMap("shapes").entries()].map(([id, shape]) => ({
			id,
			...((shape as import("yjs").Map<unknown>).toJSON() as Omit<Shape, "id">),
		}));
	});
}

const count = async (page: Page, type: string) =>
	(await shapes(page)).filter((s) => s.type === type).length;

const node = (page: Page, text: string) =>
	page.locator(".react-flow__node", { hasText: text }).first();

async function select(page: Page, text: string) {
	await node(page, text).click({ position: { x: 24, y: 14 } });
	await expect(page.getByRole("toolbar", { name: "Stage changes" })).toBeVisible();
}

const panel = (page: Page) => page.getByRole("dialog", { name: "Expand related items" });

test.beforeEach(async ({ page }) => openScenario(page, "related"));

test("lays out what's related around a card, clear of everything, as one undo step", async ({
	page,
}) => {
	const before = await shapes(page);
	await select(page, "Drop Node 18 support");
	await page.keyboard.press("Alt+KeyE");
	await expect(panel(page).getByRole("heading", { name: "Expand related" })).toBeVisible();
	const groups = panel(page).getByRole("list", { name: "Related items" });
	await expect(groups).toContainText("Ship unpic 5.0");
	await expect(groups).toContainText("and 1 more");
	// The blocker is already on the board, so it's connected rather than added.
	await expect(groups.getByText("On the board")).toHaveCount(1);
	await expect(panel(page)).toContainText("Adds 9 cards, connects 1 already here");

	await page.keyboard.press("Enter");
	await expect(panel(page)).toHaveCount(0);
	await expect(page.locator(".toast")).toContainText(
		"Laid out 9 related items, and connected 1 already here",
	);

	const after = await shapes(page);
	const added = after.filter((s) => !before.some((b) => b.id === s.id));
	const cards = added.filter((s) => s.type === "card");
	const connectors = added.filter((s) => s.type === "connector");
	expect(cards).toHaveLength(9);
	expect(connectors).toHaveLength(10);
	// A person asked for them: nothing recorded as their provenance.
	expect(cards.every((c) => c.provenance === undefined)).toBe(true);
	const source = before.find((s) => s.type === "card" && s.ref?.endsWith("#412"));
	const blocker = before.find((s) => s.type === "card" && s.ref?.endsWith("#444"));
	expect(
		connectors.find((c) => c.from?.shape === blocker?.id && c.to?.shape === source?.id)?.label,
	).toBe("blocks");

	// Everything's on screen, and nothing overlaps.
	await settleCanvas(page);
	const boxes = await page
		.locator(".react-flow__node-card, .react-flow__node-sticky")
		.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
	for (const [i, a] of boxes.entries()) {
		for (const b of boxes.slice(i + 1)) {
			const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
			expect(overlap, `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`).toBe(false);
		}
	}

	// One undo step takes it all away.
	await page.locator(".toast").getByRole("button", { name: /Undo/ }).click();
	expect((await shapes(page)).length).toBe(before.length);
});

test("leaves out the groups switched off", async ({ page }) => {
	const cards = await count(page, "card");
	await select(page, "Drop Node 18 support");
	await page.getByRole("button", { name: "Expand related items" }).click();
	await expect(panel(page)).toContainText("Adds 9 cards");
	await panel(page).getByText("Sub-issues").click();
	await panel(page).getByText("Linked pull requests").click();
	await expect(panel(page)).toContainText("Adds 3 cards, connects 1 already here");
	await panel(page).getByRole("button", { name: "Lay out" }).click();
	expect(await count(page, "card")).toBe(cards + 3);
});

test("says when the forge couldn't answer", async ({ page }) => {
	await select(page, "Astro adapter warns");
	await page.keyboard.press("Alt+KeyE");
	await expect(panel(page)).toContainText("rate limit is used up");
	await expect(panel(page).getByRole("button", { name: "Try again" })).toBeVisible();
});

test("cards an inbox, a rule or a list brought say so, and ones that stop matching ask", async ({
	page,
}) => {
	await page.keyboard.press("Shift+Digit1");
	await settleCanvas(page);
	await expect(page.getByRole("note", { name: "From the “Triage” inbox" })).toHaveCount(2);
	await expect(
		page.getByRole("note", { name: "Placed by rule: PRs beside their issues" }),
	).toHaveCount(1);
	await expect(page.getByRole("note", { name: "From a list" })).toHaveCount(1);

	const stale = node(page, "Unknown CDN should warn");
	await expect(stale.locator(".card")).toHaveAttribute("data-unmatched", "true");
	await expect(stale.getByRole("status")).toContainText("No longer matches the “Triage” inbox");

	// Keep it: it's yours now, and says nothing more.
	await stale.getByRole("button", { name: "Keep" }).click();
	await expect(stale.getByRole("status")).toHaveCount(0);
	await expect(stale.getByRole("note")).toHaveCount(0);
	const kept = (await shapes(page)).find((s) => s.ref?.endsWith("#451"));
	expect(kept?.provenance).toBeUndefined();
	expect(kept?.unmatched).toBeUndefined();

	// Undo brings the question back; Remove takes the card away.
	await page.keyboard.press("ControlOrMeta+KeyZ");
	await expect(stale.getByRole("status")).toBeVisible();
	const cards = await count(page, "card");
	await stale.getByRole("button", { name: "Remove" }).click();
	expect(await count(page, "card")).toBe(cards - 1);
});
