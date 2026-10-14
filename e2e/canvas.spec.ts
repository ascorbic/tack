import type { Locator, Page } from "@playwright/test";
import { drag, expect, nodePosition, openScenario, test } from "./fixtures.ts";

// Canvas interaction on the /play "arrange" scenario: selection, undo and
// redo, the clipboard, snapping and the shortcut sheet.

const sticky = (page: Page, text: string): Locator =>
	page.locator(".react-flow__node-sticky", { hasText: text });
const selected = (page: Page) => page.locator(".react-flow__node.selected");
const shapes = (page: Page) => page.locator(".react-flow__node");

async function centre(node: Locator): Promise<{ x: number; y: number }> {
	const box = await node.boundingBox();
	if (!box) throw new Error("node has no box");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * While a marquee is within this distance of the canvas's edge, React Flow
 * pans the canvas every frame (`autoPanOnSelection`; the default distance
 * in @xyflow/system's `calcAutoPan`), so how far it pans, and what ends up
 * in the box, depends on how long the drag takes.
 */
const AUTO_PAN_EDGE = 40;

const viewportTransform = (page: Page) =>
	page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

/**
 * Drag a selection marquee. It must start on empty canvas: if a toolbar (or
 * anything else) is under the start point, the drag would hit that instead.
 * And it must stay clear of the canvas's edges, where it would pan the
 * canvas by however far a slow machine lets it. Fail clearly on either
 * rather than flake.
 */
async function marquee(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	const onCanvas = await page.evaluate(
		({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".react-flow__pane")),
		from,
	);
	expect(onCanvas, `marquee starts on empty canvas at ${from.x},${from.y}`).toBe(true);
	const pane = await page.locator(".react-flow__pane").boundingBox();
	if (!pane) throw new Error("no canvas");
	for (const { x, y } of [from, to]) {
		const clearance = Math.min(
			x - pane.x,
			pane.x + pane.width - x,
			y - pane.y,
			pane.y + pane.height - y,
		);
		expect(clearance, `marquee point ${x},${y} is clear of the auto-pan edge`).toBeGreaterThan(
			AUTO_PAN_EDGE,
		);
	}
	const before = await viewportTransform(page);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	expect(await viewportTransform(page), "the marquee didn't pan the canvas").toBe(before);
}

test.beforeEach(async ({ page }) => openScenario(page, "arrange"));

test("shift-click and shift-marquee add to the selection", async ({ page }) => {
	const ship = await centre(sticky(page, "Ship the web component"));
	await page.mouse.click(ship.x, ship.y);
	await page.keyboard.down("Shift");
	const docs = await centre(sticky(page, "Docs before features"));
	await page.mouse.click(docs.x, docs.y);
	await page.keyboard.up("Shift");
	await expect(selected(page)).toHaveCount(2);

	// Clicking one shape in the selection narrows to it, without editing it.
	await page.mouse.click(docs.x, docs.y);
	await expect(selected(page)).toHaveCount(1);
	await expect(page.getByRole("textbox")).toHaveCount(0);

	// A plain marquee replaces the selection; with Shift it adds.
	await page.keyboard.press("Escape");
	// Let the deselect land before starting a marquee that builds on it.
	await expect(selected(page)).toHaveCount(0);
	// Down the left column of stickies: "Ship the web component…" and "Benchmark…".
	await marquee(page, { x: 60, y: 380 }, { x: 120, y: 700 });
	await expect(selected(page)).toHaveCount(2);
	await expect(page.getByRole("toolbar", { name: "Arrange selection" })).toBeVisible();
	await page.keyboard.down("Shift");
	// Right to left across the top row, adding "Docs…" and "Who owns…". This
	// starts well away from the arrange toolbar above the selection.
	await marquee(page, { x: 760, y: 480 }, { x: 300, y: 520 });
	await page.keyboard.up("Shift");
	await expect(selected(page)).toHaveCount(4);
	await expect(page.getByRole("toolbar", { name: "Arrange selection" })).toBeVisible();
});

test("a shift-marquee keeps the shapes already selected, and they move with it", async ({
	page,
}) => {
	const left = [sticky(page, "Ship the web component"), sticky(page, "Benchmark")];
	const top = [sticky(page, "Docs before features"), sticky(page, "Who owns")];
	// Select by clicking this time (the test above starts with a marquee).
	const ship = await centre(left[0]!);
	await page.mouse.click(ship.x, ship.y);
	await page.keyboard.down("Shift");
	const benchmark = await centre(left[1]!);
	await page.mouse.click(benchmark.x, benchmark.y);
	await page.keyboard.up("Shift");
	await expect(selected(page)).toHaveCount(2);

	// Over empty canvas, Shift keeps the selection as it is.
	await page.keyboard.down("Shift");
	await marquee(page, { x: 760, y: 480 }, { x: 800, y: 520 });
	await page.keyboard.up("Shift");
	await expect(selected(page)).toHaveCount(2);

	// Over more shapes, it adds them, and the earlier ones stay selected even
	// though the box never touched them.
	await page.keyboard.down("Shift");
	await marquee(page, { x: 760, y: 480 }, { x: 300, y: 520 });
	await page.keyboard.up("Shift");
	for (const node of [...left, ...top]) await expect(node).toHaveClass(/\bselected\b/);
	await expect(selected(page)).toHaveCount(4);

	// So dragging one of them moves all four, by the same amount (which
	// snapping may adjust a little).
	const all = [...top, ...left];
	const before = await Promise.all(all.map(nodePosition));
	await drag(page, await centre(top[0]!), { x: 60, y: 40 });
	const moves = async () => {
		const after = await Promise.all(all.map(nodePosition));
		return after.map((at, i) => `${at.x - before[i]!.x},${at.y - before[i]!.y}`);
	};
	await expect.poll(async () => (await moves())[0]).not.toBe("0,0");
	const [dragged] = await moves();
	expect(await moves()).toEqual(Array(4).fill(dragged));
});

test("copy, paste, undo and redo", async ({ page }) => {
	const count = await shapes(page).count();
	const ship = await centre(sticky(page, "Ship the web component"));
	await page.mouse.click(ship.x, ship.y);
	await page.keyboard.press("ControlOrMeta+c");
	await page.keyboard.press("ControlOrMeta+v");
	await expect(shapes(page)).toHaveCount(count + 1);
	await expect(sticky(page, "Ship the web component")).toHaveCount(2);
	// The copy is selected, on top of and offset from the original.
	await expect(selected(page)).toHaveCount(1);

	await page.keyboard.press("ControlOrMeta+d");
	await expect(shapes(page)).toHaveCount(count + 2);

	await page.keyboard.press("ControlOrMeta+z");
	await page.keyboard.press("ControlOrMeta+z");
	await expect(shapes(page)).toHaveCount(count);
	await page.keyboard.press("ControlOrMeta+Shift+z");
	await expect(shapes(page)).toHaveCount(count + 1);
});

test("deleting stickies with words offers an undo", async ({ page }) => {
	const count = await shapes(page).count();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(selected(page)).toHaveCount(count);
	await page.keyboard.press("Backspace");
	await expect(shapes(page)).toHaveCount(0);
	const toast = page.getByRole("status").locator(".toast");
	await expect(toast).toContainText(`Deleted ${count} shapes`);
	await toast.getByRole("button", { name: /Undo/ }).click();
	await expect(shapes(page)).toHaveCount(count);
	await expect(selected(page)).toHaveCount(count);
});

test("nudging moves by 1px, or 10px with Shift, as one undo step", async ({ page }) => {
	const node = sticky(page, "Cut scope");
	const before = await nodePosition(node);
	const at = await centre(node);
	await page.mouse.click(at.x, at.y);
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Shift+ArrowDown");
	await expect.poll(() => nodePosition(node)).toEqual({ x: before.x + 1, y: before.y + 10 });
	await page.waitForTimeout(600);
	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(() => nodePosition(node)).toEqual(before);
});

test("dragging snaps to a neighbour's edge, with a guide", async ({ page }) => {
	// "Benchmark" sits 7px right of "Ship the web component"'s left edge.
	const node = sticky(page, "Benchmark");
	const target = await nodePosition(sticky(page, "Ship the web component"));
	const from = await centre(node);
	await drag(page, from, { x: -5, y: 40 }, async () => {
		await expect(page.locator(".guide[data-axis=x]").first()).toBeVisible();
	});
	expect((await nodePosition(node)).x).toBe(target.x);
	// Guides fade away after the drop.
	await expect(page.locator(".guide")).toHaveCount(0);
});

test("undo leaves someone else's work alone", async ({ page }) => {
	// Paste text to make a sticky, then have someone type into it.
	await page.mouse.move(700, 450);
	await page.evaluate(() => {
		const data = new DataTransfer();
		data.setData("text/plain", "Mine:");
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	});
	await expect(sticky(page, "Mine:")).toHaveCount(1);
	await page.getByRole("button", { name: "Edit my last shape" }).click();
	await expect(sticky(page, "and I added this")).toHaveCount(1, { timeout: 10_000 });

	await page.keyboard.press("ControlOrMeta+z");
	await page.waitForTimeout(300);
	await expect(sticky(page, "Mine: and I added this")).toHaveCount(1);
});

test("? opens a searchable shortcut sheet", async ({ page }) => {
	await page.keyboard.press("?");
	const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByText("Cursor chat")).toBeVisible();
	await expect(sheet.getByRole("link", { name: "Read the docs" })).toHaveAttribute(
		"href",
		/^https:\/\/tack\.social\//,
	);
	await page.keyboard.type("zoom");
	const rows = sheet.locator(".sheet-row");
	await expect(rows).toHaveCount(5);
	// Results from one group use both columns, rather than leaving one empty.
	await expect
		.poll(async () => {
			const lefts = new Set<number>();
			for (const row of await rows.all()) lefts.add(Math.round((await row.boundingBox())!.x));
			return lefts.size;
		})
		.toBe(2);
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
});

test("keys on a selected sticky are shortcuts, never its text: Enter edits it", async ({
	page,
}) => {
	const node = sticky(page, "Docs before features");
	const text = node.locator(".sticky-text");
	const at = await centre(node);
	await page.mouse.click(at.x, at.y);
	await expect(node).toHaveClass(/selected/);

	// Shift+1 fits the board rather than typing "!", and Space is left to pan.
	const before = await viewportTransform(page);
	await page.keyboard.press("Shift+Digit1");
	await expect.poll(() => viewportTransform(page)).not.toBe(before);
	await page.keyboard.press(" ");
	await page.keyboard.press("-");
	await expect(text).toHaveText("Docs before features");

	// A key that isn't a shortcut says how to edit.
	await page.keyboard.press("q");
	await expect(node.locator(".edit-hint")).toBeVisible();
	await expect(text).toHaveText("Docs before features");

	const actions = page.getByRole("toolbar", { name: "Stage changes" });
	await expect(actions).toBeVisible();
	await page.keyboard.press("Enter");
	const field = page.getByRole("textbox", { name: "Sticky note" });
	await expect(field).toBeFocused();
	// "Make issue" waits until you've finished writing.
	await expect(actions).toHaveCount(0);
	await page.keyboard.type(" first");
	await page.keyboard.press("Escape");
	await expect(text).toHaveText("Docs before features first");
	await expect(actions).toBeVisible();

	// Still selected after Escape: the next tool letter picks the tool.
	await expect(node).toHaveClass(/selected/);
	await page.keyboard.press("s");
	await expect(page.getByRole("button", { name: "Sticky note" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(text).toHaveText("Docs before features first");
});

test("a click edits a selected sticky only with the select tool in hand", async ({ page }) => {
	const node = sticky(page, "Docs before features");
	const field = node.locator("textarea");
	const at = await centre(node);
	await page.mouse.click(at.x, at.y);
	await page.mouse.click(at.x, at.y);
	await expect(field).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	// The hand pans, and the connector draws from wherever it's pressed: a
	// click with either on the selected sticky doesn't open it to type in.
	for (const key of ["h", "x"]) {
		await page.keyboard.press("v");
		await page.locator(".react-flow__pane").click({ position: { x: 40, y: 400 } });
		await page.mouse.click(at.x, at.y);
		await expect(node).toHaveClass(/selected/);
		await page.keyboard.press(key);
		await expect(node).toHaveClass(/selected/);
		await page.mouse.click(at.x, at.y);
		await page.mouse.dblclick(at.x, at.y);
		await expect(field).toHaveCount(0);
	}
});

test("everything typed straight after placing a sticky lands in it", async ({ page }) => {
	await page.keyboard.press("s");
	const count = await page.locator(".react-flow__node-sticky").count();
	// No waiting for the text box: the first keys arrive before it can take focus.
	await page.mouse.click(860, 520);
	await page.keyboard.type("Before 5.0", { delay: 0 });
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(count + 1);
	await expect(page.getByRole("textbox", { name: "Sticky note" })).toHaveValue("Before 5.0");
	// None of it was taken as a tool shortcut (B is the comment tool).
	await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
});

test("tidying up never lands the selection on shapes that weren't selected", async ({ page }) => {
	await openScenario(page, "empty");
	await page.addStyleTag({ content: ".play-panel { display: none !important; }" });
	// Two stickies a row apart, and between them one that isn't selected,
	// right where the tidied second row would go.
	await page.evaluate(() => {
		const { doc } = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		const shapes = doc.getMap("shapes");
		// The page's own Yjs, by way of a type it made.
		const YMap = shapes.constructor as new () => import("yjs").Map<unknown>;
		doc.transact(() => {
			for (const [id, text, y, z] of [
				["a", "Tidy me", 100, "a1"],
				["c", "Leave me be", 300, "a2"],
				["b", "And me", 560, "a3"],
			] as const) {
				const shape = new YMap();
				for (const [key, value] of Object.entries({
					type: "sticky",
					text,
					x: 300,
					y,
					z,
					parent: null,
				})) {
					shape.set(key, value);
				}
				shapes.set(id, shape);
			}
		});
	});
	const a = page.locator('.react-flow__node[data-id="a"]');
	const b = page.locator('.react-flow__node[data-id="b"]');
	const c = page.locator('.react-flow__node[data-id="c"]');
	await expect(c).toBeVisible();
	await a.click({ position: { x: 20, y: 20 } });
	await b.click({ position: { x: 20, y: 20 }, modifiers: ["Shift"] });
	await expect(selected(page)).toHaveCount(2);
	const before = await nodePosition(b);

	await page.keyboard.press("Control+Alt+KeyT");
	await expect.poll(() => nodePosition(b)).not.toEqual(before);
	const leave = (await c.boundingBox())!;
	for (const node of [a, b]) {
		await expect
			.poll(async () => {
				const box = (await node.boundingBox())!;
				return (
					box.x < leave.x + leave.width &&
					leave.x < box.x + box.width &&
					box.y < leave.y + leave.height &&
					leave.y < box.y + box.height
				);
			})
			.toBe(false);
	}
	// Still a tidy column: one above the other, lined up.
	const [first, second] = [await nodePosition(a), await nodePosition(b)];
	expect(first.x).toBe(second.x);
	expect(second.y).toBeGreaterThan(first.y + 176);
});

test("toolbars over the selection stay inside the canvas, and out of each other's way", async ({
	page,
}) => {
	// Everything selected: its top is near the top bar, so the toolbars above
	// it would reach under the bar.
	await page.locator(".react-flow__pane").click({ position: { x: 900, y: 600 } });
	await page.keyboard.press("ControlOrMeta+a");
	const arrange = page.getByRole("toolbar", { name: "Arrange selection" });
	const shape = page.getByRole("toolbar", { name: "Shape options" });
	await expect(arrange).toBeVisible();
	await expect(shape).toBeVisible();
	const canvas = (await page.locator(".react-flow").boundingBox())!;
	await expect
		.poll(async () => {
			const a = (await arrange.boundingBox())!;
			const s = (await shape.boundingBox())!;
			return (
				a.y >= canvas.y &&
				s.y >= canvas.y &&
				a.x >= canvas.x &&
				a.x + a.width <= canvas.x + canvas.width &&
				// One above the other.
				a.y + a.height <= s.y
			);
		})
		.toBe(true);
});
