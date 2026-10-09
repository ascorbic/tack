import type { Node, NodeChange } from "@xyflow/react";
import { useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
	type Author,
	type ShapeFont,
	type ShapeProps,
	type TextSize,
	addShape,
	nextZ,
	readShape,
	shapesMap,
	topZ,
} from "../shared/shapes.ts";

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

export function addCard(doc: Y.Doc, ref: string, at: { x: number; y: number }): void {
	addShape(doc, crypto.randomUUID(), { type: "card", ref, x: at.x, y: at.y, z: nextZ(doc) });
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
	addShape(doc, id, {
		type: "text",
		text: "",
		size,
		font,
		x: Math.round(at.x - 6),
		y: Math.round(at.y - 4 - halfLine),
		z: nextZ(doc),
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
	shapesMap(doc).get(id)?.set("text", text);
}
