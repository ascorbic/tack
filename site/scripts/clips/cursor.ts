// The clips' pointer. Headless Chromium draws no cursor, so the recorder
// draws one over the page: a crisp arrow (with a name label for someone
// else's), moved along gently curved, eased paths and set for each frame
// from the frame clock, so it never runs ahead of the board. Real mouse
// events follow the same path, so the board reacts to it truthfully.

import type { Page } from "@playwright/test";

export interface Point {
	x: number;
	y: number;
}

export interface Pointer {
	x: number;
	y: number;
	/** 0 at rest, 1 pressed: the arrow dips a little. */
	press: number;
	/** Clicks still rippling, with their progress from 0 to 1. */
	ripples: { x: number; y: number; t: number }[];
	visible: boolean;
	/** For someone else's pointer: their name and colour. */
	label?: string;
	color?: string;
	/** From 0 to 1, for fading in and out: unset is 1. */
	opacity?: number;
}

/** Ease in and out, gentler than cubic at the ends. */
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Settles a little faster than it sets off, like a hand reaching for something. */
export const easeReach = (t: number) => 1 - (1 - easeInOut(t)) ** 1.15;

/**
 * A path from `from` to `to` that bows slightly to one side, as a hand's
 * movement does: a cubic Bézier whose controls sit off the straight line.
 */
export function bowedPath(from: Point, to: Point, bow = 0.12): (t: number) => Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	// Perpendicular, always bowing the same way for a given direction.
	const nx = -dy * bow;
	const ny = dx * bow;
	const c1 = { x: from.x + dx * 0.3 + nx, y: from.y + dy * 0.3 + ny };
	const c2 = { x: from.x + dx * 0.75 + nx * 0.6, y: from.y + dy * 0.75 + ny * 0.6 };
	return (t) => {
		const u = 1 - t;
		return {
			x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
			y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
		};
	};
}

/** How long a move takes: longer for longer trips, never hurried. */
export function moveDuration(from: Point, to: Point): number {
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	return Math.min(1.1, Math.max(0.45, 0.3 + distance / 900));
}

/** The overlay, installed in the page: `window.clipPointers.set([...])` draws every pointer. */
export async function installOverlay(page: Page): Promise<void> {
	await page.evaluate(() => {
		const layer = document.createElement("div");
		layer.setAttribute("aria-hidden", "true");
		layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
		document.body.append(layer);
		const arrow = (fill: string) =>
			`<svg width="26" height="26" viewBox="0 0 26 26" style="position:absolute;left:-3px;top:-2px;overflow:visible;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.28)) drop-shadow(0 3px 6px rgb(0 0 0 / 0.12))">` +
			`<path d="M3.5 2.5 L3.5 20.2 L8.1 15.9 L11.2 23 L14.6 21.5 L11.6 14.6 L17.9 14.6 Z" fill="${fill}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
		type P = {
			x: number;
			y: number;
			press: number;
			ripples: { x: number; y: number; t: number }[];
			visible: boolean;
			label?: string;
			color?: string;
			opacity?: number;
		};
		const set = (pointers: P[]) => {
			layer.innerHTML = "";
			for (const p of pointers) {
				const opacity = p.opacity ?? 1;
				if (!p.visible || opacity <= 0) continue;
				for (const r of p.ripples) {
					const ring = document.createElement("div");
					const size = 10 + 34 * (1 - (1 - r.t) ** 3);
					const ink = p.color ?? "#3b4cca";
					ring.style.cssText = `position:absolute;left:${r.x - size / 2}px;top:${r.y - size / 2}px;width:${size}px;height:${size}px;border-radius:50%;background:${ink}22;border:2px solid ${ink};opacity:${0.55 * (1 - r.t) * opacity};`;
					layer.append(ring);
				}
				const el = document.createElement("div");
				const scale = 1 - 0.12 * p.press;
				el.style.cssText = `position:absolute;left:0;top:0;transform:translate(${p.x}px,${p.y}px) scale(${scale});transform-origin:0 0;opacity:${opacity};`;
				el.innerHTML = arrow(p.color ?? "#1d1d1f");
				if (p.label) {
					const tag = document.createElement("div");
					tag.textContent = p.label;
					tag.style.cssText = `position:absolute;left:16px;top:20px;padding:3px 8px;border-radius:999px;background:${p.color};color:#fff;font:600 12px/16px Geist Variable, system-ui, sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgb(0 0 0 / 0.2);`;
					el.append(tag);
				}
				layer.append(el);
			}
		};
		Object.assign(window, { clipPointers: { set } });
	});
}

export function drawPointers(page: Page, pointers: Pointer[]): Promise<void> {
	return page.evaluate(
		(pointers) =>
			(window as unknown as { clipPointers: { set(p: unknown): void } }).clipPointers.set(pointers),
		pointers,
	);
}
