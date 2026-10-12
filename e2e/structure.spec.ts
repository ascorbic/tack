import type { Locator, Page } from "@playwright/test";
import { drag, expect, nodePosition, openScenario, settleCanvas, test } from "./fixtures.ts";

// Sections and connectors: drawing, moving with contents, following,
// detaching and undo.

// By title: a pull request card also mentions the issues it links.
const card = (page: Page, title: string): Locator =>
	page.locator(".react-flow__node-card", {
		has: page.locator(".card-title", { hasText: title }),
	});
const section = (page: Page, title: string): Locator =>
	page.locator(".react-flow__node-section", { hasText: title });
const connectors = (page: Page) => page.locator(".connector:not(.connector-draft)");

async function box(locator: Locator) {
	const rect = await locator.boundingBox();
	if (!rect) throw new Error("no box");
	return rect;
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
	const rect = await box(locator);
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The connectors in the playground's document, with their ends. */
function connectorEnds(page: Page) {
	return page.evaluate(() => {
		const sim = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		const shapes = sim.doc.getMap("shapes") as import("yjs").Map<import("yjs").Map<unknown>>;
		return [...shapes.entries()]
			.filter(([, shape]) => shape.get("type") === "connector")
			.map(([id, shape]) => ({
				id,
				from: shape.get("from") as { shape?: string },
				to: shape.get("to") as { shape?: string },
			}));
	});
}

test("draw a section around cards, then move it with them", async ({ page }) => {
	await openScenario(page, "planning");
	// The second row, so the section's title has room above it.
	const first = card(page, "Document the Wombat provider");
	const second = card(page, "Keep Node 18 support");
	const a = await box(first);
	const b = await box(second);

	await page.keyboard.press("f");
	await page.mouse.move(a.x - 24, a.y - 24);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width + 24, b.y + b.height + 24, { steps: 10 });
	await page.mouse.up();

	// The new section takes in both cards, and its title is ready to type.
	const title = page.getByRole("textbox", { name: "Section title" });
	await expect(title).toBeFocused();
	await page.keyboard.type("Now");
	await page.keyboard.press("Enter");
	const now = section(page, "Now");
	await expect(now.locator(".section-count")).toHaveText("2");

	const before = { section: await nodePosition(now), card: await nodePosition(first) };
	await drag(page, await centre(now.locator(".section-title")), { x: 120, y: 80 });
	const after = { section: await nodePosition(now), card: await nodePosition(first) };
	const moved = { x: after.section.x - before.section.x, y: after.section.y - before.section.y };
	expect(moved.x).toBeGreaterThan(50);
	expect(after.card).toEqual({ x: before.card.x + moved.x, y: before.card.y + moved.y });
	await expect(now.locator(".section-count")).toHaveText("2");
});

test("a section placed with a click lands in free space, and takes nothing from other sections", async ({
	page,
}) => {
	await openScenario(page, "sections");
	const columns = ["Now", "Next", "Later"].map((title) => section(page, title));
	for (const column of columns) await expect(column.locator(".section-count")).toHaveText("2");
	const next = await box(columns[1]!);

	// Low across the Next column's edge, where a default-size section would
	// have reached into all three.
	await page.keyboard.press("f");
	await page.mouse.click(next.x + next.width / 2, next.y + next.height - 80);
	const title = page.getByRole("textbox", { name: "Section title" });
	await expect(title).toBeFocused();
	await page.keyboard.type("Parking lot");
	await page.keyboard.press("Enter");

	// It's on screen, ready to name, though not where the click was.
	await expect(section(page, "Parking lot")).toBeVisible();
	const sections = await page.evaluate(() => {
		const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		const shapes = [...doc.getMap<import("yjs").Map<unknown>>("shapes").entries()];
		return shapes
			.filter(([, shape]) => shape.get("type") === "section")
			.map(([id, shape]) => ({
				title: String(shape.get("title")),
				x: Number(shape.get("x")),
				y: Number(shape.get("y")),
				w: Number(shape.get("w")),
				h: Number(shape.get("h")),
				holds: shapes.filter(([, other]) => other.get("parent") === id).length,
			}));
	});
	const added = sections.find((s) => s.title === "Parking lot")!;
	expect(added.holds).toBe(0);
	for (const column of sections.filter((s) => s.title !== "Parking lot")) {
		expect(column.holds).toBe(2);
		const meets =
			added.x < column.x + column.w &&
			column.x < added.x + added.w &&
			added.y < column.y + column.h &&
			column.y < added.y + added.h;
		expect(meets).toBe(false);
	}
});

test("sections selected together keep their colours within their width, clear of the next section's title", async ({
	page,
}) => {
	await openScenario(page, "sections");
	// Room above the sections for a second row of colours.
	await page.mouse.move(600, 400);
	await page.mouse.wheel(0, -160);
	await settleCanvas(page);
	const now = section(page, "Now");
	// On its own, its tools are in its bar (e2e/section-bar.spec.ts), not its header.
	await now.locator(".section-title").click();
	await expect(now.locator(".section-header button")).toHaveCount(0);
	await section(page, "Next")
		.locator(".section-title")
		.click({ modifiers: ["Shift"] });
	const edge = await box(now);
	const buttons = now.locator(".section-header button");
	await expect(buttons.first()).toBeVisible();
	for (const button of await buttons.all()) {
		const at = await box(button);
		expect(at.x + at.width).toBeLessThanOrEqual(edge.x + edge.width + 1);
	}
	// What's at the middle of the next section's title is that title.
	const next = await centre(section(page, "Next").locator(".section-title"));
	expect(
		await page.evaluate(
			({ x, y }) => document.elementFromPoint(x, y)?.closest(".section-title")?.textContent,
			next,
		),
	).toContain("Next");
});

test("undo puts a moved section and its contents back in one step", async ({ page }) => {
	await openScenario(page, "sections");
	const now = section(page, "Now");
	const inside = card(page, "Drop Node 18 support");
	const before = { section: await nodePosition(now), card: await nodePosition(inside) };

	await drag(page, await centre(now.locator(".section-title")), { x: 90, y: 60 });
	await expect.poll(() => nodePosition(inside)).not.toEqual(before.card);

	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(() => nodePosition(now)).toEqual(before.section);
	await expect.poll(() => nodePosition(inside)).toEqual(before.card);
});

test("connect two cards, and the connector follows when one moves", async ({ page }) => {
	await openScenario(page, "planning");
	const from = card(page, "Drop Node 18 support");
	const to = card(page, "Remove Node 18 from the CI");
	await expect(connectors(page)).toHaveCount(0);

	await page.keyboard.press("x");
	const start = await centre(from);
	const end = await centre(to);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y, { steps: 10 });
	await page.mouse.up();
	await expect(connectors(page)).toHaveCount(1);
	const [line] = await connectorEnds(page);
	expect(line?.from.shape).toBeTruthy();
	expect(line?.to.shape).toBeTruthy();

	// Move the target card down; the line's far end goes with it.
	const path = connectors(page).locator(".connector-line");
	const target = await box(to);
	await drag(page, { x: target.x + 40, y: target.y + 20 }, { x: 60, y: 260 });
	const moved = await box(to);
	const after = await box(path);
	expect(after.y + after.height).toBeGreaterThan(moved.y - 20);
	expect(after.x + after.width).toBeGreaterThan(moved.x - 20);
});

test("labelling a connector hides its end handles, which would cover the label", async ({
	page,
}) => {
	await openScenario(page, "planning");
	await page.keyboard.press("x");
	const start = await centre(card(page, "Drop Node 18 support"));
	const end = await centre(card(page, "Remove Node 18 from the CI"));
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y, { steps: 10 });
	await page.mouse.up();
	await connectors(page).locator(".connector-hit").first().click({ force: true });
	const ends = page.locator(".connector-end");
	await expect(ends).toHaveCount(2);
	await page
		.getByRole("toolbar", { name: "Connector" })
		.getByRole("button", { name: "Label" })
		.click();
	const field = page.getByRole("textbox", { name: "Connector label" });
	await expect(field).toBeFocused();
	await expect(ends).toHaveCount(0);
	await page.keyboard.type("blocks");
	await page.keyboard.press("Enter");
	await expect(page.locator(".connector-label", { hasText: "blocks" })).toBeVisible();
	await expect(ends).toHaveCount(2);
});

test("deleting a connected card leaves its connectors with a loose end", async ({ page }) => {
	await openScenario(page, "connectors");
	const count = (await connectorEnds(page)).length;
	const doomed = card(page, "Remove Node 18 from the CI");
	const id = await doomed.getAttribute("data-id");
	const attached = (await connectorEnds(page)).filter(
		(c) => c.from.shape === id || c.to.shape === id,
	);
	expect(attached.length).toBeGreaterThan(0);

	const at = await centre(doomed);
	await page.mouse.click(at.x, at.y);
	await page.keyboard.press("Backspace");
	await expect(doomed).toHaveCount(0);

	const ends = await connectorEnds(page);
	expect(ends).toHaveLength(count);
	for (const { id: kept } of attached) {
		const line = ends.find((c) => c.id === kept);
		expect(line?.from.shape).not.toBe(id);
		expect(line?.to.shape).not.toBe(id);
	}
	await expect(connectors(page)).toHaveCount(count);
});

/**
 * A section's box, and a card's (by its item) with whether it's in that
 * section, in board coordinates, from the playground's document.
 */
function boxes(page: Page, title: string, item = "") {
	return page.evaluate(
		({ title, item }) => {
			const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			const shapes = [...doc.getMap<import("yjs").Map<unknown>>("shapes").entries()];
			const at = (shape: import("yjs").Map<unknown> | undefined) => ({
				x: Number(shape?.get("x")),
				y: Number(shape?.get("y")),
			});
			const found = shapes.find(([, s]) => s.get("type") === "section" && s.get("title") === title);
			const shape = item
				? shapes.find(([, s]) => {
						const ref = s.get("ref");
						return typeof ref === "string" && ref.endsWith(item);
					})?.[1]
				: undefined;
			return {
				section: {
					...at(found?.[1]),
					w: Number(found?.[1].get("w")),
					h: Number(found?.[1].get("h")),
				},
				shape: { ...at(shape), inside: !!found && shape?.get("parent") === found[0] },
			};
		},
		{ title, item },
	);
}

/** Zoomed out, so whole sections and the bar under one fit on screen. */
async function zoomOut(page: Page) {
	await page.keyboard.press("-");
	await page.keyboard.press("-");
	await settleCanvas(page);
}

test("a card dropped over a section's edge grows it, and undo takes both back", async ({
	page,
}) => {
	await openScenario(page, "sections");
	await zoomOut(page);
	const before = await boxes(page, "Later", "#377");
	expect(before.shape.inside).toBe(false);
	const later = section(page, "Later");
	const zoom = (await box(later)).width / before.section.w;
	const moving = card(page, "Custom domains aren");
	const size = await box(moving);
	const height = size.height / zoom;

	// Over Later's bottom edge, with its middle still inside.
	const target = {
		x: before.section.x + 34,
		y: before.section.y + before.section.h - height / 2 - 20,
	};
	await drag(
		page,
		{ x: size.x + 40, y: size.y + 20 },
		{ x: (target.x - before.shape.x) * zoom, y: (target.y - before.shape.y) * zoom },
	);

	await expect.poll(async () => (await boxes(page, "Later", "#377")).shape.inside).toBe(true);
	const after = await boxes(page, "Later", "#377");
	const bottom = after.shape.y + height;
	expect(bottom).toBeGreaterThan(before.section.y + before.section.h);
	// Down to the card's bottom edge and the usual margin; the rest stays.
	expect(after.section).toMatchObject({ x: before.section.x, y: before.section.y, w: 320 });
	expect(Math.abs(after.section.y + after.section.h - (bottom + 24))).toBeLessThanOrEqual(2);
	// The edge glides there, rather than jumping.
	await page.waitForTimeout(500);
	expect(Math.abs((await box(later)).height - after.section.h * zoom)).toBeLessThanOrEqual(2);

	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(async () => (await boxes(page, "Later")).section).toEqual(before.section);
	expect((await boxes(page, "Later", "#377")).shape.inside).toBe(false);
});

test("Fit to contents snaps a section to what's in it, from the bar, a handle or the keyboard", async ({
	page,
}) => {
	await openScenario(page, "sections");
	await zoomOut(page);
	const now = section(page, "Now");
	const before = (await boxes(page, "Now")).section;
	const zoom = (await box(now)).width / before.w;
	await now.locator(".section-title").click();

	// Small on screen, the section's bar has Fit in its "…" menu.
	await page
		.getByRole("toolbar", { name: "Stage changes" })
		.getByRole("button", { name: "More", exact: true })
		.click();
	await page
		.getByRole("menu", { name: "More for this section" })
		.getByRole("menuitem", { name: "Fit to contents" })
		.click();
	await expect.poll(async () => (await boxes(page, "Now")).section).not.toEqual(before);
	const fitted = (await boxes(page, "Now")).section;
	// Its two cards, 74 across and 90 and 260 down, with 24 all round.
	const last = await box(card(page, "Remove Node 18 from the CI"));
	expect(fitted.x).toBe(74 - 24);
	expect(fitted.y).toBe(90 - 24);
	expect(Math.abs(fitted.w - (last.width / zoom + 48))).toBeLessThanOrEqual(2);
	expect(Math.abs(fitted.y + fitted.h - (260 + last.height / zoom + 24))).toBeLessThanOrEqual(2);
	expect(fitted.h).toBeLessThan(before.h);
	await page.waitForTimeout(500);

	// One undo step.
	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(async () => (await boxes(page, "Now")).section).toEqual(before);

	// Double-clicking a resize handle does the same; so does ⌥F.
	await now.locator(".section-title").click();
	await now.locator('.section-resize[data-handle="se"]').dblclick();
	await expect.poll(async () => (await boxes(page, "Now")).section).toEqual(fitted);
	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(async () => (await boxes(page, "Now")).section).toEqual(before);
	await now.locator(".section-title").click();
	await page.keyboard.press("Alt+KeyF");
	await expect.poll(async () => (await boxes(page, "Now")).section).toEqual(fitted);
});
