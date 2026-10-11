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
		// Between Bugs and Later there's no room for its tray: it waits folded.
		await page.getByRole("button", { name: /Open Docs's inbox/ }).click();
		// Collecting: what's new (Triage's search too, so they're shared out between the two).
		await expect(
			editor.locator(".inbox-items, .inbox-message, .inbox-elsewhere").first(),
		).toBeVisible();
		const docs = (await shapes(page)).find(
			(shape) =>
				shape.inbox?.query.q === "repo:acme/imagekit is:issue is:open no:label" && shape.id,
		);
		expect(docs).toBeTruthy();
	});

	test("a second inbox on the same search is warned, and never offers the same item twice", async ({
		page,
	}) => {
		await expect(items(page)).toHaveCount(5);
		await page.locator(".section-title", { hasText: "Docs" }).click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Make inbox" }).click();
		const editor = page.getByRole("complementary", { name: "Inbox: Docs" });
		// The section's name is a label in the repository: it's the first idea.
		await expect(editor.getByRole("button", { name: "Labelled docs" })).toBeVisible();
		await editor.getByRole("button", { name: "Needs triage" }).click();
		await expect(editor.getByRole("note")).toContainText(/“Triage” already collects \d+ of these/);
		await editor.getByRole("button", { name: /Start collecting/ }).click();
		await page.getByRole("button", { name: /Open Docs's inbox/ }).click();

		// Each waiting item is in one tray or the other.
		const docsItems = page
			.getByRole("complementary", { name: "Inbox: Docs" })
			.getByRole("list", { name: "New matches" })
			.locator("li");
		const titles = async (list: typeof docsItems) =>
			list.locator(".inbox-item-title").allTextContents();
		await expect
			.poll(async () => (await titles(items(page))).length + (await titles(docsItems)).length)
			.toBe(5);
		const triage = await titles(items(page));
		const docs = await titles(docsItems);
		expect(triage.filter((title) => docs.includes(title))).toEqual([]);
		// The one that gave its items up says where they went.
		await expect(page.locator(".inbox-elsewhere")).toContainText(/5 more wait in “(Triage|Docs)”/);
	});

	test("an inbox can place new matches straight in, as a rule", async ({ page }) => {
		await page.locator(".section-title", { hasText: "Bugs" }).click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Make inbox" }).click();
		const editor = page.getByRole("complementary", { name: "Inbox: Bugs" });
		await editor.getByRole("button", { name: "Open bugs" }).click();
		await editor.getByRole("checkbox", { name: /Place new matches straight in/ }).check();
		await editor.getByRole("button", { name: /Start collecting/ }).click();
		const bugs = (await shapes(page)).find((shape) => shape.title === "Bugs")!;
		const rules = await page.evaluate(() => {
			const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			return [...board.doc.getMap("rules").values()].map(
				(rule) => (rule as import("yjs").Map<unknown>).toJSON() as Record<string, never>,
			);
		});
		expect(rules).toMatchObject([
			{ trigger: { kind: "matches" }, action: { kind: "section", section: bugs.id } },
		]);
	});

	test("the editor comes out from under the dock, wherever the section is", async ({ page }) => {
		// Docs is low on the screen at 1280×800: its editor used to open behind the dock.
		await page.locator(".section-title", { hasText: "Docs" }).click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Make inbox" }).click();
		const start = page.getByRole("button", { name: /Start collecting/ });
		const dock = page.locator(".toolbar-dock");
		await expect
			.poll(async () => {
				const button = await start.boundingBox();
				const under = await dock.boundingBox();
				return button && under ? button.y + button.height <= under.y : false;
			})
			.toBe(true);
		const button = (await start.boundingBox())!;
		expect(button.y).toBeGreaterThan(56);
	});

	test("a tray never covers the section next door: it moves aside or folds away", async ({
		page,
	}) => {
		// Triage has room on its right.
		await expect(page.locator(".inbox-anchor").first()).toHaveAttribute("data-side", "right");
		// Docs sits between Bugs and Later, with no room either side for a tray.
		await page.locator(".section-title", { hasText: "Docs" }).click({ position: { x: 12, y: 8 } });
		await page.getByRole("button", { name: "Make inbox" }).click();
		const editor = page.getByRole("complementary", { name: "Inbox: Docs" });
		await editor.getByRole("textbox").fill("repo:acme/imagekit is:issue is:open label:docs");
		await editor.getByRole("button", { name: /Start collecting/ }).click();
		const pill = page.getByRole("button", { name: /Open Docs's inbox/ });
		await expect(pill).toBeVisible();
		await expect(page.getByRole("complementary", { name: "Inbox: Docs" })).toHaveCount(0);
		// Asked for, it opens anyway, and folds again when asked.
		await pill.click();
		await expect(page.getByRole("complementary", { name: "Inbox: Docs" })).toBeVisible();
		await page
			.getByRole("complementary", { name: "Inbox: Docs" })
			.getByRole("button", { name: "Fold the tray away" })
			.click();
		await expect(pill).toBeVisible();
	});

	test("zoomed far out, trays fold to their pills", async ({ page }) => {
		await expect(tray(page)).toBeVisible();
		const zoomOut = page.locator(".react-flow__controls-zoomout");
		for (let i = 0; i < 12 && (await tray(page).count()) > 0; i++) await zoomOut.click();
		await expect(tray(page)).toHaveCount(0);
		await expect(page.getByRole("button", { name: /Open Triage's inbox: 5 new/ })).toBeVisible();
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

	test("pausing rules for a session holds their cards until they resume", async ({ page }) => {
		await page.getByRole("button", { name: "Facilitate" }).click();
		await page.getByRole("button", { name: "Pause rules for this session" }).click();
		await page.keyboard.press("Escape");

		await play(page, "New bug").click();
		await play(page, "New bug").click();
		// Nothing lands mid-discussion, and the top bar says what's waiting.
		const button = page.getByRole("button", { name: "Rules: paused, 2 waiting" });
		await expect(button).toBeVisible();
		await expect(page.locator(".provenance[data-via='rule']")).toHaveCount(0);

		await button.click();
		const panel = page.getByRole("dialog", { name: "Rules" });
		await expect(panel.getByRole("status")).toContainText("2 updates waiting");
		await panel.getByRole("button", { name: "Resume" }).click();
		await expect(page.locator(".provenance[data-via='rule']")).toHaveCount(2);
		await expect(page.getByRole("button", { name: /^Rules: \d+ on/ })).toBeVisible();
		await expect(panel.getByRole("button", { name: "Pause all" })).toBeVisible();
	});

	test("the composer starts somewhere new, warns of duplicates, and offers an inbox instead", async ({
		page,
	}) => {
		await page.getByRole("button", { name: /^Rules/ }).click();
		const panel = page.getByRole("dialog", { name: "Rules" });
		await panel.getByRole("button", { name: "New rule" }).click();
		const query = panel.getByRole("textbox");
		// Not the bugs search a rule already uses.
		await expect(query).not.toHaveValue(/label:bug/);
		await expect(panel.locator(".rules-count")).toContainText(/\d+ match(es)? now/);

		await query.fill("repo:acme/imagekit is:issue is:open label:bug");
		await expect(panel.locator(".rules-sentence")).toHaveText(
			"There’s already a rule that does this.",
		);
		await expect(panel.getByRole("button", { name: "Add rule" })).toBeDisabled();

		await query.fill("repo:acme/imagekit is:issue is:open no:label");
		await panel.getByRole("button", { name: "Make “New bugs” an inbox instead" }).click();
		await expect(page.locator(".toast")).toContainText("“New bugs” is an inbox");
		const section = (await shapes(page)).find((shape) => shape.title === "New bugs");
		expect(section?.inbox?.query.q).toBe("repo:acme/imagekit is:issue is:open no:label");
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
		"rules-paused",
		"rules-read-only",
		"rules-read-only-empty",
	]) {
		await expect(page.locator(`figure[data-state="${state}"]`).first()).toBeVisible();
	}
	await expect(page.locator('figure[data-state="loading"] [aria-busy="true"]')).toBeVisible();
	await expect(page.locator('figure[data-state="items"] .inbox-item')).toHaveCount(4);
	await expect(page.locator('figure[data-state="error"]')).toContainText("repo:owner/name");
	await expect(page.locator('figure[data-state="empty"]')).toContainText("All sorted");
	await expect(page.locator(".card-unmatched")).toHaveCount(2);
	await expect(page.locator('figure[data-state="rules-paused"] [role="status"]')).toContainText(
		/Paused by Kai Andersen\s*3 updates waiting/,
	);
	// Viewers aren't told to start with something they can't use.
	const viewerEmpty = page.locator('figure[data-state="rules-read-only-empty"]');
	await expect(viewerEmpty).toContainText("No rules on this board.");
	await expect(viewerEmpty).not.toContainText("Start with");
});
