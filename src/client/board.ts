import type { Node, NodeChange } from "@xyflow/react";
import { generateKeyBetween } from "fractional-indexing";
import { useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { type ShapeProps, addShape, readShape, shapesMap } from "../shared/shapes.ts";

export type ShapeNode = Node<{ shape: ShapeProps; id: string }>;

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
		const nodes: ShapeNode[] = [];
		for (const [id, shape] of shapes) {
			let node = cache.get(id);
			if (!node || !changed || changed.has(id)) {
				const props = readShape(shape);
				node = {
					id,
					type: props.type,
					position: { x: props.x, y: props.y },
					data: { shape: props, id },
					zIndex: 0,
				};
				cache.set(id, node);
			}
			nodes.push(node);
		}
		for (const id of cache.keys()) if (!shapes.has(id)) cache.delete(id);
		nodes.sort((a, b) => (a.data.shape.z < b.data.shape.z ? -1 : 1));
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
): void {
	const shapes = shapesMap(doc);
	doc.transact(() => {
		for (const change of changes) {
			if (change.type === "position" && !change.dragging) {
				const position = change.position ?? lastDragPosition(change.id);
				if (!position) continue;
				moveShape(doc, change.id, position);
			} else if (change.type === "remove") {
				shapes.delete(change.id);
			}
		}
	}, "local");
}

/**
 * Commit a shape's new position and bring it to the front, as a dropped shape
 * should land on top. Call inside a transaction so x and y never mix with a
 * concurrent move's.
 */
export function moveShape(doc: Y.Doc, id: string, position: Position): void {
	const shape = shapesMap(doc).get(id);
	if (!shape) return;
	shape.set("x", Math.round(position.x));
	shape.set("y", Math.round(position.y));
	const z = topZ(doc, id);
	if (z) shape.set("z", z);
}

/**
 * A z-index above every other shape, or null if `except` is already on top.
 */
export function topZ(doc: Y.Doc, except?: string): string | null {
	let top: string | null = null;
	let topId: string | null = null;
	for (const [id, shape] of shapesMap(doc)) {
		const z = shape.get("z");
		if (typeof z === "string" && (top === null || z > top)) {
			top = z;
			topId = id;
		}
	}
	if (except && topId === except) return null;
	return generateKeyBetween(top, null);
}

function nextZ(doc: Y.Doc): string {
	return topZ(doc) ?? generateKeyBetween(null, null);
}

export function addCard(doc: Y.Doc, ref: string, at: { x: number; y: number }): void {
	addShape(doc, crypto.randomUUID(), { type: "card", ref, x: at.x, y: at.y, z: nextZ(doc) });
}

export function addSticky(doc: Y.Doc, at: { x: number; y: number }): void {
	addShape(doc, crypto.randomUUID(), {
		type: "sticky",
		text: "",
		color: "yellow",
		x: at.x,
		y: at.y,
		z: nextZ(doc),
	});
}

export function setStickyText(doc: Y.Doc, id: string, text: string): void {
	shapesMap(doc).get(id)?.set("text", text);
}
