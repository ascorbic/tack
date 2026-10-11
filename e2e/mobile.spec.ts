import { type Locator, type Page, devices } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Phones and tablets (#67), under Playwright's mobile emulation in
// Chromium (the project's only browser): an iPhone's viewport, touch and
// user agent for the phone's board (tap a shape into a sheet, vote, comment,
// write stickies, pinch and pan), and an iPad's for editing with a finger and
// a pencil. Multi-finger gestures go through the DevTools protocol, which
// Playwright's touchscreen (taps only) doesn't cover.

// The devices' own browser is WebKit; keep the project's Chromium.
const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices["iPhone 13"];
const { defaultBrowserType: _tabletBrowser, ...iPad } = devices["iPad Pro 11"];

type Point = [number, number];

/** Fingers on the screen, through the DevTools protocol. */
async function fingers(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	const send = (type: string, points: Point[]) =>
		cdp.send("Input.dispatchTouchEvent", {
			type: type as "touchStart",
			touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
		});
	return {
		cdp,
		/** Put fingers down, move each by its own offset in steps, and lift them. */
		gesture: async (from: Point[], by: Point[], steps = 10, hold = 0) => {
			await send("touchStart", from);
			if (hold) await page.waitForTimeout(hold);
			for (let i = 1; i <= steps; i++) {
				await send(
					"touchMove",
					from.map(([x, y], n) => [
						x + ((by[n]?.[0] ?? 0) * i) / steps,
						y + ((by[n]?.[1] ?? 0) * i) / steps,
					]),
				);
				await page.waitForTimeout(16);
			}
			await send("touchEnd", []);
		},
		tap: async ([x, y]: Point) => {
			await send("touchStart", [[x, y]]);
			await send("touchEnd", []);
		},
		longPress: async ([x, y]: Point) => {
			await send("touchStart", [[x, y]]);
			await page.waitForTimeout(700);
			await send("touchEnd", []);
		},
	};
}

async function centre(locator: Locator): Promise<Point> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("not on screen");
	return [box.x + box.width / 2, box.y + box.height / 2];
}

/** A point on the empty board, clear of shapes and chrome. */
async function emptySpot(page: Page): Promise<Point> {
	const spot = await page.evaluate(() => {
		const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
		if (!pane) return null;
		for (let y = pane.top + 80; y < pane.bottom - 140; y += 23) {
			for (let x = pane.left + 40; x < pane.right - 80; x += 23) {
				const hit = document.elementFromPoint(x, y);
				if (hit?.classList.contains("react-flow__pane")) return [x, y] as [number, number];
			}
		}
		return null;
	});
	if (!spot) throw new Error("no empty spot on the board");
	return spot;
}

/** The middle of a shape a finger would land on: on screen, and not under anything. */
async function shapeOnScreen(page: Page, type = "sticky"): Promise<Point> {
	const spot = await page.evaluate((type) => {
		const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
		for (const node of document.querySelectorAll(`.react-flow__node-${type}`)) {
			const box = node.getBoundingClientRect();
			const at: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
			const inside =
				pane &&
				at[0] > pane.left &&
				at[0] < pane.right &&
				at[1] > pane.top &&
				at[1] < pane.bottom - 120;
			if (inside && node.contains(document.elementFromPoint(...at))) return at;
		}
		return null;
	}, type);
	if (!spot) throw new Error(`no ${type} on screen`);
	return spot;
}

function viewport(page: Page) {
	return page.locator(".react-flow__viewport").evaluate((element) => {
		const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
			(element as HTMLElement).style.transform,
		);
		return { x: Number(match?.[1]), y: Number(match?.[2]), zoom: Number(match?.[3]) };
	});
}

/** The playground's document, read as everyone would have it. */
function shapeTexts(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const doc = (window as unknown as { tackPlayground: { doc: import("yjs").Doc } }).tackPlayground
			.doc;
		const shapes = doc.getMap("shapes").toJSON() as Record<string, { text?: string }>;
		return Object.values(shapes).flatMap((shape) => (shape.text ? [shape.text] : []));
	});
}

const sticky = (page: Page, text: string) =>
	page.locator(".react-flow__node-sticky").filter({ hasText: text });

test.describe("on a phone", () => {
	test.use(iPhone);

	test("the board is to look around: no toolbar, a + and nothing off the side", async ({
		page,
	}) => {
		await openScenario(page, "comments");
		await expect(page.locator(".app")).toHaveAttribute("data-phone", "true");
		await expect(page.getByRole("toolbar", { name: "Tools" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Add a sticky" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Show the whole board" })).toBeVisible();
		// The playground's controls fold away, to leave the board.
		await expect(page.locator(".play-panel")).toHaveAttribute("data-folded", "true");
		// The top bar fits, its tools folded into More.
		await expect(page.getByRole("button", { name: "More tools" })).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		// The Comments panel takes the width of the screen.
		await page.getByRole("button", { name: "More tools" }).tap();
		await page
			.locator(".topbar-tools")
			.getByRole("button", { name: /Comments/ })
			.tap();
		const panel = page.locator(".comments-panel");
		await expect(panel).toBeVisible();
		const box = await panel.boundingBox();
		expect(box?.width).toBeGreaterThan(350);
	});

	test("tapping a shape opens it in a sheet, with its comments to read and answer", async ({
		page,
	}) => {
		await openScenario(page, "comments");
		const card = page.locator(".react-flow__node-card").filter({ hasText: "Drop Node 18" });
		await card.tap();
		const sheet = page.getByRole("dialog", { name: "Card" });
		await expect(sheet).toBeVisible();
		await expect(sheet.locator(".card")).toContainText("Drop Node 18 support");
		// The shape stays in sight above the sheet, ringed.
		await expect(card).toHaveClass(/sheet-open/);
		await expect(card).toBeInViewport();

		// Its thread, then a reply.
		await sheet.locator(".sheet-thread").first().tap();
		const thread = page.getByRole("dialog", { name: "Comment" });
		await expect(thread).toContainText("Is this still blocked on the CI matrix change?");
		await thread.getByRole("combobox", { name: "Reply" }).fill("On it from my phone");
		await thread.getByRole("combobox", { name: "Reply" }).press("Enter");
		await expect(thread).toContainText("On it from my phone");
		// Back to the card, and a new comment on it.
		await thread.locator(".sheet-back").tap();
		await expect(page.getByRole("dialog", { name: "Card" })).toBeVisible();
		await sheet.getByRole("combobox", { name: "Add a comment" }).fill("Phones can comment too");
		await sheet.getByRole("combobox", { name: "Add a comment" }).press("Enter");
		await expect(sheet.locator(".sheet-thread")).toHaveCount(2);
		await expect(sheet).toContainText("Phones can comment too");

		// Tapping the empty board puts it away.
		const { tap } = await fingers(page);
		await tap(await emptySpot(page));
		await expect(page.getByRole("dialog", { name: "Card" })).toHaveCount(0);
	});

	test("dot votes and stamps from the sheet", async ({ page }) => {
		await openScenario(page, "vote");
		await sticky(page, "A provider playground").tap();
		const sheet = page.getByRole("dialog", { name: "Shape" });
		await expect(sheet.getByRole("region", { name: "Dot vote" })).toBeVisible();
		const mine = sheet.getByLabel(/Your dots here/);
		await expect(mine).toHaveText("0");
		await sheet.getByRole("button", { name: "Add a dot" }).tap();
		await expect(mine).toHaveText("1");
		await sheet.getByRole("button", { name: "Add a dot" }).tap();
		await expect(mine).toHaveText("2");
		await sheet.getByRole("button", { name: "Take a dot back" }).tap();
		await expect(mine).toHaveText("1");
		// On the board too, in your colour.
		await expect(sticky(page, "A provider playground").locator("xpath=..")).toBeVisible();
		await expect(page.locator(".vote-dots-anchor .vote-dot[data-mine=true]")).toHaveCount(1);
		// A stamp, and taking it back.
		const thumbs = sheet.getByRole("button", { name: /^👍/ });
		await thumbs.tap();
		await expect(thumbs).toHaveAttribute("aria-pressed", "true");
		await thumbs.tap();
		await expect(thumbs).toHaveAttribute("aria-pressed", "false");
		await sheet.getByRole("button", { name: "Close" }).tap();
		await expect(sheet).toHaveCount(0);
	});

	test("a decision's vote from the sheet", async ({ page }) => {
		await openScenario(page, "decisions");
		await page.getByTestId("rf__node-decision-node-20").tap();
		const decision = page.getByRole("dialog", { name: "Shape" });
		const agree = decision.getByRole("group", { name: "Your vote" }).getByRole("button", {
			name: /Agree/,
		});
		const before = Number(await agree.locator(".sheet-choice-count").textContent());
		await agree.tap();
		await expect(agree).toHaveAttribute("aria-pressed", "true");
		await expect(agree.locator(".sheet-choice-count")).toHaveText(String(before + 1));
		await agree.tap();
		await expect(agree).toHaveAttribute("aria-pressed", "false");
	});

	test("the + writes stickies, one after another, in the middle of the view", async ({ page }) => {
		await openScenario(page, "retro");
		const count = await page.locator(".react-flow__node-sticky").count();
		await page.getByRole("button", { name: "Add a sticky" }).tap();
		const pad = page.getByRole("dialog", { name: "New sticky" });
		await expect(pad.getByRole("textbox")).toBeFocused();
		await pad.getByRole("radio", { name: "Pink" }).tap();
		await pad.getByRole("textbox").fill("Ship the phone view");
		await pad.getByRole("button", { name: "Add", exact: true }).tap();
		await expect(pad.getByRole("textbox")).toHaveValue("");
		await pad.getByRole("textbox").fill("And the tablet one");
		await pad.getByRole("textbox").press("Enter");
		await expect(pad).toContainText("2 added");
		await expect(page.locator(".react-flow__node-sticky")).toHaveCount(count + 2);
		expect(await shapeTexts(page)).toEqual(
			expect.arrayContaining(["Ship the phone view", "And the tablet one"]),
		);
		await expect(sticky(page, "Ship the phone view").locator(".sticky")).toHaveAttribute(
			"data-color",
			"pink",
		);
		await pad.getByRole("button", { name: "Close" }).tap();
		await expect(pad).toHaveCount(0);
		await expect(sticky(page, "Ship the phone view")).toBeInViewport();
	});

	test("pinch zooms, and one or two fingers pan, without opening anything", async ({ page }) => {
		await openScenario(page, "retro");
		const { gesture } = await fingers(page);
		// One finger pans, even starting on a shape.
		const first = await viewport(page);
		await gesture([await shapeOnScreen(page)], [[-70, 0]]);
		await settleCanvas(page);
		const start = await viewport(page);
		expect(first.x - start.x).toBeGreaterThan(40);
		const [x, y] = await emptySpot(page);
		// Pinch out: zoom in.
		await gesture(
			[
				[x - 30, y],
				[x + 30, y],
			],
			[
				[-60, 0],
				[60, 0],
			],
		);
		await settleCanvas(page);
		const zoomed = await viewport(page);
		expect(zoomed.zoom).toBeGreaterThan(start.zoom * 1.4);
		// Two fingers together pan.
		await gesture(
			[
				[x - 30, y],
				[x + 30, y],
			],
			[
				[0, 80],
				[0, 80],
			],
		);
		const panned = await viewport(page);
		expect(panned.y - zoomed.y).toBeGreaterThan(40);
		expect(panned.zoom).toBeCloseTo(zoomed.zoom, 1);
		await expect(page.getByRole("dialog")).toHaveCount(0);
	});

	test("a sheet goes away dragged down by its grip", async ({ page }) => {
		await openScenario(page, "retro");
		const { gesture, tap } = await fingers(page);
		await tap(await shapeOnScreen(page));
		const sheet = page.getByRole("dialog", { name: "Shape" });
		await expect(sheet).toBeVisible();
		// Once it's finished rising.
		await sheet.evaluate((element) =>
			Promise.all(element.getAnimations().map((animation) => animation.finished)),
		);
		const grip = await centre(sheet.locator(".sheet-grip"));
		// A little way, slowly: it springs back.
		await gesture([grip], [[0, 40]], 12);
		await expect(sheet).toBeVisible();
		// Further: it goes.
		await gesture([grip], [[0, 320]], 10);
		await expect(sheet).toHaveCount(0);
	});

	test("view only: no +, and no voting, but comments still read", async ({ page }) => {
		await openScenario(page, "vote");
		await page.getByRole("button", { name: "Playground" }).tap();
		await page.getByLabel("Playground controls").getByLabel("View only").check();
		await page.getByRole("button", { name: "Playground" }).tap();
		await expect(page.getByRole("button", { name: "Add a sticky" })).toHaveCount(0);
		await sticky(page, "A provider playground").tap();
		const sheet = page.getByRole("dialog", { name: "Shape" });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole("region", { name: "Dot vote" })).toHaveCount(0);
		await expect(sheet.getByRole("group", { name: "Stamps" })).toHaveCount(0);
		await expect(sheet.getByRole("region", { name: "Comments" })).toBeVisible();
	});
});

test.describe("on a tablet", () => {
	test.use(iPad);

	test("a finger selects, drags and reaches the action bar; long-press selects several", async ({
		page,
	}) => {
		await openScenario(page, "brainstorm");
		await expect(page.locator(".app")).toHaveAttribute("data-touch", "true");
		await expect(page.locator(".app")).not.toHaveAttribute("data-phone", "true");
		await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
		const { gesture, tap, longPress } = await fingers(page);
		const stickies = page.locator(".react-flow__node-sticky");
		const selected = page.locator(".react-flow__node.selected");

		await tap(await centre(stickies.nth(0)));
		await expect(selected).toHaveCount(1);
		// The action bar, at a finger's size.
		const action = page.locator(".selection-actions .selection-action").first();
		await expect(action).toBeVisible();
		// Once it's finished arriving (it grows in).
		await expect.poll(async () => (await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);

		// Dragging moves it.
		const before = await stickies.nth(0).evaluate((el) => (el as HTMLElement).style.transform);
		await gesture([await centre(stickies.nth(0))], [[60, 40]]);
		await expect
			.poll(() => stickies.nth(0).evaluate((el) => (el as HTMLElement).style.transform))
			.not.toBe(before);

		// A long-press adds another, and from then on taps add or take out.
		await longPress(await centre(stickies.nth(3)));
		await expect(selected).toHaveCount(2);
		const pill = page.getByRole("status").filter({ hasText: "selected" });
		await expect(pill).toContainText("2 selected");
		await tap(await centre(stickies.nth(5)));
		await expect(selected).toHaveCount(3);
		await tap(await centre(stickies.nth(3)));
		await expect(selected).toHaveCount(2);
		await pill.getByRole("button", { name: "Done" }).tap();
		await expect(pill).toHaveCount(0);
		await expect(selected).toHaveCount(2);
		// Back to a tap choosing one.
		await tap(await centre(stickies.nth(5)));
		await expect(selected).toHaveCount(1);
		// A finger on the empty board pans, and doesn't draw a box.
		const start = await viewport(page);
		const spot = await emptySpot(page);
		await gesture([spot], [[-80, -40]]);
		const moved = await viewport(page);
		expect(Math.abs(moved.x - start.x)).toBeGreaterThan(40);
	});

	test("a pencil draws a selection box", async ({ page }) => {
		await openScenario(page, "brainstorm");
		const { cdp } = await fingers(page);
		// Two stickies side by side, all on screen, with the board just above and left of them.
		const box = await page.evaluate(() => {
			const pane = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
			if (!pane) return null;
			const boxes = [...document.querySelectorAll(".react-flow__node-sticky")]
				.map((node) => node.getBoundingClientRect())
				.filter(
					(b) => b.left > pane.left + 20 && b.top > pane.top + 20 && b.right < pane.right - 20,
				)
				.sort((a, b) => a.top - b.top || a.left - b.left);
			for (const a of boxes) {
				for (const b of boxes) {
					if (a === b || b.left <= a.right || Math.abs(b.top - a.top) > 40) continue;
					const from: [number, number] = [a.left - 12, Math.min(a.top, b.top) - 12];
					const hit = document.elementFromPoint(...from);
					if (!hit?.classList.contains("react-flow__pane")) continue;
					const to: [number, number] = [b.right - 20, Math.max(a.bottom, b.bottom) - 20];
					return { from, to };
				}
			}
			return null;
		});
		if (!box) throw new Error("no two stickies side by side");
		const { from, to } = box;
		const pen = (type: string, [x, y]: Point, buttons = 1) =>
			cdp.send("Input.dispatchMouseEvent", {
				type: type as "mousePressed",
				x,
				y,
				button: "left",
				buttons,
				clickCount: 1,
				pointerType: "pen",
			});
		await pen("mouseMoved", from, 0);
		await pen("mousePressed", from);
		for (let i = 1; i <= 10; i++) {
			await pen("mouseMoved", [
				from[0] + ((to[0] - from[0]) * i) / 10,
				from[1] + ((to[1] - from[1]) * i) / 10,
			]);
		}
		await pen("mouseReleased", to, 0);
		await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
	});

	test("500 cards pinch-zoom and pan smoothly enough", async ({ page }) => {
		test.slow();
		await openScenario(page, "stress");
		const { gesture } = await fingers(page);
		const spot = await emptySpot(page).catch((): Point => [400, 600]);
		// Frame times while pinching in and out and panning, for about two seconds.
		await page.evaluate(() => {
			const frames: number[] = [];
			let last = performance.now();
			const tick = (now: number) => {
				frames.push(now - last);
				last = now;
				(window as unknown as { __frames: number[] }).__frames = frames;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		for (const spread of [80, -60, 60, -80]) {
			await gesture(
				[
					[spot[0] - 40, spot[1]],
					[spot[0] + 40, spot[1]],
				],
				[
					[-spread, 20],
					[spread, 20],
				],
				20,
			);
		}
		await gesture([spot], [[-200, -120]], 20);
		const frames = await page.evaluate(() =>
			(window as unknown as { __frames: number[] }).__frames.slice(2),
		);
		frames.sort((a, b) => a - b);
		const median = frames[Math.floor(frames.length / 2)] ?? Infinity;
		const p95 = frames[Math.floor(frames.length * 0.95)] ?? Infinity;
		test.info().annotations.push({
			type: "frames",
			description: `${frames.length} frames, median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
		});
		console.log(`500 cards on a tablet: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
		// A floor that only a real regression would hit under a busy test run.
		expect(median).toBeLessThan(50);
	});
});
