import type { Rect } from "../../shared/geometry.ts";
import {
	type OpenLayout,
	PILE_SIZE,
	STICKY,
	memberAt,
	openLayout,
	pileMembers,
} from "../../shared/piles.ts";
import type { ShapeProps } from "../../shared/shapes.ts";

/** What the board tells a pile's node about itself (see `Board`). */
export interface PileView {
	/** Its stickies, top of the stack first. */
	members: { id: string; shape: ShapeProps }[];
	/** Spread open here. */
	open: boolean;
	/** A drag is held over it: it's opening up to take what's dragged. */
	receiving: boolean;
	/** Something was just dropped in: it gulps (a new number each time). */
	fed: number;
}

/** Piles on the board, as the canvas draws them. */
export interface PileLayout {
	/** Each pile's stickies, top first. */
	members: Map<string, string[]>;
	/** Each piled sticky's pile. */
	pileOf: Map<string, string>;
}

export function readPiles(shapes: ReadonlyMap<string, ShapeProps>): PileLayout {
	const members = pileMembers(shapes);
	const pileOf = new Map<string, string>();
	for (const [pile, ids] of members) for (const id of ids) pileOf.set(id, pile);
	return { members, pileOf };
}

/** Where a pile's node is drawn, and how big: the stack, or the open tray. */
export function pileBox(at: { x: number; y: number }, open: OpenLayout | null): Rect {
	return open ? open.tray : { x: at.x, y: at.y, w: PILE_SIZE.w, h: PILE_SIZE.h };
}

/** Where a sticky in a pile is drawn: in its slot while the pile's open, else on the stack. */
export function memberBox(
	pileAt: { x: number; y: number },
	open: OpenLayout | null,
	id: string,
): Rect {
	const at = open?.slots.get(id) ?? memberAt(pileAt);
	return { x: at.x, y: at.y, w: STICKY, h: STICKY };
}

export { openLayout };
