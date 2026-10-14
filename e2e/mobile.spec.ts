import { deflateSync } from "node:zlib";
import { type Locator, type Page, devices } from "@playwright/test";
import { expect, openScenario, settleCanvas, test } from "./fixtures.ts";

// Phones and tablets (#67), under Playwright's mobile emulation: an
// iPhone's viewport, touch and user agent for the phone's board (tap a shape
// into a sheet, vote, comment, write stickies, pinch and pan), and an iPad's
// for editing with a finger and a pencil. In Chromium, fingers and the pencil
// go through the DevTools protocol, which Playwright's touchscreen (taps
// only) doesn't cover; in WebKit, which has no such protocol, they're
// pointer and touch events dispatched in the page, as Safari sends them.

// The devices' own browser is WebKit; keep the project's browser.
const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices["iPhone 13"];
const { defaultBrowserType: _tabletBrowser, ...iPad } = devices["iPad Pro 11"];

type Point = [number, number];

interface Fingers {
	/** Put fingers down, move each by its own offset in steps, and lift them. */
	gesture: (from: Point[], by: Point[], steps?: number, hold?: number) => Promise<void>;
	tap: (at: Point) => Promise<void>;
	longPress: (at: Point) => Promise<void>;
	/** Draw a line with a pencil. */
	pencil: (from: Point, to: Point, steps?: number) => Promise<void>;
}

/** Fingers (and a pencil) on the screen, however this browser takes them. */
async function fingers(page: Page, browserName: string): Promise<Fingers> {
	const send = browserName === "chromium" ? await devtoolsInput(page) : await pageInput(page);
	return {
		gesture: async (from, by, steps = 10, hold = 0) => {
			await send.touch("touchStart", from);
			if (hold) await page.waitForTimeout(hold);
			for (let i = 1; i <= steps; i++) {
				await send.touch(
					"touchMove",
					from.map(([x, y], n) => [
						x + ((by[n]?.[0] ?? 0) * i) / steps,
						y + ((by[n]?.[1] ?? 0) * i) / steps,
					]),
				);
				await page.waitForTimeout(16);
			}
			await send.touch("touchEnd", []);
		},
		tap: async (at) => {
			await send.touch("touchStart", [at]);
			await send.touch("touchEnd", []);
		},
		longPress: async (at) => {
			await send.touch("touchStart", [at]);
			await page.waitForTimeout(700);
			await send.touch("touchEnd", []);
		},
		pencil: async (from, to, steps = 10) => {
			await send.pen("move", from, 0);
			await send.pen("down", from, 1);
			for (let i = 1; i <= steps; i++) {
				await send.pen(
					"move",
					[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps],
					1,
				);
			}
			await send.pen("up", to, 0);
		},
	};
}

type TouchType = "touchStart" | "touchMove" | "touchEnd";
type PenType = "down" | "move" | "up";
interface Input {
	/** Where every finger on the screen is now (none: all lifted). */
	touch: (type: TouchType, points: Point[]) => Promise<void>;
	pen: (type: PenType, at: Point, buttons: number) => Promise<void>;
}

/** Chromium: real input, through the DevTools protocol. */
async function devtoolsInput(page: Page): Promise<Input> {
	const cdp = await page.context().newCDPSession(page);
	const pens = { down: "mousePressed", move: "mouseMoved", up: "mouseReleased" } as const;
	return {
		touch: async (type, points) => {
			await cdp.send("Input.dispatchTouchEvent", {
				type,
				touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })),
			});
		},
		pen: async (type, [x, y], buttons) => {
			await cdp.send("Input.dispatchMouseEvent", {
				type: pens[type],
				x,
				y,
				button: "left",
				buttons,
				clickCount: 1,
				pointerType: "pen",
			});
		},
	};
}

/**
 * WebKit: the events Safari sends for fingers and a pencil, dispatched in
 * the page. Each finger's pointer and touch events go to what it first
 * touched (as a touch's are captured), and a tap that moved no further
 * than a press may, and wasn't cancelled, is followed by the mouse events
 * and click Safari sends after one (however long it was held). The page can't capture pointers the browser
 * doesn't know of, so asking to is let through for these.
 */
async function pageInput(page: Page): Promise<Input> {
	await page.evaluate(() => {
		const FIRST_ID = 1000;
		const PEN_ID = 999_999;
		const owner = window as unknown as { tackFingers?: unknown };
		if (owner.tackFingers) return;
		for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
			const original = Reflect.get(Element.prototype, name) as Element[typeof name];
			Element.prototype[name] = function (this: Element, id: number) {
				if (id < FIRST_ID) original.call(this, id);
			};
		}
		type Finger = {
			id: number;
			target: Element;
			x: number;
			y: number;
			from: Point;
			cancelled: boolean;
		};
		type Point = [number, number];
		let down: Finger[] = [];
		let next = 0;
		const pointer = (
			type: string,
			target: Element,
			id: number,
			[x, y]: Point,
			options: { pointerType: string; isPrimary: boolean; buttons: number },
		) =>
			target.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: type !== "pointerenter" && type !== "pointerleave",
					composed: true,
					view: window,
					pointerId: id,
					clientX: x,
					clientY: y,
					screenX: x,
					screenY: y,
					button: type === "pointermove" ? -1 : 0,
					width: 8,
					height: 8,
					pressure: options.buttons ? 0.5 : 0,
					...options,
				}),
			);
		const mouse = (type: string, target: Element, [x, y]: Point, buttons: number) =>
			target.dispatchEvent(
				new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					composed: true,
					view: window,
					clientX: x,
					clientY: y,
					screenX: x,
					screenY: y,
					button: 0,
					buttons,
					detail: 1,
				}),
			);
		// WebKit makes Touches the old way only (its Touch constructor is iOS's).
		const doc = document as Document & {
			createTouch(...args: unknown[]): Touch;
			createTouchList(...touches: Touch[]): TouchList;
		};
		const touchOf = (finger: Finger) =>
			doc.createTouch(
				window,
				finger.target,
				finger.id,
				finger.x + scrollX,
				finger.y + scrollY,
				finger.x,
				finger.y,
				4,
				4,
				0,
				1,
			);
		/** One touch event per target, as Safari sends them; whether any was cancelled. */
		const touch = (type: string, changed: Finger[]) => {
			let cancelled = false;
			for (const target of new Set(changed.map((finger) => finger.target))) {
				const mine = changed.filter((finger) => finger.target === target);
				const event = new TouchEvent(type, {
					bubbles: true,
					cancelable: true,
					composed: true,
					view: window,
					touches: doc.createTouchList(...down.map(touchOf)),
					targetTouches: doc.createTouchList(
						...down.filter((finger) => finger.target === target).map(touchOf),
					),
					changedTouches: doc.createTouchList(...mine.map(touchOf)),
				} as unknown as TouchEventInit);
				if (!target.dispatchEvent(event)) cancelled = true;
			}
			return cancelled;
		};
		const fingerPointer = (type: string, finger: Finger, buttons: number) =>
			pointer(type, finger.target, finger.id, [finger.x, finger.y], {
				pointerType: "touch",
				isPrimary: finger === down[0],
				buttons,
			});
		let pen: Element | null = null;
		owner.tackFingers = {
			touch(type: string, points: Point[]) {
				if (type === "touchStart") {
					const added = points.slice(down.length).map(([x, y]) => {
						const target = document.elementFromPoint(x, y) ?? document.documentElement;
						return {
							id: FIRST_ID + next++,
							target,
							x,
							y,
							from: [x, y] as Point,
							cancelled: false,
						};
					});
					down.push(...added);
					for (const finger of added) fingerPointer("pointerdown", finger, 1);
					if (touch("touchstart", added)) for (const finger of added) finger.cancelled = true;
				} else if (type === "touchMove") {
					down.forEach((finger, n) => {
						const point = points[n];
						if (point) [finger.x, finger.y] = point;
					});
					for (const finger of down) fingerPointer("pointermove", finger, 1);
					touch("touchmove", down);
				} else {
					const lifted = down.slice(points.length);
					const primary = down[0];
					down = down.slice(0, points.length);
					for (const finger of lifted) {
						pointer("pointerup", finger.target, finger.id, [finger.x, finger.y], {
							pointerType: "touch",
							isPrimary: finger === primary,
							buttons: 0,
						});
					}
					const cancelled = touch("touchend", lifted);
					// A tap: then the mouse events and click Safari sends after one.
					const [only] = lifted;
					if (
						only &&
						lifted.length === 1 &&
						down.length === 0 &&
						!cancelled &&
						!only.cancelled &&
						Math.hypot(only.x - only.from[0], only.y - only.from[1]) < 10
					) {
						const at: Point = [only.x, only.y];
						const target = document.elementFromPoint(...at) ?? only.target;
						mouse("mousemove", target, at, 0);
						mouse("mousedown", target, at, 1);
						mouse("mouseup", target, at, 0);
						mouse("click", target, at, 0);
					}
				}
			},
			pen(type: string, at: Point, buttons: number) {
				const target =
					type === "move" && pen ? pen : (document.elementFromPoint(...at) ?? document.body);
				if (type === "down") pen = target;
				const options = { pointerType: "pen", isPrimary: true, buttons };
				pointer(`pointer${type}`, target, PEN_ID, at, options);
				if (type === "up") pen = null;
			},
		};
	});
	const call = (method: "touch" | "pen", ...args: unknown[]) =>
		page.evaluate(
			({ method, args }) =>
				(
					(window as unknown as { tackFingers: Record<string, (...a: unknown[]) => void> })
						.tackFingers[method] as (...a: unknown[]) => void
				)(...args),
			{ method, args },
		);
	return {
		touch: (type, points) => call("touch", type, points),
		pen: (type, at, buttons) => call("pen", type, at, buttons),
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
	// As a matrix: Safari writes translate(x, 0) as translate(x).
	return page.locator(".react-flow__viewport").evaluate((element) => {
		const { e, f, a } = new DOMMatrixReadOnly((element as HTMLElement).style.transform);
		return { x: e, y: f, zoom: a };
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
		browserName,
	}) => {
		await openScenario(page, "comments");
		const card = page.locator(".react-flow__node-card").filter({ hasText: "Drop Node 18" });
		await card.tap();
		const sheet = page.getByRole("dialog", { name: "Card" });
		await expect(sheet).toBeVisible();
		await expect(sheet.locator(".card")).toContainText("Drop Node 18 support");
		// The shape stays in sight above the sheet, ringed.
		await expect(card).toHaveClass(/phone-sheet-open/);
		await expect(card).toBeInViewport();

		// Its thread, then a reply.
		await sheet.locator(".phone-sheet-thread").first().tap();
		const thread = page.getByRole("dialog", { name: "Comment" });
		await expect(thread).toContainText("Is this still blocked on the CI matrix change?");
		await thread.getByRole("combobox", { name: "Reply" }).fill("On it from my phone");
		await thread.getByRole("combobox", { name: "Reply" }).press("Enter");
		await expect(thread).toContainText("On it from my phone");
		// Back to the card, and a new comment on it.
		await thread.locator(".phone-sheet-back").tap();
		await expect(page.getByRole("dialog", { name: "Card" })).toBeVisible();
		await sheet.getByRole("combobox", { name: "Add a comment" }).fill("Phones can comment too");
		await sheet.getByRole("combobox", { name: "Add a comment" }).press("Enter");
		await expect(sheet.locator(".phone-sheet-thread")).toHaveCount(2);
		await expect(sheet).toContainText("Phones can comment too");

		// Tapping the empty board puts it away.
		const { tap } = await fingers(page, browserName);
		await tap(await emptySpot(page));
		await expect(page.getByRole("dialog", { name: "Card" })).toHaveCount(0);
	});

	test("tapping a stack shows its stickies, top first", async ({ page, browserName }) => {
		await openScenario(page, "stacks");
		const { tap } = await fingers(page, browserName);
		await tap(await shapeOnScreen(page, "stack"));
		const sheet = page.getByRole("dialog", { name: "Shape" });
		await expect(sheet).toBeVisible();
		await expect(sheet.locator(".phone-sheet-kind")).toHaveText("Stack");
		const list = sheet.getByRole("list", { name: /stacked stickies/ });
		await expect(list.getByRole("listitem").first()).toBeVisible();
		// Looking doesn't spread it open, as a click would.
		await expect(page.locator(".stack-tray")).toHaveCount(0);
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

	test("who stamped what: listed in the sheet, and a long-press names them", async ({
		page,
		browserName,
	}) => {
		await openScenario(page, "vote");
		await sticky(page, "A provider playground").tap();
		const sheet = page.getByRole("dialog", { name: "Shape" });
		const thumbs = sheet.getByRole("button", { name: /^👍/ });
		await thumbs.tap();
		await expect(thumbs).toHaveAttribute("aria-pressed", "true");
		await expect(thumbs).toHaveAccessibleName("👍 1: You");
		// Written out under the stamps: a phone has no hover to ask with.
		await expect(sheet.getByRole("list", { name: "Who stamped it" })).toContainText("👍 You");
		// A long-press names them, and doesn't also stamp.
		const box = (await thumbs.boundingBox())!;
		const { longPress } = await fingers(page, browserName);
		await longPress([box.x + box.width / 2, box.y + box.height / 2]);
		await expect(page.getByRole("tooltip")).toHaveText("👍You");
		await expect(thumbs).toHaveAttribute("aria-pressed", "true");
		// A tap anywhere else puts it away.
		await sheet.getByRole("region", { name: "Comments" }).tap();
		await expect(page.getByRole("tooltip")).toHaveCount(0);
	});

	test("tapping a card's reaction pill says who left it", async ({ page }) => {
		await openScenario(page, "comments");
		await page.locator(".react-flow__node-card").filter({ hasText: "Drop Node 18" }).tap();
		const sheet = page.getByRole("dialog", { name: "Card" });
		const thumbs = sheet.locator(".reaction-pill").first();
		// A tap does nothing else there, so a tap opens it, and another puts it away.
		await thumbs.tap();
		const tip = page.locator(".reaction-tip");
		await expect(tip).toContainText(/^👍.+/);
		await expect(thumbs).toHaveAccessibleName(/^👍 11: .+/);
		await thumbs.tap();
		await expect(tip).toHaveCount(0);
	});

	test("volunteering from the sheet, and taking it back", async ({ page }) => {
		await openScenario(page, "volunteers");
		const playground = sticky(page, "A provider playground");
		// Others' volunteers show on the board, without a hand to hover for.
		await expect(playground.getByRole("group", { name: /^Volunteers: / })).toBeVisible();
		await playground.tap();
		const sheet = page.getByRole("dialog", { name: "Shape" });
		const hand = sheet.getByRole("button", { name: "I’ll take it" });
		await expect(hand).toHaveAttribute("aria-pressed", "false");
		expect((await hand.boundingBox())?.height).toBeGreaterThanOrEqual(44);
		await hand.tap();
		await expect(hand).toHaveAttribute("aria-pressed", "true");
		await expect(sheet).toContainText("You, Kai Andersen, Tom Okafor");
		await expect(playground.locator(".volunteer")).toHaveCount(3);
		await hand.tap();
		await expect(hand).toHaveAttribute("aria-pressed", "false");
		await expect(playground.locator(".volunteer")).toHaveCount(2);
	});

	test("a decision's vote from the sheet", async ({ page }) => {
		await openScenario(page, "decisions");
		await page.getByTestId("rf__node-decision-node-20").tap();
		const decision = page.getByRole("dialog", { name: "Shape" });
		const agree = decision.getByRole("group", { name: "Your vote" }).getByRole("button", {
			name: /Agree/,
		});
		const before = Number(await agree.locator(".phone-sheet-choice-count").textContent());
		await agree.tap();
		await expect(agree).toHaveAttribute("aria-pressed", "true");
		await expect(agree.locator(".phone-sheet-choice-count")).toHaveText(String(before + 1));
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

	/** A PNG of one colour, made here: a photo to pick. */
	function solidPng(width: number, height: number): Buffer {
		const crc = (bytes: Buffer) => {
			let c = ~0;
			for (const byte of bytes) {
				c ^= byte;
				for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
			}
			return ~c >>> 0;
		};
		const chunk = (type: string, data: Buffer) => {
			const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
			const out = Buffer.alloc(body.length + 8);
			out.writeUInt32BE(data.length, 0);
			body.copy(out, 4);
			out.writeUInt32BE(crc(body), body.length + 4);
			return out;
		};
		const header = Buffer.alloc(13);
		header.writeUInt32BE(width, 0);
		header.writeUInt32BE(height, 4);
		header.set([8, 2, 0, 0, 0], 8);
		const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x3b)]);
		const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", header),
			chunk("IDAT", pixels),
			chunk("IEND", Buffer.alloc(0)),
		]);
	}

	test("the + adds a photo, which opens in its sheet", async ({ page }) => {
		await openScenario(page, "retro");
		await page.getByRole("button", { name: "Add a sticky" }).tap();
		const pad = page.getByRole("dialog", { name: "New sticky" });
		const chooser = page.waitForEvent("filechooser");
		await pad.getByText("Photo").tap();
		// A tiny PNG, as if from the camera roll.
		await (
			await chooser
		).setFiles({
			name: "photo.png",
			mimeType: "image/png",
			buffer: solidPng(400, 300),
		});
		// Off the pad, to watch it arrive.
		await expect(pad).toHaveCount(0);
		const image = page.locator(".react-flow__node-image");
		await expect(
			image.locator(".image-node[data-state='ready']:not([data-uploading])"),
		).toHaveCount(1, { timeout: 10_000 });
		await image.tap();
		const sheet = page.getByRole("dialog", { name: "Shape" });
		await expect(sheet.locator(".phone-sheet-image .image-file")).toBeVisible();
	});

	test("pinch zooms, and one or two fingers pan, without opening anything", async ({
		page,
		browserName,
	}) => {
		await openScenario(page, "retro");
		const { gesture } = await fingers(page, browserName);
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

	test("a sheet goes away dragged down by its grip", async ({ page, browserName }) => {
		await openScenario(page, "retro");
		const { gesture, tap } = await fingers(page, browserName);
		await tap(await shapeOnScreen(page));
		const sheet = page.getByRole("dialog", { name: "Shape" });
		await expect(sheet).toBeVisible();
		// Where its grip is once it's still (rising, or springing back).
		const grip = async () => {
			await sheet.evaluate((element) =>
				Promise.all(element.getAnimations().map((animation) => animation.finished)),
			);
			return centre(sheet.locator(".phone-sheet-grip"));
		};
		// A little way, slowly: it springs back.
		const at = await grip();
		await gesture([at], [[0, 40]], 12);
		await expect(sheet).toBeVisible();
		expect(Math.abs((await grip())[1] - at[1])).toBeLessThan(2);
		// Further: it goes.
		await gesture([await grip()], [[0, 320]], 10);
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
		browserName,
	}) => {
		await openScenario(page, "brainstorm");
		await expect(page.locator(".app")).toHaveAttribute("data-touch", "true");
		await expect(page.locator(".app")).not.toHaveAttribute("data-phone", "true");
		await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
		const { gesture, tap, longPress } = await fingers(page, browserName);
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

	test("a finger volunteers from the chip, and a tap on the faces unfolds Assign", async ({
		page,
		browserName,
	}) => {
		await openScenario(page, "volunteers");
		const { tap } = await fingers(page, browserName);
		// The scenario fits the board, too small to read: in to the card first.
		const ci = page.locator(".react-flow__node-card", { hasText: "#418" });
		await tap(await centre(ci));
		await expect(ci).toHaveClass(/selected/);
		await page.keyboard.press("Shift+Digit2");
		await settleCanvas(page);
		const more = ci.locator(".volunteers-more");
		// Selected, Assign has unfolded.
		await expect(more).toHaveCSS("opacity", "1");
		const hand = ci.getByRole("button", { name: "I’ll take it" });
		await tap(await centre(hand));
		await expect(hand).toHaveAttribute("aria-pressed", "true");
		await expect(ci.locator(".volunteer")).toHaveCount(2);
		// Not selected, it folds away; no hover to ask with, so a tap on the
		// faces unfolds it.
		await page.keyboard.press("Escape");
		await expect(ci).not.toHaveClass(/selected/);
		await expect(more).toHaveCSS("opacity", "0");
		await tap(await centre(ci.locator(".volunteers-who")));
		await expect(more).toHaveCSS("opacity", "1");
		await expect(ci.getByRole("button", { name: "Assign volunteers" })).toHaveCSS(
			"pointer-events",
			"auto",
		);
	});

	test("a section's bar fits across the tablet, words and all, with the rest in …", async ({
		page,
		browserName,
	}) => {
		await openScenario(page, "sections");
		await page.addStyleTag({ content: ".play-panel { display: none !important; }" });
		const { tap } = await fingers(page, browserName);
		const title = page.locator(".section-title", { hasText: "Next" }).first();
		const at = (await title.boundingBox())!;
		await tap([at.x + 12, at.y + 8]);
		const bar = page.getByRole("toolbar", { name: "Stage changes" });
		await expect(bar).toBeVisible();
		await page.waitForTimeout(400);
		// One row of touch-sized buttons, wholly on screen.
		const box = (await bar.boundingBox())!;
		const view = page.viewportSize()!;
		expect(box.height).toBeLessThan(64);
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(view.width);
		// Its main action keeps its word; what doesn't fit is in "…", with its word.
		await expect(
			bar.getByRole("button", { name: "Make a parent issue from this section" }),
		).toHaveText("Make parent issue");
		await bar.getByRole("button", { name: "More", exact: true }).click();
		const menu = page.getByRole("menu", { name: "More for this section" });
		await expect(menu.getByRole("menuitem", { name: "Draft a decision with AI" })).toHaveText(
			"Decide",
		);
	});

	test("a pencil draws a selection box", async ({ page, browserName }) => {
		await openScenario(page, "brainstorm");
		const { pencil } = await fingers(page, browserName);
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
		await pencil(box.from, box.to);
		await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
	});

	test("500 cards pinch-zoom and pan smoothly enough", async ({ page, browserName }) => {
		test.slow();
		await openScenario(page, "stress");
		const { gesture } = await fingers(page, browserName);
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
