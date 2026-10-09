import { type Point, type Rect, intersects } from "./geometry.ts";
import { type Size, type SizeOf, boxOf } from "./sections.ts";
import type { ShapeProps } from "./shapes.ts";

// Finding free space for shapes that automation adds (rules, M3). Automation
// never moves what people placed, so a new shape goes where nothing is: not
// over another shape, not across a section's edge, and not over a section's
// title. Sizes are nominal unless a client's measurements are passed in.

/** Space kept between a placed shape and its neighbours. */
export const PLACE_GAP = 24;
/** The room to leave for a card someone hasn't seen yet: a pull request with CI is taller. */
export const PLACED_CARD: Size = { w: 252, h: 150 };
/** How far above a section its title pill reaches. */
const SECTION_TITLE = { w: 260, h: 36 };

interface Obstacles {
	/** Shapes, and section titles: nothing may overlap these. */
	boxes: Rect[];
	/** Sections: a placed shape is either wholly inside one or wholly outside it. */
	sections: { id: string; box: Rect }[];
}

function obstaclesOf(shapes: ReadonlyMap<string, ShapeProps>, sizeOf?: SizeOf): Obstacles {
	const boxes: Rect[] = [];
	const sections: Obstacles["sections"] = [];
	for (const [id, shape] of shapes) {
		if (shape.type === "connector") continue;
		const box = boxOf(id, shape, sizeOf);
		if (shape.type === "section") {
			sections.push({ id, box });
			boxes.push({
				x: box.x,
				y: box.y - SECTION_TITLE.h,
				w: Math.min(box.w, SECTION_TITLE.w),
				h: SECTION_TITLE.h,
			});
		} else {
			boxes.push(box);
		}
	}
	return { boxes, sections };
}

function inflate(rect: Rect, by: number): Rect {
	return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

function inside(inner: Rect, outer: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}

function isFree(rect: Rect, obstacles: Obstacles, within?: string): boolean {
	const padded = inflate(rect, PLACE_GAP - 1);
	if (obstacles.boxes.some((box) => intersects(padded, box))) return false;
	for (const section of obstacles.sections) {
		if (section.id === within) continue;
		if (intersects(padded, section.box) && !inside(padded, section.box)) return false;
		// Placing into a particular section means not into one nested in it.
		if (within && intersects(rect, section.box)) {
			const container = obstacles.sections.find((s) => s.id === within);
			if (container && inside(section.box, container.box)) return false;
		}
	}
	return true;
}

/**
 * Free space for a shape of `size` beside `anchor` (a shape's id): to its
 * right if there's room, otherwise as near there as possible, favouring
 * below and to the right over above and to the left.
 */
export function spotBeside(
	shapes: ReadonlyMap<string, ShapeProps>,
	anchor: string,
	size: Size = PLACED_CARD,
	sizeOf?: SizeOf,
): Point | null {
	const shape = shapes.get(anchor);
	if (!shape) return null;
	const box = boxOf(anchor, shape, sizeOf);
	const ideal = { x: box.x + box.w + PLACE_GAP, y: box.y };
	return nearestFree(ideal, size, obstaclesOf(shapes, sizeOf), (x) => (x < box.x ? 400 : 0));
}

/**
 * Free space for a shape of `size` inside a section, reading left to right
 * and top to bottom, or null if it's full.
 */
export function spotInSection(
	shapes: ReadonlyMap<string, ShapeProps>,
	section: string,
	size: Size = PLACED_CARD,
	sizeOf?: SizeOf,
): Point | null {
	const shape = shapes.get(section);
	if (!shape || shape.type !== "section") return null;
	const box = boxOf(section, shape);
	const obstacles = obstaclesOf(shapes, sizeOf);
	const step = 12;
	for (let y = box.y + PLACE_GAP; y + size.h + PLACE_GAP <= box.y + box.h; y += step) {
		for (let x = box.x + PLACE_GAP; x + size.w + PLACE_GAP <= box.x + box.w; x += step) {
			const rect = { x, y, w: size.w, h: size.h };
			if (isFree(rect, obstacles, section)) return { x, y };
		}
	}
	return null;
}

/** Free space below a section (for when it's full), as near its bottom-left as there is. */
export function spotBelow(
	shapes: ReadonlyMap<string, ShapeProps>,
	section: string,
	size: Size = PLACED_CARD,
	sizeOf?: SizeOf,
): Point | null {
	const shape = shapes.get(section);
	if (!shape) return null;
	const box = boxOf(section, shape, sizeOf);
	const ideal = { x: box.x, y: box.y + box.h + PLACE_GAP * 2 };
	return nearestFree(ideal, size, obstaclesOf(shapes, sizeOf), (_x, y) =>
		y < box.y + box.h ? 600 : 0,
	);
}

const SEARCH_STEPS = 24;

function nearestFree(
	ideal: Point,
	size: Size,
	obstacles: Obstacles,
	penalty: (x: number, y: number) => number,
): Point | null {
	const stepX = Math.round((size.w + PLACE_GAP) / 2);
	const stepY = Math.round((size.h + PLACE_GAP) / 2);
	const candidates: { x: number; y: number; cost: number }[] = [];
	for (let i = -SEARCH_STEPS; i <= SEARCH_STEPS; i++) {
		for (let j = -SEARCH_STEPS; j <= SEARCH_STEPS; j++) {
			const x = Math.round(ideal.x + i * stepX);
			const y = Math.round(ideal.y + j * stepY);
			// Below is a better neighbour than above, and right than left.
			const cost =
				Math.hypot((x - ideal.x) * (i < 0 ? 1.4 : 1), (y - ideal.y) * (j < 0 ? 1.5 : 1)) +
				penalty(x, y);
			candidates.push({ x, y, cost });
		}
	}
	candidates.sort((a, b) => a.cost - b.cost);
	for (const candidate of candidates) {
		if (isFree({ x: candidate.x, y: candidate.y, w: size.w, h: size.h }, obstacles)) {
			return { x: candidate.x, y: candidate.y };
		}
	}
	return null;
}
