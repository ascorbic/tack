import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Decisions on the /play "decisions" scenario: making one with the tool,
// voting, deciding, superseding, and staging the write-back as an ADR pull
// request or a Discussion post (against the playground's fake repository,
// which already has records 0001 and 0002, while the scenario's written-back
// decision holds 0003).

const decision = (page: Page, title: string) =>
	page.locator(".react-flow__node-decision", {
		has: page.getByRole("article", { name: `Decision: ${title}`, exact: true }),
	});

const PROPOSED = "Require Node 20 in unpic 5.0";

/** What the board's document holds for the change a decision staged. */
async function stagedChange(page: Page, title: string) {
	return page.evaluate((title) => {
		const doc = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } }).tackPlayground
			.doc;
		const shapes = doc.getMap("shapes") as import("yjs").Map<import("yjs").Map<unknown>>;
		const shape = [...shapes.values()].find((s) => s.get("title") === title);
		const id = shape?.get("writeback");
		const change = typeof id === "string" ? doc.getMap("changes").get(id) : undefined;
		return change ? (change as import("yjs").Map<unknown>).toJSON() : null;
	}, title);
}

test.beforeEach(async ({ page }) => openScenario(page, "decisions"));

test("every decision state renders", async ({ page }) => {
	await expect(page.locator(".decision")).toHaveCount(4);
	await expect(page.locator(".decision[data-status=proposed]")).toHaveCount(1);
	await expect(page.locator(".decision[data-status=decided]")).toHaveCount(2);
	await expect(page.locator(".decision[data-status=superseded]")).toHaveCount(1);

	const proposed = decision(page, PROPOSED);
	// Linked through connectors to an issue and its PR.
	await expect(proposed.locator(".decision-link")).toHaveCount(2);
	await expect(proposed.getByRole("button", { name: "Agree: 2 votes" })).toBeVisible();
	await expect(proposed.getByRole("button", { name: "Disagree: 1 vote" })).toBeVisible();

	// The superseded one names what superseded it, and goes there.
	const old = decision(page, "Keep Node 16 until 5.0");
	await expect(old.locator(".decision-superseded")).toContainText(PROPOSED);

	// The written-back one shows its ADR's pull request, live.
	const written = decision(page, "Adopt Conventional Commits");
	await expect(written.locator(".decision-record")).toContainText("ADR 0003");
	await expect(written.locator(".decision-record .chip.state")).toHaveText("Open");
});

test("the decision tool places a decision to type into", async ({ page }) => {
	await openScenario(page, "empty");
	await page.keyboard.press("d");
	await expect(page.getByRole("button", { name: "Decision", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.mouse.click(520, 300);

	await expect(page.locator(".decision")).toHaveCount(1);
	const title = page.getByRole("textbox", { name: "Decision title" });
	await expect(title).toBeFocused();
	await page.keyboard.type("Ship ESM only");
	// Enter moves on to the body.
	await page.keyboard.press("Enter");
	const body = page.getByRole("textbox", { name: "Decision body" });
	await expect(body).toBeFocused();
	await page.keyboard.type("CJS doubles our build matrix.");
	await page.keyboard.press("Escape");
	await expect(title).toHaveCount(0);

	const made = decision(page, "Ship ESM only");
	await expect(made.locator(".decision")).toHaveAttribute("data-status", "proposed");
	await expect(made.locator(".decision-body")).toHaveText("CJS doubles our build matrix.");
	await expect(page.getByRole("button", { name: "Select" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("voting: one vote per person, changed or withdrawn with a click", async ({ page }) => {
	const proposed = decision(page, PROPOSED);
	const agree = proposed.getByRole("button", { name: /^Agree/ });
	const disagree = proposed.getByRole("button", { name: /^Disagree/ });

	await agree.click();
	await expect(agree).toHaveAttribute("aria-pressed", "true");
	await expect(agree).toHaveAccessibleName("Agree: 3 votes");

	// Changing your mind moves your vote.
	await disagree.click();
	await expect(disagree).toHaveAttribute("aria-pressed", "true");
	await expect(agree).toHaveAttribute("aria-pressed", "false");
	await expect(agree).toHaveAccessibleName("Agree: 2 votes");
	await expect(disagree).toHaveAccessibleName("Disagree: 2 votes");

	// Clicking it again withdraws it.
	await disagree.click();
	await expect(disagree).toHaveAccessibleName("Disagree: 1 vote");
	await expect(disagree).toHaveAttribute("aria-pressed", "false");

	// Someone else votes, and it lands.
	await page.getByRole("button", { name: "Someone votes" }).click();
	await expect(proposed.locator(".decision-voter")).toHaveCount(4);
});

test("deciding stamps it, then the write-back stages an ADR pull request", async ({ page }) => {
	const proposed = decision(page, PROPOSED);
	// Someone disagrees, so Decide asks once more, saying how the vote stands.
	await proposed.getByRole("button", { name: "Decide" }).click();
	await expect(proposed.locator(".decision")).toHaveAttribute("data-status", "proposed");
	await expect(proposed.locator(".decision-contested")).toHaveText("2 agree, 1 disagree");
	await proposed.getByRole("button", { name: "Decide anyway" }).click();
	await expect(proposed.locator(".decision")).toHaveAttribute("data-status", "decided");
	await expect(proposed.locator(".decision-stamp")).toHaveText("Decided");
	// Votes close once it's decided.
	await expect(proposed.getByRole("button", { name: /^Agree/ })).toHaveCount(0);

	await proposed.getByRole("button", { name: "Write back" }).click();
	const dialog = page.getByRole("dialog", { name: PROPOSED });
	await expect(dialog).toBeVisible();
	// Numbered after the repository's records and the one staged on this board.
	const path = "docs/decisions/0004-require-node-20-in-unpic-5-0.md";
	await expect(dialog.getByRole("textbox", { name: "Folder" })).toHaveValue("docs/decisions");
	await expect(dialog.locator(".writeback-preview-label")).toHaveText(path);
	// The repository reads as a value, and the folder can be changed in place.
	await expect(dialog.locator(".repo-value")).toContainText("acme/unpic");
	const folder = dialog.getByRole("textbox", { name: "Folder" });
	await folder.fill("docs/adr");
	await folder.press("Enter");
	await expect(dialog.locator(".writeback-preview-label")).toHaveText(
		"docs/adr/0001-require-node-20-in-unpic-5-0.md",
	);
	await folder.fill("docs/decisions");
	await folder.press("Enter");
	await expect(dialog.locator(".writeback-preview-label")).toHaveText(path);
	const preview = dialog.getByRole("region", { name: "Preview" });
	await expect(preview.locator("h1")).toHaveText(`4. ${PROPOSED}`);
	await expect(preview.locator("h2")).toHaveText([
		"Status",
		"Context",
		"Decision",
		"Consequences",
		"Links",
	]);

	// Consequences typed in the dialog land in the record, and on the decision:
	// Cancel doesn't lose them, and the board shows them.
	await dialog.getByRole("textbox", { name: "Consequences" }).fill("Users on 18 stay on 4.x.");
	await expect(preview).toContainText("Users on 18 stay on 4.x.");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(proposed.locator(".decision-consequences")).toContainText(
		"Users on 18 stay on 4.x.",
	);
	await proposed.getByRole("button", { name: "Write back" }).click();
	await expect(dialog.getByRole("textbox", { name: "Consequences" })).toHaveValue(
		"Users on 18 stay on 4.x.",
	);
	await dialog.getByRole("button", { name: "Stage write-back" }).click();
	await expect(dialog).toHaveCount(0);

	await expect(proposed.locator(".decision-writeback")).toHaveText(/ADR 0004 · Staged/);
	const change = await stagedChange(page, PROPOSED);
	expect(change).toMatchObject({
		status: "staged",
		op: {
			kind: "pr.create",
			repo: "fake.tack/acme/unpic",
			title: `ADR 0004: ${PROPOSED}`,
			branch: "tack/adr-0004-require-node-20-in-unpic-5-0",
			files: [{ path }],
		},
	});
	const content = (change as { op: { files: { content: string }[] } }).op.files[0]?.content;
	expect(content).toContain("## Consequences\n\nUsers on 18 stay on 4.x.");
	expect(content).toContain("fake.tack/acme/unpic/412");

	// Nothing's written until a push; then it shows the pull request, live.
	await page.getByRole("button", { name: "Push write-backs" }).click();
	await expect(proposed.locator(".decision-record")).toContainText("ADR 0004");
	await expect(proposed.locator(".decision-record .chip.state")).toHaveText("Open");
	await page.getByRole("button", { name: "Merge the ADR" }).click();
	await expect(proposed.locator(".decision-record .chip.state")).toHaveText("Merged");
});

test("the write-back can be a Discussion post, and staging it can be undone", async ({ page }) => {
	const proposed = decision(page, PROPOSED);
	await proposed.getByRole("button", { name: "Decide" }).click();
	await proposed.getByRole("button", { name: "Decide anyway" }).click();
	await proposed.getByRole("button", { name: "Write back" }).click();
	const dialog = page.getByRole("dialog", { name: PROPOSED });
	await dialog.getByRole("radio", { name: /Discussion post/ }).click();
	const category = dialog.getByRole("combobox", { name: "Category" });
	await expect(category).toHaveValue("Decisions");
	await category.selectOption("Announcements");
	await dialog.getByRole("button", { name: "Stage write-back" }).click();
	await expect(dialog).toHaveCount(0);

	await expect(proposed.locator(".decision-writeback")).toHaveText(/Discussion · Staged/);
	expect(await stagedChange(page, PROPOSED)).toMatchObject({
		op: {
			kind: "discussion.create",
			category: "Announcements",
			title: `Decision: ${PROPOSED}`,
		},
	});

	// Undo takes back the staged change and the decision's link to it together.
	await page.keyboard.press("ControlOrMeta+z");
	await expect(proposed.getByRole("button", { name: "Write back" })).toBeVisible();
	expect(await stagedChange(page, PROPOSED)).toBeNull();
});

test("marking it superseded by another decision is a step of its own", async ({ page }) => {
	const proposed = decision(page, PROPOSED);
	await proposed.getByRole("button", { name: "Decision options" }).click();
	// The other decisions aren't listed as though they already superseded it.
	await expect(page.getByRole("menuitem", { name: "Serve AVIF by default" })).toHaveCount(0);
	await page.getByRole("menuitem", { name: "Mark as superseded by…" }).click();
	const pick = page.getByRole("menu", { name: "Superseded by which decision?" });
	await expect(pick).toBeVisible();
	await pick.getByRole("menuitem", { name: /Back|Superseded by which/ }).click();
	await expect(page.getByRole("menu", { name: "Decision" })).toBeVisible();
	await page.getByRole("menuitem", { name: "Mark as superseded by…" }).click();
	await pick.getByRole("menuitem", { name: "Serve AVIF by default" }).click();
	await expect(proposed.locator(".decision")).toHaveAttribute("data-status", "superseded");
	await expect(proposed.locator(".decision-superseded")).toContainText("Serve AVIF by default");
});

test("superseding with a new decision links the two", async ({ page }) => {
	const decided = page.locator(".decision[data-status=decided]");
	await expect(decided).toHaveCount(2);
	const proposed = decision(page, PROPOSED);
	await proposed.getByRole("button", { name: "Decision options" }).click();
	await page.getByRole("menuitem", { name: /Supersede with a new decision/ }).click();

	await expect(proposed.locator(".decision")).toHaveAttribute("data-status", "superseded");
	const title = page.getByRole("textbox", { name: "Decision title" });
	await expect(title).toBeFocused();
	await page.keyboard.type("Require Node 22 in 6.0");
	await page.keyboard.press("Escape");
	await expect(proposed.locator(".decision-superseded")).toContainText("Require Node 22 in 6.0");
	// A dashed "supersedes" connector joins them.
	await expect(page.locator(".connector-label", { hasText: "supersedes" })).toHaveCount(2);
});
