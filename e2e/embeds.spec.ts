import type { Page } from "@playwright/test";
import type { BoardInfo } from "../src/shared/boards.ts";
import { allowClipboard, expect, settleCanvas, test } from "./fixtures.ts";

// Public boards outside Tack (#56, #57), against the dev server: Copy embed
// from Share, picking a part of the board on the canvas, the images it
// copies, link previews' meta tags, and the gallery's states.

const run = Date.now().toString(36);
let n = 0;
const login = (name: string) => `e2e-${name}-${run}-${++n}`;

test.beforeEach(async ({ page }) => {
	// Drawing an image the first time sets up WebAssembly on the dev server.
	test.slow();
	await page.route("https://github.com/**", (route) => route.abort());
});

/** A public board, laid out from the planning template, open as its owner. */
async function publicBoard(page: Page): Promise<BoardInfo> {
	await page.goto(`/auth/dev?login=${login("owner")}&return_to=/`);
	const board = await page.evaluate(async () => {
		const response = await fetch("/api/boards", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "EmDash planning",
				visibility: "public",
				template: "tack:planning",
			}),
		});
		return (await response.json()) as BoardInfo;
	});
	await page.goto(`/b/${board.id}/${board.slug}`);
	await expect(page.locator(".react-flow__node").first()).toBeVisible();
	await settleCanvas(page);
	return board;
}

test("copies an embed of the whole board, or a part picked on the canvas", async ({
	page,
	browserName,
}) => {
	await allowClipboard(page, browserName);
	const board = await publicBoard(page);

	await page.getByRole("button", { name: /^Share/ }).click();
	await page.getByRole("button", { name: "Get embed" }).click();
	const dialog = page.getByRole("dialog", { name: /Embed/ });
	await expect(dialog).toBeVisible();
	// The server's own image, drawn from the board.
	await expect(dialog.locator(".embed-preview img[data-ready]")).toBeVisible({ timeout: 30_000 });
	await expect(dialog.getByRole("radio", { name: "Whole board" })).toBeChecked();

	// Pick an area on the board: the dialog steps aside, and comes back with it.
	await dialog.getByRole("button", { name: "Pick on the board" }).click();
	await expect(dialog).toBeHidden();
	const picker = page.getByRole("application", { name: "Pick a part of the board to embed" });
	await expect(picker).toBeVisible();
	const box = (await picker.boundingBox())!;
	await page.mouse.move(box.x + 200, box.y + 160);
	await page.mouse.down();
	await page.mouse.move(box.x + 520, box.y + 380, { steps: 10 });
	await expect(picker.locator(".region-picker-label")).toHaveText(/^\d+ × \d+$/);
	await page.mouse.up();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("radio", { name: /^Area \d+ × \d+$/ })).toBeChecked();

	// Markdown, light: one image linking to the board.
	await dialog.getByRole("radio", { name: "Light" }).check({ force: true });
	await dialog.getByRole("radio", { name: "Markdown" }).check({ force: true });
	await dialog.getByRole("button", { name: "Copy embed" }).click();
	await expect(dialog.getByRole("button", { name: "Embed copied" })).toBeVisible();
	const snippet = await page.evaluate(() => navigator.clipboard.readText());
	const match = /^\[!\[EmDash planning on Tack\]\((http[^)]+)\)\]\((http[^)]+)\)$/.exec(snippet);
	expect(match, snippet).not.toBeNull();
	const [, image = "", link = ""] = match ?? [];
	expect(new URL(link).pathname).toBe(`/b/${board.id}/${board.slug}`);
	expect(new URL(image).pathname).toBe(`/embed/${board.id}.svg`);
	expect(new URL(image).searchParams.get("w")).toMatch(/^\d+$/);

	// What it copied is an image anyone can load.
	const response = await page.request.get(image);
	expect(response.status()).toBe(200);
	expect(response.headers()["content-type"]).toContain("image/svg+xml");

	// Escape while picking goes back to the dialog as it was.
	await dialog.getByRole("button", { name: "Pick again" }).click();
	await expect(picker).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("radio", { name: /^Area / })).toBeChecked();
});

test("public boards' pages carry link previews; other boards' don't", async ({ page }) => {
	const board = await publicBoard(page);
	const html = await (await page.request.get(`/b/${board.id}/${board.slug}`)).text();
	expect(html).toContain('<meta property="og:title" content="EmDash planning" />');
	expect(html).toContain("<title>EmDash planning · Tack</title>");
	const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
	expect(image).toContain(`/og/${board.id}.png?v=`);
	const preview = await page.request.get(image!);
	expect(preview.status()).toBe(200);
	expect(preview.headers()["content-type"]).toBe("image/png");

	const hidden = await page.evaluate(async () => {
		const response = await fetch("/api/boards", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Top secret", visibility: "private" }),
		});
		return (await response.json()) as BoardInfo;
	});
	const plain = await (await page.request.get(`/b/${hidden.id}/${hidden.slug}`)).text();
	expect(plain).not.toContain("og:title");
	expect(plain).not.toContain("Top secret");
	expect((await page.request.get(`/embed/${hidden.id}.svg`)).status()).toBe(404);
});

test("the gallery shows embed and signed-out states", async ({ page }) => {
	await page.goto("/play/boards");
	await expect(page.getByRole("heading", { name: "Embed", exact: true })).toBeVisible();
	const panels = page.locator(".embed");
	await expect(panels).toHaveCount(3);
	await expect(panels.nth(1).getByRole("radio", { name: "Section “Up next”" })).toBeChecked();
	await expect(panels.nth(2).getByRole("alert")).toContainText("Couldn’t draw the board");

	const notice = page.locator(".gallery-public .public-notice");
	await expect(notice).toContainText("You’re viewing a public board");
	await expect(notice.getByRole("link", { name: "Sign in" })).toBeVisible();
	await notice.getByRole("button", { name: "Dismiss" }).click();
	await expect(notice).toBeHidden();
});

test("the share dialog shows the board's link as a QR code, on a page of its own", async ({
	page,
}) => {
	await publicBoard(page);
	await page.getByRole("button", { name: /^Share/ }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Show a QR code for the link" }).click();
	// The QR page takes the dialog's place, rather than opening over it.
	await expect(dialog.getByRole("heading", { name: /on a phone/ })).toBeVisible();
	await expect(dialog.getByRole("img", { name: "QR code for this board's link" })).toBeVisible();
	await expect(dialog.locator(".share-qr-link")).toContainText("/b/");
	await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
	await expect(dialog.locator(".share-members")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Back to sharing" }).click();
	await expect(dialog.locator(".share-members")).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Show a QR code for the link" })).toBeFocused();
});
