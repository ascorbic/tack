import * as Y from "yjs";

// The board document: `shapes` is a map of shape id → Y.Map of properties.
// Each property is its own key so concurrent edits to different properties
// of the same shape merge cleanly.

export type ShapeType = "card" | "sticky";

export interface ShapeProps {
	type: ShapeType;
	x: number;
	y: number;
	/** Fractional index for stacking order. */
	z: string;
	/** Card shapes: the card key, `owner/repo#number`. */
	ref?: string;
	/** Sticky shapes: plain text for now. */
	text?: string;
	color?: string;
}

export function shapesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap("shapes");
}

export function readShape(shape: Y.Map<unknown>): ShapeProps {
	return shape.toJSON() as ShapeProps;
}

export function addShape(doc: Y.Doc, id: string, props: ShapeProps): void {
	doc.transact(() => {
		const shape = new Y.Map<unknown>();
		for (const [key, value] of Object.entries(props)) {
			if (value !== undefined) shape.set(key, value);
		}
		shapesMap(doc).set(id, shape);
	});
}

/** The set of card keys referenced anywhere on the board. */
export function cardRefs(doc: Y.Doc): Set<string> {
	const refs = new Set<string>();
	for (const shape of shapesMap(doc).values()) {
		const ref = shape.get("ref");
		if (shape.get("type") === "card" && typeof ref === "string") refs.add(ref);
	}
	return refs;
}
