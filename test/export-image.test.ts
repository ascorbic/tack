import { describe, expect, it } from "vite-plus/test";
import {
	EXPORT_PADDING,
	MAX_SIDE,
	exportRegion,
	imageSize,
	selectionScope,
} from "../src/client/export/scope.ts";
import type { ShapeProps } from "../src/shared/shapes.ts";

const shape = (props: Partial<ShapeProps> & Pick<ShapeProps, "type">): ShapeProps => ({
	x: 0,
	y: 0,
	z: "a0",
	...props,
});

describe("what an image of a selection draws", () => {
	const shapes = new Map<string, ShapeProps>([
		["outer", shape({ type: "section" })],
		["inner", shape({ type: "section", parent: "outer" })],
		["deep", shape({ type: "sticky", parent: "inner" })],
		["card", shape({ type: "card", ref: "github.com/a/b#1" })],
		["away", shape({ type: "sticky" })],
		[
			"joined",
			shape({
				type: "connector",
				from: { x: 0, y: 0, shape: "deep" },
				to: { x: 0, y: 0, shape: "card" },
			}),
		],
		[
			"half",
			shape({
				type: "connector",
				from: { x: 0, y: 0, shape: "deep" },
				to: { x: 0, y: 0, shape: "away" },
			}),
		],
		["loose", shape({ type: "connector", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } })],
	]);

	it("takes everything inside a selected section, and connectors between what's drawn", () => {
		expect([...selectionScope(shapes, ["outer", "card"])].sort()).toEqual(
			["card", "deep", "inner", "joined", "outer"].sort(),
		);
	});

	it("takes a selected connector, and ignores ids that aren't shapes", () => {
		expect([...selectionScope(shapes, ["half", "gone"])]).toEqual(["half"]);
	});
});

describe("the region and size of an image", () => {
	it("pads what's drawn", () => {
		expect(
			exportRegion([
				{ x: 10, y: 20, width: 100, height: 50 },
				{ x: 300, y: -10, width: 0, height: 0 },
			]),
		).toEqual({
			x: 10 - EXPORT_PADDING,
			y: -10 - EXPORT_PADDING,
			width: 290 + EXPORT_PADDING * 2,
			height: 80 + EXPORT_PADDING * 2,
		});
		expect(exportRegion([])).toBeNull();
	});

	it("scales, within what browsers will draw", () => {
		expect(imageSize({ width: 1000, height: 500 }, 2)).toEqual({
			width: 2000,
			height: 1000,
			scale: 2,
			capped: false,
		});
		const huge = imageSize({ width: 20_000, height: 4000 }, 2);
		expect(huge.capped).toBe(true);
		expect(huge.width).toBeLessThanOrEqual(MAX_SIDE);
	});
});
