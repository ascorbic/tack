import type { NodeChange } from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { contains } from "../../shared/geometry.ts";
import { NOMINAL_SIZE } from "../../shared/sections.ts";
import { listConfig, listWidget } from "../../shared/widgetRegistry.ts";
import type { ShapeNode } from "../board.ts";
import { nodeBox } from "../canvasStructure.ts";
import { scaledDuration } from "../motion.ts";
import type { MatchDrop } from "./context.ts";

// Drop to match (#39), on the board: while cards are dragged, which list
// (if any) they're over; when they're dropped on one, they don't move. They
// glide back to where they came from, and the list asks what to change so
// they'd show in it.

const CARD = NOMINAL_SIZE.card ?? { w: 252, h: 124 };

function same(a: MatchDrop | null, b: MatchDrop | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.widget !== b.widget || a.shapes.length !== b.shapes.length) return false;
	return a.shapes.every((id, i) => id === b.shapes[i]);
}

/** The list the dragged cards are over: the topmost one under the first card's centre. */
function targetFor(
	moves: NodeChange<ShapeNode>[],
	nodes: ShapeNode[],
	sizeOf: (id: string) => { width: number; height: number } | undefined,
): MatchDrop | null {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const dragged = moves.flatMap((change) => (change.type === "position" ? [change] : []));
	const first = dragged[0];
	if (!first) return null;
	// Only cards can be made to match.
	if (dragged.some((change) => byId.get(change.id)?.type !== "card")) return null;
	const node = byId.get(first.id);
	const at = first.position ?? node?.position;
	if (!node || !at) return null;
	const size = sizeOf(first.id);
	const centre = {
		x: at.x + (size?.width ?? CARD.w) / 2,
		y: at.y + (size?.height ?? CARD.h) / 2,
	};
	const ids = new Set(dragged.map((change) => change.id));
	for (let i = nodes.length - 1; i >= 0; i--) {
		const candidate = nodes[i];
		if (!candidate || candidate.type !== "widget" || ids.has(candidate.id)) continue;
		const shape = candidate.data.shape;
		if (shape.widget !== listWidget.kind || !listConfig(shape).q.trim()) continue;
		if (contains(nodeBox(candidate), centre)) {
			return { widget: candidate.id, shapes: [...ids] };
		}
	}
	return null;
}

export function useDropToMatch(
	nodes: ShapeNode[],
	sizeOf: (id: string) => { width: number; height: number } | undefined,
) {
	const latest = useRef(nodes);
	latest.current = nodes;
	const hoveringRef = useRef<MatchDrop | null>(null);
	const [hovering, setHovering] = useState<MatchDrop | null>(null);
	const [dropped, setDropped] = useState<MatchDrop | null>(null);
	const [returning, setReturning] = useState<ReadonlySet<string>>(() => new Set());
	const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	/**
	 * Follow React Flow's changes. Returns the shapes whose drop was caught by
	 * a list (so their moves mustn't be committed), or null.
	 */
	const track = useCallback(
		(changes: NodeChange<ShapeNode>[]): ReadonlySet<string> | null => {
			const moves = changes.filter((change) => change.type === "position");
			if (moves.length === 0) return null;
			const live = moves.filter((change) => change.type === "position" && change.dragging);
			if (live.length > 0) {
				const target = targetFor(live, latest.current, sizeOf);
				if (!same(hoveringRef.current, target)) {
					hoveringRef.current = target;
					setHovering(target);
				}
				return null;
			}
			const target = hoveringRef.current;
			if (!target) return null;
			hoveringRef.current = null;
			setHovering(null);
			const ids = new Set(target.shapes);
			if (!moves.some((change) => change.type === "position" && ids.has(change.id))) return null;
			setDropped(target);
			setReturning(ids);
			clearTimeout(settle.current);
			settle.current = setTimeout(() => setReturning(new Set()), scaledDuration(700));
			return ids;
		},
		[sizeOf],
	);

	const closeDrop = useCallback(() => setDropped(null), []);
	return useMemo(
		() => ({ track, hovering, dropped, closeDrop, returning }),
		[track, hovering, dropped, closeDrop, returning],
	);
}
