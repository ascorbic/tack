import { describe, expect, it } from "vite-plus/test";
import { chromeInsets, contentBounds, viewportToFit } from "../src/client/fitting.ts";

// Fitting the board around the chrome over it (canvas review 30, 31).

const canvas = { left: 0, top: 0, right: 1280, bottom: 800 };

describe("chromeInsets", () => {
	it("keeps a gap all round when there's no chrome", () => {
		expect(chromeInsets(canvas, {})).toEqual({ top: 32, right: 32, bottom: 32, left: 32 });
	});

	it("keeps fitted content above the dock and beside the minimap", () => {
		const insets = chromeInsets(canvas, {
			dock: { left: 400, top: 730, right: 880, bottom: 784 },
			minimap: { left: 1060, top: 640, right: 1265, bottom: 785 },
		});
		expect(insets.bottom).toBe(800 - 730 + 16);
		expect(insets.right).toBe(1280 - 1060 + 16);
		expect(insets.top).toBe(32);
		expect(insets.left).toBe(32);
	});

	it("keeps fitted content below what hangs from the top and above what sits along the bottom", () => {
		const phone = { left: 0, top: 54, right: 393, bottom: 852 };
		const insets = chromeInsets(
			phone,
			{
				// A vote's bar, and the demo's guide card, which reaches higher than the dock.
				top: [{ left: 12, top: 64, right: 381, bottom: 110 }],
				bottom: [{ left: 12, top: 385, right: 381, bottom: 768 }],
				dock: { left: 16, top: 774, right: 377, bottom: 836 },
			},
			16,
		);
		expect(insets.top).toBe(110 - 54 + 8);
		expect(insets.bottom).toBe(852 - 385 + 8);
		expect(insets.left).toBe(16);
		expect(insets.right).toBe(16);
	});

	it("takes the gap it's given", () => {
		expect(chromeInsets(canvas, {}, 96).top).toBe(96);
	});
});

describe("viewportToFit", () => {
	const insets = { top: 32, right: 32, bottom: 86, left: 32 };
	const size = { width: 1280, height: 800 };

	it("never zooms past 100% for a small board, and centres it in the space left", () => {
		const view = viewportToFit({ x: 0, y: 0, w: 200, h: 100 }, size, insets);
		expect(view.zoom).toBe(1);
		// Centred in the space between the insets.
		expect(view.x).toBe(32 + (1280 - 64 - 200) / 2);
		expect(view.y).toBe(32 + (800 - 118 - 100) / 2);
	});

	it("zooms out until everything is clear of the chrome", () => {
		const bounds = { x: -500, y: 300, w: 4000, h: 1000 };
		const view = viewportToFit(bounds, size, insets);
		expect(view.zoom).toBeCloseTo((1280 - 64) / 4000);
		const left = bounds.x * view.zoom + view.x;
		const right = (bounds.x + bounds.w) * view.zoom + view.x;
		const bottom = (bounds.y + bounds.h) * view.zoom + view.y;
		expect(left).toBeCloseTo(32);
		expect(right).toBeCloseTo(1280 - 32);
		expect(bottom).toBeLessThanOrEqual(800 - 86);
	});

	it("stays within the zoom limits", () => {
		const huge = viewportToFit({ x: 0, y: 0, w: 1e6, h: 1e6 }, size, insets);
		expect(huge.zoom).toBe(0.1);
		const close = viewportToFit({ x: 0, y: 0, w: 10, h: 10 }, size, insets, { maxZoom: 2 });
		expect(close.zoom).toBe(2);
	});
});

describe("contentBounds", () => {
	it("is nothing for an empty board", () => {
		expect(contentBounds([])).toBeNull();
	});

	it("covers every shape", () => {
		expect(
			contentBounds([
				{ x: 10, y: 20, w: 100, h: 50 },
				{ x: -40, y: 200, w: 20, h: 20 },
			]),
		).toEqual({ x: -40, y: 20, w: 150, h: 200 });
	});
});
