import { existsSync } from "node:fs";
import { expect, test } from "./fixtures.ts";

// Checks over the card gallery, which shows every card state. The pixel
// comparison ("the gallery looks right") is opt-in with VISUAL=1 while the
// design is still moving quickly: see AGENTS.md.

test.use({ reducedMotion: "reduce" });

const CARDS: [caption: string, state: string, chip: string][] = [
	["Issue, open", "open", "Open"],
	["Pull request, open", "open", "Open"],
	["Pull request, merged", "merged", "Merged"],
	["Pull request, draft", "draft", "Draft"],
	["Issue, closed as completed", "closed", "Closed"],
	["Issue, closed as not planned", "closed", "Not planned"],
	["Long title, many labels", "open", "Open"],
	["Minimal", "open", "Open"],
];

test.beforeEach(async ({ page }) => {
	await page.goto("/play/cards");
	await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
});

test("images in every state: ready, selected, captioned, loading, uploading, abandoned and missing", async ({
	page,
}) => {
	const images = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Images", exact: true }),
	});
	const figure = (caption: string) =>
		images.locator(".gallery-images > figure").filter({
			has: page.locator("figcaption", { hasText: new RegExp(`^${caption}$`) }),
		});
	await expect(figure("An image").locator(".image-node")).toHaveAttribute("data-state", "ready");
	await expect(figure("Selected").locator(".image-node")).toHaveAttribute("data-selected", "true");
	await expect(figure("With its caption").locator(".image-caption")).toHaveText("Tack’s mark");
	await expect(figure("Loading").locator(".image-node")).toHaveAttribute("data-state", "loading");
	await expect(figure("Uploading, yours").getByRole("progressbar")).toHaveAttribute(
		"aria-valuenow",
		"42",
	);
	await expect(figure("Uploading, someone else’s")).toContainText("Uploading · Priya Shah");
	await expect(figure("Upload abandoned")).toContainText("The upload didn’t finish");
	await expect(figure("Missing")).toContainText("Image unavailable");
});

test("stacks are theme cards: stickies, issues and pull requests a line each, or only a name far out", async ({
	page,
}) => {
	const stacks = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Stacks", exact: true }),
	});
	const figure = (caption: string) => stacks.locator("figure", { hasText: caption });
	const mixed = figure("Issues, a pull request and stickies");
	await expect(mixed.locator(".stack-count")).toHaveText("6");
	await expect(mixed.locator(".stack-rows .stack-row")).toHaveCount(3);
	await expect(mixed.locator(".stack-more")).toHaveText("+3 more");
	await expect(mixed.locator(".stack-row[data-kind=card]")).toHaveCount(2);
	await expect(figure("one of them private")).toContainText("Private item");
	await expect(figure("✓ keeps it").getByRole("button", { name: /^Keep/ })).toBeVisible();
	// Waiting for a name; one that isn't coming (nothing everyone may read); one that didn't come.
	await expect(figure("Being named").locator(".stack-name")).toHaveText("Naming…");
	const unnameable = figure("not named automatically").locator(".stack-name");
	await expect(unnameable).toHaveAttribute("data-unnamed", "unnameable");
	await expect(unnameable).toHaveText("Untitled stack");
	await expect(unnameable).toHaveAccessibleDescription(/what everyone here can read/);
	await expect(figure("No name came in time").locator(".stack-name")).toHaveAttribute(
		"data-unnamed",
		"late",
	);
	await expect(figure("Zoomed out: its name").locator(".stack")).toHaveAttribute(
		"data-far",
		"true",
	);
});

test("who reacted to a card: a pill per emoji, named, asking, how many, +N and a total", async ({
	page,
}) => {
	const figure = (state: string) => page.locator(`figure[data-state=reactions-${state}]`);
	const pills = (state: string) => figure(state).locator(".reaction-pill");
	await expect(pills("ready")).toHaveText(["👍5", "🎉1", "❤️2", "🚀1"]);
	await expect(pills("ready").first()).toHaveAccessibleName(/^👍 5: .+/);
	const tips = page.locator(".reaction-tip");
	await expect(tips).toHaveCount(5);
	await expect(
		tips.filter({ has: page.getByRole("status", { name: "Loading names" }) }),
	).toHaveText("❤️2 people");
	await expect(tips.filter({ hasText: "1 person" })).toHaveText("🎉1 person");
	// More kinds than fit: the most left keep their pills, the rest fold into +N.
	await expect(pills("more")).toHaveText(["👍11", "❤️6", "🚀4", "+3"]);
	await expect(pills("more").last()).toHaveAccessibleName(/^3 more: 😄 2, 🎉 3, 👀 1: 😄 /);
	// Card data from before each emoji was counted: the total, in words, never an icon.
	await expect(pills("total")).toHaveText(["9reactions"]);
	// As many as fit the foot's width: beside assignees or volunteers, and on a wider card.
	await expect(pills("fit-assignees")).toHaveText(["👍11", "❤️6", "+4"]);
	await expect(pills("fit-volunteers")).toHaveText(["👍11", "+5"]);
	await expect(pills("fit-wide")).toHaveText(["👍11", "😄2", "🎉3", "❤️6", "🚀4", "👀1"]);
	for (const state of ["fit-assignees", "fit-volunteers", "fit-wide"]) {
		const group = figure(state).locator(".reaction-pills");
		expect(await group.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
	}
	// From a list, its mark always shows, inside the card, and never folds
	// into +N: at rest, beside the ghost ✋, the chip, and the chip unfolded.
	for (const state of ["fit-list", "fit-list-ghost", "fit-list-volunteers", "fit-list-assign"]) {
		const card = figure(state).locator(".card");
		const mark = card.locator(".provenance[data-via=list]");
		await expect(mark).toBeVisible();
		await mark.scrollIntoViewIfNeeded();
		const box = (await mark.boundingBox())!;
		const edge = (await card.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(19);
		expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width - 13);
		// Nothing in the foot covers it.
		const covered = await mark.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return !hit || !el.contains(hit);
		});
		expect(covered).toBe(false);
	}
	// With no room to open its label beside the reactions, a tooltip says it.
	await expect(figure("fit-list").locator(".provenance")).toHaveAttribute(
		"data-tooltip",
		"From the “Bugs” list",
	);
});

test("every card state renders", async ({ page }) => {
	const cards = page.locator("section", { hasText: /^Cards/ }).locator("figure");
	await expect(cards).toHaveCount(CARDS.length);
	for (const [i, [caption, state, chip]] of CARDS.entries()) {
		const figure = cards.nth(i);
		await expect(figure.locator("figcaption")).toHaveText(caption);
		await expect(figure.locator(".card")).toHaveAttribute("data-state", state);
		await expect(figure.locator(".chip.state")).toHaveText(chip);
		await expect(figure.locator(".card-title")).not.toBeEmpty();
	}

	// The first four cards, three more PRs and two discussions. Every PR with checks has a CI bar.
	await expect(page.locator(".card.compact:not(.link-card)")).toHaveCount(9);
	await expect(page.locator(".card.compact .ci-bar")).toHaveCount(6);
	// Selected: the "Selected" card, two in Volunteers, and one from a list in Who reacted.
	await expect(page.locator(".card[data-selected=true]:not(.link-card)")).toHaveCount(4);
	await expect(page.locator(".card.loading")).toHaveCount(1);
	await expect(page.locator(".card.missing")).toHaveCount(9);
});

test("discussions are cards of their own: category, answered, upvotes and why they closed", async ({
	page,
}) => {
	const section = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Discussions", exact: true }) });
	const card = (caption: string) =>
		section.locator("figure", { hasText: caption }).locator(".card");
	const states: [caption: string, chip: string, category: string][] = [
		["an open RFC", "Open", "📝RFCs"],
		["answered", "Answered", "🙏Q&A"],
		["unanswered question", "Open", "🙏Q&A"],
		["closed as resolved", "Resolved", "💡Ideas"],
		["closed as outdated", "Outdated", "💡Ideas"],
		["locked announcement", "Open", "📣Announcements"],
	];
	for (const [caption, chip, category] of states) {
		const face = card(`Discussion, ${caption}`);
		await expect(face).toHaveAttribute("data-item", "discussion");
		await expect(face.locator(".chip.state")).toHaveText(chip);
		await expect(face.locator(".chip.category")).toHaveText(category);
		await expect(face.locator(".count.upvotes")).toBeVisible();
	}
	await expect(card("Discussion, answered")).toHaveAttribute("data-answered", "true");
	await expect(card("Discussion, closed as outdated")).toHaveAttribute("data-reason", "outdated");
	await expect(card("Discussion, locked announcement")).toContainText("Locked");
	const permission = card("needs the Discussions permission");
	await expect(permission).toContainText("needs the Discussions permission");
	await expect(permission.getByRole("link", { name: "Review permissions" })).toHaveAttribute(
		"href",
		/^\/setup\/install/,
	);
});

test("every link card state renders, without a broken image", async ({ page }) => {
	const section = page.locator("section", {
		has: page.getByRole("heading", { name: "Link cards" }),
	});
	const figure = (caption: string) =>
		section.locator("figure", { has: page.locator("figcaption", { hasText: caption }) });
	await expect(section.locator("figure")).toHaveCount(11);
	await expect(figure("With an image").locator(".link-media[data-loaded]")).toHaveCount(1);
	await expect(figure("Only an icon").locator(".link-tint .link-icon img")).toHaveCount(1);
	await expect(figure("Only a title").locator(".link-initial")).toHaveCount(2);
	await expect(figure("Loading").locator(".link-card")).toHaveAttribute("data-state", "loading");
	await expect(figure("Not read yet").locator(".link-card")).toHaveAttribute(
		"data-state",
		"pending",
	);
	await expect(figure("Couldn’t be read").locator(".link-note")).toBeVisible();
	await expect(figure("Won’t be read").locator(".link-globe")).toHaveCount(2);
	await expect(section.locator(".link-card.compact")).toHaveCount(2);
	// Every image that's drawn loaded: none is broken.
	const broken = await section
		.locator("img")
		.evaluateAll(
			(images) =>
				(images as HTMLImageElement[]).filter((img) => img.complete && img.naturalWidth === 0)
					.length,
		);
	expect(broken).toBe(0);
});

test("cards from other forges say how they're kept up to date", async ({ page }) => {
	const section = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Other forges", exact: true }) });
	const figures = section.locator("figure");
	await expect(figures).toHaveCount(6);
	// GitLab, writable but no webhook yet: checked while open, no app to install.
	const gitlab = figures.nth(0);
	await expect(gitlab.locator(".liveness[data-live=false]")).toBeVisible();
	await expect(gitlab.locator(".liveness-tip")).toContainText("Checked while you look");
	await expect(gitlab.locator(".liveness-tip")).toContainText("A webhook from the project");
	// A merge request's pipeline, without "needs the GitHub App".
	await expect(figures.nth(1).locator(".ci")).toHaveAttribute("data-ci", "failing");
	await expect(figures.nth(1).locator(".ci-unavailable")).toHaveCount(0);
	await expect(figures.nth(2).locator(".liveness-tip")).toContainText(
		"This instance doesn’t write to Codeberg",
	);
	await expect(figures.nth(3).locator(".liveness-tip")).toContainText("Tack only reads Tangled");
	// Nobody sees what isn't public there, and there's nothing to check again.
	await expect(figures.nth(4).locator(".missing-message")).toHaveText(
		"Tack can’t show this: it’s confidential, or not public.",
	);
	await expect(figures.nth(5).locator(".missing-message")).toContainText(
		"isn’t public on Codeberg",
	);
	await expect(figures.nth(5).getByRole("button")).toHaveCount(0);
});

test("every volunteering state renders: the chip, unfolded, yours, staged, many, and the hand", async ({
	page,
}) => {
	const section = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Volunteers", exact: true }),
	});
	await expect(section.locator("figure")).toHaveCount(11);
	await expect(
		section
			.getByRole("group", { name: "Volunteers: Kai Andersen, Priya Shah", exact: true })
			.first(),
	).toBeVisible();
	await expect(
		section.getByRole("group", { name: "Volunteers: You, Kai Andersen, Priya Shah", exact: true }),
	).toBeVisible();
	await expect(
		section.getByRole("group", {
			name: "Volunteers: Kai Andersen, Priya Shah (Kai Andersen staged to be assigned)",
		}),
	).toBeVisible();
	// Beside two volunteers, the reactions keep as many pills as fit; beside
	// a full chip, fewer.
	const reactions = (figure: string) =>
		section.locator("figure", { hasText: figure }).locator(".reaction-pill:visible");
	const more = (figure: string, at: "rest" | "open") =>
		section.locator("figure", { hasText: figure }).locator(`.reaction-more > [data-at=${at}]`);
	await expect(reactions("Two volunteers, at rest")).toHaveCount(2);
	await expect(reactions("Two volunteers, at rest").first()).toHaveText("👍11");
	await expect(more("Two volunteers, at rest", "rest")).toHaveText("+3");
	await expect(more("Two volunteers, at rest", "open")).toHaveCSS("opacity", "0");
	await expect(reactions("More than fit")).toHaveText(["👍11", "+3"]);
	// Unfolded to Assign, which opens at the chip's start over their end where
	// there's no room to spare after it, they're fitted again: those that no
	// longer fit fold into +N, rather than sliding under it.
	await expect(reactions("Yours among them")).toHaveCount(1);
	await expect(more("Yours among them", "open")).toHaveText("+4");
	await expect(more("Yours among them", "open")).toHaveCSS("opacity", "1");
	// More than fit fold into +2; yours is ringed; staged is dashed.
	await expect(section.locator(".volunteer-more")).toHaveText("+2");
	await expect(section.locator(".volunteer[data-mine]")).toHaveCount(3);
	await expect(section.locator(".volunteer[data-staged]")).toHaveCount(2);
	// At rest, ✋ and the faces; Assign unfolds when it's pointed at, or the
	// card's selected. Your hand leads the chip, pressed while it's up.
	const unfolded = (figure: string) =>
		section.locator("figure", { hasText: figure }).locator(".volunteers-more");
	await expect(unfolded("Two volunteers, at rest")).toHaveCSS("opacity", "0");
	await expect(unfolded("Pointed at")).toHaveCSS("opacity", "1");
	await expect(unfolded("Yours among them")).toHaveCSS("opacity", "1");
	const yours = section.locator("figure", { hasText: "Yours among them" });
	await expect(yours.getByRole("button", { name: "I’ll take it" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// A viewer sees who, with nothing to press.
	const viewer = section.locator("figure", { hasText: "For a viewer" });
	await expect(viewer.locator(".volunteers").getByRole("button")).toHaveCount(0);
	// Hovering the chip unfolds it too, and the card doesn't move.
	const resting = section.locator("figure", { hasText: "Two volunteers, at rest" });
	await resting.scrollIntoViewIfNeeded();
	const before = await resting.locator(".card").boundingBox();
	const chipBefore = await resting.locator(".volunteers").boundingBox();
	await resting.locator(".volunteers").hover();
	await expect(unfolded("Two volunteers, at rest")).toHaveCSS("opacity", "1");
	expect(await resting.locator(".card").boundingBox()).toEqual(before);
	// The pills fold into +4 beside it, and its far edge stays put under the pointer.
	await expect(reactions("Two volunteers, at rest")).toHaveCount(1);
	await expect(more("Two volunteers, at rest", "open")).toHaveCSS("opacity", "1");
	const chipAfter = await resting.locator(".volunteers").boundingBox();
	expect(chipAfter!.x + chipAfter!.width).toBeGreaterThanOrEqual(
		chipBefore!.x + chipBefore!.width - 0.5,
	);
	const pills = resting.locator(".reaction-pills");
	expect(await pills.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
	// From the keyboard: focusing the chip's hand unfolds it, and Tab reaches Assign.
	await page.mouse.move(0, 0);
	await expect(unfolded("Two volunteers, at rest")).toHaveCSS("opacity", "0");
	await resting.getByRole("button", { name: "I’ll take it" }).focus();
	await expect(unfolded("Two volunteers, at rest")).toHaveCSS("opacity", "1");
	await page.keyboard.press("Tab");
	await expect(resting.getByRole("button", { name: "Assign volunteers" })).toBeFocused();
	// Nobody yet: ✋ at the end of a card's foot, where the chip will be, once
	// it's pointed at or selected (never in its head); or a sticky's corner.
	await expect(section.locator(".card-head .volunteer-hand")).toHaveCount(0);
	const nobody = section.locator("figure", { hasText: "Nobody yet, at rest" });
	await expect(nobody.locator(".card-foot .volunteers[data-ghost]")).toHaveCSS("opacity", "0");
	const chosen = section.locator("figure", { hasText: "Nobody yet, selected" });
	const ghost = chosen.locator(".card-foot > .volunteers[data-ghost]");
	await expect(ghost).toBeVisible();
	await expect(ghost.getByRole("button", { name: "I’ll take it" })).toBeVisible();
	// The reactions made room for it, rather than going under it.
	await expect(chosen.locator(".reaction-pill:visible")).toHaveCount(3);
	// Pointed at, the card at rest shows it too.
	await nobody.locator(".card-title").hover();
	await expect(nobody.locator(".card-foot .volunteers[data-ghost]")).toHaveCSS("opacity", "1");
	await page.mouse.move(0, 0);
	await expect(section.locator(".sticky > .volunteer-hand")).toHaveCount(1);
});

test("every provenance state renders", async ({ page }) => {
	const section = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Provenance", exact: true }) });
	await expect(section.locator("figure")).toHaveCount(6);
	for (const via of ["inbox", "list", "rule", "comment"]) {
		await expect(section.locator(`.provenance[data-via=${via}]`).first()).toBeVisible();
	}
	// A comment's glyph links to the comment that asked for the card.
	await expect(section.getByRole("link", { name: "Added from GitHub by @priya" })).toHaveAttribute(
		"href",
		/#issuecomment-1$/,
	);
	await expect(section.getByRole("note", { name: "From the “Triage” inbox" })).toHaveCount(2);
	await expect(section.locator(".card[data-unmatched=true]")).toHaveCount(2);
	// Only boards you can edit offer to keep or remove.
	await expect(section.getByRole("button", { name: "Keep" })).toHaveCount(1);
	await expect(section.getByRole("button", { name: "Remove" })).toHaveCount(1);
});

test("every pull request state renders, and CI lands", async ({ page }) => {
	const pulls = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Pull requests: checks and reviews" }) })
		.locator("figure");
	await expect(pulls).toHaveCount(8);
	await expect(pulls.nth(1).locator(".ci")).toHaveAttribute("data-ci", "failing");
	await expect(pulls.nth(1).locator(".ci-failures li")).toHaveCount(2);
	await expect(pulls.nth(1).getByRole("img", { name: "priya: requested changes" })).toBeVisible();
	await expect(pulls.nth(2).locator(".ci-summary")).toHaveText(/All 14 checks passed/);
	await expect(pulls.nth(3).locator(".chip.conflict")).toHaveText("Conflicts");
	await expect(pulls.nth(4).locator(".ci-failures .more")).toHaveText("+4 more");
	await expect(pulls.nth(5).locator(".ci-unavailable")).toBeVisible();
	await expect(pulls.nth(6).locator(".ci")).toHaveCount(0);

	// Walk every PR through a run until a check fails: it lands as new.
	const ci = page.getByRole("button", { name: /^CI:/ });
	while (!(await ci.textContent())?.includes("A check fails")) await ci.click();
	await ci.click();
	await expect(pulls.first().locator(".ci-failures li[data-new=true]")).toHaveCount(1);
	await expect(pulls.first().locator(".card-pulse[data-tone=fail]")).toHaveCount(1);
});

test("every sticky, text and presence state renders", async ({ page }) => {
	const section = (name: string) =>
		page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });

	await expect(section("Stickies").locator(".sticky")).toHaveCount(5);
	await expect(section("Sticky states").locator(".sticky")).toHaveCount(5);
	await expect(
		section("Sticky states").getByRole("toolbar", { name: "Shape options" }),
	).toBeVisible();

	// Shrink to fit: longer notes are set smaller, never larger.
	for (const name of ["Shrink to fit", "Shrink to fit, handwriting"]) {
		const sizes = await section(name)
			.locator(".sticky")
			.evaluateAll((els) =>
				els.map((el) =>
					Number.parseFloat((el as HTMLElement).style.getPropertyValue("--fit-size")),
				),
			);
		expect(sizes).toHaveLength(6);
		expect(sizes[0]).toBe(28);
		// The last note doesn't fit even at the smallest size, and fades out.
		expect(sizes.at(-1)).toBe(11);
		await expect(section(name).locator(".sticky-text[data-overflow=true]")).toHaveCount(1);
	}
	await expect(
		section("Shrink to fit, handwriting").locator(".sticky-text[data-font=hand]"),
	).toHaveCount(6);

	const text = section("Text").locator(".text-block");
	await expect(text).toHaveCount(11);
	for (const size of ["s", "m", "l", "xl"]) {
		await expect(section("Text").locator(`.text-block[data-size=${size}]`)).not.toHaveCount(0);
	}

	const presence = section("Presence");
	await expect(presence.locator(".cursor")).toHaveCount(7);
	await expect(presence.locator(".cursor-chat")).toHaveCount(4);
	await expect(presence.locator(".cursor[data-status=idle]")).toHaveCount(1);
	await expect(presence.locator(".cursor[data-status=away]")).toHaveCount(1);
	await expect(presence.locator(".follow-pill")).toContainText("Following Kai Andersen");

	await expect(
		section("Empty board").getByRole("heading", { name: "A blank board" }),
	).toBeVisible();
	// Widgets are what Tack does that a whiteboard doesn't: the guide says so.
	await expect(section("Empty board")).toContainText("Add a live list of issues");
});

const DECISIONS: [caption: string, status: string][] = [
	["New, being written", "proposed"],
	["Proposed, no votes yet", "proposed"],
	["Votes coming in, you agree", "proposed"],
	["Just decided", "decided"],
	["Write-back staged", "decided"],
	["Pushing", "decided"],
	["ADR open, checks running", "decided"],
	["ADR merged", "decided"],
	["Posted as a Discussion", "decided"],
	["Write-back failed", "decided"],
	["Superseded", "superseded"],
	["Many linked items", "proposed"],
	["View only", "proposed"],
];

test("every decision state renders", async ({ page }) => {
	const figures = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Decisions", exact: true }) })
		.locator("figure");
	await expect(figures).toHaveCount(DECISIONS.length);
	for (const [i, [caption, status]] of DECISIONS.entries()) {
		await expect(figures.nth(i).locator("figcaption")).toHaveText(caption);
		await expect(figures.nth(i).locator(".decision")).toHaveAttribute("data-status", status);
	}
	const at = (caption: string) => figures.filter({ hasText: caption });
	await expect(
		at("New, being written").getByRole("textbox", { name: "Decision title" }),
	).toBeVisible();
	await expect(
		at("Votes coming in, you agree").getByRole("button", { name: "Agree: 4 votes" }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(at("Just decided").locator(".decision-stamp")).toHaveText("Decided");
	await expect(at("Just decided").getByRole("button", { name: "Write back" })).toBeVisible();
	await expect(at("Write-back staged").locator(".decision-writeback")).toHaveText(
		/ADR 0004 · Staged/,
	);
	await expect(at("ADR open, checks running").locator(".decision-record .chip.state")).toHaveText(
		"Open",
	);
	await expect(at("ADR merged").locator(".decision-record .chip.state")).toHaveText("Merged");
	await expect(at("ADR merged").locator(".decision-consequences")).toContainText(
		"Commit messages need a type",
	);
	await expect(at("Posted as a Discussion").locator(".decision-writeback")).toHaveAttribute(
		"href",
		/discussions\/18$/,
	);
	await expect(at("Write-back failed").getByRole("button", { name: "Retry" })).toBeVisible();
	await expect(at("Superseded").locator(".decision-superseded")).toContainText("Require Node 20");
	await expect(at("Many linked items").locator(".decision-linked-more")).toHaveText("+2 more");
	// View only: votes show, but can't be cast, and nothing can be decided.
	await expect(at("View only").getByRole("button", { name: /^Agree/ })).toBeDisabled();
	await expect(at("View only").getByRole("button", { name: "Decide" })).toHaveCount(0);
});

test("repository access states render, and installing the app upgrades cards", async ({ page }) => {
	const section = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Repository access", exact: true }) });
	await expect(section.locator("figure")).toHaveCount(5);
	await expect(section.locator(".card[data-live=false]")).toHaveCount(2);
	await expect(section.locator(".liveness[data-live=false]")).toHaveCount(2);

	// A private reference shows nothing but its key, and offers a recheck.
	const placeholder = section.locator(".card.private");
	await expect(placeholder.locator(".chip")).toHaveText("Private");
	await expect(placeholder.locator(".card-title")).toHaveCount(0);
	await expect(placeholder.getByRole("button", { name: "Got access? Check again" })).toBeEnabled();
	await placeholder.getByRole("button", { name: "Got access? Check again" }).click();
	await expect(placeholder.getByRole("button", { name: "Checking…" })).toBeDisabled();

	// A private repo without the app can't be read: install it.
	await expect(section.getByRole("link", { name: "Install the app", exact: true })).toHaveAttribute(
		"href",
		"/setup/install?state=%2Fplay%2Fcards",
	);

	await page.getByRole("button", { name: "Install the app" }).click();
	await expect(section.locator(".card[data-live=false]")).toHaveCount(0);
	await expect(section.locator(".liveness[data-live=true]")).toHaveCount(2);
	await page.getByRole("button", { name: "Remove the app" }).click();
	await expect(section.locator(".card[data-live=false]")).toHaveCount(2);
});

test("both themes render side by side", async ({ page }) => {
	await page.getByLabel("Both themes side by side").check();
	await expect(page.locator(".gallery-pane[data-theme=light]")).toBeVisible();
	await expect(page.locator(".gallery-pane[data-theme=dark]")).toBeVisible();
	// Dark tokens apply inside the dark pane only.
	const ground = (theme: string) =>
		page
			.locator(`.gallery-pane[data-theme=${theme}]`)
			.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(await ground("light")).not.toBe(await ground("dark"));
});

test("simulated updates land on every card", async ({ page }) => {
	await page.getByRole("button", { name: "Simulate an update" }).click();
	// The first round of updates adds two comments to every card.
	const first = page
		.locator("section", { hasText: /^Cards/ })
		.locator("figure")
		.first();
	await expect(first.locator(".count").first()).toHaveText("16");
	await expect(page.locator(".gallery-grid .card-pulse")).toHaveCount(CARDS.length + 5);
});

test("the gallery looks right", async ({ page }) => {
	test.skip(process.env.VISUAL !== "1", "Visual regression is opt-in: set VISUAL=1");

	// Every web font is loaded, so text doesn't render in a fallback.
	for (const font of [
		"Geist Variable",
		"Geist Mono Variable",
		"Bricolage Grotesque Variable",
		"Shantell Sans Variable",
	]) {
		expect(await page.evaluate((f) => document.fonts.check(`16px "${f}"`), font), font).toBe(true);
	}

	// CI compares against Linux baselines. Until one has been generated for a
	// platform (see AGENTS.md), say so rather than fail on its absence.
	const baseline = test.info().snapshotPath("cards.png", { kind: "screenshot" });
	if (!existsSync(baseline) && test.info().config.updateSnapshots === "none") {
		test.info().annotations.push({ type: "warning", description: `No baseline at ${baseline}` });
		return;
	}
	await expect(page).toHaveScreenshot("cards.png", { fullPage: true });
});

test.describe("boards gallery", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/play/boards");
		await expect(page.getByRole("heading", { name: "Boards", exact: true }).first()).toBeVisible();
	});

	test("every home, tile, share and top bar state renders", async ({ page }) => {
		const section = (name: string) =>
			page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });

		await expect(section("Home").locator(".home")).toHaveCount(6);
		await expect(section("Home").getByText("Your boards will live here")).toHaveCount(2);
		await expect(section("Home").getByRole("heading", { name: "Public boards" })).toBeVisible();
		// Many boards: tabs, a search box and archived boards.
		const many = section("Home").locator("figure").nth(3);
		await expect(many.getByRole("tab")).toHaveCount(5);
		// Team boards leaves out yours and those shared with you.
		await expect(many.getByRole("tab", { name: /Team boards/ })).toContainText("2");
		await expect(many.getByRole("searchbox")).toBeVisible();

		await expect(section("Tiles").locator(".board-tile")).toHaveCount(8);
		await expect(section("Tiles").locator(".board-thumb-sketch")).toHaveCount(7);
		await expect(section("Tiles").locator(".board-thumb-empty")).toHaveCount(1);
		await expect(section("Tiles").locator(".board-tile[data-archived]")).toHaveCount(1);

		const shares = section("Share").locator(".share");
		await expect(shares).toHaveCount(5);
		await expect(shares.first().getByRole("listitem")).toHaveCount(4);
		await expect(shares.nth(1).getByRole("button", { name: "Leave board" })).toBeVisible();
		await expect(shares.nth(1).getByLabel("Who can open this board")).toHaveCount(0);
		// A board's repositories on three forges: GitHub's offer the app, the others don't (#65).
		const repos = page.getByRole("region", { name: "Repositories on this board" });
		await expect(repos.getByRole("heading", { name: /^Repositories/ })).toBeVisible();
		await expect(repos.locator("li[data-state=checked]")).toContainText(
			"Updates while open · Tack can push",
		);
		await expect(
			repos.locator("li", { hasText: "codeberg.org/ascorbic/emdash" }),
		).not.toContainText("Install");

		// View only, and View only signed out on a public board, which says to sign in.
		const viewOnly = section("Board top bar").locator(".view-only");
		await expect(viewOnly).toHaveCount(2);
		await expect(viewOnly.first()).toBeVisible();
		await expect(viewOnly.nth(1)).toHaveAttribute("data-tooltip", /Sign in to comment/);
		await expect(section("Board top bar").getByText("This board is archived")).toBeVisible();
	});

	test("invites land in the list, and bad usernames say why", async ({ page }) => {
		const owner = page.locator(".share").first();
		await expect(owner.getByRole("listitem")).toHaveCount(4);
		await owner.getByLabel("GitHub usernames to invite").fill("jo-rivera, not a login!");
		await owner.getByRole("button", { name: "Invite", exact: true }).click();
		await expect(owner.getByRole("alert")).toContainText("isn’t a GitHub username");

		await owner.getByLabel("GitHub usernames to invite").fill("ghost");
		await owner.getByRole("button", { name: "Invite", exact: true }).click();
		await expect(owner.getByRole("alert")).toContainText("“ghost”");

		await owner.getByLabel("GitHub usernames to invite").fill("jo-rivera");
		await owner.getByRole("button", { name: "Invite", exact: true }).click();
		await expect(owner.getByRole("listitem")).toHaveCount(5);
		await expect(owner.getByRole("alert")).toHaveCount(0);
	});

	test("home pages render full size in both themes", async ({ page }) => {
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.goto("/play/boards?home=many");
			await expect(page.locator(".board-tile")).toHaveCount(8);
			await page.getByRole("searchbox").fill("retro");
			await expect(page.locator(".board-tile")).toHaveCount(2);
			await page.getByRole("tab", { name: /Archived/ }).click();
			await page.getByRole("searchbox").fill("");
			await expect(page.locator(".board-tile")).toHaveCount(1);
		}
	});
});

test("every facilitation, silent mode and dot voting state renders", async ({ page }) => {
	await page.goto("/play/facilitation");
	await expect(page.getByRole("heading", { name: "Facilitation", exact: true })).toBeVisible();
	for (const state of ["running", "final", "paused", "done"]) {
		await expect(
			page.locator(`figure[data-state=${state}] .timer[data-state=${state}]`).first(),
		).toBeVisible();
	}
	await expect(page.locator(".spotlight-pill")).toHaveCount(3);
	await expect(page.locator("figure[data-state=stamps] .stamp")).toHaveCount(3);
	// Stamps beside a sticky's author and volunteers: the foot leaves them
	// room, on one centre line, and the faces' rings stay inside the chip.
	for (const state of ["stamps-foot", "stamps-foot-full"]) {
		const figure = page.locator(`figure[data-state=${state}]`);
		const chip = (await figure.locator(".volunteers").boundingBox())!;
		const stamp = (await figure.locator(".stamp").first().boundingBox())!;
		expect(chip.x + chip.width).toBeLessThanOrEqual(stamp.x - 4);
		expect(Math.abs(chip.y + chip.height / 2 - (stamp.y + stamp.height / 2))).toBeLessThanOrEqual(
			1,
		);
		for (const face of await figure.locator(".volunteer").all()) {
			const box = (await face.boundingBox())!;
			expect(box.y - 1).toBeGreaterThanOrEqual(chip.y + 1);
			expect(box.y + box.height + 1).toBeLessThanOrEqual(chip.y + chip.height - 1);
		}
	}
	// With less room, the author's name gives way.
	const name = page.locator("figure[data-state=stamps-foot-full] .sticky-author-name");
	expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
	// Who stamped it, shown as hovering does: you first.
	await expect(page.getByRole("tooltip").filter({ hasText: "👍" })).toHaveText(
		"👍You, Priya Shah, Kai Andersen and Tom Okafor",
	);
	await expect(page.locator("figure[data-state=dots-hidden] .vote-dot")).toHaveCount(1);
	await expect(page.getByRole("menu", { name: "Emotes" }).getByRole("menuitem")).toHaveCount(8);
	await expect(
		page
			.getByRole("img", { name: "Priya Shah and Kai Andersen high-fived" })
			.locator(".high-five-clap"),
	).toBeVisible();
	await expect(page.locator("figure[data-state=face-down] .sticky[data-face-down]")).toBeVisible();
	await expect(page.locator("figure[data-state=hidden] .sticky[data-hidden]")).toBeVisible();
	await expect(page.getByRole("button", { name: /^Reveal/ })).toHaveCount(1);
	// Nothing written yet: it just ends.
	await expect(
		page
			.locator("figure[data-state=silent-empty]")
			.getByRole("button", { name: "End silent mode" }),
	).toBeVisible();
	await expect(page.locator(".vote-bar")).toHaveCount(7);
	await expect(
		page.locator("figure[data-state=vote-closed] .vote-bar[data-open=false]"),
	).toBeVisible();
	await expect(page.locator("figure[data-state=vote-cursors-hidden]")).toContainText(
		"Cursors hidden while voting",
	);
	await expect(page.locator(".tally-panel")).toHaveCount(4);
	await expect(page.locator("figure[data-state=tally-hidden]")).toContainText("Results are hidden");
	await expect(page.locator("figure[data-state=tally-open] .tally-row").first()).toContainText(
		"👍",
	);
});

test("every history state renders", async ({ page }) => {
	await page.goto("/play/history");
	await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
	await expect(page.locator("figure[data-state=button-open] [aria-pressed=true]")).toBeVisible();
	await expect(page.locator("figure[data-state=panel-loading] .history-skeleton")).toBeVisible();
	await expect(page.locator("figure[data-state=panel-error] [role=alert]")).toContainText(
		"Couldn’t load",
	);
	await expect(page.locator("figure[data-state=panel-empty]")).toContainText("History starts here");
	await expect(page.locator("figure[data-state=panel-ready]")).toContainText("Kai Andersen");
	await expect(
		page.locator("figure[data-state=panel-past] .history-entry[aria-current=step]"),
	).toContainText("removed a sticky");
	await expect(page.locator("figure[data-state=panel-section] select")).toHaveValue("hurts");
	await expect(page.locator("figure[data-state=panel-read-only] .history-bring-back")).toHaveCount(
		0,
	);
	await expect(page.locator("figure[data-state=dock-now] .history-dock[data-live]")).toBeVisible();
	await expect(page.locator("figure[data-state=dock-past]")).toContainText(/2 days ago|yesterday/);
	await expect(page.locator("figure[data-state=dock-playing]")).toContainText("4×");
	await expect(
		page.locator("figure[data-state=dock-loading] .history-track[data-loading]"),
	).toBeVisible();
	await expect(page.locator(".replay-mark")).toHaveCount(3);
	await expect(page.locator("figure[data-state=mark-remove] .replay-mark")).toHaveAttribute(
		"data-op",
		"remove",
	);
	await expect(page.locator("figure[data-state=restore-copy]")).toContainText("Restore a copy");
});

test("every row and mini card state renders", async ({ page }) => {
	await page.goto("/play/lists");
	await expect(page.getByRole("heading", { name: "Lists and mini cards" })).toBeVisible();
	const section = (name: string) =>
		page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
	const rows = section("Rows");
	const minis = section("Mini cards");
	await expect(rows.locator("figure")).toHaveCount(20);
	await expect(minis.locator("figure")).toHaveCount(20);
	await expect(rows.locator(".display-row")).toHaveCount(20);
	await expect(minis.locator(".display-mini")).toHaveCount(20);
	// A stack's row: its name, and what it holds.
	await expect(rows.locator("figure[data-state=stack-suggested] .display-chip")).toHaveText(
		"5 items",
	);
	await expect(rows.locator("figure[data-state=stack] .display-chip")).toHaveText("3 stickies");
	for (const state of ["open", "merged", "draft", "closed"]) {
		await expect(rows.locator(`figure[data-state=${state}] .display-row`)).toHaveAttribute(
			"data-state",
			state,
		);
	}
	await expect(rows.locator("figure[data-state=not-planned] .display-chip")).toHaveText(
		"Not planned",
	);
	await expect(rows.locator("figure[data-state=failing] .display-ci-dot")).toHaveAttribute(
		"data-ci",
		"failing",
	);
	await expect(minis.locator("figure[data-state=pending] .display-ci")).toHaveAttribute(
		"data-ci",
		"pending",
	);
	// Stamps and dots are counted inline: dots drawn on a row, counted on a mini card.
	await expect(rows.locator("figure[data-state=marks] .display-marks .stamp")).toHaveCount(2);
	await expect(rows.locator("figure[data-state=marks] .vote-dot")).toHaveCount(3);
	await expect(minis.locator("figure[data-state=marks] .display-dot-count")).toHaveText("3");
	await expect(rows.locator("figure[data-state=selected] .display-row")).toHaveAttribute(
		"data-selected",
		"true",
	);
	await expect(rows.locator("figure[data-state=loading] .display-skeleton")).toBeVisible();
	// Silent mode: someone else's lies face down, with nothing of its text; yours is marked.
	const faceDown = rows.locator("figure[data-state=face-down] .display-sticky");
	await expect(faceDown).toHaveAttribute("data-face-down", "true");
	await expect(faceDown).toContainText("Face down · Tom Okafor");
	await expect(rows.locator("figure[data-state=hidden] .display-hidden")).toBeVisible();
	await expect(section("Zoomed out").locator(".display-item[data-tier=compact]")).toHaveCount(10);
	await expect(section("Zoomed out").locator(".display-item[data-tier=far]")).toHaveCount(10);
	const switches = section("Switching and sorting");
	await expect(switches.getByRole("radio", { checked: true })).toHaveCount(3);
	await expect(switches.getByRole("button", { name: "By hand" })).toBeVisible();
	await expect(switches.getByRole("button", { name: /State/ })).toBeVisible();
	await expect(section("Popped out").locator(".display-preview .card")).toBeVisible();
	// Empty: placeholders and what goes there; held over, the ones it'll take.
	const empty = section("Empty");
	await expect(empty.locator("figure")).toHaveCount(8);
	await expect(empty.locator("figure[data-state=empty-list]")).toContainText("or paste a link");
	await expect(empty.locator("figure[data-state=empty-read-only]")).toContainText(
		"Nothing here yet",
	);
	await expect(empty.locator("figure[data-state=empty-dropping] [data-held]")).toHaveCount(1);
	await expect(empty.locator("figure[data-state=empty-mini-dropping]")).toContainText(
		"Let go to add both",
	);
	await expect(empty.locator("figure[data-state=empty-far] .list-empty-note")).toHaveCount(0);
});

test("every phone and tablet state renders", async ({ page }) => {
	await page.goto("/play/mobile");
	await expect(page.getByRole("heading", { name: "Phones and tablets" })).toBeVisible();
	const state = (name: string) => page.locator(`figure[data-state=${name}]`);
	for (const name of [
		"sticky-vote",
		"card",
		"decision",
		"face-down",
		"comments",
		"stack",
		"action",
		"view-only",
		"thread",
		"new-sticky",
	]) {
		await expect(state(name).getByRole("dialog")).toBeVisible();
	}
	await expect(state("stack").getByRole("list", { name: "3 stacked stickies" })).toContainText(
		"Sample boards to start from",
	);
	await expect(state("stack")).toContainText("Onboarding");
	await expect(state("sticky-vote").getByRole("region", { name: "Dot vote" })).toContainText(
		"2 dots left",
	);
	await expect(state("sticky-vote").getByRole("button", { name: /^👍 2/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(state("card").locator(".card")).toContainText("Drop Node 18 support");
	await expect(
		state("decision").getByRole("group", { name: "Your vote" }).getByRole("button", {
			name: /Agree/,
		}),
	).toHaveAttribute("aria-pressed", "true");
	await expect(state("face-down")).toContainText("Face down until it’s revealed");
	await expect(state("comments").locator(".phone-sheet-thread")).toHaveCount(2);
	await expect(state("view-only").getByRole("region", { name: "Dot vote" })).toHaveCount(0);
	await expect(state("view-only").getByRole("group", { name: "Stamps" })).toHaveCount(0);
	await expect(state("thread")).toContainText("Not for long: the index lands this week.");
	await expect(state("new-sticky").getByRole("radio", { checked: true })).toHaveCount(1);
	await expect(state("dock").getByRole("button", { name: "Add a sticky" })).toBeVisible();
	await expect(state("dock-view-only").getByRole("button", { name: "Add a sticky" })).toHaveCount(
		0,
	);
	await expect(state("multi").getByRole("status")).toContainText("3 selected");
});
