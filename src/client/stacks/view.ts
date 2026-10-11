import type { Rect } from "../../shared/geometry.ts";
import {
	type OpenLayout,
	STACK_SIZE,
	STICKY,
	memberAt,
	openLayout,
	stackMembers,
} from "../../shared/stacks.ts";
import type { ShapeProps } from "../../shared/shapes.ts";

/** What the board tells a stack's node about itself (see `Board`). */
export interface StackView {
	/** Its stickies, top of the stack first. */
	members: { id: string; shape: ShapeProps }[];
	/** Spread open here. */
	open: boolean;
	/** A drag is held over it: it's opening up to take what's dragged. */
	receiving: boolean;
	/** Something was just dropped in: it gulps (a new number each time). */
	fed: number;
}

/** Stacks on the board, as the canvas draws them. */
export interface StackLayout {
	/** Each stack's stickies, top first. */
	members: Map<string, string[]>;
	/** Each stacked sticky's stack. */
	stackOf: Map<string, string>;
}

export function readStacks(shapes: ReadonlyMap<string, ShapeProps>): StackLayout {
	const members = stackMembers(shapes);
	const stackOf = new Map<string, string>();
	for (const [stack, ids] of members) for (const id of ids) stackOf.set(id, stack);
	return { members, stackOf };
}

/** Where a stack's node is drawn, and how big: the stack, or the open tray. */
export function stackBox(at: { x: number; y: number }, open: OpenLayout | null): Rect {
	return open ? open.tray : { x: at.x, y: at.y, w: STACK_SIZE.w, h: STACK_SIZE.h };
}

/** Where a sticky in a stack is drawn: in its slot while the stack's open, else on the stack. */
export function memberBox(
	stackAt: { x: number; y: number },
	open: OpenLayout | null,
	id: string,
): Rect {
	const at = open?.slots.get(id) ?? memberAt(stackAt);
	return { x: at.x, y: at.y, w: STICKY, h: STICKY };
}

export { openLayout };
