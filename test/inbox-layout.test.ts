import { describe, expect, it } from "vite-plus/test";
import {
	TRAY_GAP,
	TRAY_MIN_ZOOM,
	TRAY_WIDTH,
	trayHeight,
	traySide,
} from "../src/client/inbox/layout.ts";

// Inbox trays keep off the sections beside theirs (#40): the review found a
// tray covering the next section, and covering everything zoomed out.

const section = { x: 400, y: 0, w: 320, h: 460 };
const size = { w: TRAY_WIDTH, h: trayHeight(5) };
const leftOf = { x: 40, y: 0, w: 320, h: 460 };
const rightOf = { x: 740, y: 0, w: 320, h: 460 };
const farRight = { x: 400 + 320 + TRAY_GAP + TRAY_WIDTH + 40, y: 0, w: 320, h: 460 };

describe("traySide", () => {
	it("goes on the right when nothing's there", () => {
		expect(traySide(section, size, 1, [leftOf])).toBe("right");
		expect(traySide(section, size, 1, [farRight])).toBe("right");
	});

	it("goes on the left when the right is taken", () => {
		expect(traySide(section, size, 1, [rightOf])).toBe("left");
	});

	it("has nowhere to go between two sections, and folds", () => {
		expect(traySide(section, size, 1, [leftOf, rightOf])).toBeNull();
	});

	it("needs more room zoomed out, as it grows to stay readable", () => {
		// Clear at 100%, but at 50% the tray is twice as wide on the board.
		expect(traySide(section, size, 1, [farRight, leftOf])).toBe("right");
		expect(traySide(section, size, 0.5, [farRight, leftOf])).toBeNull();
	});

	it("always folds far out", () => {
		expect(traySide(section, size, TRAY_MIN_ZOOM - 0.01, [])).toBeNull();
	});

	it("only minds what's level with it", () => {
		const below = { x: 740, y: section.y + trayHeight(5) + 40, w: 320, h: 200 };
		expect(traySide(section, size, 1, [below])).toBe("right");
	});
});
