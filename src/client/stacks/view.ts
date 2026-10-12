import { stackMembers } from "../../shared/stacks.ts";
import type { ShapeProps } from "../../shared/shapes.ts";

/** What the board tells a stack's node about itself (see `Board`). */
export interface StackView {
	/** Its stickies and cards, top of the stack first. */
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
	/** Each stack's members, top first. */
	members: Map<string, string[]>;
	/** Each stacked sticky's or card's stack. */
	stackOf: Map<string, string>;
}

export function readStacks(shapes: ReadonlyMap<string, ShapeProps>): StackLayout {
	const members = stackMembers(shapes);
	const stackOf = new Map<string, string>();
	for (const [stack, ids] of members) for (const id of ids) stackOf.set(id, stack);
	return { members, stackOf };
}
