import { useCallback, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Point, Rect } from "../shared/geometry.ts";
import {
	NOMINAL_SIZE,
	type SectionGeometry,
	type Size,
	containerFor,
	descendantsOf,
	readStructure,
} from "../shared/sections.ts";
import { SECTION_Z, type ShapeNode } from "./board.ts";
import { useAwarenessField } from "./ephemeral.ts";
import type { RemoteDrag } from "./presence.ts";

// How sections shape what's on screen while things are in motion: contents
// following a section that's being dragged, sections being resized, which
// section a dragged shape would land in, and how all of that stacks. None of
// it touches the document until a drop or a resize ends.

/** A section being dragged: where it started, and how far it's gone. */
export interface SectionDrag {
	box: Rect;
	delta: Point;
}

export interface CanvasStructure {
	/** Positions to draw instead of the document's, including contents following their section. */
	overrides: Map<string, RemoteDrag>;
	/** Sections being resized, by anyone. */
	resizes: Map<string, Rect>;
	sectionDrags: SectionDrag[];
	/** Shapes following a section someone else is dragging. */
	followsRemote: ReadonlySet<string>;
	/** Sections a dragged shape would land in if dropped now. */
	dropTargets: ReadonlySet<string>;
	zIndexOf: (node: ShapeNode) => number | undefined;
	/** Show (or stop showing) a resize in progress. */
	setResize: (id: string, rect: Rect | null) => void;
	/** Everything inside any of these sections, at any depth. */
	contentsOf: (ids: Iterable<string>) => string[];
}

/** The size a node is drawn at: its own, measured, or nominal. */
export function nodeSize(node: ShapeNode, measured?: { width?: number; height?: number }): Size {
	const shape = node.data.shape;
	if (shape.type === "section") return { w: shape.w ?? 0, h: shape.h ?? 0 };
	if (measured?.width && measured.height) return { w: measured.width, h: measured.height };
	return NOMINAL_SIZE[shape.type] ?? { w: 0, h: 0 };
}

/** Where a node is drawn, with its size. */
export function nodeBox(node: ShapeNode): Rect {
	const shape = node.data.shape;
	const size =
		shape.type === "section"
			? { w: node.width ?? shape.w ?? 0, h: node.height ?? shape.h ?? 0 }
			: nodeSize(node, node.measured);
	return { x: node.position.x, y: node.position.y, ...size };
}

export function useCanvasStructure({
	shapeNodes,
	drags,
	measured,
	awareness,
}: {
	shapeNodes: ShapeNode[];
	/** Drags in progress, local and remote. */
	drags: Map<string, RemoteDrag>;
	measured: Map<string, { width: number; height: number }>;
	awareness: Awareness;
}): CanvasStructure {
	const [remoteResizes, publishResizes] = useAwarenessField<Record<string, Rect>>(
		awareness,
		"resizes",
	);
	const [localResizes, setLocalResizes] = useState<Map<string, Rect>>(() => new Map());
	const localResizesRef = useRef(localResizes);

	const setResize = useCallback(
		(id: string, rect: Rect | null) => {
			const next = new Map(localResizesRef.current);
			if (rect) next.set(id, rect);
			else next.delete(id);
			localResizesRef.current = next;
			setLocalResizes(next);
			publishResizes(next.size > 0 ? Object.fromEntries(next) : null);
		},
		[publishResizes],
	);

	const resizes = useMemo(() => {
		const merged = new Map<string, Rect>();
		for (const { value } of remoteResizes) {
			for (const [id, rect] of Object.entries(value)) merged.set(id, rect);
		}
		for (const [id, rect] of localResizes) merged.set(id, rect);
		return merged;
	}, [remoteResizes, localResizes]);

	const structure = useMemo(
		() => readStructure(new Map(shapeNodes.map((node) => [node.id, node.data.shape]))),
		[shapeNodes],
	);

	const motion = useMemo(() => {
		const byId = new Map(shapeNodes.map((node) => [node.id, node]));
		const overrides = new Map(drags);
		const followers = new Set<string>();
		const followsRemote = new Set<string>();
		const sectionDrags: SectionDrag[] = [];

		// Contents follow a dragged section, unless they're being dragged
		// themselves (in which case they carry their own contents).
		const follow = (section: string, delta: Point, remote: boolean) => {
			for (const child of structure.children.get(section) ?? []) {
				if (drags.has(child)) continue;
				const base = byId.get(child);
				if (!base) continue;
				overrides.set(child, { x: base.position.x + delta.x, y: base.position.y + delta.y });
				followers.add(child);
				if (remote) followsRemote.add(child);
				follow(child, delta, remote);
			}
		};
		for (const [id, drag] of drags) {
			const base = byId.get(id);
			if (!base || base.data.shape.type !== "section") continue;
			const delta = { x: drag.x - base.position.x, y: drag.y - base.position.y };
			sectionDrags.push({ box: { ...base.position, ...nodeSize(base) }, delta });
			follow(id, delta, drag.user !== undefined);
		}
		return { overrides, followers, followsRemote, sectionDrags };
	}, [shapeNodes, drags, structure]);

	// Where each dragged shape would land, given where everything is now.
	const dropKey = useMemo(() => {
		if (drags.size === 0) return "";
		const sections: SectionGeometry[] = [];
		for (const node of shapeNodes) {
			if (node.data.shape.type !== "section") continue;
			const at = resizes.get(node.id) ?? motion.overrides.get(node.id) ?? node.position;
			sections.push({
				id: node.id,
				box: { ...nodeSize(node), ...resizes.get(node.id), x: at.x, y: at.y },
				depth: structure.depth.get(node.id) ?? 0,
				z: node.data.shape.z,
			});
		}
		const byId = new Map(shapeNodes.map((node) => [node.id, node]));
		const targets = new Set<string>();
		for (const [id, drag] of drags) {
			const node = byId.get(id);
			if (!node) continue;
			const exclude = new Set([id, ...descendantsOf(structure, id)]);
			const box = { ...nodeSize(node, measured.get(id)), x: drag.x, y: drag.y };
			const target = containerFor(box, sections, exclude);
			if (target && target !== (structure.parentOf.get(id) ?? null)) targets.add(target);
		}
		return [...targets].sort().join(" ");
	}, [drags, shapeNodes, resizes, motion.overrides, structure, measured]);
	const dropTargets = useMemo(() => new Set(dropKey ? dropKey.split(" ") : []), [dropKey]);

	const zIndexOf = useCallback(
		(node: ShapeNode): number | undefined => {
			const section = node.data.shape.type === "section";
			const depth = section ? (node.zIndex ?? SECTION_Z) - SECTION_Z : 0;
			// A dragged section floats, but beneath the contents it carries.
			// (A selected shape dragged along with it gets 1000 + React Flow's
			// 1000 for selection, so following sections stay below that.)
			if (motion.followers.has(node.id)) return section ? 1500 + depth : 2100;
			if (drags.has(node.id)) return section ? 500 + depth : 1000;
			return node.zIndex;
		},
		[motion.followers, drags],
	);

	const contentsOf = useCallback(
		(ids: Iterable<string>) => [...ids].flatMap((id) => descendantsOf(structure, id)),
		[structure],
	);

	return useMemo(
		() => ({
			contentsOf,
			overrides: motion.overrides,
			resizes,
			sectionDrags: motion.sectionDrags,
			followsRemote: motion.followsRemote,
			dropTargets,
			zIndexOf,
			setResize,
		}),
		[contentsOf, motion, resizes, dropTargets, zIndexOf, setResize],
	);
}

/** A stable `sizeOf` for structural edits, reading the latest measured sizes. */
export function useSizeOf(measured: Map<string, { width: number; height: number }>) {
	const ref = useRef(measured);
	ref.current = measured;
	return useCallback((id: string): Size | undefined => {
		const size = ref.current.get(id);
		return size ? { w: size.width, h: size.height } : undefined;
	}, []);
}
