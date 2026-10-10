import type * as Y from "yjs";
import { boxOf, descendantsOf, readStructure } from "./sections.ts";
import { type ShapeProps, readShape, shapesMap } from "./shapes.ts";
import type { QueryContext } from "./widgets.ts";

// What widgets' queries may read from the board around them (see
// `QueryContext`): the cards in a section, for a dependency map of a
// section's cards. The server and the playground both read it from the
// document, so they agree on what a widget runs.

/** A query context over a board's document, read as it is now. */
export function boardQueryContext(doc: Y.Doc, now = Date.now()): QueryContext {
	let shapes: Map<string, ShapeProps> | null = null;
	const read = () => {
		if (!shapes) {
			shapes = new Map();
			for (const [id, shape] of shapesMap(doc)) shapes.set(id, readShape(shape));
		}
		return shapes;
	};
	return { now, cardsIn: (section) => cardsIn(read(), section) };
}

/** How close the tops of two cards must be to read as the same row. */
const ROW_BAND = 80;

/** The items of the cards inside a section, at any depth, in reading order (rows, then columns). */
export function cardsIn(shapes: ReadonlyMap<string, ShapeProps>, section: string): string[] {
	if (shapes.get(section)?.type !== "section") return [];
	const structure = readStructure(shapes);
	const cards = descendantsOf(structure, section).flatMap((id) => {
		const shape = shapes.get(id);
		return shape?.type === "card" && typeof shape.ref === "string"
			? [{ ref: shape.ref, box: boxOf(id, shape) }]
			: [];
	});
	// Cards whose tops are in the same band of the section read as one row.
	const row = (y: number) => Math.floor(y / ROW_BAND);
	cards.sort((a, b) => row(a.box.y) - row(b.box.y) || a.box.x - b.box.x || a.box.y - b.box.y);
	return [...new Set(cards.map((card) => card.ref))];
}
