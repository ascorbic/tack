import type { Page } from "@playwright/test";
import { drag, expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Sections as lists and mini cards (#72), on /play?scenario=lists: "Now" is
// a list (with a group inside), the backlog mini cards sorted by state, and
// "Ideas" still cards.

test.use({ reducedMotion: "reduce" });

interface Shape {
	type: string;
	x: number;
	y: number;
	parent?: string | null;
	ref?: string;
	text?: string;
	title?: string;
	display?: string;
	sort?: unknown;
	order?: string;
	stack?: string;
}

/** Every shape in the board's document, by id. */
function shapes(page: Page): Promise<Record<string, Shape>> {
	return page.evaluate(() => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return board.doc.getMap("shapes").toJSON() as Record<string, Shape>;
	});
}

/** The id of the card for item `#n`, or the shape with this text or title. */
async function idOf(page: Page, name: string): Promise<string> {
	const all = await shapes(page);
	const found = Object.entries(all).find(
		([, shape]) => shape.ref?.endsWith(name) || shape.text === name || shape.title === name,
	);
	if (!found) throw new Error(`No shape ${name}`);
	return found[0];
}

/** The rows in "Now", top to bottom, by their first word or number. */
function rowOrder(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll(".display-row")]
			.map((row) => ({
				y: row.getBoundingClientRect().y,
				label: row.getAttribute("aria-label") ?? "",
			}))
			.sort((a, b) => a.y - b.y)
			.map(({ label }) => label.split(/[\s,]/)[0] ?? ""),
	);
}

const row = (page: Page, label: string) =>
	page.locator(".react-flow__node", { has: page.locator(`.display-row[aria-label^="${label}"]`) });

/** Wait for rows to finish gliding into their places. */
async function settled(page: Page) {
	await page.waitForTimeout(150);
	await settleCanvas(page);
}

test.beforeEach(async ({ page }) => openScenario(page, "lists"));

test("lists and mini cards render, with their groups, sort and connector", async ({ page }) => {
	// Six cards and two stickies in "Now", two more in its group.
	await expect(page.locator(".display-row")).toHaveCount(10);
	await expect(page.locator(".section-group")).toHaveCount(1);
	await expect(page.locator(".section-group-head")).toContainText("Needs a decision");
	// Thirteen in the backlog, sorted by state: open first, closed last.
	await expect(page.locator(".display-mini")).toHaveCount(13);
	await expect(page.locator(".section-sorted")).toHaveText("State ↑");
	const states = await page.evaluate(() =>
		[...document.querySelectorAll(".display-mini.display-card")]
			.map((mini) => ({
				y: mini.getBoundingClientRect().y,
				x: mini.getBoundingClientRect().x,
				state: mini.getAttribute("data-state"),
			}))
			.sort((a, b) => a.y - b.y || a.x - b.x)
			.map(({ state }) => state),
	);
	expect(states.indexOf("closed")).toBeGreaterThan(states.lastIndexOf("open"));
	// Stamps are counted on the row, not hung off it.
	await expect(row(page, "#412").locator(".display-marks .stamp")).toHaveCount(2);
	// The connector from the note ends on #412's row.
	await expect(page.locator(".connector-line")).toHaveCount(1);
	// "Ideas" is still cards.
	expect((await shapes(page))[await idOf(page, "Ideas")]?.display).toBeUndefined();
});

test("hovering a row pops its card out, and selecting it pins it", async ({ page }) => {
	await row(page, "#418").hover();
	const preview = page.locator(".display-preview");
	await expect(preview).toBeVisible();
	await expect(preview.locator(".card")).toContainText("Remove Node 18");
	await page.mouse.move(5, 500);
	await expect(preview).toHaveCount(0);
	await row(page, "#377").click();
	await expect(preview).toHaveAttribute("data-pinned", "true");
	await expect(preview.locator(".card")).toContainText("Custom domains");
});

test("switching to cards puts everything back, and undo brings the list back", async ({ page }) => {
	const before = await shapes(page);
	const now = await idOf(page, "Now");
	await page.locator(".section-title", { hasText: "Now" }).click();
	await page.getByRole("radio", { name: "Cards", exact: true }).click();
	await expect(page.locator(".display-row")).toHaveCount(0);
	await expect(page.locator(".react-flow__node-card .card").first()).toBeVisible();
	const after = await shapes(page);
	expect(after[now]?.display).toBeUndefined();
	// Nothing moved: every shape is where it was.
	for (const [id, shape] of Object.entries(before)) {
		if (shape.type === "connector") continue;
		expect([after[id]?.x, after[id]?.y], id).toEqual([shape.x, shape.y]);
	}
	await page.keyboard.press("ControlOrMeta+z");
	await expect(page.locator(".display-row")).toHaveCount(10);

	// And on to mini cards.
	await page.locator(".section-title", { hasText: "Now" }).click();
	await page.getByRole("radio", { name: "Mini cards" }).click();
	await expect(page.locator(".display-row")).toHaveCount(0);
	await expect(page.locator(".display-mini")).toHaveCount(13 + 10);
});

test("dragging a row reorders the list, leaving its free-form place alone", async ({ page }) => {
	const id = await idOf(page, "#418");
	const before = (await shapes(page))[id];
	expect((await rowOrder(page)).slice(0, 4)).toEqual(["#412", "#418", "#377", "#409"]);
	const box = await row(page, "#418").boundingBox();
	if (!box) throw new Error("no row");
	// Two rows down.
	await drag(page, { x: box.x + 60, y: box.y + box.height / 2 }, { x: 0, y: 2 * 38 + 4 });
	await settled(page);
	expect((await rowOrder(page)).slice(0, 4)).toEqual(["#412", "#377", "#409", "#418"]);
	const after = (await shapes(page))[id];
	expect([after?.x, after?.y, after?.parent]).toEqual([before?.x, before?.y, before?.parent]);
	expect(typeof after?.order).toBe("string");
});

test("a row dragged out becomes a card again, and dropped back joins where it lands", async ({
	page,
}) => {
	const id = await idOf(page, "#409");
	const box = await row(page, "#409").boundingBox();
	if (!box) throw new Error("no row");
	await drag(page, { x: box.x + 60, y: box.y + box.height / 2 }, { x: 400, y: 40 });
	await settled(page);
	expect((await shapes(page))[id]?.parent).toBeNull();
	const card = page.locator(".react-flow__node-card", {
		has: page.locator(".card", { hasText: "Wombat" }),
	});
	await expect(card).toBeVisible();
	await expect(page.locator(".display-row")).toHaveCount(9);

	// Back in, between the first two rows.
	const cardBox = await card.boundingBox();
	const first = await row(page, "#412").boundingBox();
	if (!cardBox || !first) throw new Error("no card");
	const grab = { x: cardBox.x + 30, y: cardBox.y + 14 };
	// The card's centre lands just below the first row's middle.
	const target = { x: first.x + first.width / 2, y: first.y + first.height * 0.9 };
	await drag(page, grab, {
		x: target.x - (cardBox.x + cardBox.width / 2),
		y: target.y - (cardBox.y + cardBox.height / 2),
	});
	await settled(page);
	const now = await idOf(page, "Now");
	expect((await shapes(page))[id]?.parent).toBe(now);
	expect((await rowOrder(page)).slice(0, 3)).toEqual(["#412", "#409", "#418"]);
});

test("arrow keys move through a list, and Shift-arrows move rows in it", async ({ page }) => {
	await row(page, "#412").click();
	await page.keyboard.press("ArrowDown");
	await expect(row(page, "#418").locator(".display-row")).toHaveAttribute("data-selected", "true");
	await page.keyboard.press("ArrowDown");
	await expect(row(page, "#377").locator(".display-row")).toHaveAttribute("data-selected", "true");
	const id = await idOf(page, "#377");
	const before = (await shapes(page))[id];
	await page.keyboard.press("Shift+ArrowUp");
	await settled(page);
	expect((await rowOrder(page)).slice(0, 3)).toEqual(["#412", "#377", "#418"]);
	// Moved in the list, not nudged on the board.
	const after = (await shapes(page))[id];
	expect([after?.x, after?.y, after?.parent]).toEqual([before?.x, before?.y, before?.parent]);
});

test("a list sorts by state, and goes back to by hand when its rows are moved", async ({
	page,
}) => {
	const now = await idOf(page, "Now");
	await page.locator(".section-title", { hasText: "Now" }).click();
	await page.getByRole("button", { name: "By hand" }).click();
	await page.getByRole("menuitemradio", { name: /State/ }).click();
	await expect(page.locator(".section-sorted")).toHaveText(["State ↑", "State ↑"]);
	expect((await shapes(page))[now]?.sort).toEqual({ by: "state" });
	await settled(page);
	// Open first, then the draft, then merged, then closed; stickies after.
	expect((await rowOrder(page)).slice(0, 6)).toEqual([
		"#412",
		"#418",
		"#377",
		"#423",
		"#409",
		"#398",
	]);
	await row(page, "#377").click();
	await page.keyboard.press("Shift+ArrowUp");
	await expect(page.getByText("Back to ordering by hand")).toBeVisible();
	expect((await shapes(page))[now]?.sort).toBeUndefined();
	await settled(page);
	expect((await rowOrder(page)).slice(0, 3)).toEqual(["#412", "#377", "#418"]);
});

test("a section switched to mini cards keeps its bar just under it, not under the size it was", async ({
	page,
}) => {
	await page.goto("/play?scenario=sections");
	await expect(page.locator(".section-title").first()).toBeVisible({ timeout: 30_000 });
	await page
		.locator(".section-title", { hasText: "Next" })
		.first()
		.click({ position: { x: 12, y: 8 } });
	await page.getByRole("radio", { name: "Mini cards" }).dispatchEvent("click");
	const section = page.locator(".react-flow__node-section.selected");
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await expect
		.poll(async () => {
			const [s, b] = [await section.boundingBox(), await bar.boundingBox()];
			return s && b ? Math.round(b.y - (s.y + s.height)) : null;
		})
		.toBeLessThan(40);
});

test("a row dragged out of a list and held over a sticky makes a stack with it", async ({
	page,
}) => {
	const sticky = await idOf(page, "Ship this by Friday!");
	const now = await idOf(page, "Now");
	// Bring the loose sticky beside the list.
	await page.evaluate(
		([stickyId, sectionId]) => {
			const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			const map = board.doc.getMap("shapes");
			const section = map.get(sectionId) as import("yjs").Map<unknown>;
			const shape = map.get(stickyId) as import("yjs").Map<unknown>;
			board.doc.transact(() => {
				shape.set("x", Number(section.get("x")) + Number(section.get("w")) + 60);
				shape.set("y", Number(section.get("y")) + 40);
			});
		},
		[sticky, now] as const,
	);
	await settled(page);
	const target = page.locator(`.react-flow__node[data-id="${sticky}"]`);
	await expect(target).toBeVisible();
	const from = row(page, "#377");
	const a = (await from.boundingBox())!;
	const b = (await target.boundingBox())!;
	const start = { x: a.x + 40, y: a.y + a.height / 2 };
	await drag(page, start, { x: b.x + b.width / 2 - start.x, y: b.y + b.height / 2 - start.y }, () =>
		page.waitForTimeout(700),
	);
	const card = await idOf(page, "#377");
	await expect
		.poll(async () => {
			const all = await shapes(page);
			const stack = all[sticky]?.stack;
			return Boolean(stack) && all[card]?.stack === stack;
		})
		.toBe(true);
});
