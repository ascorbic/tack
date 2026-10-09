import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_ROUTE,
	endAt,
	readConnector,
	resolveEnds,
	routeConnector,
	withFallbacks,
} from "../src/shared/connectors.ts";
import {
	anchorSide,
	clipToOutline,
	distanceToPolyline,
	nearestOutlineAnchor,
	pointAlong,
	rectFromPoints,
} from "../src/shared/geometry.ts";

const box = { x: 0, y: 0, w: 200, h: 100 };

describe("geometry", () => {
	it("clips a ray from the centre to the outline", () => {
		expect(clipToOutline(box, { x: 500, y: 50 })).toEqual({
			point: { x: 200, y: 50 },
			side: "right",
		});
		expect(clipToOutline(box, { x: 100, y: -300 })).toEqual({
			point: { x: 100, y: 0 },
			side: "top",
		});
		// Diagonal: leaves through the nearer edge.
		const corner = clipToOutline(box, { x: 300, y: 150 });
		expect(corner.side).toBe("bottom");
		expect(corner.point).toEqual({ x: 200, y: 100 });
	});

	it("finds the nearest point on the outline from inside and outside", () => {
		expect(nearestOutlineAnchor(box, { x: 190, y: 40 })).toEqual({
			anchor: { x: 1, y: 0.4 },
			distance: 10,
		});
		expect(nearestOutlineAnchor(box, { x: 50, y: -8 })).toEqual({
			anchor: { x: 0.25, y: 0 },
			distance: 8,
		});
		expect(anchorSide({ x: 0.25, y: 0 })).toBe("top");
		expect(anchorSide({ x: 0, y: 0.6 })).toBe("left");
	});

	it("measures distance to a polyline and walks along it", () => {
		const line = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
		];
		expect(distanceToPolyline({ x: 50, y: 10 }, line)).toBe(10);
		expect(distanceToPolyline({ x: 120, y: 50 }, line)).toBe(20);
		expect(pointAlong(line, 0.5)).toEqual({ x: 100, y: 0 });
		expect(pointAlong(line, 0.75)).toEqual({ x: 100, y: 50 });
	});

	it("normalises rectangles drawn in any direction", () => {
		expect(rectFromPoints({ x: 10, y: 50 }, { x: -10, y: 20 })).toEqual({
			x: -10,
			y: 20,
			w: 20,
			h: 30,
		});
	});
});

describe("connector ends", () => {
	const targets = [
		{ id: "card", type: "card" as const, box: { x: 0, y: 0, w: 200, h: 100 } },
		{ id: "section", type: "section" as const, box: { x: -100, y: -100, w: 600, h: 400 } },
	];

	it("pins to the outline near an edge, snapping to the middle of a side", () => {
		expect(endAt({ x: 196, y: 30 }, targets, 10)).toEqual({
			x: 200,
			y: 30,
			shape: "card",
			anchor: { x: 1, y: 0.3 },
		});
		expect(endAt({ x: 204, y: 47 }, targets, 10)).toEqual({
			x: 200,
			y: 50,
			shape: "card",
			anchor: { x: 1, y: 0.5 },
		});
	});

	it("floats around the outline when dropped well inside a shape", () => {
		expect(endAt({ x: 100, y: 50 }, targets, 10)).toEqual({ x: 100, y: 50, shape: "card" });
	});

	it("only binds to sections near their outline", () => {
		expect(endAt({ x: 400, y: 200 }, targets, 10)).toEqual({ x: 400, y: 200 });
		expect(endAt({ x: 498, y: 200 }, targets, 10)).toMatchObject({ shape: "section" });
	});

	it("can skip shapes, e.g. the one a connector starts from", () => {
		expect(endAt({ x: 100, y: 50 }, targets, 10, new Set(["card"]))).toEqual({ x: 100, y: 50 });
	});

	it("aims floating ends at each other and leaves a gap at the outline", () => {
		const boxes = new Map([
			["a", { x: 0, y: 0, w: 100, h: 100 }],
			["b", { x: 300, y: 0, w: 100, h: 100 }],
		]);
		const { start, end } = resolveEnds(
			{ x: 0, y: 0, shape: "a" },
			{ x: 0, y: 0, shape: "b" },
			(id) => boxes.get(id),
			5,
		);
		expect(start.point).toEqual({ x: 105, y: 50 });
		expect(start.normal).toEqual({ x: 1, y: 0 });
		expect(end.point).toEqual({ x: 295, y: 50 });
	});

	it("draws an end bound to a missing shape at its last known point", () => {
		const { end } = resolveEnds({ x: 0, y: 0 }, { x: 40, y: 60, shape: "gone" }, () => undefined);
		expect(end).toEqual({ point: { x: 40, y: 60 }, normal: null, shape: null });
	});

	it("records fallback points for bound ends", () => {
		const boxes = new Map([["a", { x: 0, y: 0, w: 100, h: 100 }]]);
		const { from, to } = withFallbacks(
			{ x: 0, y: 0, shape: "a", anchor: { x: 0.5, y: 1 } },
			{ x: 50, y: 400 },
			(id) => boxes.get(id),
		);
		expect(from).toEqual({ x: 50, y: 100, shape: "a", anchor: { x: 0.5, y: 1 } });
		expect(to).toEqual({ x: 50, y: 400 });
	});

	it("reads connectors tolerantly", () => {
		expect(readConnector({ from: { x: 0, y: 0 } })).toBeNull();
		expect(
			readConnector({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, route: "zigzag" as never }),
		).toMatchObject({ route: DEFAULT_ROUTE, arrow: "end", color: "ink", dash: false, label: "" });
	});
});

describe("routing", () => {
	const right = { point: { x: 0, y: 0 }, normal: { x: 1, y: 0 }, shape: "a" };
	const left = { point: { x: 200, y: 100 }, normal: { x: -1, y: 0 }, shape: "b" };

	it("routes elbows with right angles only", () => {
		const route = routeConnector(right, left, "elbow");
		for (let i = 1; i < route.points.length; i++) {
			const a = route.points[i - 1];
			const b = route.points[i];
			expect(a?.x === b?.x || a?.y === b?.y).toBe(true);
		}
		expect(route.points[0]).toEqual(right.point);
		expect(route.points.at(-1)).toEqual(left.point);
		expect(route.middle).toEqual({ x: 100, y: 50 });
	});

	it("routes elbows around when the ends face away from each other", () => {
		const backwards = { point: { x: -200, y: 100 }, normal: { x: 1, y: 0 }, shape: "b" };
		const route = routeConnector(right, backwards, "elbow");
		for (let i = 1; i < route.points.length; i++) {
			const a = route.points[i - 1];
			const b = route.points[i];
			expect(a?.x === b?.x || a?.y === b?.y).toBe(true);
		}
	});

	it("leaves curves along each end's normal", () => {
		const route = routeConnector(right, left, "curved");
		expect(route.d.startsWith("M0,0 C")).toBe(true);
		// Leaves heading right, arrives heading right (into the left side).
		expect(Math.cos(route.startAngle)).toBeCloseTo(-1, 1);
		expect(Math.cos(route.endAngle)).toBeCloseTo(1, 1);
	});

	it("trims ends for arrowheads", () => {
		const route = routeConnector(
			{ point: { x: 0, y: 0 }, normal: null, shape: null },
			{ point: { x: 100, y: 0 }, normal: null, shape: null },
			"straight",
			{ start: 0, end: 10 },
		);
		expect(route.d).toBe("M0,0 L90,0");
	});
});
