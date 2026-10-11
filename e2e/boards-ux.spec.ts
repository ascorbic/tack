import type { Browser, Page } from "@playwright/test";
import type { BoardInfo, MemberRole, Visibility } from "../src/shared/boards.ts";
import { expect, test } from "./fixtures.ts";

// Around the canvas, against the dev server: arriving from an invite,
// finding boards, archiving and leaving, the Share dialog, the top bar at
// every width, and what viewers and archived boards offer. Signed in with
// /auth/dev (see playwright.config.ts); logins are unique per test, so each
// starts from an empty home page.

const run = Date.now().toString(36);
let n = 0;
const login = (name: string) => `e2e-${name}-${run}-${++n}`;

test.beforeEach(async ({ page }) => {
	// Several people in several pages each: room for a busy dev server.
	test.slow();
	await page.route("https://github.com/**", (route) => route.abort());
});

async function signInAs(page: Page, who: string, returnTo = "/") {
	await page.goto(`/auth/dev?login=${who}&return_to=${encodeURIComponent(returnTo)}`);
}

async function newPage(browser: Browser, who?: string): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	if (who) await signInAs(page, who);
	return page;
}

/** Make a board through the API, as whoever's signed in on the page. */
async function makeBoard(
	page: Page,
	title: string,
	visibility: Visibility = "instance",
): Promise<BoardInfo> {
	return page.evaluate(
		async ({ title, visibility }) => {
			const response = await fetch("/api/boards", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title, visibility }),
			});
			return response.json();
		},
		{ title, visibility },
	);
}

async function invite(page: Page, id: string, logins: string[], role: MemberRole = "editor") {
	const status = await page.evaluate(
		async ({ id, logins, role }) =>
			(
				await fetch(`/api/boards/${id}/members`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ logins, role }),
				})
			).status,
		{ id, logins, role },
	);
	expect(status).toBe(200);
}

async function archive(page: Page, id: string) {
	await page.evaluate(
		async (id) =>
			fetch(`/api/boards/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ archived: true }),
			}),
		id,
	);
}

const path = (board: BoardInfo) => `/b/${board.id}/${board.slug}`;

test("an invitee lands on the board shared with them, marked new", async ({ browser, page }) => {
	const owner = login("owner");
	const friend = login("friend");
	await signInAs(page, owner);
	const shared = await makeBoard(page, "EmDash planning", "private");
	await invite(page, shared.id, [friend]);

	const them = await newPage(browser, friend);
	// Recent, not an empty "My boards": the invite is the first thing they see.
	await expect(them.getByRole("tab", { name: /Recent/ })).toHaveAttribute("aria-selected", "true");
	const tile = them.locator(".board-tile").filter({ hasText: "EmDash planning" });
	await expect(tile).toContainText("New");
	await expect(
		them.getByRole("tab", { name: /Shared with me/ }).getByRole("img", { name: "1 new" }),
	).toBeVisible();

	// Opened once, it's no longer new.
	await tile.getByRole("link", { name: "EmDash planning" }).click();
	await expect(them.getByRole("toolbar", { name: "Tools" })).toBeVisible();
	await them.goto("/");
	await expect(
		them.locator(".board-tile").filter({ hasText: "EmDash planning" }),
	).not.toContainText("New");
	await them.context().close();
});

test("search finds boards on every tab, forgivingly, with archived ones on request", async ({
	page,
}) => {
	await signInAs(page, login("finder"));
	// Private, so other tests' boards (and these) stay out of each other's way.
	for (const title of [
		"Quokka planning",
		"Docs restructure",
		"Release 5.0",
		"Triage",
		"Roadmap",
		"Design crit",
		"Wombat retro 41",
	]) {
		await makeBoard(page, title, "private");
	}
	const old = await makeBoard(page, "Wombat retro 40", "private");
	await archive(page, old.id);
	await page.reload();

	// `/` jumps to the search box, as on GitHub.
	const search = page.getByRole("searchbox", { name: "Find a board" });
	await expect(search).toBeVisible();
	await page.locator("body").click({ position: { x: 5, y: 300 } });
	await page.keyboard.press("/");
	await expect(search).toBeFocused();

	// A letter missing still finds it.
	await search.fill("qukka");
	await expect(page.getByRole("status").filter({ hasText: "1 board matches" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Quokka planning" })).toBeVisible();

	await search.fill("wombat retro");
	await expect(page.getByRole("link", { name: "Wombat retro 41" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Wombat retro 40" })).toHaveCount(0);
	await page.getByRole("button", { name: "Show 1 archived match" }).click();
	await expect(page.getByRole("link", { name: "Wombat retro 40" })).toBeVisible();

	// Escape clears it.
	await search.press("Escape");
	await expect(search).toHaveValue("");
});

test("the home page's tabs move with the arrow keys", async ({ browser, page }) => {
	const owner = login("tabs");
	await signInAs(page, owner);
	const other = await newPage(browser, login("other"));
	const theirs = await makeBoard(other, "Their board", "private");
	await invite(other, theirs.id, [owner]);
	await other.context().close();
	await makeBoard(page, "Mine");
	await page.reload();

	const recent = page.getByRole("tab", { name: /Recent/ });
	await recent.focus();
	await page.keyboard.press("ArrowRight");
	const mine = page.getByRole("tab", { name: /My boards/ });
	await expect(mine).toBeFocused();
	await expect(mine).toHaveAttribute("aria-selected", "true");
	await expect(recent).toHaveAttribute("tabindex", "-1");
	await expect(page.getByRole("tabpanel")).toContainText("Mine");
});

test("archiving from a tile can be undone", async ({ page }) => {
	await signInAs(page, login("archiver"));
	await makeBoard(page, "Docs restructure");
	await page.reload();
	await page.getByRole("button", { name: "More for Docs restructure" }).click();
	await page.getByRole("menuitem", { name: "Archive" }).click();
	const toast = page.locator(".toast").filter({ hasText: "Archived “Docs restructure”" });
	await expect(toast).toBeVisible();
	await expect(page.getByRole("link", { name: "Docs restructure" })).toHaveCount(0);
	await toast.getByRole("button", { name: "Undo" }).click();
	await expect(page.getByRole("link", { name: "Docs restructure" })).toBeVisible();
});

test("leaving a board asks first, then says so", async ({ browser, page }) => {
	const owner = login("host");
	const guest = login("leaver");
	await signInAs(page, owner);
	const board = await makeBoard(page, "Release 5.0", "private");
	await invite(page, board.id, [guest]);

	const them = await newPage(browser, guest);
	await them.goto(path(board));
	await them.getByRole("button", { name: "Share" }).click();
	const dialog = them.getByRole("dialog", { name: /Share/ });
	// Without anyone to invite, focus starts on Copy link.
	await expect(dialog.getByRole("button", { name: "Copy link" })).toBeFocused();
	await dialog.getByRole("button", { name: "Leave board" }).click();
	const confirm = dialog.getByRole("alertdialog", { name: "Leave this board?" });
	await expect(confirm).toContainText("You’ll need an invite to get back in.");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toHaveCount(0);

	await dialog.getByRole("button", { name: "Leave board" }).click();
	await dialog.getByRole("button", { name: "Leave", exact: true }).click();
	await expect(them).toHaveURL(/\/$/);
	// The home page loads its boards first, which can take a moment.
	await expect(them.locator(".toast")).toContainText("You left “Release 5.0”", {
		timeout: 15_000,
	});
	await them.context().close();
});

test("the Share dialog starts at the invite field, nudges you to send the link, and splits public access", async ({
	page,
}) => {
	await signInAs(page, login("sharer"));
	const board = await makeBoard(page, "EmDash planning");
	await page.goto(path(board));
	// Who can open it, beside the title.
	const chip = page.locator(".topbar .access-chip");
	await expect(chip).toContainText("Anyone here can edit");

	await chip.click();
	const dialog = page.getByRole("dialog", { name: /Share/ });
	const field = dialog.getByRole("combobox", { name: "GitHub usernames to invite" });
	await expect(field).toBeFocused();
	const invitee = login("invitee");
	await page.keyboard.type(`${invitee} `);
	// Finished logins are previewed before they're sent.
	await expect(dialog.getByRole("list", { name: "Who you’re inviting" })).toContainText(invitee);
	await page.keyboard.press("Enter");
	await expect(dialog.getByRole("listitem").filter({ hasText: invitee })).toContainText(
		"hasn’t signed in yet",
	);
	await expect(
		dialog.getByRole("status").filter({ hasText: "Tack doesn’t email anyone" }),
	).toBeVisible();

	// Public: the link and people on this Tack are two rows, each with its own role.
	await dialog.getByLabel("Who can open this board").selectOption("public");
	const access = dialog.getByRole("region", { name: "General access" });
	const rows = access.locator(".share-access-row");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText("Anyone with the link");
	await expect(rows.nth(0)).toContainText("Can view");
	await expect(rows.nth(1)).toContainText("People on this Tack");
	await expect(rows.nth(1).getByLabel("What people on this Tack can do")).toHaveValue("editor");
	await page.keyboard.press("Escape");
	await expect(chip).toContainText("Public");
});

test("new boards ask who can open them, and remember", async ({ page }) => {
	await signInAs(page, login("chooser"));
	await page.getByRole("button", { name: "Create your first board" }).click();
	await page.getByRole("option", { name: /^Blank board/ }).click();
	const access = page.getByRole("group", { name: "Who can open it" });
	await expect(access.getByRole("radio", { name: /Everyone on this Tack/ })).toBeChecked();
	await access.getByText("Only people I invite").click();
	await expect(access.getByRole("radio", { name: /Only people I invite/ })).toBeChecked();
	await page.getByRole("button", { name: "Create board" }).click();
	await expect(page.locator(".topbar .access-chip")).toContainText("Invite only");

	await page.goto("/");
	await page.getByRole("button", { name: "New board" }).click();
	await page.getByRole("option", { name: /^Blank board/ }).click();
	await expect(
		page.getByRole("group", { name: "Who can open it" }).getByRole("radio", {
			name: /Only people I invite/,
		}),
	).toBeChecked();
});

test("the top bar never wraps, folding its tools away on narrow windows", async ({ page }) => {
	await signInAs(page, login("bar"));
	const board = await makeBoard(
		page,
		"Incident review: the image CDN outage on the first of October, and what we learned",
	);
	await page.goto(path(board));
	const bar = page.locator(".board-bar");
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
	for (const width of [1440, 1280, 1024, 768, 375]) {
		await page.setViewportSize({ width, height: 800 });
		const height = await bar.evaluate((el) => el.getBoundingClientRect().height);
		expect(height, `top bar height at ${width}px`).toBeLessThan(64);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth,
		);
		expect(overflow, `sideways scroll at ${width}px`).toBeLessThanOrEqual(0);
	}

	// Below 900px the tools are in "More tools", each labelled.
	await page.setViewportSize({ width: 768, height: 800 });
	await expect(page.getByRole("button", { name: /^History/ })).toBeHidden();
	await page.getByRole("button", { name: "More tools" }).click();
	await expect(page.getByRole("button", { name: /^History/ })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "More tools" })).toHaveAttribute(
		"aria-expanded",
		"false",
	);

	// Theme moved to the account menu; sync is a dot until something's wrong.
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.locator(".topbar .theme-switch, .topbar .theme-toggle")).toHaveCount(0);
	await expect(page.locator(".topbar .status[data-synced=true]")).toBeVisible();
	await expect(page.locator(".topbar .status-text")).toHaveCount(0);
});

test("the board's panels open one at a time, and Escape closes them", async ({ page }) => {
	await signInAs(page, login("panels"));
	const board = await makeBoard(page, "Panels");
	await page.goto(path(board));
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
	const comments = page.getByRole("button", { name: /^Comments/ });
	const rules = page.getByRole("button", { name: /^Rules/ });
	const changes = page.getByRole("button", { name: /^Changes/ });

	await comments.click();
	await expect(comments).toHaveAttribute("aria-pressed", "true");
	await rules.click();
	await expect(rules).toHaveAttribute("aria-pressed", "true");
	await expect(comments).toHaveAttribute("aria-pressed", "false");
	await changes.click();
	await expect(changes).toHaveAttribute("aria-expanded", "true");
	await expect(rules).toHaveAttribute("aria-pressed", "false");

	await page.keyboard.press("Escape");
	await expect(changes).toHaveAttribute("aria-expanded", "false");
});

test("viewers are told why edit keys do nothing, and archived boards keep their view tools", async ({
	browser,
	page,
}) => {
	const owner = login("keeper");
	const viewer = login("looker");
	await signInAs(page, owner);
	const board = await makeBoard(page, "Archive me", "private");
	await invite(page, board.id, [viewer], "viewer");

	const them = await newPage(browser, viewer);
	await them.goto(path(board));
	await expect(them.getByText("View only")).toBeVisible();
	await them.locator(".react-flow__pane").click({ position: { x: 400, y: 300 } });
	await them.keyboard.press("s");
	await expect(them.locator(".toast")).toContainText("You can view this board, but not edit it");
	// An empty rules panel doesn't offer viewers what they can't add.
	await them.getByRole("button", { name: /^Rules/ }).click();
	await expect(them.getByText("No rules on this board.")).toBeVisible();
	await them.context().close();

	// Archived: select and the hand stay, and the comment tool says why it's off.
	await archive(page, board.id);
	await page.goto(path(board));
	const tools = page.getByRole("toolbar", { name: "Tools" });
	await expect(tools.getByRole("button", { name: "Select" })).toBeVisible();
	await expect(tools.getByRole("button", { name: "Hand" })).toBeVisible();
	await expect(tools.getByRole("button", { name: /^Comment/ })).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await page.locator(".react-flow__pane").click({ position: { x: 400, y: 300 } });
	await page.keyboard.press("s");
	await expect(page.locator(".toast")).toContainText("archived");
});

test("unknown addresses say so, with the way home", async ({ page }) => {
	await signInAs(page, login("lost"), "/some/random/path");
	await expect(page.getByRole("heading", { name: "This page isn’t here" })).toBeVisible();
	await expect(page).toHaveTitle("Not found · Tack");
	await page.getByRole("link", { name: "All boards" }).click();
	await expect(page).toHaveURL(/\/$/);
});

test("signing out says so", async ({ page }) => {
	await signInAs(page, login("leaving"));
	await page.getByRole("button", { name: /^Account/ }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.locator(".toast")).toContainText("Signed out");
});
