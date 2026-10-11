import { describe, expect, it } from "vite-plus/test";
import { labelPoint, labelWidth } from "../src/shared/connectors.ts";

// A connector's label sits on its middle, unless the connector is too short
// to show it there, when it moves beside the line (canvas review 24).

const route = (points: { x: number; y: number }[]) => {
	const a = points[0]!;
	const b = points.at(-1)!;
	return { points, middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
};

describe("labelPoint", () => {
	it("is the middle of a connector long enough for the label", () => {
		const long = route([
			{ x: 0, y: 0 },
			{ x: 400, y: 0 },
		]);
		expect(labelPoint(long, "blocked by")).toEqual(long.middle);
	});

	it("goes above a short level connector, clear of the line", () => {
		const short = route([
			{ x: 0, y: 0 },
			{ x: 12, y: 0 },
		]);
		const at = labelPoint(short, "blocks");
		expect(at.x).toBeCloseTo(6);
		// Half the pill's height and a gap above the line.
		expect(at.y).toBeLessThanOrEqual(-20);
	});

	it("goes left of a short upright connector, by half its width and more", () => {
		const short = route([
			{ x: 0, y: 0 },
			{ x: 0, y: 30 },
		]);
		const at = labelPoint(short, "depends on");
		expect(at.y).toBeCloseTo(15);
		expect(at.x).toBeLessThan(-labelWidth("depends on") / 2);
	});

	it("measures the whole route, bends and all", () => {
		const elbow = route([
			{ x: 0, y: 0 },
			{ x: 0, y: 200 },
			{ x: 10, y: 200 },
		]);
		expect(labelPoint(elbow, "next")).toEqual(elbow.middle);
	});
});
