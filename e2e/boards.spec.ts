import type { Browser, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// Boards end to end against the dev server: create one from the home page,
// rename it, share it, and open it as a viewer and signed out. The dev
// server runs with TACK_DEV_AUTH (see playwright.config.ts), so /auth/dev
// signs people in without GitHub. Logins are unique per run, so each run
// starts from an empty home page.

const run = Date.now().toString(36);
const OWNER = `e2e-owner-${run}`;
const FRIEND = `e2e-friend-${run}`;

test.beforeEach(async ({ page }) => {
	// Keep the tests hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

async function signInAs(page: Page, login: string, returnTo = "/") {
	await page.goto(`/auth/dev?login=${login}&return_to=${encodeURIComponent(returnTo)}`);
}

async function newPage(browser: Browser, login?: string): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	if (login) await signInAs(page, login);
	return page;
}

test.describe.serial("a board's life", () => {
	let boardUrl = "";

	test("create, open, rename and share", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await signInAs(page, OWNER);
		await expect(page.getByRole("heading", { name: "Your boards will live here" })).toBeVisible();

		// Creating opens the new board with its title ready to type over.
		await page.getByRole("button", { name: "Create your first board" }).click();
		// It opens the template picker: start blank.
		await page.getByRole("option", { name: /^Blank board/ }).click();
		await page.getByRole("button", { name: "Create board" }).click();
		await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/untitled-board$/, { timeout: 15_000 });
		const title = page.getByRole("textbox", { name: "Board title" });
		// The first load of a board can be slow on a cold dev server.
		await expect(title).toBeFocused({ timeout: 15_000 });
		await page.keyboard.type("E2E roadmap");
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/e2e-roadmap$/);
		await expect(page.getByRole("button", { name: "E2E roadmap" })).toBeVisible();
		await expect(page).toHaveTitle("E2E roadmap · Tack");
		await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
		boardUrl = page.url();

		// Share: invite a friend to view, and keep it to invited people only.
		await page.getByRole("button", { name: "Share" }).click();
		const dialog = page.getByRole("dialog", { name: /Share/ });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("listitem").filter({ hasText: "(you)" })).toContainText("Owner");
		await dialog.getByLabel("GitHub usernames to invite").fill(`@${FRIEND}`);
		await dialog.getByLabel("Invite as").selectOption("viewer");
		await dialog.getByRole("button", { name: "Invite", exact: true }).click();
		const friend = dialog.getByRole("listitem").filter({ hasText: FRIEND });
		await expect(friend).toContainText("hasn’t signed in yet");
		await expect(friend.getByRole("combobox")).toHaveValue("viewer");

		await dialog.getByLabel("Who can open this board").selectOption("private");
		await expect(dialog).toContainText("Only the people above can open this board.");

		await dialog.getByRole("button", { name: "Copy link" }).click();
		await expect(dialog.getByRole("button", { name: "Link copied" })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(boardUrl);

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();

		// Home lists it.
		await page.getByRole("link", { name: "Tack: all boards" }).click();
		await expect(page.getByRole("link", { name: "E2E roadmap" })).toBeVisible();
	});

	test("a viewer can look but not edit", async ({ browser }) => {
		const page = await newPage(browser, FRIEND);
		await page.goto(boardUrl);
		await expect(page.getByText("View only")).toBeVisible();
		await expect(page.locator(".react-flow__renderer")).toBeVisible();
		// Viewers can comment (#51), so they get the hand and the comment tool, and nothing else.
		const tools = page.getByRole("toolbar", { name: "Tools" });
		await expect(tools.getByRole("button", { name: "Comment" })).toBeVisible();
		await expect(tools.getByRole("button")).toHaveCount(3);
		// No tool shortcuts that would change the board: sections (F), connectors (X), stickies (S).
		for (const key of ["f", "x", "s"]) {
			await page.locator(".react-flow__pane").click({ position: { x: 400, y: 300 } });
			await page.keyboard.press(key);
			await expect(page.locator("main.canvas")).toHaveAttribute("data-tool", "select");
		}
		// The title isn't renameable either.
		await expect(page.getByRole("heading", { name: "E2E roadmap" })).toBeVisible();
		await expect(page.getByRole("button", { name: "E2E roadmap" })).toHaveCount(0);
		await page.context().close();
	});

	test("signed out, private boards ask you to sign in, and public ones open read-only", async ({
		browser,
		page,
	}) => {
		const stranger = await newPage(browser);
		await stranger.goto(boardUrl);
		await expect(stranger.getByRole("heading", { name: "Sign in to Tack" })).toBeVisible();

		await signInAs(page, OWNER, new URL(boardUrl).pathname);
		await page.getByRole("button", { name: "Share" }).click();
		await page.getByLabel("Who can open this board").selectOption("public");
		await expect(page.getByRole("dialog")).toContainText("no sign-in needed");
		// The dev server has no GitHub App, so everyone counts as on the
		// instance: make that view-only too, as the public always is.
		await page.getByLabel("What people on this Tack can do").selectOption("viewer");
		await expect(page.getByRole("dialog")).toContainText("Everyone who can sign in here can view.");

		await stranger.reload();
		await expect(stranger.getByText("View only")).toBeVisible();
		// Looking around, but no commenting without signing in, and it says so.
		const tools = stranger.getByRole("toolbar", { name: "Tools" });
		await expect(tools.getByRole("button")).toHaveCount(3);
		await expect(tools.getByRole("button", { name: /^Comment/ })).toHaveAttribute(
			"aria-label",
			"Comment: Sign in to comment",
		);
		await stranger.context().close();
	});
});

test("old ?board= links find their board", async ({ page }) => {
	await signInAs(page, OWNER, `/?board=e2e-legacy-${run}`);
	await expect(page).toHaveURL(new RegExp(`/b/e2e-legacy-${run}/e2e-legacy-${run}$`));
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
});

test("unknown boards say so", async ({ page }) => {
	await signInAs(page, OWNER, "/b/no-such-board/whatever");
	await expect(page.getByRole("heading", { name: "This board isn’t here" })).toBeVisible();
});

test("the card tool searches the forge for the board's repositories", async ({ page }) => {
	await signInAs(page, OWNER, `/?board=e2e-cards-${run}`);
	await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
	const cardKeys = () =>
		page.evaluate(() => {
			const { doc } = (window as unknown as { tackBoard: { doc: import("yjs").Doc } }).tackBoard;
			return [...doc.getMap<import("yjs").Map<unknown>>("shapes").values()]
				.filter((shape) => shape.get("type") === "card")
				.map((shape) => String(shape.get("ref")))
				.sort();
		});

	await page.locator(".react-flow__pane").click({ position: { x: 400, y: 300 } });
	await page.keyboard.press("c");
	const field = page.getByRole("combobox", { name: "Issue, pull request or discussion" });
	await field.fill("https://fake.tack/stress/cards/issues/3");
	await field.press("Enter");
	await expect.poll(cardKeys).toEqual(["fake.tack/stress/cards#3"]);

	// Now the board has a repository, words search it, through the Worker.
	await field.fill("synthetic");
	const options = page
		.getByRole("listbox", { name: "Issues, pull requests and discussions" })
		.getByRole("option");
	await expect(options).toHaveCount(10);
	await expect(options.filter({ hasText: "#3" }).first()).toBeVisible();
	await field.press("ArrowDown");
	await field.press("Enter");
	await expect.poll(async () => (await cardKeys()).length).toBe(2);
});

test("opening a board shows all of it, clear of the dock, and coming back is where you left it", async ({
	page,
	browser,
}) => {
	// Two people, and two reloads.
	test.setTimeout(90_000);
	await signInAs(page, OWNER, `/?board=e2e-fit-${run}`);
	await expect(page.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	// Spread out, wider than the screen: most of it starts off screen.
	const stickies = Array.from({ length: 6 }, (_, i) => ({
		id: `s${i}`,
		props: { type: "sticky", x: (i % 3) * 1400, y: Math.floor(i / 3) * 900, text: `Far ${i}` },
	}));
	await page.evaluate(
		(payload) => {
			const data = new DataTransfer();
			data.setData("application/x-tack+json", JSON.stringify(payload));
			window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
		},
		{ tack: 1, shapes: stickies },
	);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { tackBoard: { doc: import("yjs").Doc } }).tackBoard.doc.getMap(
						"shapes",
					).size,
			),
		)
		.toBe(6);
	const url = page.url();

	// Someone else opening it (no view of theirs remembered) sees every note.
	const other = await newPage(browser, OWNER);
	await other.goto(url);
	await expect(other.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	const notes = other.locator(".react-flow__node");
	await expect(notes).toHaveCount(6);
	await settleCanvas(other);
	const dock = await other.getByRole("toolbar", { name: "Tools" }).boundingBox();
	const minimap = await other.locator(".react-flow__minimap").boundingBox();
	for (const note of await notes.all()) {
		const box = (await note.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height).toBeLessThanOrEqual(dock!.y);
		expect(box.x + box.width).toBeLessThanOrEqual(minimap!.x);
	}

	// The zoom level shows, and its menu has the zoom shortcuts.
	const level = other.getByRole("button", { name: /^Zoom: \d+%$/ });
	await expect(level).not.toHaveAccessibleName("Zoom: 100%");
	await level.click();
	const menu = other.getByRole("menu", { name: "Zoom" });
	await expect(menu.getByRole("menuitem", { name: /Zoom to selection/ })).toBeDisabled();
	await menu.getByRole("menuitem", { name: /Zoom to 100%/ }).click();
	await expect(menu).toBeHidden();
	await expect(other.getByRole("button", { name: "Zoom: 100%" })).toBeVisible();
	await settleCanvas(other);
	const viewport = () =>
		other
			.locator(".react-flow__viewport")
			.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform))
			.then(({ a, e, f }) => ({ zoom: a, x: e, y: f }));
	const left = await viewport();

	// Coming back opens where you left it.
	await other.reload();
	await expect(other.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	await settleCanvas(other);
	// Where you left it is put back once the board has loaded: slower on CI.
	await expect(other.getByRole("button", { name: "Zoom: 100%" })).toBeVisible({ timeout: 15_000 });
	const back = await viewport();
	expect(back.zoom).toBeCloseTo(left.zoom, 3);
	expect(back.x).toBeCloseTo(left.x, 0);
	expect(back.y).toBeCloseTo(left.y, 0);

	// The minimap can be put away, and stays away.
	await other.getByRole("button", { name: "Zoom: 100%" }).click();
	await other.getByRole("menuitemcheckbox", { name: "Minimap" }).click();
	await expect(other.locator(".react-flow__minimap")).toHaveCount(0);
	await other.reload();
	await expect(other.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	await expect(other.locator(".react-flow__minimap")).toHaveCount(0);
	await other.context().close();
});

test("an empty board has no minimap, and the first sticky doesn't move the view", async ({
	page,
}) => {
	await signInAs(page, OWNER, `/?board=e2e-empty-${run}`);
	await expect(page.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	await expect(page.getByRole("button", { name: "Zoom: 100%" })).toBeVisible();
	await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
	const before = await page.locator(".react-flow__viewport").evaluate((el) => el.style.transform);
	await page.keyboard.press("s");
	await page.locator(".react-flow__pane").click({ position: { x: 300, y: 200 } });
	await page.keyboard.type("First");
	await page.keyboard.press("Escape");
	await expect(page.locator(".react-flow__minimap")).toBeVisible();
	await page.waitForTimeout(400);
	expect(await page.locator(".react-flow__viewport").evaluate((el) => el.style.transform)).toBe(
		before,
	);
});

test("edits made offline wait on this device, survive a reload, and are sent on reconnecting", async ({
	page,
	browser,
}) => {
	test.setTimeout(90_000);
	// The board's connection, cut and restored at will.
	let offline = false;
	const open = new Set<import("@playwright/test").WebSocketRoute>();
	await page.routeWebSocket(/\/parties\/board\//, (ws) => {
		if (offline) {
			void ws.close();
			return;
		}
		ws.connectToServer();
		open.add(ws);
	});
	const goOffline = async () => {
		offline = true;
		for (const ws of open) await ws.close();
		open.clear();
	};
	const status = page.locator(".status");

	await signInAs(page, OWNER, `/?board=e2e-offline-${run}`);
	await expect(status).toHaveText("Synced", { timeout: 15_000 });
	await page.keyboard.press("s");
	await page.locator(".react-flow__pane").click({ position: { x: 300, y: 220 } });
	await page.keyboard.type("Written online");
	await page.keyboard.press("Escape");
	const url = page.url();

	await goOffline();
	await expect(status).toHaveText("Reconnecting…");
	await page.keyboard.press("Escape");
	await page.keyboard.press("s");
	await page.locator(".react-flow__pane").click({ position: { x: 600, y: 220 } });
	await page.keyboard.type("Written offline");
	await page.keyboard.press("Escape");
	await expect(status).toHaveText(/^Offline · \d+ edits? waiting$/);

	// Leaving asks first; staying on (reloading anyway) loses nothing.
	const asked = new Promise<string>((resolve) =>
		page.once("dialog", (dialog) => {
			resolve(dialog.type());
			void dialog.accept();
		}),
	);
	await page.reload();
	expect(await asked).toBe("beforeunload");
	await expect(status).toHaveText(/^Offline · \d+ edits? waiting$/);

	// Back online: the edits go to the server, and everyone sees them.
	offline = false;
	await expect(status).toHaveText("Synced", { timeout: 30_000 });
	const sticky = (on: Page, text: string) =>
		on.locator(".react-flow__node-sticky", { hasText: text });
	await expect(sticky(page, "Written offline")).toBeVisible();
	const other = await newPage(browser, OWNER);
	await other.goto(url);
	await expect(other.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	await expect(sticky(other, "Written offline")).toHaveCount(1);
	await expect(sticky(other, "Written online")).toHaveCount(1);
	await other.context().close();
});

test("someone deleting the sticky you're writing in says so, and it can be restored", async ({
	page,
	browser,
}) => {
	test.setTimeout(90_000);
	const sticky = (on: Page, text: string) =>
		on.locator(".react-flow__node-sticky", { hasText: text });
	await signInAs(page, OWNER, `/?board=e2e-deleted-${run}`);
	await expect(page.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	await page.keyboard.press("s");
	await page.locator(".react-flow__pane").click({ position: { x: 400, y: 260 } });
	await page.keyboard.type("Shared note");
	await page.keyboard.press("Escape");

	// Someone else opens it and starts writing.
	const writer = await newPage(browser, FRIEND);
	await writer.goto(page.url());
	await expect(writer.locator(".status")).toHaveText("Synced", { timeout: 15_000 });
	await sticky(writer, "Shared note").click();
	await writer.keyboard.press("Enter");
	await expect(writer.getByRole("textbox", { name: "Sticky note" })).toBeFocused();
	await writer.keyboard.type(" (still writing)");
	await expect(sticky(page, "still writing")).toBeVisible();

	// The owner deletes it under them.
	await page.keyboard.press("Escape");
	await sticky(page, "Shared note").click();
	await page.keyboard.press("Delete");
	await expect(sticky(page, "Shared note")).toHaveCount(0);

	const toast = writer.locator(".toast", {
		hasText: "Someone else deleted the sticky you were writing in",
	});
	await expect(toast).toBeVisible();
	await toast.getByRole("button", { name: "Restore" }).click();
	await expect(sticky(writer, "Shared note (still writing)")).toBeVisible();
	await expect(sticky(page, "Shared note (still writing)")).toBeVisible();
	await writer.context().close();
});

test("the boards page never scrolls sideways, even with a top bar tooltip near the edge", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto(`/auth/dev?login=e2e-no-scroll-${Date.now().toString(36)}&return_to=/`);
	await expect(page.locator(".notifications-button")).toBeVisible();
	const widths = () =>
		page.evaluate(() => [
			document.documentElement.scrollWidth,
			document.documentElement.clientWidth,
		]);
	const [scroll, client] = await widths();
	expect(scroll).toBe(client);
});
