import type { Browser, Locator, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// Volunteering on a real board, as two people in separate browsers signed in
// with /auth/dev: hands up on an issue's card show for both, either can
// withdraw, "Assign volunteers" stages them as assignees and the push sheet
// writes them, and a sticky's volunteers become its new issue's assignees.
// Kai and Priya are people the fake forge (fake.tack) lets be assigned.

test.use({ reducedMotion: "reduce" });

const REPO = "fake.tack/demo/app";

interface Change {
	id: string;
	status: string;
	op: { kind: string; add?: string[]; assignees?: string[]; title?: string };
}

async function signIn(
	browser: Browser,
	baseURL: string | undefined,
	login: string,
	name: string,
): Promise<Page> {
	const context = await browser.newContext({ baseURL, reducedMotion: "reduce" });
	const page = await context.newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	await page.goto(
		`/auth/dev?login=${login}&name=${encodeURIComponent(name)}&return_to=${encodeURIComponent("/")}`,
	);
	return page;
}

/** A board with an issue's card and a sticky, as its owner. */
async function makeBoard(page: Page): Promise<string> {
	await page
		.getByRole("button", { name: /^(Create your first board|New board)$/ })
		.first()
		.click();
	await page.getByRole("option", { name: /^Blank board/ }).click();
	await page.getByRole("button", { name: "Create board" }).click();
	await expect(page.getByRole("textbox", { name: "Board title" })).toBeFocused({
		timeout: 15_000,
	});
	await page.keyboard.type("Volunteers");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/volunteers$/);
	await page.evaluate((repo) => {
		const data = new DataTransfer();
		const shapes = [
			{ id: "card", props: { type: "card", ref: `${repo}#4`, x: 0, y: 0 } },
			{ id: "sticky", props: { type: "sticky", x: 360, y: 0, text: "Write the migration guide" } },
		];
		data.setData("application/x-tack+json", JSON.stringify({ tack: 1, shapes }));
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
	}, REPO);
	await expect(page.locator(".react-flow__node")).toHaveCount(2);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Shift+1");
	await settleCanvas(page);
	return page.url();
}

async function openBoard(page: Page, url: string) {
	await page.goto(url);
	await expect(page.locator(".react-flow__node")).toHaveCount(2);
	await settleCanvas(page);
}

const card = (page: Page) => page.locator(".react-flow__node-card");
const sticky = (page: Page) => page.locator(".react-flow__node-sticky");
const volunteers = (shape: Locator) => shape.getByRole("group", { name: /^Volunteers: / });
const faces = (shape: Locator) => shape.locator(".volunteer-stack .volunteer");

/** Your hand, on a shape: in its head before anyone's volunteered, then in the row. */
async function raiseHand(shape: Locator) {
	await shape.hover();
	await shape.getByRole("button", { name: "I’ll take it" }).click();
}

/**
 * Open the changes panel and its push sheet for the one change staged. A
 * cold dev server can reload the page as it first loads the sheet's code,
 * closing the panel, so it's opened again until the sheet's up.
 */
async function reviewAndPush(page: Page): Promise<Locator> {
	const panel = page.getByRole("complementary", { name: "Pending changes" });
	const sheet = page.locator(".push-dialog");
	await expect(async () => {
		if (!(await panel.isVisible())) await page.getByRole("button", { name: /^Changes/ }).click();
		await panel.getByRole("button", { name: "Review and push 1" }).click({ timeout: 3000 });
		await expect(sheet).toBeVisible({ timeout: 3000 });
	}).toPass({ timeout: 30_000 });
	return sheet;
}

function changes(page: Page): Promise<Change[]> {
	return page.evaluate(() => {
		const doc = (window as unknown as { tackBoard: { doc: import("yjs").Doc } }).tackBoard.doc;
		return [...doc.getMap("changes").values()].map(
			(change) => (change as import("yjs").Map<unknown>).toJSON() as Change,
		);
	});
}

test.describe.serial("volunteering", () => {
	test.describe.configure({ timeout: 90_000 });
	let kai: Page;
	let priya: Page;

	test.beforeAll(async ({ browser, baseURL }) => {
		kai = await signIn(browser, baseURL, "kai", "Kai Andersen");
		const url = await makeBoard(kai);
		priya = await signIn(browser, baseURL, "priya", "Priya Shah");
		await openBoard(priya, url);
	});

	test.afterAll(async () => {
		await kai?.context().close();
		await priya?.context().close();
	});

	test("two people volunteer and both show, for both; withdrawing takes yours back", async () => {
		// Nobody yet: no row, and the hand waits in the head until you point.
		await expect(volunteers(card(kai))).toHaveCount(0);
		await raiseHand(card(kai));
		await expect(volunteers(card(kai))).toHaveAttribute("aria-label", "Volunteers: You");
		await expect(volunteers(card(priya))).toHaveAttribute("aria-label", "Volunteers: Kai Andersen");

		await raiseHand(card(priya));
		await expect(faces(card(priya))).toHaveCount(2);
		await expect(volunteers(card(priya))).toHaveAttribute(
			"aria-label",
			"Volunteers: You, Kai Andersen",
		);
		await expect(faces(card(kai))).toHaveCount(2);
		await expect(volunteers(card(kai))).toHaveAttribute(
			"aria-label",
			"Volunteers: You, Priya Shah",
		);
		// Pressed: yours is up.
		await card(priya).hover();
		const mine = card(priya).getByRole("button", { name: "I’ll take it" });
		await expect(mine).toHaveAttribute("aria-pressed", "true");

		// Withdrawing.
		await mine.click();
		await expect(volunteers(card(kai))).toHaveAttribute("aria-label", "Volunteers: You");
		await expect(faces(card(kai))).toHaveCount(1);
		// And back again.
		await raiseHand(card(priya));
		await expect(faces(card(kai))).toHaveCount(2);
		// Nothing's staged by volunteering: it's the board's.
		expect(await changes(kai)).toEqual([]);
	});

	test("Assign volunteers stages them as assignees, and a push writes them", async () => {
		await card(kai).click({ position: { x: 24, y: 14 } });
		const bar = kai.getByRole("toolbar", { name: "Stage changes" });
		await bar.getByRole("button", { name: /^Assign volunteers/ }).click();
		await expect(kai.locator(".toast", { hasText: "Staged +@kai +@priya on #4" })).toBeVisible();
		const [assign] = await changes(kai);
		expect(assign?.op).toMatchObject({ kind: "item.assignees", add: ["kai", "priya"] });
		// Staged: the bar says so, and the faces are marked.
		await expect(bar.getByRole("button", { name: /^Assign volunteers/ })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await expect(volunteers(card(priya))).toHaveAttribute(
			"aria-label",
			"Volunteers: You, Kai Andersen (staged to be assigned)",
		);

		await kai.keyboard.press("Escape");
		const sheet = await reviewAndPush(kai);
		await expect(sheet).toContainText("@kai");
		await expect(sheet).toContainText("@priya");
		await sheet.getByRole("button", { name: "Push 1 change" }).click();
		await expect(sheet.locator(".push-step[data-status=applied]")).toHaveCount(1, {
			timeout: 30_000,
		});
		await sheet.getByRole("button", { name: "Done" }).click();
		await kai.keyboard.press("Escape");
		expect((await changes(kai)).map((change) => change.status)).toEqual(["applied"]);
	});

	test("a sticky's volunteers become its new issue's assignees through Make issue", async () => {
		await raiseHand(sticky(kai));
		await expect(volunteers(sticky(priya))).toHaveAttribute(
			"aria-label",
			"Volunteers: Kai Andersen",
		);
		await sticky(kai).click({ position: { x: 24, y: 24 } });
		await kai.keyboard.press("Alt+KeyI");
		const issues = kai.getByRole("dialog", { name: "Make issues from stickies" });
		await expect(
			issues.getByRole("img", { name: /^Assigned to its volunteer: Kai Andersen/ }),
		).toBeVisible();
		await issues.getByRole("button", { name: "Stage issue" }).click();
		await expect(issues).toHaveCount(0);
		const made = (await changes(kai)).find((change) => change.op.kind === "issue.create");
		expect(made?.op).toMatchObject({ title: "Write the migration guide", assignees: ["kai"] });
		// Staged with its issue: the face is marked.
		await expect(volunteers(sticky(kai))).toHaveAttribute(
			"aria-label",
			"Volunteers: You (staged to be assigned)",
		);

		// The push sheet shows who it's made assigned to.
		const sheet = await reviewAndPush(kai);
		await expect(sheet.getByText("@kai", { exact: true })).toBeVisible();
		await sheet.getByRole("button", { name: "Push 1 change" }).click();
		await expect(sheet.locator(".push-step[data-status=applied]")).toHaveCount(1, {
			timeout: 30_000,
		});
		await sheet.getByRole("button", { name: "Done" }).click();
		await kai.keyboard.press("Escape");
		// The sticky's now its issue's card, and Kai's hand went with it.
		await expect(sticky(kai)).toHaveCount(0);
		await expect(card(priya)).toHaveCount(2);
		await expect(
			volunteers(card(priya).filter({ hasText: "Made on the fake forge" })),
		).toHaveAttribute("aria-label", "Volunteers: Kai Andersen");
	});
});
