import type { Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// The selection actions (#32, #33) on the playground's "Write back" board:
// each stages changes in the board document, and nothing else.

interface Change {
	id: string;
	status: string;
	op: { kind: string; [key: string]: unknown };
	effect?: { kind: string; shapes?: string[]; shape?: string; near?: string[] };
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
	await expect(panel.locator(".repo-value")).toContainText("acme/unpic");
	const list = panel.getByRole("list", { name: "Issues to make" });
	await expect(list.getByRole("textbox").first()).toHaveValue("Benchmarks in CI");
	// A description opens to be checked.
	await list.getByRole("button", { name: "+ description" }).click();
	await expect(list).toContainText("Run them on every PR and comment with the diff");
	// A title can be reworded here, and it's written back to its sticky.
	await list.getByRole("textbox").nth(1).fill("A provider playground, live");
	await expect(node(page, "A provider playground, live")).toBeVisible();
	await panel.getByRole("button", { name: "Stage 2 issues" }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.locator(".toast")).toContainText("Staged 2 issues for acme/unpic");

	const staged = await changes(page);
	expect(staged.map((c) => c.op)).toEqual([
		{
			kind: "issue.create",
			repo: "fake.tack/acme/unpic",
			title: "Benchmarks in CI",
			body: "Run them on every PR and comment with the diff",
		},
		{ kind: "issue.create", repo: "fake.tack/acme/unpic", title: "A provider playground, live" },
	]);
	expect(staged.every((c) => c.status === "staged" && c.effect?.kind === "replace")).toBe(true);

	// Already staged: the bar says so.
	await expect(bar(page).getByRole("button", { name: "Make issues from stickies" })).toBeDisabled();

	await page.locator(".toast").getByRole("button", { name: /Undo/ }).click();
	expect(await changes(page)).toEqual([]);
});

test("stickies become issues that start with labels, a milestone and an assignee", async ({
	page,
}) => {
	await select(page, "Benchmarks in CI", "A provider playground");
	await page.keyboard.press("Alt+KeyI");
	const panel = page.getByRole("dialog", { name: "Make issues from stickies" });
	const extras = panel.getByRole("group", { name: "Start with" });

	// Labels: type to filter, ↵ ticks; the pill shows them once closed.
	await extras.getByRole("button", { name: "Labels" }).click();
	await expect(panel.getByRole("combobox", { name: "Filter labels" })).toBeFocused();
	await page.keyboard.type("perf");
	await page.keyboard.press("Enter");
	await panel.getByRole("combobox", { name: "Filter labels" }).fill("");
	await panel.getByRole("option", { name: /^docs/ }).click();
	await extras.getByRole("button", { name: "Labels" }).click();
	await expect(extras.getByRole("button", { name: "Labels" })).toContainText("performance");

	// A milestone: picking one closes its list.
	await extras.getByRole("button", { name: "Milestone" }).click();
	await panel.getByRole("option", { name: /5\.0/ }).click();
	await expect(panel.getByRole("listbox", { name: "Milestones" })).toHaveCount(0);
	await expect(extras.getByRole("button", { name: "Milestone" })).toContainText("5.0");

	await extras.getByRole("button", { name: "Assignees" }).click();
	await panel.getByRole("option", { name: /kai/ }).click();
	await panel.getByRole("button", { name: "Stage 2 issues" }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.locator(".toast")).toContainText("with 2 labels");

	const extra = { labels: ["performance", "docs"], milestone: "5.0", assignees: ["kai"] };
	expect((await changes(page)).map((c) => c.op)).toEqual([
		{
			kind: "issue.create",
			repo: "fake.tack/acme/unpic",
			title: "Benchmarks in CI",
			body: "Run them on every PR and comment with the diff",
			...extra,
		},
		{
			kind: "issue.create",
			repo: "fake.tack/acme/unpic",
			title: "A provider playground",
			...extra,
		},
	]);
});

test("a typed repository, and one without the app", async ({ page }) => {
	await select(page, "Codemods for 5.0");
	await bar(page).getByRole("button", { name: "Make issues from stickies" }).click();
	const panel = page.getByRole("dialog");
	// The board's own repository is chosen, and reads as a value, with the
	// list folded away until it's wanted.
	const field = panel.getByRole("combobox", { name: "Repository" });
	await expect(panel.locator(".repo-value")).toContainText("acme/unpic");
	await expect(field).toHaveAttribute("aria-expanded", "false");
	await expect(panel.getByRole("listbox")).toBeHidden();
	await panel.getByRole("button", { name: "Change" }).click();
	await panel.getByRole("option", { name: /pixelmill\/pixelmill/ }).click();
	await expect(panel.getByRole("listbox")).toBeHidden();
	await expect(panel.locator(".repo-value")).toContainText("pixelmill/pixelmill");
	await expect(panel.getByText("Tack can’t write to")).toBeVisible();
	await expect(panel.getByRole("button", { name: "Stage issue" })).toBeDisabled();

	// A pasted link to an issue picks its repository.
	await field.fill("https://fake.tack/demo/app/issues/3");
	await expect(panel.getByRole("option", { name: /demo\/app/ })).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(panel.locator(".repo-value")).toContainText("demo/app");

	await field.fill("acme/new-thing");
	await page.keyboard.press("Enter");
	await expect(panel.locator(".repo-value")).toContainText("acme/new-thing");
	// ⌘↵ stages from every panel, as its button says.
	await expect(panel.getByRole("button", { name: /^Stage issue/ }).locator("kbd")).toHaveText(
		/⌘↵|Ctrl ↵/,
	);
	await page.keyboard.press("ControlOrMeta+Enter");
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
	// Its card will land above the section, which shows where meanwhile.
	expect(parent?.effect).toEqual({ kind: "place", near: parent?.shapes });
	await expect(page.locator(".staged-parent")).toContainText("Docs for 5.0");
	expect(staged.filter((c) => c.op.kind === "issue.create")).toHaveLength(3);
	const links = staged.filter((c) => c.op.kind === "item.subIssue");
	expect(links).toHaveLength(4);
	expect(links.every((c) => (c.op.parent as { pending: string }).pending === parent?.id)).toBe(
		true,
	);
	expect(links.filter((c) => "pending" in (c.op.child as object))).toHaveLength(2);
});

test("a section that's already under a parent issue adds to it, rather than making another", async ({
	page,
}) => {
	await page.locator(".section-handle", { hasText: "Node 20 cleanup" }).click();
	await bar(page).getByRole("button", { name: "Make a parent issue from this section" }).click();
	const panel = page.getByRole("dialog");
	// It asks the forge which parents its cards have, then says.
	await expect(panel.getByText("Checking which already have a parent…")).toBeVisible();
	await expect(panel.locator(".action-notice[data-tone=warn]")).toHaveText(
		"#441 and #442 are already sub-issues of #412 Drop Node 18 support.",
	);
	const choices = panel.getByRole("group", { name: "What to do" });
	await expect(choices.getByRole("radio", { name: /^Add to #412/ })).toBeChecked();
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveCount(0);
	const list = panel.getByRole("list", { name: "Sub-issues" });
	await expect(list.locator("li[data-fate=already]")).toHaveCount(2);
	await expect(list.locator("li[data-fate=already]").first()).toContainText("already under #412");

	// Moving them to a new parent says so, row by row.
	await choices.locator("label", { hasText: "Make a new parent and move them" }).click();
	await expect(list.locator("li[data-fate=move]")).toHaveCount(2);
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Node 20 cleanup");
	await expect(panel.getByRole("button", { name: /^Stage 3, moving 2/ })).toBeVisible();

	// The default: only the sticky is new, and it goes under #412.
	await choices.locator("label", { hasText: "Add to #412" }).click();
	await panel.getByRole("button", { name: /^Add 1 sub-issue to #412/ }).click();
	const staged = await changes(page);
	expect(staged.filter((c) => c.op.kind === "issue.create").map((c) => c.op.title)).toEqual([
		"Drop Node 18 from the docs examples",
	]);
	const links = staged.filter((c) => c.op.kind === "item.subIssue");
	expect(links).toHaveLength(1);
	expect(links[0]?.op.parent).toEqual({ key: expect.stringMatching(/#412$/) });
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

	// Enter picks the first real milestone; taking it off is last in the list.
	await page.keyboard.press("Alt+KeyM");
	const milestones = page.getByRole("dialog", { name: "Milestone" }).getByRole("option");
	await expect(milestones.first()).toContainText("5.0");
	await expect(milestones.last()).toContainText("No milestone");
	await page.keyboard.press("Enter");

	await page.keyboard.press("Alt+KeyC");
	await page.getByRole("menuitem", { name: /Close as not planned/ }).click();

	const ops = (await changes(page)).map((c) => c.op);
	const key = (n: number) => ({ key: `fake.tack/acme/unpic#${n}` });
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

test("the bar is a toolbar the keyboard reaches from the selection", async ({ page }) => {
	await select(page, "Drop Node 18");
	const shape = node(page, "Drop Node 18");
	await shape.focus();
	// Tab from the selected shape lands on the bar's first button.
	await page.keyboard.press("Tab");
	const buttons = bar(page).locator(":scope > .selection-action");
	await expect(buttons.first()).toBeFocused();
	// One tab stop; arrow keys move along it.
	await expect(buttons.nth(1)).toHaveAttribute("tabindex", "-1");
	await page.keyboard.press("ArrowRight");
	await expect(buttons.nth(1)).toBeFocused();
	await page.keyboard.press("End");
	await expect(buttons.last()).toBeFocused();
	await page.keyboard.press("Home");
	await expect(buttons.first()).toBeFocused();
	// Opening a panel and closing it comes back to the button.
	await page.keyboard.press("ArrowRight");
	const labelsButton = bar(page).getByRole("button", { name: "Labels" });
	await expect(labelsButton).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "Labels" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Labels" })).toHaveCount(0);
	await expect(labelsButton).toBeFocused();
	// Escape goes back to the shape; F6 from the board comes back to the bar.
	await page.keyboard.press("Escape");
	await expect(shape).toBeFocused();
	await page.keyboard.press("F6");
	await expect(labelsButton).toBeFocused();
});

test("two connected issues offer blocked-by in the action bar", async ({ page }) => {
	await select(page, "Drop Node 18", "Custom domains");
	await bar(page)
		.getByRole("button", { name: /^Blocked by/ })
		.click();
	const panel = page.getByRole("dialog", { name: "Blocked by" });
	await expect(panel).toContainText("#377 will be marked as blocked by #412.");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(panel).toHaveCount(0);
	const [change] = await changes(page);
	expect(change?.op).toEqual({
		kind: "item.blockedBy",
		target: { key: "fake.tack/acme/unpic#377" },
		blockedBy: { key: "fake.tack/acme/unpic#412" },
	});
	// Not connected: not offered.
	await select(page, "Custom domains", "Rotate the signing keys");
	await expect(bar(page).getByRole("button", { name: /^Blocked by/ })).toHaveCount(0);
});

test("a connector between issues becomes blocked-by", async ({ page }) => {
	await page.locator(".connector-hit").first().click({ force: true });
	await page.getByRole("button", { name: "Blocked by", exact: true }).click();
	const panel = page.getByRole("dialog", { name: "Blocked by" });
	await expect(panel).toContainText("#377 will be marked as blocked by #412.");
	await panel.getByRole("button", { name: "Swap which blocks which" }).click();
	await expect(panel).toContainText("#412 will be marked as blocked by #377.");
	await panel.getByRole("button", { name: "Swap which blocks which" }).click();
	await panel.getByRole("button", { name: /^Stage/ }).click();

	const [change] = await changes(page);
	expect(change?.op).toEqual({
		kind: "item.blockedBy",
		target: { key: "fake.tack/acme/unpic#377" },
		blockedBy: { key: "fake.tack/acme/unpic#412" },
	});
	expect(change?.effect?.kind).toBe("connect");
	await expect(page.getByRole("button", { name: "Blocked by", exact: true })).toHaveAttribute(
		"data-staged",
		"true",
	);
});

const uploads = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { tackSnapshots: { bytes: number }[] }).tackSnapshots.length,
	);

test("backlinks are a link to the board, naming the card's section, by default", async ({
	page,
}) => {
	await select(page, "Document every provider");
	await page.keyboard.press("Alt+KeyK");
	const panel = page.getByRole("dialog", { name: "Comment with a link to this board" });
	const include = panel.getByRole("checkbox", { name: "Include a snapshot of the board" });
	await expect(include).not.toBeChecked();
	await expect(panel.locator(".backlink-snapshot img")).toHaveCount(0);
	await panel.getByRole("button", { name: "Stage comment" }).click();
	await expect(panel).toHaveCount(0);

	const [comment] = (await changes(page)).filter((c) => c.op.kind === "item.comment");
	expect(comment?.op.body).toBe(
		`This is on [**Playground**](${new URL(page.url()).origin}/play) in Tack, in the **Docs for 5.0** section.`,
	);
	// Nothing was drawn or uploaded.
	expect(await uploads(page)).toBe(0);
	expect(await page.evaluate(() => "tackSnapshotDom" in window)).toBe(false);
});

test("backlinks with snapshots that hide other private repositories", async ({ page }) => {
	// A staged label, so the card has staged marks the snapshot must leave out.
	await select(page, "Custom domains");
	await page.keyboard.press("Alt+KeyL");
	const labels = page.getByRole("dialog", { name: "Labels" });
	await labels.getByRole("combobox").fill("docs");
	await page.keyboard.press("Enter");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(labels).toHaveCount(0);
	await expect(node(page, "Custom domains").locator(".staged-label")).toHaveCount(1);

	await select(page, "Custom domains", "Rotate the signing keys");
	await page.keyboard.press("Alt+KeyK");
	const panel = page.getByRole("dialog", { name: "Comment with a link to this board" });
	await panel.getByRole("checkbox", { name: "Include a snapshot of the board" }).check();
	// One snapshot for the public repository's readers, one for the private one's.
	await expect(panel.getByRole("tab")).toHaveCount(2);
	await expect(panel.getByRole("tab").first()).toHaveText("For public repos");
	await expect(panel.getByRole("tab").nth(1)).toContainText("For acme/vault");
	await expect(panel).toContainText("2 versions of the image");
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

	// The image is of the board as it is (#69): the cards, but not their
	// selection, nor the label that's only staged.
	const drawn = await page.evaluate(
		() => (window as unknown as { tackSnapshotDom: string }).tackSnapshotDom,
	);
	expect(drawn).toContain("Custom domains");
	expect(drawn).not.toContain("staged-");
	expect(drawn).not.toMatch(/data-selected="true"|class="[^"]*\bselected\b/);
	expect(drawn).not.toContain("react-flow__node-toolbar");
	// The board on screen kept its selection and marks throughout.
	await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
	await expect(node(page, "Custom domains").locator(".staged-label")).toHaveCount(1);
	await expect(page.locator(".snapshot-stage")).toHaveCount(0);

	// The choice is remembered for this board.
	await page.keyboard.press("Alt+KeyK");
	await expect(
		page
			.getByRole("dialog", { name: "Comment with a link to this board" })
			.getByRole("checkbox", { name: "Include a snapshot of the board" }),
	).toBeChecked();
});

test("Assign says when nobody can be assigned, rather than opening an empty panel", async ({
	page,
}) => {
	await select(page, "Rotate the signing keys");
	const assign = bar(page).getByRole("button", { name: /^Assign/ });
	await expect(assign).toBeDisabled();
	await expect(assign).toHaveAttribute("data-tooltip", "Nobody can be assigned in acme/vault");
	await page.keyboard.press("Alt+KeyP");
	await expect(page.getByRole("dialog", { name: "Assign" })).toHaveCount(0);
	await expect(bar(page).getByRole("button", { name: "Labels" })).toBeEnabled();
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
	await expect(page.getByRole("toolbar", { name: "Stage changes" })).toHaveCount(6);
	// 27, and Group these' eight (#73): one with cards included, two of cards alone.
	await expect(page.locator(".action-popover")).toHaveCount(35);
	await expect(
		page
			.getByRole("dialog", { name: "Group these: Cards included" })
			.getByRole("checkbox", { name: /Include cards/ }),
	).toBeChecked();
	// Too few to group once the cards whose titles can't be shared are left out: it says so.
	await expect(
		page.getByRole("dialog", { name: "Group these: Too few, once private cards are left out" }),
	).toContainText("2 cards were left out, as their titles can’t be shared");
	const unreadable = page.getByRole("dialog", { name: "Group these: Nothing everyone can read" });
	await expect(unreadable).toContainText("Tack can only group what everyone here can read");
	await expect(unreadable.getByRole("checkbox")).toHaveCount(0);
	// Parent issues over what already has one: add to it, move them, or leave them.
	const already = page.locator("figure", { hasText: "Already a parent issue" });
	await expect(already.getByText("#5 and #6 are already sub-issues of #4 Resizing.")).toBeVisible();
	await expect(already.getByRole("button", { name: /^Add 1 sub-issue to #4/ })).toBeVisible();
	const moving = page.locator("figure", { hasText: "Making a new parent and moving them" });
	await expect(moving.locator("li[data-fate=move]")).toHaveCount(2);
	const others = page.locator("figure", { hasText: "Some have other parents" });
	await expect(others.locator("li[data-fate=out]")).toHaveCount(2);
	await expect(others.getByRole("radio", { name: "Make a new parent without them" })).toBeChecked();
	await expect(page.getByText("Checking which already have a parent…")).toBeVisible();
	await expect(page.locator(".backlink-snapshot img")).toHaveCount(2);
	// New issues that start with labels and a milestone, the labels' list open.
	const extras = page.locator("figure", { hasText: "With labels and a milestone" });
	await expect(extras.locator(".issue-extra[data-chosen]")).toHaveCount(2);
	// The repository reads as a value (its list folded away), and three labels are ticked.
	await expect(extras.locator(".repo-value")).toContainText("acme/unpic");
	await expect(extras.getByRole("option", { selected: true })).toHaveCount(3);
	await expect(page.getByText("Tack can’t write to")).toBeVisible();
	await expect(page.getByText("Make “Benchmarks in CI” an issue first")).toBeVisible();
	// Expand related: loading, ready, switched off, nothing, all here, and rate limited.
	const related = page.locator("section", { hasText: /^Expand related/ });
	await expect(related.locator(".related-panel")).toHaveCount(6);
	await expect(related.locator(".related-group")).toHaveCount(5 + 5 + 2);
	await expect(related.locator(".related-group[data-on=false]")).toHaveCount(2);
	await expect(related.getByText("Nothing’s linked to this issue yet")).toBeVisible();
	await expect(related.getByText("Everything’s here and connected.")).toBeVisible();
	await expect(related.getByText("rate limit is used up")).toBeVisible();
});

test("a merged pull request can still be triaged, but not closed, and needs no app", async ({
	page,
}) => {
	// Turn "Document every provider’s options" (#431) into a merged pull request.
	await page.evaluate(() => {
		type Store = { get(key: string): { kind: string } | undefined; set(card: unknown): void };
		const w = window as unknown as {
			tackCards: Store;
			tackPlayground: { doc: import("yjs").Doc };
		};
		for (const shape of w.tackPlayground.doc.getMap("shapes").values()) {
			const ref = (shape as import("yjs").Map<unknown>).get("ref");
			if (typeof ref !== "string" || !ref.endsWith("#431")) continue;
			const card = w.tackCards.get(ref);
			if (card) w.tackCards.set({ ...card, kind: "pull", state: "merged" });
		}
	});
	await select(page, "Document every provider");
	await expect(bar(page).getByRole("link", { name: "Install the app" })).toHaveCount(0);
	await expect(bar(page).getByRole("button", { name: "Labels" })).toBeEnabled();
	await expect(bar(page).getByRole("button", { name: "Close or reopen" })).toBeDisabled();
	await expect(bar(page).getByRole("button", { name: "Close or reopen" })).toHaveAttribute(
		"data-tooltip",
		"Merged pull requests can’t be closed or reopened",
	);
});
