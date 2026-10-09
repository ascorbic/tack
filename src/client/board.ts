import type { Node, NodeChange } from "@xyflow/react";
import { useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { addDecision } from "../shared/decisions.ts";
import { NOMINAL_SIZE, type SizeOf, readStructure } from "../shared/sections.ts";
import {
	type Author,
	type ShapeFont,
	type ShapeProps,
	type ShapeType,
	type TextSize,
	addShape,
	nextZ,
	readShape,
	shapesMap,
} from "../shared/shapes.ts";
import { commitMoves, placeInSections, removeShapes } from "../shared/structure.ts";
import { transactLocal } from "./undo.ts";

export type ShapeNode = Node<{
	shape: ShapeProps;
	id: string;
	/** Sections: how many shapes are directly inside. */
	count?: number;
}>;

/**
 * Sections sit beneath everything else, outer ones beneath inner ones. This
 * is negative so that React Flow lifting a selected node by 1000 still
 * leaves a selected section beneath the shapes in it.
 */
export const SECTION_Z = -2000;

// Shapes added moments ago, so they can animate in. Big batches (a board
// loading, a scenario seeding) don't count: only a few shapes at a time.
const FRESH_MS = 1500;
const FRESH_BATCH = 5;
const freshShapes = new Map<string, number>();

export function isFresh(id: string): boolean {
	const added = freshShapes.get(id);
	return added !== undefined && performance.now() - added < FRESH_MS;
}

/**
 * Derives React Flow nodes from the Yjs shapes map. Node objects are reused
 * when a shape hasn't changed, so React Flow's memoised nodes skip re-render.
 */
export function useShapeNodes(doc: Y.Doc): ShapeNode[] {
	const store = useMemo(() => createNodeStore(doc), [doc]);
	return useSyncExternalStore(store.subscribe, () => store.getSnapshot());
}

function createNodeStore(doc: Y.Doc) {
	const shapes = shapesMap(doc);
	const cache = new Map<string, ShapeNode>();
	let snapshot: ShapeNode[] = [];

	const rebuild = (changed?: Set<string>) => {
		// Containment decides sections' stacking and counts, so it's read for
		// every rebuild; a section's node is replaced when either changes.
		const links = new Map<string, { type: ShapeType; parent?: string | null }>();
		for (const [id, shape] of shapes) {
			links.set(id, {
				type: shape.get("type") as ShapeType,
				parent: shape.get("parent") as string | null | undefined,
			});
		}
		const structure = readStructure(links);
		const nodes: ShapeNode[] = [];
		for (const [id, shape] of shapes) {
			// Connectors are drawn on their own layer, not as nodes.
			const type = links.get(id)?.type;
			if (type === "connector") continue;
			const section = type === "section";
			const count = section ? (structure.children.get(id)?.length ?? 0) : undefined;
			const zIndex = section ? SECTION_Z + (structure.depth.get(id) ?? 0) : 0;
			let node = cache.get(id);
			if (
				!node ||
				!changed ||
				changed.has(id) ||
				node.data.count !== count ||
				node.zIndex !== zIndex
			) {
				const props = readShape(shape);
				node = {
					id,
					type: props.type,
					position: { x: props.x, y: props.y },
					data: { shape: props, id, count },
					zIndex,
					...(section && {
						width: props.w,
						height: props.h,
						// Sections are picked up by their title; dragging inside one
						// selects what's in it.
						dragHandle: ".section-handle",
					}),
				};
				cache.set(id, node);
			}
			nodes.push(node);
		}
		for (const id of cache.keys()) if (!shapes.has(id)) cache.delete(id);
		// Sections first (outer, then inner), then everything else by z.
		nodes.sort((a, b) =>
			a.zIndex !== b.zIndex
				? (a.zIndex ?? 0) - (b.zIndex ?? 0)
				: a.data.shape.z < b.data.shape.z
					? -1
					: 1,
		);
		snapshot = nodes;
	};
	rebuild();

	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			// The document may have synced before React subscribed; React
			// re-reads the snapshot after subscribing, so refresh it first.
			rebuild();
			const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
				const changed = new Set<string>();
				for (const event of events) {
					if (event.target === shapes) {
						const added = [...event.keys].filter(([, change]) => change.action === "add");
						if (added.length <= FRESH_BATCH) {
							for (const [key] of added) freshShapes.set(key, performance.now());
						}
						for (const key of event.keys.keys()) changed.add(key);
						continue;
					} else if (typeof event.path[0] === "string") changed.add(event.path[0]);
				}
				rebuild(changed);
				listener();
			};
			shapes.observeDeep(observer);
			return () => shapes.unobserveDeep(observer);
		},
	};
}

export type Position = { x: number; y: number };

/**
 * Write React Flow changes into the document. Positions are committed only
 * when a drag ends: every Yjs write leaves a ~10 byte tombstone, so writing
 * each drag frame would bloat long-lived boards. In-progress drags travel as
 * awareness state instead (see usePresence).
 */
export function applyNodeChanges(
	doc: Y.Doc,
	changes: NodeChange<ShapeNode>[],
	lastDragPosition: (id: string) => Position | undefined = () => undefined,
	sizeOf?: SizeOf,
): void {
	const moves = new Map<string, Position>();
	const removed: string[] = [];
	for (const change of changes) {
		if (change.type === "position" && !change.dragging) {
			const position = change.position ?? lastDragPosition(change.id);
			if (position) moves.set(change.id, position);
		} else if (change.type === "remove") {
			removed.push(change.id);
		}
	}
	if (moves.size === 0 && removed.length === 0) return;
	transactLocal(doc, () => {
		// Dropped shapes land on top, in or out of sections, and sections
		// bring their contents along: all one undo step. See shared/structure.ts.
		if (moves.size > 0) commitMoves(doc, moves, sizeOf);
		if (removed.length > 0) deleteShapes(doc, removed, sizeOf);
	});
}

/**
 * Delete shapes, as one undo step. Every deletion goes through here (the
 * delete key, cut, empty text tidying itself away), so anything that must
 * go with a shape goes too: a section takes what's in it, and connectors
 * attached to a deleted shape are left with a loose end where it was.
 */
export function deleteShapes(doc: Y.Doc, ids: Iterable<string>, sizeOf?: SizeOf): void {
	transactLocal(doc, () => removeShapes(doc, ids, sizeOf));
}

/**
 * Commit a shape's new position and bring it to the front, as a dropped shape
 * should land on top. x, y and its section are written together so they
 * never mix with a concurrent move's.
 */
export function moveShape(doc: Y.Doc, id: string, position: Position, sizeOf?: SizeOf): void {
	transactLocal(doc, () => commitMoves(doc, new Map([[id, position]]), sizeOf));
}

export function addCard(doc: Y.Doc, ref: string, at: { x: number; y: number }): string {
	const id = crypto.randomUUID();
	transactLocal(doc, () => {
		addShape(doc, id, { type: "card", ref, x: at.x, y: at.y, z: nextZ(doc) });
		placeInSections(doc, [id]);
	});
	return id;
}

export const STICKY_SIZE = 176;
export const STICKY_COLORS = ["yellow", "pink", "blue", "green", "purple"] as const;
export type StickyColor = (typeof STICKY_COLORS)[number];

/** Add a sticky centred on `at`, and return its id. */
export function addSticky(
	doc: Y.Doc,
	at: { x: number; y: number },
	{
		color = "yellow",
		author,
		font,
	}: { color?: StickyColor; author?: Author; font?: ShapeFont } = {},
): string {
	const id = crypto.randomUUID();
	transactLocal(doc, () => {
		addShape(doc, id, {
			type: "sticky",
			text: "",
			color,
			font,
			author,
			x: Math.round(at.x - STICKY_SIZE / 2),
			y: Math.round(at.y - STICKY_SIZE / 2),
			z: nextZ(doc),
		});
		placeInSections(doc, [id]);
	});
	return id;
}

/** Text sizes in pixels, as styled by `.text-block[data-size]`. */
export const TEXT_SIZES: Record<TextSize, number> = { s: 14, m: 20, l: 34, xl: 56 };

/**
 * Add an empty text block with its first line centred on `at`, so the caret
 * lands where you clicked, and return its id.
 */
export function addText(
	doc: Y.Doc,
	at: { x: number; y: number },
	{ size = "m", font }: { size?: TextSize; font?: ShapeFont } = {},
): string {
	const id = crypto.randomUUID();
	// The block's padding (4px 6px), and half a line.
	const halfLine = (TEXT_SIZES[size] * 1.3) / 2;
	transactLocal(doc, () => {
		addShape(doc, id, {
			type: "text",
			text: "",
			size,
			font,
			x: Math.round(at.x - 6),
			y: Math.round(at.y - 4 - halfLine),
			z: nextZ(doc),
		});
		placeInSections(doc, [id]);
	});
	return id;
}

/** Add a proposed decision with its top edge's middle near `at`, and return its id. */
export function addDecisionAt(doc: Y.Doc, at: { x: number; y: number }, author?: Author): string {
	const id = crypto.randomUUID();
	const width = NOMINAL_SIZE.decision?.w ?? 320;
	transactLocal(doc, () => {
		addDecision(doc, id, { x: at.x - width / 2, y: at.y - 40, author });
		placeInSections(doc, [id]);
	});
	return id;
}

// A sticky or text block this client just made, whose text box should take
// focus once it mounts so you can type straight away.
let focusOnMount: string | null = null;

export function focusWhenMounted(id: string): void {
	focusOnMount = id;
}

export function takeFocus(id: string): boolean {
	if (focusOnMount !== id) return false;
	focusOnMount = null;
	return true;
}

export function setStickyText(doc: Y.Doc, id: string, text: string): void {
	transactLocal(doc, () => shapesMap(doc).get(id)?.set("text", text));
}
