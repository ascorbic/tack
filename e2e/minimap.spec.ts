import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// The minimap and what's under it (#71): popovers open clear of it, and it
// steps aside, letting clicks through, for shapes beneath it.

const node = (page: Page, text: string) =>
	page.locator(".react-flow__node", { hasText: text }).first();
const minimap = (page: Page) => page.locator(".react-flow__minimap");

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function boxOf(locator: ReturnType<Page["locator"]>): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("not on screen");
	return box;
}

const meets = (a: Box, b: Box) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Move a shape so its top left is at a point on screen, relative to the minimap's top left. */
async function moveNearMinimap(page: Page, text: string, dx: number, dy: number) {
	const id = await node(page, text).getAttribute("data-id");
	await page.evaluate(
		({ id, dx, dy }) => {
			const map = document.querySelector(".react-flow__minimap")!.getBoundingClientRect();
			const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
			const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
			const m = new DOMMatrix(getComputedStyle(viewport).transform);
			const x = (map.left + dx - flow.left - m.e) / m.a;
			const y = (map.top + dy - flow.top - m.f) / m.d;
			const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
				.tackPlayground;
			const shape = doc.getMap("shapes").get(id!) as import("yjs").Map<unknown>;
			doc.transact(() => {
				shape.set("x", x);
				shape.set("y", y);
			});
		},
		{ id, dx, dy },
	);
}

test.beforeEach(async ({ page }) => {
	await openScenario(page, "writes");
	// The playground's own controls sit over the minimap's corner.
	await page.addStyleTag({ content: ".play-panel { display: none !important; }" });
});

test("the minimap steps aside for shapes under it, and lets clicks through", async ({ page }) => {
	// A card reaching in under the minimap's left half.
	await moveNearMinimap(page, "Custom domains", -100, 20);
	const card = node(page, "Custom domains");
	const map = await boxOf(minimap(page));
	const cardBox = await boxOf(card);
	expect(cardBox.x + cardBox.width).toBeLessThan(map.x + map.width - 30);

	// Over empty canvas under the minimap, it's still the minimap.
	await page.mouse.move(map.x + map.width - 15, map.y + map.height - 15);
	await expect(minimap(page)).not.toHaveClass(/minimap-dodging/);

	// Over the card under it: it fades back, and a click reaches the card.
	const under = { x: map.x + 40, y: cardBox.y + 30 };
	await page.mouse.move(under.x, under.y, { steps: 4 });
	await expect(minimap(page)).toHaveClass(/minimap-dodging/);
	await expect(minimap(page)).toHaveCSS("pointer-events", "none");
	await page.mouse.click(under.x, under.y);
	await expect(card).toHaveClass(/selected/);

	// Selected, and so with its toolbar about, it stays out of the way…
	await page.mouse.move(map.x + map.width - 15, map.y + map.height - 15, { steps: 4 });
	await expect(minimap(page)).toHaveClass(/minimap-dodging/);
	// …until nothing needs it to.
	await page.keyboard.press("Escape");
	await expect(card).not.toHaveClass(/selected/);
	await expect(minimap(page)).not.toHaveClass(/minimap-dodging/);
	await expect(minimap(page)).toHaveCSS("pointer-events", "auto");
});

test("popovers open clear of the minimap and the rest of the chrome", async ({ page }) => {
	// Four popovers in turn.
	test.setTimeout(60_000);
	const card = node(page, "Custom domains");
	const labels = page.getByRole("dialog", { name: "Labels" });
	const stage = labels.getByRole("button", { name: /^Stage/ });
	// A card just above the minimap, beside it, and reaching under it: in
	// each, the Labels popover (whose Stage button is at its foot) opens
	// where nothing covers it.
	const spots = [
		[0, -250],
		[-40, -330],
		[-200, -170],
		[-120, 20],
	] as const;
	for (const [i, [dx, dy]] of spots.entries()) {
		await moveNearMinimap(page, "Custom domains", dx, dy);
		await card.click({ position: { x: 24, y: 14 } });
		await page.keyboard.press("Alt+KeyL");
		await labels.getByRole("combobox").fill("docs");
		await page.keyboard.press("Enter");
		await expect(stage).toBeEnabled();
		// Settled: opened, and re-placed after its list filtered.
		await page.waitForTimeout(400);

		const popover = await boxOf(labels);
		for (const chrome of [".react-flow__minimap", ".react-flow__controls", ".toolbar-dock"]) {
			expect(
				meets(popover, await boxOf(page.locator(chrome))),
				`at ${dx},${dy}, the popover is clear of ${chrome}`,
			).toBe(false);
		}
		const flow = await boxOf(page.locator(".react-flow"));
		expect(popover.x).toBeGreaterThanOrEqual(flow.x);
		expect(popover.x + popover.width).toBeLessThanOrEqual(flow.x + flow.width);
		// Nothing's over the button.
		const onTop = await stage.evaluate((button) => {
			const { left, top, width, height } = button.getBoundingClientRect();
			return button.contains(document.elementFromPoint(left + width / 2, top + height / 2));
		});
		expect(onTop, `at ${dx},${dy}, the Stage button is on top`).toBe(true);

		if (i < spots.length - 1) {
			await page.keyboard.press("Escape");
			await expect(labels).toHaveCount(0);
		}
	}
	// And it takes a real click.
	await stage.click();
	await expect(labels).toHaveCount(0);
	await expect(card.locator(".staged-label")).toHaveCount(1);
});
