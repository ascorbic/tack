// Recording a clip, one frame at a time on a clock of our own.
//
// Nothing on the page moves by itself while recording: script time is
// Playwright's fake clock (timers, requestAnimationFrame, Date), and every
// CSS transition and animation is paused and stepped by hand. Each frame
// moves both on by exactly 1/fps, draws the pointers, then screenshots at
// twice the CSS pixels, so a slow machine records the same smooth clip as
// a fast one, just more slowly, and the camera can crop in later and stay
// sharp.

import { type Browser, type CDPSession, type Locator, type Page, chromium } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	type Point,
	type Pointer,
	bowedPath,
	drawPointers,
	easeReach,
	installOverlay,
	moveDuration,
} from "./cursor.ts";

/** The page's width and height in CSS pixels, and how many pixels each is recorded at. */
export const SIZE = 960;
export const SCALE = 2.25;
export const FPS = 30;

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** What the camera and the encoder need from a recording. */
export interface Recording {
	dir: string;
	frames: number;
	fps: number;
	/** Named moments, in seconds from the first frame. */
	marks: Record<string, number>;
	/** Named elements' boxes, in CSS pixels, when they were measured. */
	boxes: Record<string, Box>;
}

/** Hide what isn't the board as people see it: the playground's controls, the minimap. */
const TIDY = `
	[aria-label="Playground controls"], .react-flow__minimap, .fps { display: none !important; }
	*, *::before, *::after { caret-color: transparent !important; }
	/* A marquee that ends over the action bar as it appears selects its words. */
	::selection { background: transparent !important; }
`;

export interface Setup {
	/** The app's dev server, e.g. http://localhost:5391. */
	base: string;
	/** A path on the app, e.g. /play?scenario=empty. */
	url: string;
	/** The board's name in the top bar, in place of the playground's. */
	title?: string;
	/** Who you are on the board. */
	you?: { name: string; color: string };
	/** Words to replace wherever they appear, e.g. the playground's name for its pretend forge. */
	retext?: [RegExp, string][];
}

export class Recorder {
	readonly marks: Record<string, number> = {};
	readonly boxes: Record<string, Box> = {};
	readonly pointer: Pointer = { x: 0, y: 0, press: 0, ripples: [], visible: false };
	/** Other people's pointers, drawn with their names. */
	readonly others: Pointer[] = [];
	/**
	 * How fast the page's time runs against the clip's: below 1 is slow
	 * motion, for something too quick to see (a card turning over).
	 */
	speed = 1;
	private frame = 0;
	private cdp!: CDPSession;
	private ripples: { x: number; y: number; born: number }[] = [];

	readonly browser: Browser;
	readonly page: Page;
	readonly dir: string;

	private constructor(browser: Browser, page: Page, dir: string) {
		this.browser = browser;
		this.page = page;
		this.dir = dir;
	}

	static async open(setup: Setup, dir: string): Promise<Recorder> {
		const browser = await chromium.launch();
		const context = await browser.newContext({
			viewport: { width: SIZE, height: SIZE },
			deviceScaleFactor: SCALE,
			colorScheme: "light",
		});
		await context.addInitScript(
			({ you }) => {
				localStorage.setItem("tack:user", JSON.stringify(you));
				// The app's own copy of one of its modules, for seeding a board with its
				// helpers: the URL it loaded it from, which after an edit carries Vite's
				// `?t=`, so that module state (a counter, a store) is shared with the app.
				// The dev server serves hundreds of modules: keep every one's entry.
				// (The real `performance`: the fake clock swaps in its own.)
				const timing = performance;
				timing.setResourceTimingBufferSize(100_000);
				Object.assign(window, {
					clipImport: (path: string) => {
						const loaded = timing
							.getEntriesByType("resource")
							.map((entry) => entry.name)
							.find((name) => new URL(name).pathname === path);
						return import(/* @vite-ignore */ loaded ?? path);
					},
				});
				// The same "random" every run: jittered timings, made-up ids in fixtures.
				let seed = 0x7ac4;
				Math.random = () => {
					seed = (seed + 0x6d2b79f5) | 0;
					let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
					t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
					return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
				};
			},
			{ you: setup.you ?? { name: "Jo Rivera", color: "#5b5fc7" } },
		);
		const page = await context.newPage();
		await page.clock.install({ time: new Date("2026-10-12T10:00:00Z") });
		page.on("pageerror", (error) => console.error("page error:", error.message));
		await page.goto(new URL(setup.url, setup.base).href);
		await page.locator(".react-flow__renderer").waitFor();
		await page.addStyleTag({ content: TIDY });
		const retext: [RegExp, string][] = [
			...(setup.title ? ([[/^Playground( · .*)?$/, setup.title]] as [RegExp, string][]) : []),
			...(setup.retext ?? []),
		];
		await page.evaluate(
			(rules) => {
				const patterns = rules.map(
					([source, flags, to]) => [new RegExp(source, flags), to] as const,
				);
				const fix = (node: Node) => {
					const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
					for (let text = walker.nextNode(); text; text = walker.nextNode()) {
						let value = text.nodeValue ?? "";
						for (const [pattern, to] of patterns) value = value.replace(pattern, to);
						if (value !== text.nodeValue) text.nodeValue = value;
					}
				};
				fix(document.body);
				// And whatever's rendered later: panels, sheets, toasts.
				new MutationObserver((records) => {
					for (const record of records) {
						if (record.type === "characterData") fix(record.target.parentNode ?? record.target);
						for (const added of record.addedNodes) fix(added);
					}
				}).observe(document.body, { subtree: true, childList: true, characterData: true });
			},
			retext.map(([pattern, to]) => [pattern.source, pattern.flags, to] as const),
		);
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		const recorder = new Recorder(browser, page, dir);
		recorder.cdp = await context.newCDPSession(page);
		await installOverlay(page);
		return recorder;
	}

	/** The time of the next frame, in seconds from the first. */
	get t(): number {
		return this.frame / FPS;
	}

	/** Stop the page's clocks: from here on, time only moves a frame at a time. */
	async start(): Promise<void> {
		const now = await this.page.evaluate(() => Date.now());
		await this.page.clock.pauseAt(now + 50);
		await this.page.evaluate(() => {
			const seen = new WeakMap<Animation, number>();
			const step = (ms: number) => {
				for (const animation of document.getAnimations()) {
					const at = seen.get(animation);
					const next = at === undefined ? 0 : at + ms;
					if (at === undefined) animation.pause();
					seen.set(animation, next);
					animation.currentTime = next;
				}
			};
			Object.assign(window, { clipAnimations: { step } });
		});
		await this.page.evaluate(() =>
			(window as unknown as { clipAnimations: { step(ms: number): void } }).clipAnimations.step(0),
		);
	}

	/**
	 * One frame: time moves on by a frame (script time, then CSS animations),
	 * then the pointers are drawn and it's screenshot. The first frame is the
	 * board as it is when recording starts.
	 */
	async tick(): Promise<void> {
		const ms = (1000 / FPS) * this.speed;
		if (this.frame > 0) {
			await this.page.clock.runFor(ms);
			await this.page.evaluate(async (ms) => {
				// Let React finish what the timers started (it schedules over MessageChannel).
				for (let i = 0; i < 2; i++) {
					await new Promise<void>((resolve) => {
						const channel = new MessageChannel();
						channel.port1.onmessage = () => resolve();
						channel.port2.postMessage(null);
					});
				}
				(window as unknown as { clipAnimations: { step(ms: number): void } }).clipAnimations.step(
					ms,
				);
			}, ms);
		}
		await this.shoot();
		this.frame++;
	}

	private async shoot(): Promise<void> {
		this.pointer.ripples = this.ripples
			.map((r) => ({ x: r.x, y: r.y, t: (this.frame - r.born) / (0.5 * FPS) }))
			.filter((r) => r.t <= 1);
		await drawPointers(this.page, [...this.others, this.pointer]);
		const { data } = await this.cdp.send("Page.captureScreenshot", {
			format: "jpeg",
			quality: 95,
			clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: SCALE },
		});
		await writeFile(this.framePath(this.frame), Buffer.from(data, "base64"));
	}

	framePath(n: number): string {
		return path.join(this.dir, `${String(n).padStart(5, "0")}.jpg`);
	}

	/** Hold for a while, in seconds. */
	async wait(seconds: number): Promise<void> {
		const frames = Math.round(seconds * FPS);
		for (let i = 0; i < frames; i++) await this.tick();
	}

	/** Frames go by until the page shows something, e.g. a button appearing. */
	async until(locator: Locator, timeout = 10): Promise<void> {
		const end = this.t + timeout;
		while (!(await locator.isVisible())) {
			if (this.t > end) throw new Error(`Never appeared: ${locator}`);
			await this.tick();
		}
	}

	mark(name: string): void {
		this.marks[name] = this.t;
	}

	/** Measure an element now, for the camera to aim at. */
	async box(name: string, locator: Locator): Promise<Box> {
		const box = await locator.boundingBox();
		if (!box) throw new Error(`Can't measure ${name}`);
		const measured = { x: box.x, y: box.y, w: box.width, h: box.height };
		this.boxes[name] = measured;
		return measured;
	}

	/** Where an element's centre is, nudged by `offset`. */
	async centre(locator: Locator, offset: Partial<Point> = {}): Promise<Point> {
		const box = await locator.boundingBox();
		if (!box) throw new Error(`Can't find ${locator}`);
		return {
			x: box.x + box.width / 2 + (offset.x ?? 0),
			y: box.y + box.height / 2 + (offset.y ?? 0),
		};
	}

	/** Show the pointer, resting somewhere. */
	async place(at: Point): Promise<void> {
		Object.assign(this.pointer, at, { visible: true });
		await this.page.mouse.move(at.x, at.y);
	}

	/** Move the pointer along a gently bowed, eased path; the real mouse follows it. */
	async moveTo(to: Point, seconds = moveDuration(this.pointer, to)): Promise<void> {
		const path = bowedPath({ ...this.pointer }, to);
		const frames = Math.max(1, Math.round(seconds * FPS));
		for (let i = 1; i <= frames; i++) {
			const at = path(easeReach(i / frames));
			Object.assign(this.pointer, at);
			await this.page.mouse.move(at.x, at.y);
			await this.tick();
		}
	}

	/** Press and release where the pointer is, with a ripple. */
	async click(): Promise<void> {
		await this.press();
		await this.release();
	}

	async press(): Promise<void> {
		for (const press of [0.5, 1]) {
			this.pointer.press = press;
			await this.tick();
		}
		await this.page.mouse.down();
		this.ripples.push({ x: this.pointer.x, y: this.pointer.y, born: this.frame });
		await this.tick();
	}

	async release(): Promise<void> {
		await this.page.mouse.up();
		for (const press of [0.6, 0.2, 0]) {
			this.pointer.press = press;
			await this.tick();
		}
	}

	/** Press, move with the button held (a marquee, a drag), and let go. */
	async drag(to: Point, seconds?: number): Promise<void> {
		await this.press();
		await this.moveTo(to, seconds);
		await this.release();
	}

	recording(): Recording {
		return {
			dir: this.dir,
			frames: this.frame,
			fps: FPS,
			marks: this.marks,
			boxes: this.boxes,
		};
	}

	async close(): Promise<void> {
		await this.browser.close();
	}
}
