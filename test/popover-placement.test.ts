import { describe, expect, it } from "vite-plus/test";
import { type Box, placePopover } from "../src/client/actions/popoverPlacement.ts";

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
