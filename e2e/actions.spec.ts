import type { Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// The selection actions (#32, #33) on the playground's "Write back" board:
// each stages changes in the board document, and nothing else.

interface Change {
	id: string;
	status: string;
	op: { kind: string; [key: string]: unknown };
	effect?: { kind: string; shapes?: string[]; shape?: string };
	shapes?: string[];
}

/** The board's staged changes, oldest first. */
function changes(page: Page): Promise<Change[]> {
	return page.evaluate(() => {
		const board = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } })
			.tackPlayground;
		return [...board.doc.getMap("changes").values()]
			.map((change) => (change as import("yjs").Map<unknown>).toJSON() as Change)
			.sort((a, b) => ((a as never)["stagedAt"] < (b as never)["stagedAt"] ? -1 : 1));
	});
}

const node = (page: Page, text: string) =>
	page.locator(".react-flow__node", { hasText: text }).first();

const bar = (page: Page) => page.getByRole("toolbar", { name: "Stage changes" });

async function select(page: Page, ...texts: string[]) {
	for (const [i, text] of texts.entries()) {
		await node(page, text).click({
			position: { x: 24, y: 14 },
			modifiers: i > 0 ? ["Shift"] : [],
		});
	}
	await expect(bar(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => openScenario(page, "writes"));

test("stickies become staged issues, one undo step", async ({ page }) => {
	await select(page, "Benchmarks in CI", "A provider playground");
	await expect(bar(page).getByRole("button", { name: "Make issues from stickies" })).toHaveText(
		"Make 2 issues",
	);
	await page.keyboard.press("Alt+KeyI");
	const panel = page.getByRole("dialog", { name: "Make issues from stickies" });
	await expect(panel.getByRole("heading", { name: "Make 2 issues" })).toBeVisible();
	// The board's busiest repository is chosen; the titles are the first lines.
	await expect(panel.getByRole("option", { selected: true })).toContainText("acme/imagekit");
	await expect(panel.getByRole("list", { name: "Issues to make" })).toContainText(
		"Benchmarks in CI",
	);
	await panel.getByRole("button", { name: "Stage 2 issues" }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.locator(".toast")).toContainText("Staged 2 issues for acme/imagekit");

	const staged = await changes(page);
	expect(staged.map((c) => c.op)).toEqual([
		{
			kind: "issue.create",
			repo: "fake.tack/acme/imagekit",
			title: "Benchmarks in CI",
			body: "Run them on every PR and comment with the diff",
		},
		{ kind: "issue.create", repo: "fake.tack/acme/imagekit", title: "A provider playground" },
	]);
	expect(staged.every((c) => c.status === "staged" && c.effect?.kind === "replace")).toBe(true);

	// Already staged: the bar says so.
	await expect(bar(page).getByRole("button", { name: "Make issues from stickies" })).toBeDisabled();

	await page.locator(".toast").getByRole("button", { name: /Undo/ }).click();
	expect(await changes(page)).toEqual([]);
});

test("a typed repository, and one without the app", async ({ page }) => {
	await select(page, "Codemods for 5.0");
	await bar(page).getByRole("button", { name: "Make issues from stickies" }).click();
	const panel = page.getByRole("dialog");
	await panel.getByRole("option", { name: /lovell\/sharp/ }).click();
	await expect(panel.getByText("Tack can’t write to")).toBeVisible();
	await expect(panel.getByRole("button", { name: "Stage issue" })).toBeDisabled();

	await panel.getByRole("combobox", { name: "Repository" }).fill("acme/new-thing");
	await page.keyboard.press("Enter");
	await expect(panel.getByRole("option", { selected: true })).toContainText("acme/new-thing");
	await page.keyboard.press("Enter");
	expect((await changes(page)).map((c) => c.op)).toEqual([
		{ kind: "issue.create", repo: "fake.tack/acme/new-thing", title: "Codemods for 5.0" },
	]);
});

test("a section becomes a parent issue with sub-issues", async ({ page }) => {
	await page.locator(".section-handle").first().click();
	await bar(page).getByRole("button", { name: "Make a parent issue from this section" }).click();
	const panel = page.getByRole("dialog");
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Docs for 5.0");
	await expect(panel.getByRole("list", { name: "Sub-issues" }).locator("li")).toHaveCount(4);
	await panel.getByRole("button", { name: "Stage with 4 sub-issues" }).click();

	const staged = await changes(page);
	const parent = staged.find((c) => c.op.kind === "issue.create" && c.op.title === "Docs for 5.0");
	expect(parent).toBeTruthy();
	expect(staged.filter((c) => c.op.kind === "issue.create")).toHaveLength(3);
	const links = staged.filter((c) => c.op.kind === "item.subIssue");
	expect(links).toHaveLength(4);
	expect(links.every((c) => (c.op.parent as { pending: string }).pending === parent?.id)).toBe(
		true,
	);
	expect(links.filter((c) => "pending" in (c.op.child as object))).toHaveLength(2);
});

test("labels, milestone and closing on selected cards", async ({ page }) => {
	await select(page, "Drop Node 18", "Custom domains");
	await page.keyboard.press("Alt+KeyL");
	const labels = page.getByRole("dialog", { name: "Labels" });
	// Mixed: one card has "bug"; neither has "docs".
	await expect(labels.getByRole("option", { name: /^bug/ })).toHaveAttribute(
		"aria-checked",
		"mixed",
	);
	await labels.getByRole("combobox").fill("docs");
	await page.keyboard.press("Enter");
	await expect(labels.locator(".action-summary")).toContainText("+2");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(labels).toHaveCount(0);

	await page.keyboard.press("Alt+KeyM");
	await page
		.getByRole("dialog", { name: "Milestone" })
		.getByRole("option", { name: /5\.0/ })
		.click();

	await page.keyboard.press("Alt+KeyC");
	await page.getByRole("menuitem", { name: /Close as not planned/ }).click();

	const ops = (await changes(page)).map((c) => c.op);
	const key = (n: number) => ({ key: `fake.tack/acme/imagekit#${n}` });
	expect(ops).toEqual([
		{ kind: "item.labels", target: key(412), add: ["docs"] },
		{ kind: "item.labels", target: key(377), add: ["docs"] },
		{ kind: "item.milestone", target: key(412), milestone: "5.0" },
		{ kind: "item.milestone", target: key(377), milestone: "5.0" },
		{ kind: "item.state", target: key(412), state: "closed", reason: "not_planned" },
		{ kind: "item.state", target: key(377), state: "closed", reason: "not_planned" },
	]);

	// Labels again: the staged edit shows, and taking it back unstages it.
	await page.keyboard.press("Alt+KeyL");
	const again = page.getByRole("dialog", { name: "Labels" });
	await expect(again.getByRole("option", { name: /^docs/ })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await again.getByRole("option", { name: /^docs/ }).click();
	await again.getByRole("button", { name: /^Stage/ }).click();
	expect((await changes(page)).filter((c) => c.op.kind === "item.labels")).toEqual([]);
});

test("a connector between issues becomes blocked-by", async ({ page }) => {
	await page.locator(".connector-hit").first().click({ force: true });
	await page.getByRole("button", { name: "Blocked by" }).click();
	const panel = page.getByRole("dialog", { name: "Blocked by" });
	await expect(panel).toContainText("#377 will be marked as blocked by #412.");
	await panel.getByRole("button", { name: "Swap which blocks which" }).click();
	await expect(panel).toContainText("#412 will be marked as blocked by #377.");
	await panel.getByRole("button", { name: "Swap which blocks which" }).click();
	await panel.getByRole("button", { name: /^Stage/ }).click();

	const [change] = await changes(page);
	expect(change?.op).toEqual({
		kind: "item.blockedBy",
		target: { key: "fake.tack/acme/imagekit#377" },
		blockedBy: { key: "fake.tack/acme/imagekit#412" },
	});
	expect(change?.effect?.kind).toBe("connect");
	await expect(page.getByRole("button", { name: "Blocked by" })).toHaveAttribute(
		"data-staged",
		"true",
	);
});

test("backlinks with snapshots that hide other private repositories", async ({ page }) => {
	await select(page, "Custom domains", "Rotate the signing keys");
	await page.keyboard.press("Alt+KeyK");
	const panel = page.getByRole("dialog", { name: "Comment with a link to this board" });
	// One snapshot for the public repository's readers, one for the private one's.
	await expect(panel.getByRole("tab")).toHaveCount(2);
	await expect(panel.locator(".backlink-snapshot img")).toBeVisible({ timeout: 15_000 });
	await expect(panel).toContainText("A card from a private repository is hidden");
	await panel.getByRole("tab", { name: /vault/ }).click();
	await expect(panel.locator(".backlink-snapshot img")).toBeVisible({ timeout: 15_000 });
	await panel.getByRole("textbox", { name: "Note" }).fill("Planned for 5.0");
	await panel.getByRole("button", { name: "Stage 2 comments" }).click();
	await expect(panel).toHaveCount(0);

	const comments = (await changes(page)).filter((c) => c.op.kind === "item.comment");
	expect(comments).toHaveLength(2);
	for (const comment of comments) {
		expect(comment.op.body).toContain("Planned for 5.0");
		expect(comment.op.body).toMatch(/\[!\[The board around this item\]\(blob:/);
	}
	// Each audience got its own image, both real PNGs.
	const sizes = await page.evaluate(() =>
		(window as unknown as { tackSnapshots: { bytes: number }[] }).tackSnapshots.map((s) => s.bytes),
	);
	expect(sizes).toHaveLength(2);
	expect(sizes.every((bytes) => bytes > 1000)).toBe(true);
});

test("cards without the app can't be changed", async ({ page }) => {
	await page.keyboard.press("Shift+Digit1");
	await settleCanvas(page);
	await select(page, "AVIF output");
	await expect(bar(page).getByRole("button", { name: "Labels" })).toBeDisabled();
	await expect(bar(page).getByRole("link", { name: "Install the app" })).toBeVisible();
	await page.keyboard.press("Alt+KeyL");
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the actions gallery shows every state", async ({ page }) => {
	await page.goto("/play/actions");
	await expect(page.getByRole("heading", { name: "Selection actions" })).toBeVisible();
	await expect(page.getByRole("toolbar", { name: "Stage changes" })).toHaveCount(5);
	await expect(page.locator(".action-popover")).toHaveCount(15);
	await expect(page.locator(".backlink-snapshot img")).toHaveCount(2);
	await expect(page.getByText("Tack can’t write to")).toBeVisible();
	await expect(page.getByText("Make “Benchmarks in CI” an issue first")).toBeVisible();
});
