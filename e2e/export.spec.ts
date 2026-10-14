import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Download, Page } from "@playwright/test";
import { readBoardExport } from "../src/shared/boardExport.ts";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Export and import (#59): images and JSON from the playground's board, and
// on the real dev server, a board imported from JSON and backed up to a
// branch on the fake forge.

const run = Date.now().toString(36);

test.beforeEach(async ({ page }) => {
	// Hermetic: GitHub avatars fail to load, and fall back to initials.
	await page.route("https://github.com/**", (route) => route.abort());
});

async function saved(download: Download): Promise<Buffer> {
	const path = await download.path();
	return readFile(path);
}

async function openExport(page: Page) {
	await page.keyboard.press("ControlOrMeta+Shift+KeyE");
	const dialog = page.getByRole("dialog", { name: "Export" });
	await expect(dialog).toBeVisible();
	return dialog;
}

test.describe("exporting from the playground", () => {
	test("the whole board as a PNG and an SVG, at a scale, with a preview", async ({ page }) => {
		await openScenario(page, "planning");
		const dialog = await openExport(page);
		await dialog.getByRole("radio", { name: "PNG" }).click();
		await expect(dialog.getByRole("radio", { name: "Selection" })).toBeDisabled();
		await expect(dialog.getByRole("radio", { name: "Whole board" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		// The preview, drawn from every shape (not just those in view), at 100%.
		await expect(dialog.getByRole("img", { name: "What the image will look like" })).toBeVisible({
			timeout: 15_000,
		});
		await dialog.getByRole("radio", { name: "1×" }).click();
		const size = await dialog.locator(".export-size").textContent();
		const [width, height] = (size?.match(/[\d,]+/g) ?? []).map((n) => Number(n.replace(/,/g, "")));
		expect(width).toBeGreaterThan(800);

		const [png] = await Promise.all([
			page.waitForEvent("download"),
			dialog.getByRole("button", { name: "Download PNG" }).click(),
		]);
		expect(png.suggestedFilename()).toMatch(/^playground-planning-\d{4}-\d{2}-\d{2}\.png$/);
		const bytes = await saved(png);
		expect(bytes.subarray(1, 4).toString()).toBe("PNG");
		// Width and height from the PNG header.
		expect(bytes.readUInt32BE(16)).toBe(width);
		expect(bytes.readUInt32BE(20)).toBe(height);
		await expect(dialog).toBeHidden();
		await expect(page.locator(".toast[data-leaving=false]")).toContainText("Exported PNG");
		// The board's back where it was, culling and all.
		await expect(page.locator(".canvas")).not.toHaveAttribute("data-exporting", /.*/);

		const again = await openExport(page);
		await again.getByRole("radio", { name: "SVG" }).click();
		const [svg] = await Promise.all([
			page.waitForEvent("download"),
			again.getByRole("button", { name: "Download SVG" }).click(),
		]);
		const text = (await saved(svg)).toString();
		expect(text).toMatch(/^<\?xml/);
		expect(text).toContain("<svg");
		expect(text).toContain("foreignObject");
		// The board's cards, and none of the chrome around them.
		expect(text).toContain("react-flow__node-card");
		expect(text).not.toContain("react-flow__minimap");
	});

	test("just what's selected, with what's in its sections", async ({ page }) => {
		await openScenario(page, "planning");
		await page.locator(".react-flow__node-sticky").first().click();
		const dialog = await openExport(page);
		await dialog.getByRole("radio", { name: "PNG" }).click();
		await expect(dialog.getByRole("radio", { name: "Selection" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(dialog.getByRole("img", { name: "What the image will look like" })).toBeVisible({
			timeout: 15_000,
		});
		await dialog.getByRole("radio", { name: "1×" }).click();
		const [png] = await Promise.all([
			page.waitForEvent("download"),
			dialog.getByRole("button", { name: "Download PNG" }).click(),
		]);
		expect(png.suggestedFilename()).toMatch(/selection-.*\.png$/);
		const bytes = await saved(png);
		// A sticky and its padding, not the board.
		expect(bytes.readUInt32BE(16)).toBeLessThan(400);
	});

	test("the board as JSON, which reads back as a board", async ({ page }) => {
		await openScenario(page, "planning");
		const dialog = await openExport(page);
		await dialog.getByRole("radio", { name: "JSON" }).click();
		await expect(dialog).toContainText(/\d+ cards/);
		await expect(dialog).toContainText("History and staged changes stay here");
		const [json] = await Promise.all([
			page.waitForEvent("download"),
			dialog.getByRole("button", { name: "Download JSON" }).click(),
		]);
		expect(json.suggestedFilename()).toMatch(/\.json$/);
		const read = readBoardExport((await saved(json)).toString());
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.data.shapes.length).toBeGreaterThan(5);
		// Remembered for next time (once the dialog has finished closing).
		await expect(dialog).toBeHidden();
		const next = await openExport(page);
		await expect(next.getByRole("radio", { name: "JSON" })).toHaveAttribute("aria-checked", "true");
	});

	test("with what people did, when asked, for reading but not importing", async ({ page }) => {
		await openScenario(page, "vote");
		const dialog = await openExport(page);
		await dialog.getByRole("radio", { name: "JSON" }).click();
		const include = dialog.getByRole("switch", { name: "Include votes, stamps and comments" });
		await expect(include).not.toBeChecked();
		await expect(dialog).toContainText("for reading the board elsewhere");
		await dialog.getByText("Include votes, stamps and comments").click();
		await expect(include).toBeChecked();
		await expect(dialog).toContainText("2 votes");
		await expect(dialog).toContainText("except in hidden votes");
		const [json] = await Promise.all([
			page.waitForEvent("download"),
			dialog.getByRole("button", { name: "Download JSON" }).click(),
		]);
		const text = (await saved(json)).toString();
		const { activity } = JSON.parse(text) as {
			activity: {
				votes: { hidden: boolean; closedAt?: string; results?: { by?: unknown[] }[] }[];
				items: { title: string }[];
			};
		};
		const [hidden, open] = [
			activity.votes.find((vote) => vote.hidden),
			activity.votes.find((vote) => !vote.hidden),
		];
		// Closed, so its results are in, but never who voted for what.
		expect(hidden?.closedAt).toBeDefined();
		expect(hidden?.results?.length).toBeGreaterThan(0);
		for (const row of hidden?.results ?? []) expect(row).not.toHaveProperty("by");
		expect(open?.closedAt).toBeUndefined();
		expect(open?.results?.[0]?.by?.length).toBeGreaterThan(0);
		expect(activity.items.length).toBeGreaterThan(0);
		// Importing it leaves what people did behind.
		const read = readBoardExport(text);
		expect(read.ok && read.data).not.toHaveProperty("activity");
		await expect(dialog).toBeHidden();
		const next = await openExport(page);
		await expect(
			next.getByRole("switch", { name: "Include votes, stamps and comments" }),
		).toBeChecked();
	});
});

test.describe.serial("importing and backing up a real board", () => {
	const login = `e2e-export-${run}`;
	// A one-pixel PNG, carried in the file as an export carries its images.
	const pixel = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		"base64",
	);
	const hash = createHash("sha256").update(pixel).digest("hex");
	const board = {
		format: "tack.board",
		version: 1,
		title: `Imported ${run}`,
		exportedAt: "2026-10-01T10:00:00.000Z",
		shapes: [
			{ id: "s", type: "section", x: 0, y: 0, w: 640, h: 360, title: "Went well", parent: null },
			{ id: "a", type: "sticky", x: 40, y: 80, text: "Exports landed", color: "pink", parent: "s" },
			{ id: "b", type: "sticky", x: 280, y: 80, text: "Imports too", color: "blue", parent: "s" },
			{ id: "c", type: "card", x: 720, y: 80, ref: "fake.tack/demo/app#3" },
			{
				id: "k",
				type: "connector",
				x: 0,
				y: 0,
				from: { x: 0, y: 0, shape: "b" },
				to: { x: 0, y: 0, shape: "c" },
			},
			{
				id: "i",
				type: "image",
				x: 720,
				y: 280,
				w: 160,
				h: 160,
				iw: 1,
				ih: 1,
				mime: "image/png",
				image: hash,
				alt: "A single pixel",
				parent: null,
			},
		],
		rules: [],
		prepared: [],
		images: [{ hash, type: "image/png", data: pixel.toString("base64") }],
	};

	test("import a board from pasted JSON", async ({ page }) => {
		await page.goto(`/auth/dev?login=${login}&return_to=/`);
		await page.getByRole("button", { name: "Create your first board" }).click();
		const picker = page.getByRole("dialog", { name: "New board" });
		await picker.locator('[data-template="import"]').click();
		await picker.getByRole("button", { name: "Or paste the JSON instead" }).click();
		const paste = picker.getByLabel("Paste its JSON");
		await paste.fill("{ not json");
		await expect(picker.getByRole("alert")).toHaveCount(0);
		await paste.fill(JSON.stringify({ ...board, version: 9 }));
		await expect(picker.getByRole("alert")).toContainText("newer version of Tack");
		await paste.fill(JSON.stringify(board));
		await expect(picker.getByRole("heading", { name: board.title })).toBeVisible();
		await expect(picker.getByRole("list", { name: "What’s inside" })).toContainText("2 stickies");
		await picker.getByLabel("Name").fill(`Imported retro ${run}`);
		await picker.getByRole("button", { name: "Import board" }).click();
		await expect(page).toHaveURL(/\/b\/[a-z0-9]{10}\/imported-retro/, { timeout: 15_000 });
		await expect(page.locator(".react-flow__node-sticky")).toHaveCount(2, { timeout: 15_000 });
		await expect(page.locator(".react-flow__node-card")).toHaveCount(1);
		await expect(page.locator(".react-flow__node-section")).toContainText("Went well");
		// Its image's file was uploaded to the new board as it was, under the same hash.
		await expect(page.locator(".react-flow__node-image .image-file[data-loaded]")).toHaveAttribute(
			"src",
			new RegExp(`/images/${hash}$`),
			{ timeout: 15_000 },
		);
		await settleCanvas(page);

		// And it goes out again with the board's JSON.
		const dialog = await openExport(page);
		await dialog.getByRole("radio", { name: "JSON" }).click();
		await expect(dialog).toContainText("1 image goes in the file too");
		const [json] = await Promise.all([
			page.waitForEvent("download"),
			dialog.getByRole("button", { name: "Download JSON" }).click(),
		]);
		const read = readBoardExport((await saved(json)).toString());
		expect(read.ok && read.data.images).toEqual([board.images[0]]);
		// An SVG of the board carries the image, inlined.
		await expect(dialog).toBeHidden();
		const again = await openExport(page);
		await again.getByRole("radio", { name: "SVG" }).click();
		const [svg] = await Promise.all([
			page.waitForEvent("download"),
			again.getByRole("button", { name: "Download SVG" }).click(),
		]);
		const text = (await saved(svg)).toString();
		expect(text).toContain("image-file");
		expect(text).toContain(`data:image/png;base64,${pixel.toString("base64")}`);
	});

	test("back it up to a branch, from the board's menu", async ({ page }) => {
		await page.goto(`/auth/dev?login=${login}&return_to=/`);
		await page
			.getByRole("link", { name: new RegExp(`Imported retro ${run}`) })
			.first()
			.click();
		await expect(page.locator(".react-flow__node-sticky")).toHaveCount(2, { timeout: 15_000 });
		await page.getByRole("button", { name: "Board menu" }).click();
		await page.getByRole("menuitem", { name: "Back up to GitHub…" }).click();
		const dialog = page.getByRole("dialog", { name: "Back up to GitHub" });
		await expect(dialog).toContainText("Anyone who can read the repository");
		await dialog.getByLabel("Repository").fill("fake.tack/demo/backups");
		await dialog.getByRole("radio", { name: "Every hour" }).click();
		await dialog.getByRole("button", { name: "Turn on backups" }).click();
		await expect(dialog.getByRole("status").first()).toContainText(
			"Backed up just now to fake.tack/demo/backups",
		);
		await expect(dialog.getByRole("link", { name: "See the commit" })).toHaveAttribute(
			"href",
			/^https:\/\/fake\.tack\/demo\/backups\/commit\//,
		);
		await dialog.getByRole("button", { name: "Back up now" }).click();
		await expect(dialog.getByRole("status").first()).toContainText("Backed up just now");

		// A branch the forge refuses: said in words.
		await dialog.getByLabel("Branch").fill("fail-here");
		await dialog.getByRole("button", { name: "Save changes" }).click();
		await expect(dialog.getByRole("status").first()).toContainText("didn’t work");

		await dialog.getByRole("button", { name: "Turn off backups" }).click();
		await expect(dialog.getByRole("button", { name: "Turn on backups" })).toBeVisible();
	});

	test("others on the board can export, but only its owner backs up", async ({ page }) => {
		await page.goto(`/auth/dev?login=${login}&return_to=/`);
		await page
			.getByRole("link", { name: new RegExp(`Imported retro ${run}`) })
			.first()
			.click();
		const url = page.url();
		await page.goto(
			`/auth/dev?login=${login}-viewer&return_to=${encodeURIComponent(new URL(url).pathname)}`,
		);
		// Open to everyone on this Tack before setup: editors, so try the menu as one.
		await page.getByRole("button", { name: "Board menu" }).click();
		await expect(page.getByRole("menuitem", { name: /^Export/ })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Back up to GitHub…" })).toHaveCount(0);
		await page.getByRole("menuitem", { name: /^Export/ }).click();
		await expect(page.getByRole("dialog", { name: "Export" })).toBeVisible();
	});
});
