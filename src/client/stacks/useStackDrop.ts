import type { NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contains } from "../../shared/geometry.ts";
import type { ShapeNode } from "../board.ts";
import { nodeBox } from "../canvasStructure.ts";
import { scaledDuration } from "../motion.ts";
import type { StackLayout } from "./view.ts";

// Dragging stickies onto a sticky or a stack (#73), as apps go into folders on
// a phone: hold what you're dragging over one for a moment and it opens up to
// take it in; let go and they're a stack (or join it). Moving on before it
// opens is just moving. Only stickies (and stacks) can be stacked.

/** How long to hold over a sticky or stack before it opens to take what's dragged. */
export const STACK_HOLD_MS = 350;

export interface StackDropState {
	/** What the drag is over: a sticky or stack it could go into. */
	target: string | null;
	/** Held there long enough: let go now and it goes in. */
	armed: boolean;
	/** What's being dragged. */
	dragged: readonly string[];
}

const IDLE: StackDropState = { target: null, armed: false, dragged: [] };

/** What to stack, when a drag that was held over something ends. */
export interface StackDrop {
	target: string;
	ids: string[];
}

export function useStackDrop({
	nodes,
	stacks,
	pointer,
	enabled,
}: {
	/** The nodes as drawn (kept current by the board), for what's under the pointer. */
	nodes: React.RefObject<ShapeNode[]>;
	stacks: StackLayout;
	/** Where the pointer is, in board coordinates. */
	pointer: React.RefObject<{ x: number; y: number } | null>;
	enabled: boolean;
}) {
	const latest = useRef({ stacks, enabled });
	latest.current = { stacks, enabled };
	const [state, setState] = useState<StackDropState>(IDLE);
	const stateRef = useRef(state);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const update = useCallback((next: StackDropState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const reset = useCallback(() => {
		clearTimeout(timer.current);
		if (stateRef.current !== IDLE) update(IDLE);
	}, [update]);

	/**
	 * Follow React Flow's changes while something's dragged. Returns what to
	 * stack when a drag that was held over a sticky or stack ends (so its moves
	 * mustn't be committed), or null.
	 */
	const track = useCallback(
		(changes: NodeChange<ShapeNode>[]): StackDrop | null => {
			const moves = changes.filter((change) => change.type === "position");
			if (moves.length === 0) return null;
			const live = moves.filter((change) => change.type === "position" && change.dragging);
			if (live.length === 0) {
				const { target, armed, dragged } = stateRef.current;
				reset();
				const dropped = new Set(moves.map((change) => change.id));
				if (!target || !armed || !dragged.some((id) => dropped.has(id))) return null;
				return { target, ids: [...dragged] };
			}
			const { stacks, enabled: on } = latest.current;
			const drawn = nodes.current ?? [];
			const at = pointer.current;
			const ids = live.map((change) => change.id);
			const byId = new Map(drawn.map((node) => [node.id, node] as const));
			const stackable = ids.every((id) => {
				const node = byId.get(id);
				return (
					node &&
					(node.type === "sticky" || node.type === "stack") &&
					node.data.display === undefined &&
					!(node.type === "stack" && node.data.stack?.open)
				);
			});
			if (!on || !at || !stackable) {
				reset();
				return null;
			}
			const dragged = new Set(ids);
			for (const id of ids) for (const member of stacks.members.get(id) ?? []) dragged.add(member);
			// Moving stickies around inside the stack they're in is just that.
			const own = new Set(ids.map((id) => stacks.stackOf.get(id) ?? null));
			const ownStack = own.size === 1 ? [...own][0] : null;
			let best: ShapeNode | null = null;
			drawn.forEach((node) => {
				if (node.hidden || dragged.has(node.id) || node.data.display !== undefined) return;
				if (node.type !== "sticky" && node.type !== "stack") return;
				const stack = node.type === "stack" ? node.id : (stacks.stackOf.get(node.id) ?? null);
				if (ownStack && stack === ownStack) return;
				if (!contains(nodeBox(node), at)) return;
				// The topmost under the pointer: an open stack's stickies over its tray.
				if (!best || (node.zIndex ?? 0) >= (best.zIndex ?? 0)) best = node;
			});
			const target = (best as ShapeNode | null)?.id ?? null;
			const current = stateRef.current;
			if (target === current.target) {
				if (current.dragged.length !== dragged.size) update({ ...current, dragged: ids });
				return null;
			}
			clearTimeout(timer.current);
			update({ target, armed: false, dragged: ids });
			if (target) {
				timer.current = setTimeout(() => {
					if (stateRef.current.target === target) update({ ...stateRef.current, armed: true });
				}, scaledDuration(STACK_HOLD_MS));
			}
			return null;
		},
		[nodes, pointer, reset, update],
	);

	return useMemo(() => ({ state, track, reset }), [state, track, reset]);
}
