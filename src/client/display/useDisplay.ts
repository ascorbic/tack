import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type DisplayLayout,
	type SectionLayout,
	type Slot,
	type SlotKind,
	type SortableCard,
	displaySections,
	insertionIndex,
	layoutDisplays,
	sortOf,
} from "../../shared/display.ts";
import { type Rect, centre } from "../../shared/geometry.ts";
import {
	NOMINAL_SIZE,
	type Structure,
	containerFor,
	descendantsOf,
	readStructure,
} from "../../shared/sections.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { sectionGeometries } from "../../shared/structure.ts";
import type { ShapeNode } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import type { RemoteDrag } from "../presence.ts";

// How sections showing lists and mini cards (#72) draw what's in them, frame
// by frame: each shape's slot, where a dragged shape would land (with a gap
// held open for it), and which shapes just changed how they show, so they
// can morph. The document only ever says which mode a section is in; the
// shapes keep their free-form positions, and this decides where they draw.

/** How long a shape that changed how it shows animates for. */
const MORPH_MS = 760;

export interface DrawnSlot extends Slot {
	/** Being dragged: drawn at the drag, at its slot's size. */
	dragging: boolean;
}

/** Where something being dragged would land in a list, if dropped now. */
export interface DisplayHover {
	section: string;
	index: number;
	ids: string[];
}

export interface DisplayState {
	/** Whether any section shows a list or grid: if not, nothing here applies. */
	active: boolean;
	shapes: ReadonlyMap<string, ShapeProps>;
	structure: Structure;
	/** The lists and grids as they'd be with nothing being dragged. */
	base: DisplayLayout;
	/** As drawn now, gaps and all. */
	layout: DisplayLayout;
	/** Every shape drawn as a row, mini card or group, including ones being dragged. */
	slots: ReadonlyMap<string, DrawnSlot>;
	/** Sections showing a list or grid (nested ones too), as drawn now. */
	sections: ReadonlyMap<string, SectionLayout>;
	hover: DisplayHover | null;
	/** Where shapes would land if dropped with these top-left corners. */
	hoverAt: (positions: ReadonlyMap<string, { x: number; y: number }>) => DisplayHover | null;
	/** Shapes that just changed how they show, and their place in the stagger. */
	morphing: ReadonlyMap<string, number>;
	/** The outermost list a shape is drawn in, if any. */
	rootOf: (id: string) => string | null;
	cardOf: (ref: string) => SortableCard | undefined;
}

/**
 * Where shapes at `positions` (top-left corners) would land if dropped: the
 * list under them, and where in it. Only one list at a time takes a drop.
 */
function hoverOf(
	{
		shapes,
		structure,
		base,
		lists,
		measured,
	}: {
		shapes: ReadonlyMap<string, ShapeProps>;
		structure: Structure;
		base: DisplayLayout;
		lists: ReadonlySet<string>;
		measured: ReadonlyMap<string, { width: number; height: number }>;
	},
	positions: ReadonlyMap<string, { x: number; y: number }>,
): DisplayHover | null {
	const geometry = sectionGeometries(shapes, structure, base);
	const dragged = new Set(positions.keys());
	let found = null as DisplayHover | null;
	for (const [id, at] of positions) {
		const shape = shapes.get(id);
		if (!shape || shape.type === "connector") continue;
		// What's carried along with something else doesn't land by itself.
		const parent = structure.parentOf.get(id);
		if (parent && dragged.has(parent)) continue;
		const slot = base.slots.get(id);
		const own = measured.get(id);
		const size = slot
			? { w: slot.rect.w, h: slot.rect.h }
			: shape.type === "section"
				? { w: shape.w ?? 0, h: shape.h ?? 0 }
				: own
					? { w: own.width, h: own.height }
					: (NOMINAL_SIZE[shape.type] ?? { w: 0, h: 0 });
		const box: Rect = { x: at.x, y: at.y, ...size };
		const exclude = new Set([id, ...descendantsOf(structure, id)]);
		const target = containerFor(box, geometry, exclude);
		if (!target || !lists.has(target)) continue;
		if (found && found.section !== target) continue;
		const index = insertionIndex(base, target, centre(box), dragged);
		found = found ? { ...found, ids: [...found.ids, id] } : { section: target, index, ids: [id] };
	}
	return found;
}

export function sortableCard(ref: string): SortableCard | undefined {
	const card = cardStore.get(ref);
	return card && !("missing" in card) ? card : undefined;
}

/** A counter that goes up when a card in a sorted list changes, so the sort follows it. */
function useSortVersion(shapes: ReadonlyMap<string, ShapeProps>, structure: Structure): number {
	const watched = useMemo(() => {
		const refs = new Set<string>();
		for (const [id, shape] of shapes) {
			if (shape.type !== "section" || !sortOf(shape)) continue;
			for (const child of structure.children.get(id) ?? []) {
				const ref = shapes.get(child)?.ref;
				if (ref) refs.add(ref);
			}
		}
		return refs;
	}, [shapes, structure]);
	const [version, setVersion] = useState(0);
	useEffect(() => {
		if (watched.size === 0) return;
		let frame = 0;
		const unsubscribe = cardStore.subscribeAll((key) => {
			if (!watched.has(key) || frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				setVersion((n) => n + 1);
			});
		});
		return () => {
			unsubscribe();
			cancelAnimationFrame(frame);
		};
	}, [watched]);
	return version;
}

const EMPTY_LAYOUT: DisplayLayout = { sections: new Map(), slots: new Map() };

export function useDisplay({
	shapeNodes,
	drags,
	overrides,
	measured,
}: {
	shapeNodes: ShapeNode[];
	/** Drags in progress, local and remote. */
	drags: ReadonlyMap<string, RemoteDrag>;
	/** Where shapes draw instead of the document's (drags, and contents following a section). */
	overrides: ReadonlyMap<string, RemoteDrag>;
	/** Free-form sizes, measured. */
	measured: ReadonlyMap<string, { width: number; height: number }>;
}): DisplayState {
	const shapes = useMemo(
		() => new Map(shapeNodes.map((node) => [node.id, node.data.shape] as const)),
		[shapeNodes],
	);
	const structure = useMemo(() => readStructure(shapes), [shapes]);
	const lists = useMemo(() => displaySections(shapes, structure), [shapes, structure]);
	const active = lists.size > 0;
	const version = useSortVersion(shapes, structure);
	const cardOf = sortableCard;

	// Sections being dragged (or following one) draw their lists there.
	const at = useMemo(() => {
		const moved = new Map<string, RemoteDrag>();
		for (const [id, position] of overrides) if (lists.has(id)) moved.set(id, position);
		return moved;
	}, [overrides, lists]);
	const atKey = [...at].map(([id, p]) => `${id}:${p.x},${p.y}`).join("|");

	const base = useMemo(() => {
		if (!active) return EMPTY_LAYOUT;
		void version;
		return layoutDisplays(shapes, structure, { at: (id) => at.get(id), cardOf });
		// `atKey` stands in for `at`, which is a new map every frame.
	}, [active, shapes, structure, atKey, version]);

	// Where each drag would land.
	const dragKey = active ? [...drags].map(([id, p]) => `${id}:${p.x},${p.y}`).join("|") : "";
	const hoverAt = useCallback(
		(positions: ReadonlyMap<string, { x: number; y: number }>) =>
			active ? hoverOf({ shapes, structure, base, lists, measured }, positions) : null,
		[active, shapes, structure, base, lists, measured],
	);
	// `dragKey` stands in for `drags`.
	const hover = useMemo(() => (drags.size > 0 ? hoverAt(drags) : null), [hoverAt, dragKey]);

	const layout = useMemo(() => {
		if (!active) return EMPTY_LAYOUT;
		if (drags.size === 0) return base;
		void version;
		return layoutDisplays(shapes, structure, {
			at: (id) => at.get(id),
			cardOf,
			exclude: new Set(drags.keys()),
			...(hover && {
				gap: { section: hover.section, index: hover.index, count: hover.ids.length },
			}),
		});
	}, [active, base, dragKey, hover, shapes, structure, atKey, version]);

	const slots = useMemo(() => {
		const out = new Map<string, DrawnSlot>();
		for (const [id, slot] of layout.slots) out.set(id, { ...slot, dragging: false });
		// Something being dragged out of a list keeps its slot's shape and size.
		for (const [id, drag] of drags) {
			const slot = base.slots.get(id);
			if (!slot || out.has(id)) continue;
			out.set(id, { ...slot, rect: { ...slot.rect, x: drag.x, y: drag.y }, dragging: true });
		}
		return out;
	}, [layout, base, dragKey]);

	const rootOf = useMemo(() => {
		const cache = new Map<string, string | null>();
		return (id: string): string | null => {
			if (cache.has(id)) return cache.get(id) ?? null;
			let root: string | null = null;
			let current = structure.parentOf.get(id);
			const seen = new Set<string>();
			while (current !== undefined && !seen.has(current)) {
				seen.add(current);
				if (lists.has(current)) root = current;
				current = structure.parentOf.get(current);
			}
			cache.set(id, root);
			return root;
		};
	}, [structure, lists]);

	const morphing = useMorphs(slots, layout, shapes);

	return useMemo(
		() => ({
			active,
			shapes,
			structure,
			base,
			layout,
			slots,
			sections: layout.sections,
			hover,
			hoverAt,
			morphing,
			rootOf,
			cardOf,
		}),
		[active, shapes, structure, base, layout, slots, hover, hoverAt, morphing, rootOf],
	);
}

/**
 * Shapes whose way of showing just changed (cards to rows, rows to mini
 * cards, a row pulled out onto the board), with their place in a stagger.
 * Changes are kept by time rather than diffed per render, so a render that
 * runs twice still sees them.
 */
function useMorphs(
	slots: ReadonlyMap<string, DrawnSlot>,
	layout: DisplayLayout,
	shapes: ReadonlyMap<string, ShapeProps>,
): ReadonlyMap<string, number> {
	const seen = useRef(new Map<string, SlotKind | "free">());
	const changed = useRef(new Map<string, { at: number; order: number }>());
	const [, setTick] = useState(0);
	const now = performance.now();
	let order = 0;
	for (const [id, shape] of shapes) {
		if (shape.type === "connector") continue;
		const kind: SlotKind | "free" = slots.get(id)?.kind ?? "free";
		const before = seen.current.get(id);
		const sectionMode = shape.type === "section" ? (layout.sections.get(id)?.mode ?? "free") : null;
		const key = (sectionMode ? `${kind}:${sectionMode}` : kind) as SlotKind | "free";
		if (before !== undefined && before !== key) {
			const index = slots.get(id)?.index ?? order++;
			changed.current.set(id, { at: now, order: index });
		}
		seen.current.set(id, key);
	}
	for (const id of seen.current.keys()) if (!shapes.has(id)) seen.current.delete(id);
	const out = new Map<string, number>();
	let soonest = Number.POSITIVE_INFINITY;
	for (const [id, { at, order: i }] of changed.current) {
		const left = at + MORPH_MS - now;
		if (left <= 0) changed.current.delete(id);
		else {
			out.set(id, i);
			soonest = Math.min(soonest, left);
		}
	}
	const key = [...out.keys()].sort().join(" ");
	useEffect(() => {
		if (!Number.isFinite(soonest)) return;
		const timer = setTimeout(() => setTick((n) => n + 1), soonest + 20);
		return () => clearTimeout(timer);
	}, [key, soonest]);
	// Keep the same map while nothing's changed, so nodes keep their identity.
	const last = useRef<{ key: string; map: Map<string, number> }>({ key: "", map: new Map() });
	if (last.current.key !== key) last.current = { key, map: out };
	return last.current.map;
}
