import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Stacks (#73) on the playground's theming board: dragging a sticky onto
// another and holding makes a stack, named ✨ by the pretend server's
// stand-in model, drawn as a theme card (its name, count and first few
// members, and only its name zoomed out); ✓ keeps a suggested name; stacks
// open into a tray and gather back; issues and pull requests stack too, and
// a stack of them becomes a parent issue with its issues as sub-issues;
// Auto-stack previews stacks for a selection (cards too, if asked) before
// making them.

interface Shape {
	id: string;
	type: string;
	text?: string;
	title?: string;
	stack?: string | null;
	suggested?: { title: string };
	unnameable?: { hash: string };
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

/** The board's staged changes. */
function changes(page: Page): Promise<{ op: Record<string, unknown> }[]> {
	return page.evaluate(() => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return [...board.doc.getMap("changes").values()].map(
			(change) =>
				(change as import("yjs").Map<unknown>).toJSON() as { op: Record<string, unknown> },
		);
	});
}

const sticky = (page: Page, text: string) =>
	page.locator(".react-flow__node-sticky", { hasText: text }).first();

const stackNode = (page: Page, name: string) =>
	page.locator(".react-flow__node-stack", { hasText: name }).first();

const cardNode = (page: Page, text: string) =>
	page.locator(".react-flow__node-card", { hasText: text }).first();

/** Spread a stack open (a click), selecting it: its actions are in the bar. */
async function openStack(page: Page, name: string) {
	await stackNode(page, name).locator(".stack-rows").click();
	await expect(page.locator(".stack-tray")).toBeVisible();
}

/** Shift-click each of these, after clicking the first. */
async function selectAll(page: Page, items: Locator[]) {
	const [first, ...rest] = items;
	if (!first) return;
	const at = await centre(first);
	await page.mouse.click(at.x, at.y);
	await page.keyboard.down("Shift");
	for (const item of rest) {
		const next = await centre(item);
		await page.mouse.click(next.x, next.y);
	}
	await page.keyboard.up("Shift");
}

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
	// A theme card: its name, and its first stickies a line each.
	await expect(stack.locator(".stack-rows li")).toHaveCount(3);
	await expect(stack.locator(".stack-rows")).toContainText("Builds got 2x slower");
	await stack.locator(".stack-rows").click();
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
	await stack.locator(".stack-rows").click();
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
	await stack.locator(".stack-name").click();
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

test("Auto-stack proposes named stacks, previewed on the board, made in one undo step", async ({
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
	await bar.getByRole("button", { name: "Auto-stack: sort these into named stacks" }).click();
	const panel = page.getByRole("dialog", { name: "Auto-stack: sort these into named stacks" });
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
	await openStack(page, "Big sites are slow");
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await bar.getByRole("button", { name: /Make a parent issue from this stack/ }).click();
	const panel = page.getByRole("dialog", { name: /Make a parent issue from this stack/ });
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Big sites are slow");
	for (const text of ["Srcset generation", "Builds got 2x slower", "Dev server lags"]) {
		await expect(panel).toContainText(text);
	}
});

test("a stack of issues, a pull request and a sticky: its issues become sub-issues, the pull request left out", async ({
	page,
}) => {
	const stack = stackNode(page, "Thin release notes");
	// Its first few, a line each, then how many more.
	await expect(stack.locator(".stack-count")).toHaveText("5");
	await expect(stack.locator(".stack-rows")).toContainText("Upgrade notes for 5.0 are missing");
	await expect(stack.locator(".stack-rows")).toContainText("#701");
	await expect(stack.locator(".stack-more")).toHaveText("+2 more");
	await openStack(page, "Thin release notes");
	// Its bar's under the playground's panel here: the shortcut does the same.
	await page.keyboard.press("Alt+Shift+KeyI");
	const panel = page.getByRole("dialog", { name: /Make a parent issue from this stack/ });
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Thin release notes");
	const subs = panel.getByRole("list", { name: "Sub-issues" });
	await expect(subs).toContainText("Upgrade notes for 5.0 are missing");
	await expect(subs).toContainText("Write release notes for the 5.0 migration");
	await expect(subs).not.toContainText("Changelog entries for the new loader API");
	await expect(panel).toContainText("A pull request is left out: only issues can be sub-issues.");
	await panel.getByRole("button", { name: /^Stage/ }).click();
	await expect(panel).toHaveCount(0);
	const staged = await changes(page);
	const links = staged.filter((c) => c.op.kind === "item.subIssue");
	// The issues already there are linked as they are; only the sticky's made.
	const keys = links.flatMap((c) => {
		const child = c.op.child as { key?: string };
		return child.key ? [child.key] : [];
	});
	expect(keys.some((key) => key.endsWith("#701"))).toBe(true);
	expect(keys.some((key) => key.endsWith("#712"))).toBe(false);
	expect(staged.filter((c) => c.op.kind === "issue.create").map((c) => c.op.title)).toEqual(
		expect.arrayContaining(["Thin release notes", "Upgrade notes for 5.0 are missing"]),
	);
});

test("✓ keeps a suggested name, which then never changes", async ({ page }) => {
	const stack = stackNode(page, "Newcomer onboarding");
	await expect(stack.locator(".stack-spark")).toBeVisible();
	await stack.hover();
	await stack.getByRole("button", { name: "Keep “Newcomer onboarding” as its name" }).click();
	await expect(stack.locator(".stack-spark")).toHaveCount(0);
	await expect
		.poll(async () => (await stacks(page)).find((s) => s.title === "Newcomer onboarding"))
		.toBeTruthy();
	await expect(stack.getByRole("button", { name: /^Keep/ })).toHaveCount(0);
});

test("a sticky and a card stack together", async ({ page }) => {
	await selectAll(page, [sticky(page, "A logo?"), cardNode(page, "Dev server lags")]);
	const before = (await stacks(page)).length;
	await page
		.getByRole("toolbar", { name: "Stage changes" })
		.getByRole("button", { name: "Stack these" })
		.click();
	await expect.poll(async () => (await stacks(page)).length).toBe(before + 1);
	const made = page.getByRole("group", { name: /a stack of 2 items/ });
	await expect(made).toBeVisible();
	await expect(made.locator(".stack-rows")).toContainText("#720");
	await expect(made.locator(".stack-rows")).toContainText("A logo?");
	await expect(cardNode(page, "Dev server lags")).toBeHidden();
});

test("zoomed out, a stack is its name and count", async ({ page }) => {
	const stack = page.locator(".stack", { hasText: "Big sites are slow" }).first();
	await expect(stack).not.toHaveAttribute("data-far", "true");
	const out = page.getByRole("button", { name: "Zoom out" });
	for (let i = 0; i < 4; i++) await out.click();
	await expect(stack).toHaveAttribute("data-far", "true");
	await expect(stack.locator(".stack-far-name")).toContainText("Big sites are slow");
	await expect(stack.locator(".stack-far-count")).toHaveText("3");
});

test("Unstack lays a stack's stickies out where it was", async ({ page }) => {
	await openStack(page, "Big sites are slow");
	await page.keyboard.press("Alt+KeyU");
	await expect(stackNode(page, "Big sites are slow")).toHaveCount(0);
	for (const text of ["Srcset generation", "Builds got 2x slower", "Dev server lags"]) {
		await expect(sticky(page, text)).toBeVisible();
	}
});

test("Auto-stack leaves cards out unless asked to include them", async ({ page }) => {
	await selectAll(page, [
		sticky(page, "CI takes 25 minutes"),
		sticky(page, "Flaky e2e on Windows"),
		sticky(page, "Can't rerun one job"),
		cardNode(page, "Dev server lags"),
	]);
	await page.keyboard.press("Alt+Shift+KeyG");
	const panel = page.getByRole("dialog", { name: "Auto-stack: sort these into named stacks" });
	await expect(panel.getByRole("textbox", { name: "Name of stack 1" })).toHaveValue(
		"Unreliable CI",
	);
	const include = panel.getByRole("checkbox", { name: /Include cards/ });
	await expect(include).not.toBeChecked();
	await expect(page.locator(".react-flow__node.stack-proposed")).toHaveCount(3);
	await expect(panel.getByText("1 card stays where it is.")).toHaveCount(0);
	// Asked in, the card's read too: it fits no theme here, so it stays.
	await include.check();
	await expect(panel.getByText("1 card stays where it is.")).toBeVisible();
});

test("issues and pull requests on their own are grouped, with nothing to tick", async ({
	page,
}) => {
	// The release stack's cards, laid out loose, and two more beside them.
	await openStack(page, "Thin release notes");
	await page.keyboard.press("Alt+KeyU");
	await expect(stackNode(page, "Thin release notes")).toHaveCount(0);
	await page.keyboard.press("Shift+Digit1");
	await selectAll(page, [
		cardNode(page, "Write release notes for the 5.0"),
		cardNode(page, "Changelog entries for the new loader"),
		cardNode(page, "Version notes skip breaking"),
		cardNode(page, "Dev server lags"),
		cardNode(page, "perf: cache srcset"),
	]);
	const bar = page.getByRole("toolbar", { name: "Stage changes" });
	await expect(
		bar.getByRole("button", { name: "Auto-stack: sort these into named stacks" }),
	).toHaveCount(1);
	await page.keyboard.press("Alt+Shift+KeyG");
	const panel = page.getByRole("dialog", { name: "Auto-stack: sort these into named stacks" });
	await expect(panel.getByRole("textbox", { name: "Name of stack 1" })).toHaveValue(
		"Thin release notes",
	);
	await expect(panel.getByRole("checkbox", { name: /Include cards/ })).toHaveCount(0);
	await expect(page.locator(".react-flow__node.stack-proposed")).toHaveCount(3);
	await expect(panel.getByText("2 cards stay where they are.")).toBeVisible();
	await page.screenshot({ path: "/private/tmp/claude-501/group-cards/cards-only.png" });
	const before = (await stacks(page)).length;
	await panel.getByRole("button", { name: "Make the stack" }).click();
	await expect.poll(async () => (await stacks(page)).length).toBe(before + 1);
});

test("with AI suggestions off, stacks are Untitled and there's no Auto-stack", async ({ page }) => {
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
	await expect(
		bar.getByRole("button", { name: "Auto-stack: sort these into named stacks" }),
	).toHaveCount(0);
});

test("a stack of only private cards is untitled for a person to name, never Naming… forever", async ({
	page,
}) => {
	// Seeded with two cards from a private repository: nothing everyone could read.
	const stack = page.getByRole("group", { name: "Untitled stack: a stack of 2 cards" });
	await expect(stack.locator(".stack-rows")).toContainText("Draft the 5.0 launch post");
	const name = stack.locator(".stack-name");
	// The pretend server marks it, well before the client would stop waiting on its own.
	await expect(name).toHaveAttribute("data-unnamed", "unnameable", { timeout: 5_000 });
	await expect(name).not.toHaveAttribute("data-waiting");
	await expect(name).toHaveText("Untitled stack");
	await expect(name.locator(".stack-pencil")).toBeVisible();
	expect((await stacks(page)).filter((s) => s.unnameable)).toHaveLength(1);
	// Why, said quietly: on hover, and to a screen reader.
	await expect(name).toHaveAccessibleDescription(
		"Not named automatically Tack only names stacks from what everyone here can read.",
	);
	const tip = stack.getByRole("tooltip");
	await expect(tip).toHaveCSS("opacity", "0");
	await name.hover();
	await expect(tip).toHaveCSS("opacity", "1");
	// And it's theirs to name.
	await name.click();
	const field = page.getByRole("textbox", { name: "Stack name" });
	await field.fill("Launch prep");
	await field.press("Enter");
	await expect(page.getByRole("group", { name: "Launch prep: a stack of 2 cards" })).toBeVisible();
	await expect
		.poll(async () => (await stacks(page)).some((s) => s.title === "Launch prep"))
		.toBe(true);
});

test("a stack whose name never comes stops saying Naming… and is untitled to name", async ({
	page,
}) => {
	test.slow();
	await page.getByRole("radiogroup", { name: "AI suggestions" }).getByText("Failing").click();
	await selectAll(page, [sticky(page, "A logo?"), sticky(page, "Getting started guide")]);
	await page
		.getByRole("toolbar", { name: "Stage changes" })
		.getByRole("button", { name: "Stack these" })
		.click();
	const name = page
		.getByRole("group", { name: "Untitled stack: a stack of 2 stickies" })
		.locator(".stack-name");
	// Waiting, for a while: the model's failing, but it could have been slow.
	await expect(name).toHaveAttribute("data-waiting", "true");
	await expect(name).toHaveText("Naming…");
	await page.waitForTimeout(5_000);
	await expect(name).toHaveText("Naming…");
	// Then it stops waiting: untitled, with the pencil.
	await expect(name).toHaveAttribute("data-unnamed", "late", { timeout: 12_000 });
	await expect(name).toHaveText("Untitled stack");
	await expect(name.locator(".stack-pencil")).toBeVisible();
});
