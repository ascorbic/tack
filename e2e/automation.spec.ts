import type { Page } from "@playwright/test";
import { drag, expect, openScenario, test } from "./fixtures.ts";

// Inbox frames (#40) and rules (#44) on the playground's "Triage inbox" and
// "Rules" boards, where a pretend forge stands in for webhooks and search.

interface Shape {
	id: string;
	type: string;
	title?: string;
	ref?: string;
	parent?: string | null;
	provenance?: { via: string; source: string };
	unmatched?: string;
	dismissed?: Record<string, unknown>;
	inbox?: { query: { q: string } };
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

const tray = (page: Page) => page.getByRole("complementary", { name: "Inbox: Triage" });
const items = (page: Page) => tray(page).getByRole("list", { name: "New matches" }).locator("li");
const play = (page: Page, name: string) =>
	page.getByLabel("Playground controls").getByRole("button", { name, exact: true });

test.describe("inbox frames", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "inbox"));

	test("new matches wait in the tray, and arrive live", async ({ page }) => {
		await expect(items(page)).toHaveCount(5);
		await expect(tray(page)).toContainText("5 new");
		// The section's title says so too.
		await expect(page.locator(".section-inbox")).toContainText("5");

		await play(page, "New issue").click();
		await expect(items(page)).toHaveCount(6);
		await expect(items(page).first()).toHaveAttribute("data-arrived", "true");
		await expect(items(page).first()).toContainText("New");
	});

	test("dragging a match out makes a card with the inbox's provenance", async ({ page }) => {
		const first = items(page).first();
		const title = (await first.locator(".inbox-item-title").textContent()) ?? "";
		const box = (await first.boundingBox())!;
		const bugs = (await page.locator(".section", { hasText: "Bugs" }).boundingBox())!;
		await drag(
			page,
			{ x: box.x + 40, y: box.y + 20 },
			{ x: bugs.x + 60 - box.x - 40, y: bugs.y + 80 - box.y - 20 },
			async () => {
				await expect(page.locator(".inbox-ghost")).toBeVisible();
			},
		);
		await expect(items(page)).toHaveCount(4);
		await expect(page.locator(".react-flow__node-card", { hasText: title })).toBeVisible();

		const all = await shapes(page);
		const inbox = all.find((shape) => shape.inbox)!;
		const section = all.find((shape) => shape.title === "Bugs")!;
		const placed = all.filter(
			(shape) => shape.provenance?.via === "inbox" && shape.parent !== inbox.id,
		);
		expect(placed).toHaveLength(1);
		expect(placed[0]?.provenance).toEqual({ via: "inbox", source: inbox.id });
		expect(placed[0]?.parent).toBe(section.id);

		// One undo step puts it back in the tray.
		await page.keyboard.press("ControlOrMeta+z");
		await expect(items(page)).toHaveCount(5);
	});

	test("clicking a match drops it into the section", async ({ page }) => {
		await items(page).first().click();
		await expect(items(page)).toHaveCount(4);
		const all = await shapes(page);
		const inbox = all.find((shape) => shape.inbox)!;
		expect(
			all.filter((shape) => shape.provenance?.via === "inbox" && shape.parent === inbox.id),
		).toHaveLength(3);
	});

	test("dismissing remembers it in the document, and can be undone", async ({ page }) => {
		const first = items(page).first();
		await first.hover();
		await first.getByRole("button", { name: /^Dismiss/ }).click();
		await expect(items(page)).toHaveCount(4);
		await expect(tray(page)).toContainText("1 dismissed");
		const inbox = (await shapes(page)).find((shape) => shape.inbox)!;
		expect(Object.keys(inbox.dismissed ?? {})).toHaveLength(1);

		await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
		await expect(items(page)).toHaveCount(5);
	});

	test("a card that stops matching is marked, never moved", async ({ page }) => {
		// Already on the board: one sorted card was relabelled since.
		await expect(page.locator(".card-unmatched")).toHaveCount(1);
		const before = await shapes(page);
		await play(page, "Label an issue").click();
		await expect(page.locator(".card-unmatched")).toHaveCount(2);
		await expect(page.locator(".card-unmatched").first()).toContainText("No longer matches");
		// Marked in the document, and nothing else changed: nothing moved or went.
		const after = await shapes(page);
		const strip = (list: Shape[]) => list.map((shape) => ({ ...shape, unmatched: undefined }));
		expect(strip(after)).toEqual(strip(before));
		expect(after.filter((shape) => shape.unmatched)).toHaveLength(2);

		// Keep it: it's yours now, and no longer marked.
		await page.locator(".card-unmatched").first().getByRole("button", { name: "Keep" }).click();
		await expect(page.locator(".card-unmatched")).toHaveCount(1);
	});

	test("a section becomes an inbox, with a live count as you write", async ({ page }) => {
		await page.locator(".section-title", { hasText: "Docs" }).click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Make inbox" }).click();
		const editor = page.getByRole("complementary", { name: "Inbox: Docs" });
		await editor.getByRole("textbox").fill("repo:acme/imagekit is:issue is:open no:label");
		await expect(editor.locator(".inbox-count")).toContainText(/\d+ match/);
		await editor.getByRole("button", { name: /Start collecting/ }).click();
		await expect(editor.getByRole("list", { name: "New matches" })).toBeVisible();
		const docs = (await shapes(page)).find(
			(shape) =>
				shape.inbox?.query.q === "repo:acme/imagekit is:issue is:open no:label" && shape.id,
		);
		expect(docs).toBeTruthy();
	});
});

test.describe("rules", () => {
	test.beforeEach(async ({ page }) => openScenario(page, "rules"));

	test("a pull request that fixes a card lands beside it, and the panel says so", async ({
		page,
	}) => {
		await play(page, "PR fixes a card").click();
		await expect(page.locator(".provenance[data-via='rule']")).toHaveCount(1);
		await expect(page.locator(".toast")).toContainText(/Placed #\d+ beside #\d+/);

		await page.getByRole("button", { name: /^Rules/ }).click();
		const panel = page.getByRole("dialog", { name: "Rules" });
		await expect(panel.getByRole("region", { name: "Recent activity" })).toContainText(
			/Placed #\d+ beside #\d+/,
		);
		await expect(panel).toContainText("Placed 1 card");
	});

	test("new bugs go into their section; paused rules do nothing", async ({ page }) => {
		await play(page, "New bug").click();
		await expect(page.locator(".provenance[data-via='rule']")).toHaveCount(1);
		const all = await shapes(page);
		const section = all.find((shape) => shape.type === "section")!;
		expect(all.find((shape) => shape.provenance?.via === "rule")?.parent).toBe(section.id);

		await page.getByRole("button", { name: /^Rules/ }).click();
		const panel = page.getByRole("dialog", { name: "Rules" });
		await panel.getByRole("switch").nth(1).uncheck();
		await expect(panel).toContainText("Paused");
		await play(page, "New bug").click();
		await expect(page.locator(".provenance[data-via='rule']")).toHaveCount(1);
	});

	test("rules are added and deleted from the panel", async ({ page }) => {
		await page.getByRole("button", { name: /^Rules/ }).click();
		const panel = page.getByRole("dialog", { name: "Rules" });
		await expect(panel.locator(".rule")).toHaveCount(2);
		await panel.getByRole("button", { name: "New rule" }).click();
		await panel.getByRole("textbox").fill("repo:acme/imagekit milestone:v1");
		await expect(panel.locator(".rules-sentence")).toContainText("milestone:v1");
		await expect(panel.getByRole("button", { name: "Add rule" })).toBeDisabled();
		await panel.getByRole("textbox").fill("repo:acme/imagekit is:issue label:docs");
		await panel.getByRole("button", { name: "Add rule" }).click();
		await expect(panel.locator(".rule")).toHaveCount(3);
		await panel.getByRole("button", { name: "Delete this rule" }).last().click();
		await expect(panel.locator(".rule")).toHaveCount(2);
		await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
		await expect(panel.locator(".rule")).toHaveCount(3);
	});
});

test("the inbox and rules gallery shows every state", async ({ page }) => {
	await page.goto("/play/inbox");
	for (const state of [
		"loading",
		"items",
		"empty",
		"error",
		"collapsed",
		"new",
		"editing",
		"read-only",
		"stale",
		"fresh",
		"rules-empty",
		"rules-busy",
		"rules-composing",
		"rules-read-only",
	]) {
		await expect(page.locator(`figure[data-state="${state}"]`).first()).toBeVisible();
	}
	await expect(page.locator('figure[data-state="loading"] [aria-busy="true"]')).toBeVisible();
	await expect(page.locator('figure[data-state="items"] .inbox-item')).toHaveCount(4);
	await expect(page.locator('figure[data-state="error"]')).toContainText("repo:owner/name");
	await expect(page.locator('figure[data-state="empty"]')).toContainText("All sorted");
	await expect(page.locator(".card-unmatched")).toHaveCount(2);
});
