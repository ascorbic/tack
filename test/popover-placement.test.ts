import { describe, expect, it } from "vite-plus/test";
import {
	type Box,
	panIntoView,
	placeBeside,
	placePopover,
} from "../src/client/actions/popoverPlacement.ts";

// Popovers keep clear of the canvas's fixed chrome (#71).

const box = (left: number, top: number, width: number, height: number): Box => ({
	left,
	top,
	right: left + width,
	bottom: top + height,
});

const bounds = box(0, 56, 1280, 744); // a 1280×800 window under the header
const minimap = box(1048, 637, 217, 148); // bottom right
const controls = box(15, 663, 32, 122); // bottom left
const dock = box(420, 724, 440, 60); // bottom centre
const chrome = [minimap, controls, dock];
const size = { width: 320, height: 300 };

describe("placePopover", () => {
	it("opens centred below its bar when there's room", () => {
		expect(
			placePopover({
				anchor: box(500, 200, 200, 36),
				size,
				bounds,
				obstacles: chrome,
				prefer: "below",
			}),
		).toEqual({ side: "below", nudge: 0, room: 800 - 12 - 244 });
	});

	it("shifts sideways to clear the minimap", () => {
		// A bar near the bottom right: below would run under the minimap.
		const anchor = box(980, 300, 200, 36);
		const placement = placePopover({ anchor, size, bounds, obstacles: chrome, prefer: "below" });
		expect(placement.side).toBe("below");
		const left = (anchor.left + anchor.right) / 2 - size.width / 2 + placement.nudge;
		expect(left + size.width).toBeLessThanOrEqual(minimap.left - 12);
		// No further than it has to.
		expect(left + size.width).toBe(minimap.left - 12);
	});

	it("flips above when below is blocked and there's no room to the side", () => {
		// The dock and the minimap span the bottom, with no gap wide enough between.
		const wall = [box(0, 600, 1280, 200)];
		const placement = placePopover({
			anchor: box(980, 420, 200, 36),
			size,
			bounds,
			obstacles: wall,
			prefer: "below",
		});
		expect(placement.side).toBe("above");
		expect(placement.room).toBe(420 - 8 - 56 - 12);
	});

	it("scrolls in the room it has, rather than going under chrome", () => {
		const placement = placePopover({
			anchor: box(500, 100, 200, 36),
			size: { width: 1200, height: 900 },
			bounds,
			obstacles: [dock],
			prefer: "below",
		});
		expect(placement.side).toBe("below");
		// Stopping short of the dock.
		expect(placement.room).toBe(dock.top - 12 - (136 + 8));
	});

	it("stays on its side once open", () => {
		const placement = placePopover({
			anchor: box(500, 700, 200, 36),
			size,
			bounds,
			obstacles: [],
			prefer: "below",
			stay: true,
		});
		expect(placement.side).toBe("below");
		expect(placement.room).toBe(180);
	});

	it("keeps within the canvas sideways", () => {
		const placement = placePopover({
			anchor: box(0, 200, 80, 36),
			size,
			bounds,
			obstacles: [],
			prefer: "below",
		});
		expect(40 - size.width / 2 + placement.nudge).toBe(12);
	});

	it("goes where there's most room when nothing is clear", () => {
		const everywhere = [box(0, 0, 1280, 800)];
		const placement = placePopover({
			anchor: box(500, 600, 200, 36),
			size,
			bounds,
			obstacles: everywhere,
			prefer: "below",
		});
		expect(placement.side).toBe("above");
	});
});

// Widget panels beside their widget, and inbox editors panned into view: the
// review found both opening off screen at 1280×800.

describe("placeBeside", () => {
	// The canvas under the header, in its own coordinates.
	const canvas = box(0, 0, 1280, 744);
	const panel = { width: 340, height: 480 };
	const dockOnCanvas = box(370, 668, 540, 60);
	const minimapOnCanvas = box(1064, 580, 200, 150);

	it("opens to the right, centred on the widget, when there's room", () => {
		const anchor = box(100, 200, 360, 300);
		const placement = placeBeside({ anchor, size: panel, bounds: canvas, obstacles: [] });
		expect(placement).toEqual({ side: "right", left: 474, top: 110, room: 720 });
	});

	it("flips to the left of a widget in the right-hand column", () => {
		// The "Needs triage" list at 1280×800: its right edge near the window's.
		const anchor = box(840, 40, 360, 240);
		const placement = placeBeside({ anchor, size: panel, bounds: canvas, obstacles: [] });
		expect(placement.side).toBe("left");
		expect(placement.left).toBe(840 - 14 - 340);
		// Never above the canvas.
		expect(placement.top).toBeGreaterThanOrEqual(12);
	});

	it("slides down to stay below the canvas's top edge", () => {
		const anchor = box(100, -200, 400, 300);
		const placement = placeBeside({ anchor, size: panel, bounds: canvas, obstacles: [] });
		expect(placement.top).toBe(12);
		expect(placement.room).toBeGreaterThanOrEqual(panel.height);
	});

	it("keeps clear of the dock, sliding up rather than under it", () => {
		const anchor = box(200, 450, 300, 280);
		const placement = placeBeside({
			anchor,
			size: panel,
			bounds: canvas,
			obstacles: [dockOnCanvas, minimapOnCanvas],
		});
		expect(placement.side).toBe("right");
		expect(placement.top + panel.height).toBeLessThanOrEqual(dockOnCanvas.top - 12);
	});

	it("pins a panel taller than the canvas to the top, to scroll", () => {
		const short = box(0, 0, 1280, 400);
		const placement = placeBeside({
			anchor: box(100, 100, 300, 200),
			size: panel,
			bounds: short,
			obstacles: [],
		});
		expect(placement.top).toBe(12);
		expect(placement.room).toBe(400 - 24);
	});

	it("overlaps a widget wider than the canvas rather than leaving the screen", () => {
		const placement = placeBeside({
			anchor: box(-200, 100, 1600, 400),
			size: panel,
			bounds: canvas,
			obstacles: [],
		});
		expect(placement.left).toBeGreaterThanOrEqual(12);
		expect(placement.left + panel.width).toBeLessThanOrEqual(1280 - 12);
	});
});

describe("panIntoView", () => {
	const canvas = box(0, 56, 1440, 900);
	const dockOnScreen = box(450, 826, 540, 60);

	it("leaves what's already in view where it is", () => {
		expect(
			panIntoView({ rect: box(400, 200, 280, 300), bounds: canvas, obstacles: [dockOnScreen] }),
		).toEqual({ dx: 0, dy: 0 });
	});

	it("pans up so an editor under the dock comes out from under it", () => {
		// "Make inbox" on a lower section: the editor ran behind the dock.
		const rect = box(716, 696, 280, 360);
		const { dx, dy } = panIntoView({ rect, bounds: canvas, obstacles: [dockOnScreen] });
		expect(dx).toBe(0);
		expect(rect.bottom + dy).toBe(dockOnScreen.top - 16);
	});

	it("pans sideways to bring something off the right edge in", () => {
		const { dx } = panIntoView({ rect: box(1300, 200, 280, 300), bounds: canvas, obstacles: [] });
		expect(1300 + dx + 280).toBe(1440 - 16);
	});

	it("shows the top of something taller than the room", () => {
		const { dy } = panIntoView({ rect: box(100, -400, 280, 2000), bounds: canvas, obstacles: [] });
		expect(-400 + dy).toBe(56 + 16);
	});
});
