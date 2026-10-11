import { describe, expect, it } from "vite-plus/test";
import {
	FLICK_SPEED,
	PRESS_SLOP,
	clearOfSheet,
	movedTooFar,
	panToShow,
	sheetCloses,
	sheetOffset,
} from "../src/client/touch/gestures.ts";

// The pure parts of touch on the board (#67): presses, the bottom sheet's
// drag, and keeping a tapped shape (or a new sticky) in sight above it.

describe("presses", () => {
	it("is still a press within the slop, and a drag beyond it", () => {
		const from = { x: 100, y: 100 };
		expect(movedTooFar(from, { x: 100, y: 100 })).toBe(false);
		expect(movedTooFar(from, { x: 100 + PRESS_SLOP, y: 100 })).toBe(false);
		expect(movedTooFar(from, { x: 108, y: 108 })).toBe(true);
		expect(movedTooFar(from, { x: 104, y: 103 }, 4)).toBe(true);
	});
});

describe("the sheet's drag", () => {
	it("springs back from a short, slow drag", () => {
		expect(sheetCloses(40, 0.1, 500)).toBe(false);
	});

	it("closes when dragged far enough down", () => {
		// A third of a tall sheet, capped at 160px.
		expect(sheetCloses(170, 0.1, 600)).toBe(true);
		expect(sheetCloses(150, 0.1, 600)).toBe(false);
		// A short sheet needs less.
		expect(sheetCloses(80, 0.1, 200)).toBe(true);
	});

	it("closes on a flick down, however short", () => {
		expect(sheetCloses(12, FLICK_SPEED, 600)).toBe(true);
	});

	it("stays when flicked back up, however far down it was", () => {
		expect(sheetCloses(300, -0.5, 600)).toBe(false);
	});

	it("never closes from a drag up", () => {
		expect(sheetCloses(-50, 2, 600)).toBe(false);
		expect(sheetCloses(0, 2, 600)).toBe(false);
	});

	it("follows a finger down one to one, and up only a little", () => {
		expect(sheetOffset(0)).toBe(0);
		expect(sheetOffset(120)).toBe(120);
		expect(sheetOffset(-100)).toBe(-20);
		expect(sheetOffset(-400)).toBeGreaterThan(-400 / 4);
	});
});

describe("keeping a shape in sight above the sheet", () => {
	const canvas = { width: 390, height: 800 };

	it("leaves the canvas above the sheet, and all of it without one", () => {
		expect(clearOfSheet(canvas, null)).toEqual({ x: 0, y: 0, w: 390, h: 800 });
		expect(clearOfSheet(canvas, 420)).toEqual({ x: 0, y: 0, w: 390, h: 420 });
		// A sheet that covers almost everything still leaves a sliver.
		expect(clearOfSheet(canvas, 40).h).toBe(120);
	});

	it("doesn't move a shape that's already in view", () => {
		const clear = clearOfSheet(canvas, 420);
		expect(panToShow({ x: 100, y: 100, w: 150, h: 150 }, clear)).toBeNull();
	});

	it("centres a shape the sheet would cover in the space above it", () => {
		const clear = clearOfSheet(canvas, 420);
		const pan = panToShow({ x: 100, y: 500, w: 150, h: 150 }, clear);
		expect(pan).not.toBeNull();
		const moved = { x: 100 + (pan?.dx ?? 0), y: 500 + (pan?.dy ?? 0) };
		expect(moved.x + 75).toBeCloseTo(195);
		expect(moved.y + 75).toBeCloseTo(210);
	});

	it("brings in a shape off the side", () => {
		const clear = clearOfSheet(canvas, null);
		const pan = panToShow({ x: -300, y: 300, w: 150, h: 150 }, clear);
		expect(pan?.dx).toBeGreaterThan(300);
	});

	it("shows the top of a shape too big for the space", () => {
		const clear = clearOfSheet(canvas, 300);
		const pan = panToShow({ x: 0, y: 400, w: 600, h: 600 }, clear, 16);
		expect(0 + (pan?.dx ?? 0)).toBe(16);
		expect(400 + (pan?.dy ?? 0)).toBe(16);
	});
});
