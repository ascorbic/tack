import { describe, expect, it } from "vite-plus/test";
import { SNAPSHOT_FRAME, snapshotRegion } from "../src/client/actions/snapshotFrame.ts";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const VISIBLE = rect(-2000, -2000, 4000, 4000);

describe("a backlink snapshot's frame", () => {
	it("frames the selection with even padding, not a field of empty board", () => {
		const selection = rect(0, 0, 252, 120);
		expect(snapshotRegion(selection, VISIBLE, [selection])).toEqual(
			rect(-SNAPSHOT_FRAME, -SNAPSHOT_FRAME, 252 + SNAPSHOT_FRAME * 2, 120 + SNAPSHOT_FRAME * 2),
		);
	});

	it("takes in its neighbours whole, never cutting one in half", () => {
		const selection = rect(0, 0, 252, 120);
		// Beside it, partly within reach: taken in whole.
		const beside = rect(-300, 10, 252, 140);
		// Far away: left out.
		const far = rect(1200, 0, 252, 120);
		const region = snapshotRegion(selection, VISIBLE, [selection, beside, far]);
		expect(region.x).toBe(-300 - SNAPSHOT_FRAME);
		expect(region.y).toBe(-SNAPSHOT_FRAME);
		expect(region.x + region.width).toBe(252 + SNAPSHOT_FRAME);
		expect(region.y + region.height).toBe(150 + SNAPSHOT_FRAME);
	});

	it("takes in what its padding would otherwise clip", () => {
		const selection = rect(0, 0, 252, 120);
		// A neighbour within reach is taken in; one past it is out of reach,
		// but the frame's padding would cut it, so it's taken in too.
		const neighbour = rect(0, 200, 252, 120);
		const past = rect(0, 350, 252, 120);
		const region = snapshotRegion(selection, VISIBLE, [selection, neighbour, past]);
		expect(region.y + region.height).toBe(470 + SNAPSHOT_FRAME);
		expect(region.y).toBe(-SNAPSHOT_FRAME);
	});

	it("takes in what pokes into the framed area", () => {
		const selection = rect(0, 300, 252, 120);
		// Within reach above, widening what's framed to the left...
		const above = rect(-300, 150, 252, 120);
		// ...which now overlaps a tall sticky that wasn't within reach.
		const tall = rect(-600, 0, 330, 200);
		const region = snapshotRegion(selection, VISIBLE, [selection, above, tall]);
		expect(region.y).toBe(-SNAPSHOT_FRAME);
		expect(region.x).toBe(-600 - SNAPSHOT_FRAME);
	});

	it("leaves out neighbours that are off screen, since they aren't drawn", () => {
		const selection = rect(0, 0, 252, 120);
		const offscreen = rect(-150, 0, 140, 120);
		const visible = rect(-100, -100, 800, 600);
		// Not taken in, and not cut either: the edge stops short of it.
		expect(snapshotRegion(selection, visible, [selection, offscreen]).x).toBe(-4);
	});
});
