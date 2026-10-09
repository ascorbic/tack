import type { Node, NodeChange } from "@xyflow/react";
import { generateKeyBetween } from "fractional-indexing";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { CardMessage } from "../shared/cards.ts";
import { type ShapeProps, addShape, readShape, shapesMap } from "../shared/shapes.ts";
import { cardStore } from "./cardStore.ts";

export type ShapeNode = Node<{ shape: ShapeProps; id: string }>;

export interface BoardConnection {
	doc: Y.Doc;
	provider: YProvider;
}

export function useBoardConnection(name: string): BoardConnection {
	const [connection] = useState(() => {
		const doc = new Y.Doc();
		const provider = new YProvider(location.host, name, doc, { party: "board" });
		provider.on("custom-message", (message: string) => {
			cardStore.apply(JSON.parse(message) as CardMessage);
		});
		return { doc, provider };
	});
	useEffect(() => () => connection.provider.destroy(), [connection]);
	return connection;
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
					if (event.target === shapes) for (const key of event.keys.keys()) changed.add(key);
					else if (typeof event.path[0] === "string") changed.add(event.path[0]);
				}
				rebuild(changed);
				listener();
			};
			shapes.observeDeep(observer);
			return () => shapes.unobserveDeep(observer);
		},
	};
}

type Position = { x: number; y: number };

/**
 * Write React Flow changes into the document. Positions are committed only
 * when a drag ends: every Yjs write leaves a ~10 byte tombstone, so writing
 * each drag frame would bloat long-lived boards. In-progress drags travel as
 * awareness state instead (see useDragOverrides).
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
				const shape = shapes.get(change.id);
				// x and y in one transaction so concurrent moves never mix axes.
				shape?.set("x", Math.round(position.x));
				shape?.set("y", Math.round(position.y));
			} else if (change.type === "remove") {
				shapes.delete(change.id);
			}
		}
	}, "local");
}

/**
 * Positions of shapes being dragged right now, by this client or others.
 * Local drags come from React Flow change events; remote drags arrive via
 * awareness, so they're ephemeral and never touch the document.
 */
export function useDragOverrides(provider: YProvider) {
	const [local, setLocal] = useState(() => new Map<string, Position>());
	const [remote, setRemote] = useState(() => new Map<string, Position>());
	const localRef = useRef(local);
	localRef.current = local;

	useEffect(() => {
		const awareness = provider.awareness;
		const onChange = () => {
			const next = new Map<string, Position>();
			for (const [clientId, state] of awareness.getStates()) {
				if (clientId === awareness.clientID) continue;
				const drags = (state as { drags?: Record<string, Position> }).drags;
				for (const [id, position] of Object.entries(drags ?? {})) next.set(id, position);
			}
			setRemote(next);
		};
		awareness.on("change", onChange);
		return () => awareness.off("change", onChange);
	}, [provider]);

	// Publish local drags at most once per frame.
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			provider.awareness.setLocalStateField("drags", Object.fromEntries(local));
		});
		return () => cancelAnimationFrame(frame);
	}, [provider, local]);

	const onPositionChanges = useCallback((changes: NodeChange<ShapeNode>[]) => {
		let next: Map<string, Position> | undefined;
		for (const change of changes) {
			if (change.type !== "position") continue;
			next ??= new Map(localRef.current);
			if (change.dragging && change.position) next.set(change.id, change.position);
			else next.delete(change.id);
		}
		if (next) setLocal(next);
	}, []);

	const overrides = useMemo(() => {
		if (remote.size === 0) return local;
		if (local.size === 0) return remote;
		return new Map([...remote, ...local]);
	}, [local, remote]);

	return {
		overrides,
		onPositionChanges,
		lastDragPosition: (id: string) => localRef.current.get(id),
	};
}

export function topZ(doc: Y.Doc): string {
	let top: string | null = null;
	for (const shape of shapesMap(doc).values()) {
		const z = shape.get("z");
		if (typeof z === "string" && (top === null || z > top)) top = z;
	}
	return generateKeyBetween(top, null);
}

export function addCard(doc: Y.Doc, ref: string, at: { x: number; y: number }): void {
	addShape(doc, crypto.randomUUID(), { type: "card", ref, x: at.x, y: at.y, z: topZ(doc) });
}

export function addSticky(doc: Y.Doc, at: { x: number; y: number }): void {
	addShape(doc, crypto.randomUUID(), {
		type: "sticky",
		text: "",
		color: "yellow",
		x: at.x,
		y: at.y,
		z: topZ(doc),
	});
}

export function setStickyText(doc: Y.Doc, id: string, text: string): void {
	shapesMap(doc).get(id)?.set("text", text);
}
