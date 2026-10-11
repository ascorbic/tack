import { type Rect, area, centre, contains } from "./geometry.ts";
import { STACK_SIZE } from "./stacks.ts";
import type { ShapeProps } from "./shapes.ts";
import { widgetSize } from "./widgetRegistry.ts";

// Sections contain shapes through each shape's `parent` key. Containment is
// decided geometrically when something is dropped, moved or resized (a shape
// belongs to the topmost section under its centre), then stored, so it reads
// the same everywhere without knowing how big anything rendered.

export const SECTION_COLORS = [
	"grey",
	"red",
	"orange",
	"yellow",
	"green",
	"blue",
	"purple",
] as const;
export type SectionColor = (typeof SECTION_COLORS)[number];

export const SECTION_MIN = { w: 160, h: 100 };
export const SECTION_DEFAULT = { w: 640, h: 440 };

export interface Size {
	w: number;
	h: number;
}

/** Sizes to assume for shapes that size to their content but haven't been measured. */
export const NOMINAL_SIZE: Partial<Record<ShapeProps["type"], Size>> = {
	card: { w: 252, h: 124 },
	sticky: { w: 176, h: 176 },
	text: { w: 200, h: 40 },
	decision: { w: 320, h: 230 },
	widget: { w: 360, h: 440 },
	action: { w: 296, h: 104 },
	stack: STACK_SIZE,
};

/** A shape's rendered size where known (e.g. measured by the client). */
export type SizeOf = (id: string) => Size | undefined;

/** The shape's box: its position, with its own size, a measured one, or a nominal one. */
export function boxOf(id: string, shape: ShapeProps, sizeOf?: SizeOf): Rect {
	if (shape.type === "section") {
		return {
			x: shape.x,
			y: shape.y,
			w: shape.w ?? SECTION_DEFAULT.w,
			h: shape.h ?? SECTION_DEFAULT.h,
		};
	}
	// Widgets are sized like sections: by their own w and h.
	if (shape.type === "widget") return { x: shape.x, y: shape.y, ...widgetSize(shape) };
	// Stacks are always a stack's size, whatever an open one draws (stacks.ts).
	if (shape.type === "stack") return { x: shape.x, y: shape.y, ...STACK_SIZE };
	const size = sizeOf?.(id) ?? NOMINAL_SIZE[shape.type] ?? { w: 0, h: 0 };
	return { x: shape.x, y: shape.y, w: size.w, h: size.h };
}

type StructureInput = ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>;

export interface Structure {
	/** Each shape's section, for valid links only. */
	parentOf: Map<string, string>;
	/** Each section's direct contents. */
	children: Map<string, string[]>;
	/** How deeply each shape is nested: 0 at the top level. */
	depth: Map<string, number>;
	/** Shapes whose stored parent is set but invalid (missing, not a section, or a cycle). */
	broken: Set<string>;
}

/**
 * Read containment from the shapes, ignoring links that dangle after
 * concurrent edits: a parent that's gone, isn't a section, or is part of a
 * cycle (two sections dropped into each other at the same time). Shapes with
 * broken links are treated as top-level.
 */
export function readStructure(shapes: StructureInput): Structure {
	const parentOf = new Map<string, string>();
	const broken = new Set<string>();
	for (const [id, shape] of shapes) {
		const parent = shape.parent;
		if (parent === undefined || parent === null) continue;
		if (shape.type === "connector") continue;
		if (typeof parent !== "string" || shapes.get(parent)?.type !== "section" || parent === id) {
			broken.add(id);
		} else {
			parentOf.set(id, parent);
		}
	}

	// Anything whose chain of parents loops never reaches the top level.
	const depth = new Map<string, number>();
	const depthOf = (id: string): number => {
		const known = depth.get(id);
		if (known !== undefined) return known;
		const chain: string[] = [];
		const seen = new Set<string>();
		let current: string | undefined = id;
		while (current !== undefined && !depth.has(current)) {
			if (seen.has(current)) {
				// A cycle: cut every link in it.
				const start = chain.indexOf(current);
				for (const member of chain.slice(start)) {
					parentOf.delete(member);
					broken.add(member);
				}
				break;
			}
			seen.add(current);
			chain.push(current);
			current = parentOf.get(current);
		}
		for (let i = chain.length - 1; i >= 0; i--) {
			const member = chain[i] as string;
			const parent = parentOf.get(member);
			depth.set(member, parent === undefined ? 0 : (depth.get(parent) ?? 0) + 1);
		}
		return depth.get(id) ?? 0;
	};
	for (const id of shapes.keys()) depthOf(id);

	const children = new Map<string, string[]>();
	for (const [id, parent] of parentOf) {
		const list = children.get(parent);
		if (list) list.push(id);
		else children.set(parent, [id]);
	}
	return { parentOf, children, depth, broken };
}

/** Everything inside a section, at any depth. */
export function descendantsOf(structure: Structure, id: string): string[] {
	const out: string[] = [];
	const stack = [...(structure.children.get(id) ?? [])];
	while (stack.length > 0) {
		const next = stack.pop() as string;
		out.push(next);
		stack.push(...(structure.children.get(next) ?? []));
	}
	return out;
}

export interface SectionGeometry {
	id: string;
	box: Rect;
	depth: number;
	z: string;
	/**
	 * How big it counts as, if not its box's area: a list (display.ts) is as
	 * big as its section, however few rows it draws, so cards still fit in it.
	 */
	area?: number;
}

/**
 * The section a shape with this box belongs in: the topmost section (deepest,
 * then highest in z-order) that contains the box's centre and is bigger than
 * it, so a big section dropped on a small one doesn't end up inside it.
 */
export function containerFor(
	box: Rect,
	sections: Iterable<SectionGeometry>,
	exclude?: ReadonlySet<string>,
): string | null {
	const point = centre(box);
	const size = area(box);
	let best: SectionGeometry | null = null;
	for (const section of sections) {
		if (exclude?.has(section.id)) continue;
		if (!contains(section.box, point) || (section.area ?? area(section.box)) <= size) continue;
		if (
			!best ||
			section.depth > best.depth ||
			(section.depth === best.depth && section.z > best.z)
		) {
			best = section;
		}
	}
	return best?.id ?? null;
}

/** Order sections bottom to top: outer before inner, then by z-order. */
export function compareSections(a: SectionGeometry, b: SectionGeometry): number {
	if (a.depth !== b.depth) return a.depth - b.depth;
	return a.z < b.z ? -1 : a.z > b.z ? 1 : 0;
}

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/**
 * Resize a rectangle by dragging one of its handles by `delta`, keeping the
 * opposite edges fixed and a minimum size (a section's, unless given).
 */
export function resizeRect(
	start: Rect,
	handle: ResizeHandle,
	delta: { x: number; y: number },
	min: Size = SECTION_MIN,
): Rect {
	let { x, y, w, h } = start;
	if (handle.includes("e")) w = Math.max(start.w + delta.x, min.w);
	if (handle.includes("s")) h = Math.max(start.h + delta.y, min.h);
	if (handle.includes("w")) {
		w = Math.max(start.w - delta.x, min.w);
		x = start.x + start.w - w;
	}
	if (handle.includes("n")) {
		h = Math.max(start.h - delta.y, min.h);
		y = start.y + start.h - h;
	}
	return { x, y, w, h };
}
