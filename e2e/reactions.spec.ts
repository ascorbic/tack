import type { Browser, Page } from "@playwright/test";
import { expect, settleCanvas, test } from "./fixtures.ts";

// Who reacted, on a real board on the dev server: two people signed in with
// /auth/dev stamp the same sticky, and pointing at the stamp names them both,
// you first; a card from the fake forge (fake.tack) names who reacted to its
// item when its count is pointed at; and the keyboard gets the same.

const run = Date.now().toString(36);
const LENA = `e2e-lena-${run}`;
const GUS = `e2e-gus-${run}`;
// The fake forge's #8 is a pull request with 8 reactions, from made-up people.
const CARD = "fake.tack/tack/cirrus#8";

async function signIn(browser: Browser, baseURL: string | undefined, login: string, name: string) {
	const context = await browser.newContext({ baseURL, reducedMotion: "reduce" });
	const page = await context.newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	await page.goto(
		`/auth/dev?login=${login}&name=${encodeURIComponent(name)}&return_to=${encodeURIComponent("/")}`,
	);
	return page;
}

/** A blank board with a sticky and a card, as its owner. */
async function makeBoard(page: Page): Promise<string> {
	await page.getByRole("button", { name: "Create your first board" }).click();
	await page.getByRole("option", { name: /^Blank board/ }).click();
	await page.getByRole("button", { name: "Create board" }).click();
	await expect(page.getByRole("textbox", { name: "Board title" })).toBeFocused({
		timeout: 15_000,
	});
	await page.keyboard.type("Retro");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/retro$/);
	await page.evaluate((ref) => {
		const data = new DataTransfer();
		const shapes = [
			{ id: "a", props: { type: "sticky", x: 0, y: 0, text: "Tiles load fast" } },
			{ id: "b", props: { type: "card", ref, x: 320, y: 0 } },
		];
		data.setData("application/x-tack+json", JSON.stringify({ tack: 1, shapes }));
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
	}, CARD);
	await expect(page.locator(".react-flow__node-card")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Shift+1");
	await settleCanvas(page);
	return page.url();
}

async function openBoard(page: Page, url: string) {
	await page.goto(url);
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(1);
	await settleCanvas(page);
}

/** Stamp the sticky with 👍, the stamp tool's first. */
async function stampSticky(page: Page) {
	await page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } });
	await page.keyboard.press("m");
	await page.keyboard.press("1");
	await page.locator(".react-flow__node-sticky").click();
	await page.keyboard.press("Escape");
}

test.describe.serial("who reacted", () => {
	let lena: Page;
	let gus: Page;

	test.beforeAll(async ({ browser, baseURL }) => {
		lena = await signIn(browser, baseURL, LENA, "Lena Lindqvist");
		const url = await makeBoard(lena);
		gus = await signIn(browser, baseURL, GUS, "Gus Okoro");
		await openBoard(gus, url);
	});

	test.afterAll(async () => {
		await lena?.context().close();
		await gus?.context().close();
	});

	test("two people stamp a sticky, and pointing at it names them both, you first", async () => {
		await stampSticky(lena);
		await expect(gus.locator(".stamp")).toHaveAccessibleName("👍 1: Lena Lindqvist");
		await stampSticky(gus);
		const theirs = lena.locator(".stamp");
		await expect(theirs).toHaveAccessibleName("👍 2: You and Gus Okoro");
		await theirs.hover();
		await expect(lena.getByRole("tooltip")).toHaveText("👍You and Gus Okoro");
		const mine = gus.locator(".stamp");
		await expect(mine).toHaveAccessibleName("👍 2: You and Lena Lindqvist");
		await mine.hover();
		await expect(gus.getByRole("tooltip")).toHaveText("👍You and Lena Lindqvist");
		await gus.mouse.move(10, 400);
		await expect(gus.getByRole("tooltip")).toHaveCount(0);
	});

	test("a card shows each reaction as GitHub does, and a pill names who left it", async () => {
		const card = lena.locator(".react-flow__node-card");
		const pills = card.getByRole("group", { name: "Reactions" }).getByRole("button");
		// The fake forge's #8: four 👍, two ❤️, one 🎉, one 🚀, in GitHub's order.
		await expect(pills).toHaveText(["👍4", "🎉1", "❤️2", "🚀1"]);
		const thumbs = pills.first();
		await expect(thumbs).toHaveAccessibleName("👍 4");
		const asked = lena.waitForRequest((request) => request.url().includes("/reactors?key="));
		await thumbs.hover();
		await asked;
		const tip = lena.getByRole("tooltip");
		// Who left that one, on one line under its pill: fewer names rather than a wrap.
		await expect(tip).toContainText(/^👍.+/);
		await expect(tip).not.toContainText("❤️");
		await expect(tip).toHaveAttribute("data-side", "below");
		const line = await tip
			.locator(".reaction-tip-names")
			.evaluate((el) => el.getBoundingClientRect().height);
		expect(line).toBeLessThan(24);
		await expect(thumbs).toHaveAccessibleName(/^👍 4: .+/);
		// Asked once for the whole card: another pill uses what came back.
		let again = 0;
		lena.on("request", (request) => {
			if (request.url().includes("/reactors?key=")) again++;
		});
		await lena.mouse.move(10, 400);
		await expect(tip).toHaveCount(0);
		// Pointed at, the card shows ✋ at its foot's end, and the fewest left
		// fold into +N to make room: it names them.
		await card.locator(".card-title").hover();
		await expect(card.locator(".volunteers[data-ghost]")).toBeVisible();
		await expect(pills).toHaveText(["👍4", "❤️2", "+2"]);
		await pills.nth(2).hover();
		await expect(tip).toContainText("🚀");
		await expect(pills.nth(2)).toHaveAccessibleName(/^2 more: 🎉 1, 🚀 1: .+/);
		expect(again).toBe(0);
		await lena.mouse.move(10, 400);
	});

	test("the keyboard: focusing a stamp or a count shows the same", async () => {
		// Keyboard focus (not a click's) shows the tooltip.
		await gus.keyboard.press("Shift");
		await gus.locator(".stamp").focus();
		await expect(gus.getByRole("tooltip")).toHaveText("👍You and Lena Lindqvist");
		await gus.keyboard.press("Escape");
		await expect(gus.getByRole("tooltip")).toHaveCount(0);
		const party = gus.locator(".react-flow__node-card .reaction-pill").nth(1);
		await party.focus();
		await expect(gus.getByRole("tooltip")).toContainText(/^🎉.+/);
		await expect(party).toHaveAccessibleName(/^🎉 1: .+/);
	});
});
