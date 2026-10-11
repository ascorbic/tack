import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Adding issues and pull requests at session speed (the card tool, pasted
// links) on the /play "arrange" board, whose cards are the playground's
// acme/imagekit fixtures, and what a click on a card does.

/** The board's cards, from its document (React Flow only draws those in view). */
function cardIds(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return [...doc.getMap<import("yjs").Map<unknown>>("shapes").entries()]
			.filter(([, shape]) => shape.get("type") === "card")
			.map(([id]) => id);
	});
}

/**
 * Shapes that `ids` overlap, by where the document puts them and the size
 * each is drawn at (nominal for any not drawn).
 */
function overlapsOf(page: Page, ids: string[]): Promise<string[]> {
	return page.evaluate((mine) => {
		const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		const boxes = [...doc.getMap<import("yjs").Map<unknown>>("shapes").entries()]
			.filter(([, shape]) => !["section", "connector"].includes(String(shape.get("type"))))
			.map(([id, shape]) => {
				const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
				const nominal = shape.get("type") === "card" ? [252, 150] : [176, 176];
				return {
					id,
					x: Number(shape.get("x")),
					y: Number(shape.get("y")),
					w: el?.offsetWidth || nominal[0]!,
					h: el?.offsetHeight || nominal[1]!,
				};
			});
		const out: string[] = [];
		for (const a of boxes.filter((box) => mine.includes(box.id))) {
			for (const b of boxes) {
				if (a.id === b.id) continue;
				const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
				if (!apart) out.push(`${a.id} × ${b.id}`);
			}
		}
		return out;
	}, ids);
}

async function added(page: Page, before: string[]): Promise<string[]> {
	return (await cardIds(page)).filter((id) => !before.includes(id));
}

async function paste(page: Page, text: string) {
	await page.evaluate((value) => {
		const data = new DataTransfer();
		data.setData("text/plain", value);
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	}, text);
}

test.beforeEach(async ({ page }) => openScenario(page, "arrange"));

test("the card tool searches the board's repository, and says what's already here", async ({
	page,
}) => {
	const before = await cardIds(page);
	await page.keyboard.press("c");
	const field = page.getByRole("combobox", { name: "Issue or pull request" });
	await expect(field).toBeFocused();
	await field.fill("node");
	const results = page.getByRole("listbox", { name: "Issues and pull requests" });
	const options = results.getByRole("option");
	await expect(options).toHaveCount(3);
	await expect(options.filter({ hasText: "Drop Node 18 support" })).toContainText("On the board");

	// Down to the one that isn't here yet, and add it.
	const keep = options.filter({ hasText: "Keep Node 18 support" });
	while ((await keep.getAttribute("aria-selected")) !== "true") {
		await field.press("ArrowDown");
	}
	await field.press("Enter");
	await expect.poll(async () => (await added(page, before)).length).toBe(1);
	await expect(keep).toContainText("Added");
	// The tool stays open for the next one, and nothing landed on anything.
	await expect(field).toBeFocused();
	await expect.poll(async () => overlapsOf(page, await added(page, before))).toEqual([]);

	// One already on the board isn't added again: it's shown, with a copy on offer.
	await options.filter({ hasText: "Drop Node 18 support" }).click();
	const status = page.locator(".card-status");
	await expect(status).toContainText("imagekit#412 is already on the board");
	expect(await added(page, before)).toHaveLength(1);
	await status.getByRole("button", { name: "Add another copy" }).click();
	await expect.poll(async () => (await added(page, before)).length).toBe(2);

	// Words that match nothing, and junk, say so.
	await field.fill("zebra crossing");
	await expect(status).toContainText("Nothing in acme/imagekit matches");
	await field.fill("https://example.com/not/an/issue");
	await field.press("Enter");
	await expect(status).toContainText("not a link to an issue or pull request");
	await expect(field).toHaveAttribute("aria-invalid", "true");

	await field.press("Escape");
	await expect(field).toHaveCount(0);
});

test("cards added one after another go side by side, never on top of anything", async ({
	page,
}) => {
	const before = await cardIds(page);
	await page.keyboard.press("c");
	const field = page.getByRole("combobox", { name: "Issue or pull request" });
	for (const n of [5, 6, 7, 8, 9]) {
		// Just the number: an item in the board's repository.
		await field.fill(`#${n}`);
		await field.press("Enter");
		await expect(field).toHaveValue("");
	}
	await expect.poll(async () => (await added(page, before)).length).toBe(5);
	await expect.poll(async () => overlapsOf(page, await added(page, before))).toEqual([]);
});

test("pasting links adds cards in free space, and a link Tack can't show says so", async ({
	page,
}) => {
	const before = await cardIds(page);
	await page.mouse.move(640, 420);
	await paste(page, "fake.tack/acme/imagekit#20\nhttps://fake.tack/acme/imagekit/issues/21");
	await expect.poll(async () => (await added(page, before)).length).toBe(2);
	await expect.poll(async () => overlapsOf(page, await added(page, before))).toEqual([]);

	// Again: it's here already, so nothing's added, and the toast says why.
	await paste(page, "fake.tack/acme/imagekit#20");
	// The one showing, not one still sliding away.
	const toast = page.getByRole("status").locator('.toast:not([data-leaving="true"])');
	await expect(toast).toContainText("imagekit#20 is already on the board");
	expect(await added(page, before)).toHaveLength(2);
	await toast.getByRole("button", { name: "Add another copy" }).click();
	await expect.poll(async () => (await added(page, before)).length).toBe(3);

	await paste(page, "https://github.com/acme/imagekit/discussions/4");
	await expect(toast).toContainText("Added as a sticky");
	await expect(page.locator(".react-flow__node-sticky", { hasText: "discussions/4" })).toHaveCount(
		1,
	);
});

test("a card's title selects it first; once selected, or with ⌘, it opens", async ({ page }) => {
	// Nothing leaves the playground.
	await page.context().route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
	const popups: string[] = [];
	page.on("popup", (popup) => {
		popups.push(popup.url());
		void popup.close();
	});
	const card = page
		.locator(".react-flow__node-card")
		.filter({ has: page.locator(".card-title", { hasText: "Drop Node 18 support" }) });
	const title = card.locator("a.card-title");
	await title.click();
	await expect(card).toHaveClass(/selected/);
	await page.waitForTimeout(300);
	expect(popups).toEqual([]);

	const opened = page.waitForEvent("popup");
	await title.click();
	await opened;
	expect(popups).toHaveLength(1);

	// The ↗ beside its state opens it in one click.
	await expect(card.getByRole("link", { name: "Open on the test forge" })).toHaveAttribute(
		"href",
		/fake\.tack\/acme\/imagekit\/412/,
	);
});

test("a selected card keeps its ring while the pointer's over it", async ({ page }) => {
	const card = page
		.locator(".react-flow__node-card")
		.filter({ has: page.locator(".card-title", { hasText: "Drop Node 18 support" }) });
	// A first click on its title selects it, opening nothing.
	await card.locator("a.card-title").click();
	await expect(card).toHaveClass(/selected/);
	const face = card.locator(".card");
	await page.mouse.move(0, 0);
	await expect(face).toHaveAttribute("data-selected", "true");
	const ring = () => face.evaluate((el) => getComputedStyle(el).boxShadow);
	await expect.poll(ring).toContain("0px 0px 0px");
	const resting = await ring();
	await face.hover();
	// Past any shadow transition: the ring is still there, unchanged.
	await page.waitForTimeout(500);
	expect(await ring()).toBe(resting);
});
