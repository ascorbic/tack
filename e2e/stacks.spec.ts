import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Stacks (#73) on the playground's theming board: dragging a sticky onto
// another and holding makes a stack, named ✨ by the pretend server's
// stand-in model; stacks open into a tray and gather back; "Group these"
// previews stacks for a selection before making them.

interface Shape {
	id: string;
	type: string;
	text?: string;
	title?: string;
	stack?: string | null;
	suggested?: { title: string };
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

const stacks = async (page: Page) => (await shapes(page)).filter((s) => s.type === "stack");

const sticky = (page: Page, text: string) =>
	page.locator(".react-flow__node-sticky", { hasText: text }).first();

const stackNode = (page: Page, name: string) =>
	page.locator(".react-flow__node-stack", { hasText: name }).first();

async function centre(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("not on screen");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag `from` over `onto` and hold there (or not) before letting go. */
async function dragOnto(page: Page, from: Locator, onto: Locator, holdMs: number) {
	const start = await centre(from);
	const end = await centre(onto);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 2, start.y + 2);
	await page.mouse.move(end.x, end.y, { steps: 14 });
	if (holdMs > 0) {
		await page.waitForTimeout(holdMs);
		// A little wiggle, as a hand holding still does.
		await page.mouse.move(end.x + 2, end.y + 1);
	}
	await page.mouse.up();
}

test.beforeEach(async ({ page }) => openScenario(page, "stacks"));

test("holding a sticky over another makes a stack, named ✨, in one undo step", async ({
	page,
}) => {
	const before = (await stacks(page)).length;
	const target = sticky(page, "Can't rerun one job");
	const ci = sticky(page, "CI takes 25 minutes");
	// Just passing over on the way somewhere else: only a move.
	const through = await centre(target);
	const from = await centre(ci);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 2, from.y + 2);
	await page.mouse.move(through.x, through.y, { steps: 6 });
	await page.mouse.move(through.x + 40, through.y + 260, { steps: 6 });
	await page.mouse.up();
	expect(await stacks(page)).toHaveLength(before);

	const start = await centre(ci);
	const end = await centre(target);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 2, start.y + 2);
	await page.mouse.move(end.x, end.y, { steps: 14 });
	// Held there, the one underneath opens up to take it.
	await expect(page.locator(".react-flow__node.stack-target")).toHaveCount(1);
	await page.mouse.move(end.x + 2, end.y + 1);
	await page.mouse.up();

	await expect.poll(async () => (await stacks(page)).length).toBe(before + 1);
	await expect
		.poll(async () => (await stacks(page)).some((s) => s.suggested?.title === "Unreliable CI"))
		.toBe(true);
	// Named from what it says, marked as a suggestion.
	const node = stackNode(page, "Unreliable CI");
	await expect(node).toBeVisible();
	await expect(node.locator(".stack-spark")).toBeVisible();
	await expect(node.locator(".stack-count")).toHaveText("2");

	// One undo step: two stickies again.
	await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(async () => (await stacks(page)).length).toBe(before);
	await expect(sticky(page, "CI takes 25 minutes")).toBeVisible();
	await expect(sticky(page, "Can't rerun one job")).toBeVisible();
});

test("a stack spreads into a tray when clicked, and Escape gathers it back", async ({ page }) => {
	const stack = stackNode(page, "Big sites are slow");
	await expect(stack.locator(".stack-count")).toHaveText("3");
	await expect(sticky(page, "Builds got 2x slower")).toHaveCount(0);
	await stack.locator(".stack-top").click();
	const tray = page.getByRole("group", { name: /Big sites are slow, 3 stickies, open/ });
	await expect(tray).toBeVisible();
	for (const text of ["Srcset generation", "Builds got 2x slower", "Dev server lags"]) {
		await expect(sticky(page, text)).toBeVisible();
	}
	await page.keyboard.press("Escape");
	await expect(tray).toHaveCount(0);
	await expect(sticky(page, "Builds got 2x slower")).toHaveCount(0);
	await expect(stack.locator(".stack-count")).toHaveText("3");
	// Still selected: Enter spreads it again, from the keyboard.
	await page.keyboard.press("Enter");
	await expect(tray).toBeVisible();
});

test("dragging a sticky out of an open stack takes it out; a stack of one dissolves", async ({
	page,
}) => {
	const stack = stackNode(page, "Newcomer onboarding");
	await stack.locator(".stack-top").click();
	await expect(
		page.getByRole("group", { name: /Newcomer onboarding, 2 stickies, open/ }),
	).toBeVisible();
	const out = sticky(page, "Newcomers bounce off");
	const from = await centre(out);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 2, from.y + 2);
	await page.mouse.move(from.x - 120, from.y + 260, { steps: 14 });
	await page.mouse.up();
	// Out of it: the one left is a sticky again, and the stack's gone.
	await expect
		.poll(async () =>
			(await stacks(page)).some((s) => s.suggested?.title === "Newcomer onboarding"),
		)
		.toBe(false);
	await expect(sticky(page, "Newcomers bounce off")).toBeVisible();
	await expect(sticky(page, "First-time contributors")).toBeVisible();
});

test("a stack's name is a person's once they write one, and never replaced", async ({ page }) => {
	const stack = stackNode(page, "Newcomer onboarding");
	await stack.locator(".stack-name").dblclick();
	const field = page.getByRole("textbox", { name: "Stack name" });
	await field.fill("Getting started is hard");
	await field.press("Enter");
	const node = stackNode(page, "Getting started is hard");
	await expect(node).toBeVisible();
	await expect(node.locator(".stack-spark")).toHaveCount(0);
	await expect
		.poll(async () => (await stacks(page)).find((s) => s.title === "Getting started is hard"))
		.toBeTruthy();
});

test("Group these proposes named stacks, previewed on the board, made in one undo step", async ({
	page,
}) => {
	const texts = [
		"Provider docs are hard",
		"CI takes 25 minutes",
		"No example for a custom",
		"Flaky e2e on Windows",
		"Can't rerun one job",
		"Which CDN options",
	];
	const first = await centre(sticky(page, texts[0] as string));
	await page.mouse.click(first.x, first.y);
	await page.keyboard.down("Shift");
	for (const text of texts.slice(1)) {
		const at = await centre(sticky(page, text));
		await page.mouse.click(at.x, at.y);
	}
	await page.keyboard.up("Shift");
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await bar.getByRole("button", { name: "Group these into named stacks" }).click();
	const panel = page.getByRole("dialog", { name: "Group these into named stacks" });
	await expect(panel.getByRole("textbox", { name: "Name of stack 1" })).toBeVisible();
	// The board marks what each proposed stack would take.
	await expect(page.locator(".react-flow__node.stack-proposed")).toHaveCount(6);
	await expect(panel.getByRole("textbox", { name: "Name of stack 1" })).toHaveValue(
		"Hard-to-find docs",
	);
	await expect(panel.getByRole("textbox", { name: "Name of stack 2" })).toHaveValue(
		"Unreliable CI",
	);
	// Tweak: a person's name for the first, and one sticky left out of the second.
	await panel.getByRole("textbox", { name: "Name of stack 1" }).fill("Docs nobody can find");
	await panel.getByRole("button", { name: /Leave “Flaky e2e on Windows/ }).click();
	await expect(page.locator(".react-flow__node.stack-proposed")).toHaveCount(5);
	const before = (await stacks(page)).length;
	await panel.getByRole("button", { name: "Make 2 stacks" }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.locator(".react-flow__node.stack-proposed")).toHaveCount(0);
	await expect.poll(async () => (await stacks(page)).length).toBe(before + 2);
	const all = await stacks(page);
	expect(all.find((s) => s.title === "Docs nobody can find")?.suggested).toBeUndefined();
	expect(all.some((s) => s.suggested?.title === "Unreliable CI" && !s.title)).toBe(true);
	await expect(sticky(page, "Flaky e2e on Windows")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+z");
	await expect.poll(async () => (await stacks(page)).length).toBe(before);
	await expect(sticky(page, "Provider docs are hard")).toBeVisible();
});

test("a stack becomes a parent issue named after it, with its stickies as sub-issues", async ({
	page,
}) => {
	await stackNode(page, "Big sites are slow")
		.locator(".stack-label")
		.click({ position: { x: 4, y: 4 } });
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await bar.getByRole("button", { name: /Make a parent issue from this stack/ }).click();
	const panel = page.getByRole("dialog", { name: /Make a parent issue from this stack/ });
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Big sites are slow");
	for (const text of ["Srcset generation", "Builds got 2x slower", "Dev server lags"]) {
		await expect(panel).toContainText(text);
	}
});

test("Unstack lays a stack's stickies out where it was", async ({ page }) => {
	await stackNode(page, "Big sites are slow")
		.locator(".stack-label")
		.click({ position: { x: 4, y: 4 } });
	await page.keyboard.press("Alt+KeyU");
	await expect(stackNode(page, "Big sites are slow")).toHaveCount(0);
	for (const text of ["Srcset generation", "Builds got 2x slower", "Dev server lags"]) {
		await expect(sticky(page, text)).toBeVisible();
	}
});

test("with AI suggestions off, stacks are Untitled and there's no Group these", async ({
	page,
}) => {
	await page.getByRole("radiogroup", { name: "AI suggestions" }).getByText("Off").click();
	await dragOnto(page, sticky(page, "A logo?"), sticky(page, "Getting started guide"), 700);
	await expect(stackNode(page, "Untitled stack")).toBeVisible();
	const first = await centre(sticky(page, "Provider docs are hard"));
	await page.mouse.click(first.x, first.y);
	await page.keyboard.down("Shift");
	for (const text of ["CI takes 25 minutes", "No example for a custom"]) {
		const at = await centre(sticky(page, text));
		await page.mouse.click(at.x, at.y);
	}
	await page.keyboard.up("Shift");
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await expect(bar.getByRole("button", { name: "Stack these" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Group these into named stacks" })).toHaveCount(0);
});
