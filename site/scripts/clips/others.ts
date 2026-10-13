// Other people's pointers in a clip: named arrows (cursor.ts draws them)
// moved on the recorder's frame clock, so several people can be on the
// move at once, each along a gently bowed, eased path, with a click that
// ripples in their colour. A move can start after a delay, and `follow`
// runs on every frame of it, for whatever moves with the pointer (a card
// being dragged, say).

import type { Page } from "@playwright/test";
import { FPS, type Recorder } from "./capture.ts";
import { type Point, type Pointer, bowedPath, easeReach, moveDuration } from "./cursor.ts";

type Follow = (at: Point, t: number) => Promise<unknown>;

interface Glide {
	who: Pointer;
	to: Point;
	/** Set when it starts, from wherever the pointer is then. */
	path?: (t: number) => Point;
	start: number;
	frames: number;
	follow?: Follow;
}

export interface Move {
	/** How long it takes, in seconds. */
	seconds?: number;
	/** How long until it starts, in seconds. */
	delay?: number;
	follow?: Follow;
}

export class Crowd {
	private glides: Glide[] = [];
	private clicks: { who: Pointer; x: number; y: number; born: number }[] = [];
	readonly rec: Recorder;

	constructor(rec: Recorder) {
		this.rec = rec;
	}

	/** The recorder's next frame, so glides keep time even across its own moves. */
	private get frame(): number {
		return Math.round(this.rec.t * FPS);
	}

	/** Someone on the board, resting somewhere, with their name by their pointer. */
	join(name: string, color: string, at: Point): Pointer {
		const who: Pointer = { ...at, press: 0, ripples: [], visible: true, label: name, color };
		this.rec.others.push(who);
		return who;
	}

	/** Set someone off towards `to`; they carry on while other frames go by. */
	move(who: Pointer, to: Point, { seconds, delay = 0, follow }: Move = {}): void {
		this.glides = this.glides.filter((g) => g.who !== who);
		this.glides.push({
			who,
			to,
			start: this.frame + Math.round(delay * FPS),
			frames: Math.max(1, Math.round((seconds ?? moveDuration(who, to)) * FPS)),
			follow,
		});
	}

	/** Until someone's got where they were going. */
	async arrive(who: Pointer): Promise<void> {
		while (this.glides.some((g) => g.who === who)) await this.tick();
	}

	/** Move someone and wait for them to get there. */
	async moveTo(who: Pointer, to: Point, move: Move = {}): Promise<void> {
		this.move(who, to, move);
		await this.arrive(who);
	}

	/**
	 * Your own pointer, with the real mouse following it, while everyone
	 * else keeps moving (the recorder's `moveTo` holds them still).
	 */
	async moveYou(to: Point, { seconds, delay, follow }: Move = {}): Promise<void> {
		const { page, pointer } = this.rec;
		await this.moveTo(pointer, to, {
			seconds,
			delay,
			follow: async (at, t) => {
				await page.mouse.move(at.x, at.y);
				await follow?.(at, t);
			},
		});
	}

	/** A press and release where someone's pointer is, with a ripple; `then` runs as it lands. */
	async click(who: Pointer, then?: () => Promise<unknown>): Promise<void> {
		await this.press(who);
		await then?.();
		await this.release(who);
	}

	async press(who: Pointer): Promise<void> {
		for (const press of [0.5, 1]) {
			who.press = press;
			await this.tick();
		}
		this.clicks.push({ who, x: who.x, y: who.y, born: this.frame });
	}

	async release(who: Pointer): Promise<void> {
		for (const press of [0.6, 0.2, 0]) {
			who.press = press;
			await this.tick();
		}
	}

	/** Hold, while anyone already on the move carries on. */
	async wait(seconds: number): Promise<void> {
		const frames = Math.round(seconds * FPS);
		for (let i = 0; i < frames; i++) await this.tick();
	}

	/** One frame: everyone moving takes a step, then the recorder's frame. */
	async tick(): Promise<void> {
		for (const glide of [...this.glides]) {
			const i = this.frame - glide.start + 1;
			if (i < 1) continue;
			glide.path ??= bowedPath({ x: glide.who.x, y: glide.who.y }, glide.to);
			const t = Math.min(1, i / glide.frames);
			const at = glide.path(easeReach(t));
			Object.assign(glide.who, at);
			await glide.follow?.(at, t);
			if (t >= 1) this.glides = this.glides.filter((g) => g !== glide);
		}
		for (const who of this.rec.others) {
			who.ripples = this.clicks
				.filter((c) => c.who === who)
				.map((c) => ({ x: c.x, y: c.y, t: (this.frame - c.born) / (0.5 * FPS) }))
				.filter((r) => r.t <= 1);
		}
		await this.rec.tick();
	}
}

/** Where a point on the board is on the page, from React Flow's viewport as it is now. */
export async function boardToPage(page: Page): Promise<(at: Point) => Point> {
	const { x, y, zoom } = await page.evaluate(() => {
		const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
		const pane = document.querySelector<HTMLElement>(".react-flow")?.getBoundingClientRect();
		const matrix = new DOMMatrix(viewport ? getComputedStyle(viewport).transform : undefined);
		return { x: matrix.e + (pane?.left ?? 0), y: matrix.f + (pane?.top ?? 0), zoom: matrix.a };
	});
	return (at) => ({ x: x + at.x * zoom, y: y + at.y * zoom });
}
