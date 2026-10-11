import type * as Y from "yjs";
import { selection } from "./aiContext.ts";
import { withFallbacks } from "./connectors.ts";
import { addDecision } from "./decisions.ts";
import type { Rect } from "./geometry.ts";
import { spotNear } from "./placement.ts";
import { type SizeOf, boxOf } from "./sections.ts";
import { type Author, addShape, nextZ, readShape, shapesMap } from "./shapes.ts";
import { addConnector, placeInSections, readShapes } from "./structure.ts";

// Placing what the AI drafted (#64), once someone's read and maybe edited
// it: a summary as a text block, a decision as a proposed decision linked to
// the cards it was drafted from. Beside what it was drafted from, in free
// space. Call inside a local transaction (`transactLocal`): one undo step.

/** Room between what was selected and what's placed. */
const GAP = 56;
/** At most this many cards are linked to a drafted decision. */
export const DECISION_LINKS = 8;

/** The box around shapes, as drawn. */
function around(doc: Y.Doc, ids: readonly string[], sizeOf?: SizeOf): Rect | null {
	const boxes = ids.flatMap((id) => {
		const raw = shapesMap(doc).get(id);
		if (!raw) return [];
		const shape = readShape(raw);
		return shape.type === "connector" ? [] : [boxOf(id, shape, sizeOf)];
	});
	if (boxes.length === 0) return null;
	const x = Math.min(...boxes.map((b) => b.x));
	const y = Math.min(...boxes.map((b) => b.y));
	return {
		x,
		y,
		w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
		h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
	};
}

/** Free space to the right of what was selected, for something of `size`. */
function spotBesideAll(
	doc: Y.Doc,
	near: readonly string[],
	size: { w: number; h: number },
	sizeOf?: SizeOf,
): { x: number; y: number } {
	const box = around(doc, near, sizeOf) ?? { x: 0, y: 0, w: 0, h: 0 };
	const ideal = { x: box.x + box.w + GAP, y: box.y };
	return spotNear(readShapes(doc), ideal, size, sizeOf) ?? ideal;
}

/** A text block's size for some text, at the medium size (20px), roughly. */
export function textSize(text: string): { w: number; h: number } {
	const lines = text.split("\n");
	const longest = Math.max(1, ...lines.map((line) => line.length));
	return { w: Math.round(longest * 10.6 + 12), h: Math.round(lines.length * 26.4 + 8) };
}

/** Put a summary on the board as a text block beside `near`; returns its id. */
export function placeSummary(
	doc: Y.Doc,
	text: string,
	near: readonly string[],
	sizeOf?: SizeOf,
	id: string = crypto.randomUUID(),
): string {
	const at = spotBesideAll(doc, near, textSize(text), sizeOf);
	addShape(doc, id, {
		type: "text",
		text,
		size: "m",
		x: Math.round(at.x),
		y: Math.round(at.y),
		z: nextZ(doc),
	});
	placeInSections(doc, [id], sizeOf);
	return id;
}

/**
 * Put a drafted decision on the board beside `near`, proposed, and linked to
 * the cards among `near` (and in sections among it) as any decision is: by
 * a connector to each. Returns its id and the connectors'.
 */
export function placeDecision(
	doc: Y.Doc,
	draft: { title: string; text: string },
	near: readonly string[],
	author?: Author,
	sizeOf?: SizeOf,
	id: string = crypto.randomUUID(),
): { decision: string; connectors: string[] } {
	const size = { w: 320, h: 260 };
	const at = spotBesideAll(doc, near, size, sizeOf);
	addDecision(doc, id, { x: at.x, y: at.y, title: draft.title, text: draft.text, author });
	placeInSections(doc, [id], sizeOf);
	const shapes = readShapes(doc);
	const cards = [...selection(shapes, near)]
		.filter((shape) => shapes.get(shape)?.type === "card")
		.slice(0, DECISION_LINKS);
	const boxFor = (shape: string): Rect | undefined => {
		if (shape === id) return { ...at, ...size };
		const found = shapes.get(shape);
		return found ? boxOf(shape, found, sizeOf) : undefined;
	};
	const connectors = cards.map((card) =>
		addConnector(
			doc,
			withFallbacks({ x: 0, y: 0, shape: id }, { x: 0, y: 0, shape: card }, boxFor),
		),
	);
	return { decision: id, connectors };
}
