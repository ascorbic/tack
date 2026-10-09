import { existsSync } from "node:fs";
import { expect, test } from "./fixtures.ts";

// Visual regression over the card gallery, which shows every card state.
// Baselines are per platform (`*-darwin.png`, `*-linux.png`): update them
// with `pnpm e2e:update`, and see AGENTS.md for refreshing the Linux ones CI
// compares against.

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
	await expect(page.locator(".card.missing")).toHaveCount(4);
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
		await expect(many.getByRole("searchbox")).toBeVisible();

		await expect(section("Tiles").locator(".board-tile")).toHaveCount(8);
		await expect(section("Tiles").locator(".board-thumb-sketch")).toHaveCount(7);
		await expect(section("Tiles").locator(".board-thumb-empty")).toHaveCount(1);
		await expect(section("Tiles").locator(".board-tile[data-archived]")).toHaveCount(1);

		const shares = section("Share").locator(".share");
		await expect(shares).toHaveCount(3);
		await expect(shares.first().getByRole("listitem")).toHaveCount(4);
		await expect(shares.nth(1).getByRole("button", { name: "Leave board" })).toBeVisible();
		await expect(shares.nth(1).getByLabel("Who can open this board")).toHaveCount(0);

		await expect(section("Board top bar").locator(".view-only")).toBeVisible();
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
