import { describe, expect, it } from "vite-plus/test";
import { centreClearOf } from "../src/client/clearView.ts";

// Jumps land things in the part of the board side panels leave clear.
describe("centreClearOf", () => {
	const view = { width: 1280, height: 800, left: 0, right: 0 };

	it("centres on the point when nothing is open", () => {
		expect(centreClearOf({ x: 100, y: 50 }, 1, view)).toEqual({ x: 100, y: 50 });
	});

	it("moves the point right of a panel on the left", () => {
		// A 380px digest: the clear part's middle is 190px right of the window's.
		const centre = centreClearOf({ x: 100, y: 50 }, 1, { ...view, left: 380 });
		expect(centre).toEqual({ x: 100 - 190, y: 50 });
		expect(centreClearOf({ x: 100, y: 50 }, 2, { ...view, left: 380 }).x).toBe(100 - 95);
	});

	it("and left of one on the right", () => {
		expect(centreClearOf({ x: 0, y: 0 }, 1, { ...view, right: 400 }).x).toBe(200);
	});
});
