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

/**
 * Free space for a shape of `size` as near `ideal` (its top left) as there
 * is, outside any section it would cross. For shapes that belong nowhere in
 * particular, such as a card someone asked for in a comment (#58).
 */
export function spotNear(
	shapes: ReadonlyMap<string, ShapeProps>,
	ideal: Point,
	size: Size = PLACED_CARD,
	sizeOf?: SizeOf,
): Point | null {
	return nearestFree(ideal, size, obstaclesOf(shapes, sizeOf), () => 0);
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

/** The smallest a section placed with a click shrinks to, to fit a gap. */
const SECTION_SHRINK_MIN: Size = { w: 320, h: 220 };

/**
 * Where a section placed with a click (not drawn) goes: centred on the
 * click at `size` if that's clear, or shrunk to fit the gap there, or at
 * full size in the nearest free space. Never over another shape, across a
 * section's edge or over a section's title, so it never takes shapes from
 * other sections (or anything else): it starts empty, as a click promises.
 * Wholly inside a section is fine: a section can hold sections.
 */
export function sectionSpot(
	shapes: ReadonlyMap<string, ShapeProps>,
	at: Point,
	size: Size,
	sizeOf?: SizeOf,
): Rect {
	const obstacles = obstaclesOf(shapes, sizeOf);
	const centred = (s: Size): Rect => ({
		x: Math.round(at.x - s.w / 2),
		y: Math.round(at.y - s.h / 2),
		w: s.w,
		h: s.h,
	});
	// The title pill sits above the section, so it needs to be clear too.
	const clear = (rect: Rect) =>
		isFree(
			{ x: rect.x, y: rect.y - SECTION_TITLE.h, w: rect.w, h: rect.h + SECTION_TITLE.h },
			obstacles,
		);
	for (let scale = 1; scale >= 0.4; scale -= 0.1) {
		const s = {
			w: Math.max(SECTION_SHRINK_MIN.w, Math.round(size.w * scale)),
			h: Math.max(SECTION_SHRINK_MIN.h, Math.round(size.h * scale)),
		};
		const rect = centred(s);
		if (clear(rect)) return rect;
		if (s.w === SECTION_SHRINK_MIN.w && s.h === SECTION_SHRINK_MIN.h) break;
	}
	const ideal = centred(size);
	const spot = nearestFree(
		{ x: ideal.x, y: ideal.y - SECTION_TITLE.h },
		{ w: size.w, h: size.h + SECTION_TITLE.h },
		obstacles,
		() => 0,
	);
	return spot ? { x: spot.x, y: spot.y + SECTION_TITLE.h, w: size.w, h: size.h } : ideal;
}

/**
 * Where a group of shapes laid out together (`box`, their bounds) should go
 * so it doesn't land on anything else: null if it's clear where it is,
 * otherwise the nearest free top left for it. `moving` are the shapes in
 * the group, which don't count, and nor does anything inside them.
 */
export function slideClear(
	shapes: ReadonlyMap<string, ShapeProps>,
	moving: ReadonlySet<string>,
	box: Rect,
	sizeOf?: SizeOf,
): Point | null {
	const within = (id: string): boolean => {
		const parent = shapes.get(id)?.parent;
		return typeof parent === "string" && (moving.has(parent) || within(parent));
	};
	const others = new Map<string, ShapeProps>();
	for (const [id, shape] of shapes) {
		if (!moving.has(id) && !within(id)) others.set(id, shape);
	}
	const obstacles = obstaclesOf(others, sizeOf);
	const crossing = obstacles.sections.some(
		(section) => intersects(box, section.box) && !inside(box, section.box),
	);
	if (!crossing && !obstacles.boxes.some((other) => intersects(box, other))) return null;
	return nearestFree({ x: box.x, y: box.y }, { w: box.w, h: box.h }, obstacles, () => 0);
}
