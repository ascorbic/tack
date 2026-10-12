import type { Browser, Page } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Images on boards: pasted, dropped and picked, uploaded while everyone
// watches, resized keeping their proportions, undone and redone, and seen by
// a second person on a real board.

/** Image shapes in the board's document. */
async function images(page: Page, global = "tackPlayground"): Promise<Record<string, unknown>[]> {
	return page.evaluate((name) => {
		const holder = (window as unknown as Record<string, { doc: import("yjs").Doc }>)[name];
		if (!holder) return [];
		return [...holder.doc.getMap<import("yjs").Map<unknown>>("shapes").values()]
			.map((shape) => shape.toJSON() as Record<string, unknown>)
			.filter((shape) => shape.type === "image");
	}, global);
}

/** Make picture files in the page, and hand them to `deliver` (a paste, a drop). */
async function withFiles(
	page: Page,
	sizes: [number, number][],
	deliver: "paste" | "drop",
	type = "image/png",
): Promise<void> {
	await page.evaluate(
		async ({ sizes, deliver, type }) => {
			const files: File[] = [];
			for (const [i, [w, h]] of sizes.entries()) {
				let blob: Blob;
				if (type === "image/svg+xml") {
					blob = new Blob(
						[
							`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#3b4cca"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="#ffd85c"/></svg>`,
						],
						{ type },
					);
				} else {
					const canvas = document.createElement("canvas");
					canvas.width = w;
					canvas.height = h;
					const g = canvas.getContext("2d") as CanvasRenderingContext2D;
					g.fillStyle = ["#e5533d", "#3b4cca", "#1f7a6b", "#ffd85c"][i % 4] as string;
					g.fillRect(0, 0, w, h);
					g.fillStyle = "#fff";
					g.fillRect(w / 4, h / 4, w / 2, h / 2);
					blob = await new Promise<Blob>((resolve) =>
						canvas.toBlob((b) => resolve(b as Blob), type),
					);
				}
				files.push(new File([blob], `picture-${i}.${type.split("/")[1]}`, { type }));
			}
			const data = new DataTransfer();
			for (const file of files) data.items.add(file);
			if (deliver === "paste") {
				document
					.querySelector(".react-flow")
					?.dispatchEvent(
						new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
					);
			} else {
				const canvas = document.querySelector(".canvas") as HTMLElement;
				const box = canvas.getBoundingClientRect();
				const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
				for (const kind of ["dragenter", "dragover", "drop"]) {
					canvas.dispatchEvent(
						new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true, ...at }),
					);
				}
			}
		},
		{ sizes, deliver, type },
	);
}

/** An image shape's box, as tests read it. */
interface Size {
	w: number;
	h: number;
}

const ready = (page: Page) => page.locator(".image-node[data-state='ready']:not([data-uploading])");

/** Every image's file is stored, and none says it's uploading. */
async function uploaded(page: Page, count: number, global = "tackPlayground"): Promise<void> {
	await expect
		.poll(
			async () =>
				(await images(page, global)).filter(
					(shape) => typeof shape.image === "string" && !shape.upload,
				).length,
			{ timeout: 15_000 },
		)
		.toBe(count);
}

test.describe("images in the playground", () => {
	test.beforeEach(async ({ page }) => {
		await openScenario(page, "empty");
	});

	test("a pasted screenshot uploads, then shows its file", async ({ page }) => {
		await page.evaluate(() => Object.assign(window, { tackImageDelay: 2500 }));
		await withFiles(page, [[1600, 1000]], "paste");
		const node = page.locator(".image-node");
		await expect(node).toHaveCount(1);
		// Yours fills in as it goes up.
		await expect(node.locator(".image-progress")).toBeVisible();
		await uploaded(page, 1);
		await expect(ready(page)).toHaveCount(1, { timeout: 10_000 });
		await expect(node.locator(".image-progress")).toHaveCount(0);
		const [shape] = await images(page);
		expect(shape?.image).toMatch(/^[0-9a-f]{64}$/);
		expect(shape?.upload).toBeUndefined();
		expect(shape?.preview).toBeUndefined();
		// Placed at its proportions.
		expect(Number(shape?.w) / Number(shape?.h)).toBeCloseTo(1.6, 1);

		// Alt text, from Enter on the selected image.
		await page.keyboard.press("Enter");
		const field = page.getByRole("textbox", { name: "Alt text" });
		await expect(field).toBeFocused();
		await page.keyboard.type("A red square with a white one inside");
		await page.keyboard.press("Enter");
		await expect(field).toBeHidden();
		expect((await images(page))[0]?.alt).toBe("A red square with a white one inside");
		await page.getByRole("switch", { name: "Caption" }).click();
		await expect(page.locator(".image-caption")).toHaveText("A red square with a white one inside");
	});

	test("files dropped together land in a tidy grid, as one undo step", async ({ page }) => {
		await withFiles(
			page,
			[
				[800, 600],
				[600, 800],
				[900, 900],
				[1200, 500],
			],
			"drop",
		);
		await expect(ready(page)).toHaveCount(4, { timeout: 10_000 });
		await uploaded(page, 4);
		const shapes = await images(page);
		const boxes = shapes.map((s) => ({
			x: Number(s.x),
			y: Number(s.y),
			w: Number(s.w),
			h: Number(s.h),
		}));
		// Two rows of two, none overlapping.
		expect(new Set(boxes.map((b) => b.y)).size).toBe(2);
		for (const [i, a] of boxes.entries()) {
			for (const b of boxes.slice(i + 1)) {
				const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
				expect(apart).toBe(true);
			}
		}
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await page.keyboard.press(`${modifier}+z`);
		await expect(page.locator(".image-node")).toHaveCount(0);
		await page.keyboard.press(`${modifier}+Shift+z`);
		await expect(ready(page)).toHaveCount(4);
		await uploaded(page, 4);
	});

	test("undone while it uploads, then redone, it still arrives", async ({ page }) => {
		await page.evaluate(() => Object.assign(window, { tackImageDelay: 2500 }));
		await withFiles(page, [[800, 600]], "paste");
		await expect(page.locator(".image-node")).toHaveCount(1);
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		console.log(
			"before undo",
			JSON.stringify(await images(page)).slice(0, 300),
			await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200)),
		);
		await page.keyboard.press(`${modifier}+z`);
		console.log("after undo", (await images(page)).length);
		await expect(page.locator(".image-node")).toHaveCount(0);
		// The upload finishes while it's gone…
		await page.waitForTimeout(3000);
		await page.keyboard.press(`${modifier}+Shift+z`);
		// …and it comes back showing its file, not stuck uploading.
		await uploaded(page, 1);
		await expect(ready(page)).toHaveCount(1);
	});

	test("the toolbar's Image picks files, and an SVG is drawn into a picture", async ({ page }) => {
		const chooser = page.waitForEvent("filechooser");
		await page
			.getByRole("toolbar", { name: "Tools" })
			.getByRole("button", { name: "Image" })
			.click();
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#ffd85c"/><script>alert(1)</script></svg>`;
		await (
			await chooser
		).setFiles({
			name: "drawing.svg",
			mimeType: "image/svg+xml",
			buffer: Buffer.from(svg),
		});
		await expect(ready(page)).toHaveCount(1, { timeout: 10_000 });
		const [shape] = await images(page);
		// Never stored as SVG: drawn into a PNG, at least 1024 pixels across.
		expect(shape?.mime).toBe("image/png");
		expect(Number(shape?.iw)).toBeGreaterThanOrEqual(1024);
		expect(Number(shape?.iw) / Number(shape?.ih)).toBeCloseTo(1.5, 1);
	});

	test("resizing keeps its proportions, unless Shift's held", async ({ page }) => {
		await withFiles(page, [[1200, 600]], "paste");
		await expect(ready(page)).toHaveCount(1, { timeout: 10_000 });
		await settleCanvas(page);
		const grip = page.locator(".react-flow__node-image .section-resize[data-handle='se']");
		const before = (await images(page))[0] as unknown as Size;
		const at = (await grip.boundingBox()) as {
			x: number;
			y: number;
			width: number;
			height: number;
		};
		const from = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x + 120, from.y + 10, { steps: 8 });
		await page.mouse.up();
		const after = (await images(page))[0] as unknown as Size;
		expect(after.w).toBeGreaterThan(before.w);
		expect(after.w / after.h).toBeCloseTo(before.w / before.h, 1);

		// Free, with Shift: it goes where it's pulled (from the left, clear of the playground's panel).
		const left = page.locator(".react-flow__node-image .section-resize[data-handle='sw']");
		const at2 = (await left.boundingBox()) as {
			x: number;
			y: number;
			width: number;
			height: number;
		};
		const from2 = { x: at2.x + at2.width / 2, y: at2.y + at2.height / 2 };
		await page.mouse.move(from2.x, from2.y);
		await page.mouse.down();
		await page.keyboard.down("Shift");
		await page.mouse.move(from2.x, from2.y + 150, { steps: 8 });
		await page.mouse.up();
		await page.keyboard.up("Shift");
		const free = (await images(page))[0] as unknown as Size;
		expect(free.w).toBeCloseTo(after.w, 0);
		expect(free.h).toBeGreaterThan(after.h + 100);
		// And back to its own proportions from its toolbar.
		await page.getByRole("button", { name: "Original proportions" }).click();
		const restored = (await images(page))[0] as unknown as Size;
		expect(restored.w / restored.h).toBeCloseTo(2, 1);
	});

	test("files that aren't pictures are refused in words", async ({ page }) => {
		await page.evaluate(() => {
			const data = new DataTransfer();
			data.items.add(new File(["just text"], "notes.txt", { type: "text/plain" }));
			const canvas = document.querySelector(".canvas") as HTMLElement;
			for (const kind of ["dragover", "drop"]) {
				canvas.dispatchEvent(
					new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true }),
				);
			}
		});
		await expect(page.locator(".toasts")).toContainText("PNG, JPEG, GIF, WebP, AVIF and SVG");
		await expect(page.locator(".image-node")).toHaveCount(0);
	});

	test("the moodboard shows every state", async ({ page }) => {
		await openScenario(page, "images");
		await expect(ready(page)).toHaveCount(2, { timeout: 10_000 });
		await expect(page.locator(".image-node[data-state='uploading']")).toContainText(
			"Uploading · Priya Shah",
		);
		await expect(page.locator(".image-node[data-state='interrupted']")).toContainText(
			"The upload didn’t finish",
		);
		await expect(page.locator(".image-node[data-state='missing']")).toContainText(
			"The old logo, retired in 2025",
		);
		await expect(page.locator(".image-caption")).toContainText("Tack’s mark");
	});
});

// A real board, signed in through the dev server's fake sign-in.

const run = Date.now().toString(36);

async function signedIn(browser: Browser, login: string): Promise<Page> {
	const page = await (await browser.newContext()).newPage();
	await page.route("https://github.com/**", (route) => route.abort());
	await page.goto(`/auth/dev?login=${login}&return_to=/`);
	return page;
}

test("a second person sees a pasted image arrive, served by the board", async ({ browser }) => {
	const owner = await signedIn(browser, `e2e-img-${run}`);
	const other = await signedIn(browser, `e2e-img2-${run}`);
	const board = await owner.evaluate(async (friend) => {
		const response = await fetch("/api/boards", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Pictures", visibility: "private" }),
		});
		const made = (await response.json()) as { id: string; slug: string };
		await fetch(`/api/boards/${made.id}/members`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ logins: [friend], role: "editor" }),
		});
		return made;
	}, `e2e-img2-${run}`);
	const path = `/b/${board.id}/${board.slug}`;
	await owner.goto(path);
	await expect(owner.getByRole("toolbar", { name: "Tools" })).toBeVisible({ timeout: 15_000 });
	await other.goto(path);
	await expect(other.getByRole("toolbar", { name: "Tools" })).toBeVisible({ timeout: 15_000 });
	await settleCanvas(owner);

	await withFiles(owner, [[1400, 900]], "paste");
	await uploaded(owner, 1, "tackBoard");
	await expect(ready(owner)).toHaveCount(1, { timeout: 15_000 });
	const [shape] = await images(owner, "tackBoard");
	expect(shape?.image).toMatch(/^[0-9a-f]{64}$/);

	// The other person's board shows it, loaded from the board's own address.
	await expect(ready(other)).toHaveCount(1, { timeout: 15_000 });
	const loaded = other.locator(".image-file[data-loaded]");
	await expect(loaded).toHaveAttribute(
		"src",
		`/api/boards/${board.id}/images/${String(shape?.image)}`,
	);
	expect(await loaded.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1400);

	// Copied to another board of the owner's, its file comes too, to that board's own address.
	const copied = await owner.evaluate(() => {
		const data = new DataTransfer();
		document
			.querySelector(".react-flow")
			?.dispatchEvent(
				new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
			);
		return data.getData("application/x-tack+json");
	});
	expect(copied).toContain(String(shape?.image));
	const second = await owner.evaluate(async () => {
		const response = await fetch("/api/boards", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "More pictures", visibility: "private" }),
		});
		return (await response.json()) as { id: string; slug: string };
	});
	await owner.goto(`/b/${second.id}/${second.slug}`);
	await expect(owner.getByRole("toolbar", { name: "Tools" })).toBeVisible({ timeout: 15_000 });
	await settleCanvas(owner);
	await owner.evaluate((json) => {
		const data = new DataTransfer();
		data.setData("application/x-tack+json", json);
		document
			.querySelector(".react-flow")
			?.dispatchEvent(
				new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
			);
	}, copied);
	await uploaded(owner, 1, "tackBoard");
	await expect(owner.locator(".image-file[data-loaded]")).toHaveAttribute(
		"src",
		`/api/boards/${second.id}/images/${String(shape?.image)}`,
	);

	// Someone signed out can't fetch it.
	const response = await (
		await browser.newContext()
	).request.get(
		new URL(`/api/boards/${board.id}/images/${String(shape?.image)}`, owner.url()).toString(),
	);
	expect(response.status()).toBe(404);
});
