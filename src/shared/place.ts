import type * as Y from "yjs";
import { withFallbacks } from "./connectors.ts";
import type { Rect } from "./geometry.ts";
import { addCardShape } from "./provenance.ts";
import { type CardSizing, planExpand } from "./related.ts";
import { type SizeOf, boxOf } from "./sections.ts";
import { readShape, shapesMap } from "./shapes.ts";
import { addConnector, placeInSections, readShapes } from "./structure.ts";

// Placing a card for an item that was made from shapes that stay on the
// board: the parent issue a section (or a cluster) becomes. The card goes
// above them, as Expand related puts a parent, sliding to the nearest spot
// clear of everything else, and an elbow connector runs from it down to
// each of them, parent to child. The push engine runs this as a change's
// `place` effect (src/shared/changes.ts), and the playground's pretend push
// server does the same.
//
//                 [ parent ]
//                     │
//          ┌──────────┴── Section ───┐
//          │  sticky   sticky        │

/** Where a connector attaches: bottom middle of the parent, top middle of each child. */
const BOTTOM = { x: 0.5, y: 1 };
const TOP = { x: 0.5, y: 0 };

export interface Placement {
	/** The card for the item: new, or the one already showing it. */
	card: string;
	/** Whether the card was added (false: it was already on the board). */
	added: boolean;
	/** Connectors added, one per shape it wasn't already connected to. */
	connectors: string[];
}

/**
 * Add a card for `key` above `near`, connected to each of them. If the item
 * already has a card on the board, it stays where it is and is connected.
 * Null when none of `near` is on the board any more. Call inside a
 * transaction with the right origin (the push engine's, or `transactLocal`).
 */
export function placeCard(
	doc: Y.Doc,
	key: string,
	near: readonly string[],
	options: { sizeOf?: SizeOf; card?: CardSizing } = {},
): Placement | null {
	const { sizeOf } = options;
	const shapes = readShapes(doc);
	const targets = near.filter((id) => {
		const shape = shapes.get(id);
		return shape && shape.type !== "connector";
	});
	if (targets.length === 0) return null;
	const boxes = targets.map((id) => boxOf(id, shapes.get(id)!, sizeOf));
	const around = union(boxes);
	const skip = new Set(targets);

	let existing: string | undefined;
	const obstacles: Rect[] = [];
	const pairs = new Set<string>();
	for (const [id, shape] of shapes) {
		if (shape.type === "connector") {
			const a = shape.from?.shape;
			const b = shape.to?.shape;
			if (a && b) pairs.add(`${a}\n${b}`).add(`${b}\n${a}`);
			continue;
		}
		if (shape.type === "card" && shape.ref?.toLowerCase() === key.toLowerCase()) existing ??= id;
		if (skip.has(id)) continue;
		const box = boxOf(id, shape, sizeOf);
		// Sections around them aren't in the way: the card may join them.
		if (shape.type === "section" && encloses(box, around)) continue;
		obstacles.push(box);
	}

	let card = existing;
	let box: Rect | undefined;
	if (!card) {
		const plan = planExpand({
			source: { id: targets.length === 1 ? (targets[0] as string) : "", key: "", box: around },
			result: {
				kind: "related",
				key: "",
				parent: key,
				subIssues: [],
				blockedBy: [],
				blocking: [],
				linkedPulls: [],
				cards: [],
			},
			groups: new Set(["parent"]),
			onBoard: new Map(),
			obstacles,
			cards: options.card ? new Map([[key, options.card]]) : undefined,
		});
		box = plan.cards[0]?.box;
		if (!box) return null;
	}

	const connectors: string[] = [];
	doc.transact(() => {
		if (!card) {
			card = crypto.randomUUID();
			addCardShape(doc, card, { ref: key, x: box!.x, y: box!.y });
			placeInSections(doc, [card], sizeOf);
		}
		const id = card;
		const boxFor = (shape: string): Rect | undefined => {
			if (shape === id && box) return box;
			const raw = shapesMap(doc).get(shape);
			return raw ? boxOf(shape, readShape(raw), sizeOf) : undefined;
		};
		for (const target of targets) {
			if (pairs.has(`${id}\n${target}`)) continue;
			const ends = withFallbacks(
				{ x: 0, y: 0, shape: id, anchor: BOTTOM },
				{ x: 0, y: 0, shape: target, anchor: TOP },
				boxFor,
			);
			connectors.push(addConnector(doc, { ...ends, route: "elbow" }));
		}
	});
	return { card: card as string, added: !existing, connectors };
}

function union(boxes: Rect[]): Rect {
	const x = Math.min(...boxes.map((b) => b.x));
	const y = Math.min(...boxes.map((b) => b.y));
	const right = Math.max(...boxes.map((b) => b.x + b.w));
	const bottom = Math.max(...boxes.map((b) => b.y + b.h));
	return { x, y, w: right - x, h: bottom - y };
}

function encloses(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}
