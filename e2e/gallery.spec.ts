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

	// The first four cards, then three more PRs. Every PR with checks has a CI bar.
	await expect(page.locator(".card.compact")).toHaveCount(7);
	await expect(page.locator(".card.compact .ci-bar")).toHaveCount(6);
	await expect(page.locator(".card[data-selected=true]")).toHaveCount(1);
	await expect(page.locator(".card.loading")).toHaveCount(1);
	await expect(page.locator(".card.missing")).toHaveCount(8);
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
			repos.locator("li", { hasText: "codeberg.org/forgejo/forgejo" }),
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
	await expect(page.locator(".vote-bar")).toHaveCount(6);
	await expect(
		page.locator("figure[data-state=vote-closed] .vote-bar[data-open=false]"),
	).toBeVisible();
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
	await expect(rows.locator("figure")).toHaveCount(18);
	await expect(minis.locator("figure")).toHaveCount(18);
	await expect(rows.locator(".display-row")).toHaveCount(18);
	await expect(minis.locator(".display-mini")).toHaveCount(18);
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
});
