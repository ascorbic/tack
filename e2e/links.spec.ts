import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures.ts";

// Link cards on /play: pasting or dropping an address that isn't an item, the
// preview read by the playground's stand-in unfurler (nothing leaves the
// browser), and every state: with an image, failed, blocked, and an address
// with words around it staying a sticky.

async function paste(page: Page, text: string) {
	await page.evaluate((value) => {
		const data = new DataTransfer();
		data.setData("text/plain", value);
		window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	}, text);
}

test.beforeEach(async ({ page }) => {
	// Nothing on the playground ever fetches from elsewhere: make sure.
	await page.context().route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
});

test("the scenario shows link cards in every state", async ({ page }) => {
	await openScenario(page, "links");
	const links = page.locator(".react-flow__node-link .link-card");
	await expect(links).toHaveCount(9);
	// Pages with an image show it, through the link service, once it's loaded.
	await expect(page.locator(".link-card .link-media[data-loaded]")).toHaveCount(5);
	await expect(page.locator('.link-card[data-state="failed"] .link-note')).toContainText(
		"couldn’t be read",
	);
	await expect(page.locator('.link-card[data-state="blocked"] .link-note')).toContainText(
		"doesn’t read previews",
	);
	// No broken images anywhere: failed and blocked cards draw a tint, not an <img>.
	await expect(page.locator('.link-card[data-state="failed"] .link-image')).toHaveCount(0);
	// The one read as the board opens settles from its skeleton into its preview.
	await expect(page.locator('.link-card[data-state="loading"]')).toHaveCount(0);
	await expect(page.locator(".link-title", { hasText: "Using Unpic with Astro" })).toBeVisible();
});

test("pasting an address makes a link card with its preview, in one undo step", async ({
	page,
}) => {
	await openScenario(page, "empty");
	await page.mouse.move(640, 400);
	await paste(page, "https://unpic.pics");
	const card = page.locator(".react-flow__node-link .link-card");
	await expect(card).toHaveCount(1);
	await expect(card).toHaveAttribute("data-state", "ok");
	await expect(card.locator(".link-title")).toHaveText(
		"Unpic: responsive images, without the fuss",
	);
	await expect(card.locator(".link-site-name")).toHaveText("Unpic");
	await expect(card.locator(".link-host")).toHaveText("unpic.pics");
	await expect(card.locator(".link-media[data-loaded] img")).toBeVisible();
	await expect(card.locator(".link-open")).toHaveAttribute("href", "https://unpic.pics/");

	// The preview arriving isn't a step of its own: one undo takes the card away.
	await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
	await page.keyboard.press("ControlOrMeta+z");
	await expect(card).toHaveCount(0);
});

test("a page that can't be read is a plain link card, never a broken image", async ({ page }) => {
	await openScenario(page, "empty");
	await paste(page, "https://tack.social/[fail]");
	const card = page.locator(".react-flow__node-link .link-card");
	await expect(card).toHaveAttribute("data-state", "failed");
	await expect(card.locator(".link-title")).toHaveText("tack.social/[fail]");
	await expect(card.locator(".link-site-name")).toHaveText("tack.social");
	await expect(card.locator("img")).toHaveCount(0);
	await expect(card.locator(".link-initial")).toHaveCount(2);
});

test("words around an address keep it a sticky; several addresses are several cards", async ({
	page,
}) => {
	await openScenario(page, "empty");
	await paste(page, "Read https://tack.social before Friday");
	await expect(page.locator(".react-flow__node-sticky")).toHaveCount(1);
	await expect(page.locator(".react-flow__node-link")).toHaveCount(0);

	await paste(page, "https://emdashcms.com https://tack.social\nhttps://emdashcms.com/");
	await expect(page.locator(".react-flow__node-link")).toHaveCount(2);
	await expect(page.locator(".link-site-name")).toHaveText(["EmDash", "Tack"]);

	// Again: it's here already, so the toast offers a copy rather than making one.
	await paste(page, "https://tack.social/");
	const toast = page.getByRole("status").locator('.toast:not([data-leaving="true"])');
	await expect(toast).toContainText("tack.social is already on the board");
	await expect(page.locator(".react-flow__node-link")).toHaveCount(2);
});

test("dropping a link from elsewhere makes a link card where it lands", async ({ page }) => {
	await openScenario(page, "empty");
	await page.evaluate(() => {
		const pane = document.querySelector(".react-flow__pane") as HTMLElement;
		const data = new DataTransfer();
		data.setData("text/uri-list", "# a comment\nhttps://emdashcms.com/docs/roadmap");
		data.setData("text/plain", "https://emdashcms.com/docs/roadmap");
		for (const type of ["dragover", "drop"]) {
			pane.dispatchEvent(
				new DragEvent(type, {
					dataTransfer: data,
					bubbles: true,
					cancelable: true,
					clientX: 500,
					clientY: 360,
				}),
			);
		}
	});
	await expect(page.locator(".react-flow__node-link .link-title")).toHaveText("Roadmap · EmDash");
});
