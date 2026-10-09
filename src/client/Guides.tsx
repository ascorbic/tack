import { type NodeChange, ViewportPortal, useStore, useStoreApi } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShapeNode } from "./board.ts";
import { type Guide, type Rect, SNAP_PX, intersects, snapRect, unionRect } from "./snapping.ts";

// Snapping while dragging, and the guides that show it. Snapping happens
// locally, frame by frame, before positions reach presence (so other people
// see the snapped drag) and before the drop is committed to the document.

type Size = { width: number; height: number };

class GuideStore {
	private guides: Guide[] = [];
	private key = "";
	private readonly listeners = new Set<() => void>();

	set(guides: Guide[]): void {
		const key = guides.map(guideKey).join("|");
		if (key === this.key && guides.every((g, i) => sameSpan(g, this.guides[i]))) return;
		this.guides = guides;
		this.key = key;
		for (const listener of this.listeners) listener();
	}

	clear(): void {
		this.set([]);
	}

	getSnapshot = (): Guide[] => this.guides;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

function guideKey(guide: Guide): string {
	return `${guide.axis}:${Math.round(guide.at * 2) / 2}`;
}

function sameSpan(a: Guide, b: Guide | undefined): boolean {
	return !!b && Math.abs(a.from - b.from) < 0.5 && Math.abs(a.to - b.to) < 0.5;
}

/**
 * Snap position changes from React Flow drags to other shapes nearby. Hold
 * ⌘ (Ctrl elsewhere) while dragging to move freely.
 */
export function useSnapping(nodes: ShapeNode[], sizeOf: (id: string) => Size | undefined) {
	const store = useStoreApi();
	const [guides] = useState(() => new GuideStore());
	const [dragging, setDragging] = useState(false);
	const session = useRef<{ dx: number; dy: number } | null>(null);
	const free = useRef(false);
	const latest = useRef({ nodes, sizeOf });
	latest.current = { nodes, sizeOf };

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			free.current = event.metaKey || event.ctrlKey;
		};
		const onBlur = () => {
			free.current = false;
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKey);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onKey);
			window.removeEventListener("blur", onBlur);
		};
	}, []);

	const snapChanges = useCallback(
		(changes: NodeChange<ShapeNode>[]): NodeChange<ShapeNode>[] => {
			const moves = changes.filter(
				(change): change is Extract<NodeChange<ShapeNode>, { type: "position" }> =>
					change.type === "position" && change.position !== undefined,
			);
			if (moves.length === 0) return changes;
			const shift = (offset: { dx: number; dy: number }) =>
				offset.dx === 0 && offset.dy === 0
					? changes
					: changes.map((change) =>
							change.type === "position" && change.position
								? {
										...change,
										position: {
											x: change.position.x + offset.dx,
											y: change.position.y + offset.dy,
										},
									}
								: change,
						);

			// The drop: land exactly where the last frame was shown.
			if (!moves.some((change) => change.dragging)) {
				const offset = session.current;
				if (!offset) return changes;
				session.current = null;
				setDragging(false);
				guides.clear();
				return shift(offset);
			}

			if (!session.current) setDragging(true);
			const { nodes, sizeOf } = latest.current;
			const sizeFor = (id: string) => sizeOf(id) ?? { width: 0, height: 0 };
			const box = unionRect(
				moves.map((change) => ({ ...(change.position as Rect), ...sizeFor(change.id) })),
			);
			const { transform, width, height } = store.getState();
			const [tx, ty, zoom] = transform;
			const view = { x: -tx / zoom, y: -ty / zoom, width: width / zoom, height: height / zoom };
			const moving = new Set(moves.map((change) => change.id));
			const targets: Rect[] = [];
			for (const node of nodes) {
				const size = sizeOf(node.id);
				if (moving.has(node.id) || !size) continue;
				const rect = { ...node.position, ...size };
				if (intersects(rect, view)) targets.push(rect);
			}
			const snap =
				free.current || !box
					? { dx: 0, dy: 0, guides: [] }
					: snapRect(box, targets, SNAP_PX / zoom);
			session.current = { dx: snap.dx, dy: snap.dy };
			guides.set(snap.guides);
			return shift(snap);
		},
		[store, guides],
	);

	return { snapChanges, guides, dragging };
}

interface Shown {
	guide: Guide;
	leaving: boolean;
}

/** Snap guides, drawn in flow space at a constant on-screen weight. */
export function Guides({ store }: { store: GuideStore }) {
	const guides = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const zoom = useStore((state) => state.transform[2]);
	const [shown, setShown] = useState<Map<string, Shown>>(() => new Map());

	useEffect(() => {
		setShown((current) => {
			const next = new Map<string, Shown>();
			for (const guide of guides) next.set(guideKey(guide), { guide, leaving: false });
			// Guides that went away fade out where they were.
			for (const [key, item] of current) {
				if (!next.has(key)) next.set(key, { guide: item.guide, leaving: true });
			}
			return next;
		});
	}, [guides]);

	const remove = (key: string) =>
		setShown((current) => {
			if (!current.get(key)?.leaving) return current;
			const next = new Map(current);
			next.delete(key);
			return next;
		});

	if (shown.size === 0) return null;
	return (
		<ViewportPortal>
			<div className="guides" aria-hidden="true" style={{ "--zoom": zoom } as React.CSSProperties}>
				{[...shown].map(([key, { guide, leaving }]) => (
					<div
						key={key}
						className="guide"
						data-axis={guide.axis}
						data-leaving={leaving}
						onAnimationEnd={(event) => {
							if (event.animationName === "guide-out") remove(key);
						}}
						style={
							guide.axis === "x"
								? { left: guide.at, top: guide.from, height: guide.to - guide.from }
								: { left: guide.from, top: guide.at, width: guide.to - guide.from }
						}
					/>
				))}
			</div>
		</ViewportPortal>
	);
}

export type { GuideStore };
