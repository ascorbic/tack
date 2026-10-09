import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";

// The board document: `shapes` is a map of shape id → Y.Map of properties.
// Each property is its own key so concurrent edits to different properties
// of the same shape merge cleanly.

export type ShapeType = "card" | "sticky" | "text";

/** Typeface for stickies and text: the UI sans, or a handwriting face. */
export type ShapeFont = "sans" | "hand";

/** Text block sizes, small to extra large. */
export type TextSize = "s" | "m" | "l" | "xl";

export interface ShapeProps {
	type: ShapeType;
	x: number;
	y: number;
	/** Fractional index for stacking order. */
	z: string;
	/** Card shapes: the card key, `owner/repo#number`. */
	ref?: string;
	/** Sticky and text shapes: plain text for now. */
	text?: string;
	color?: string;
	/** Sticky and text shapes: the typeface. Absent means sans. */
	font?: ShapeFont;
	/** Text shapes: the type size. Absent means medium. */
	size?: TextSize;
	/** Who made it, shown on stickies. */
	author?: Author;
}

export interface Author {
	name: string;
	color: string;
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

/**
 * A z-index above every other shape, or null if `except` is already on top.
 */
export function topZ(doc: Y.Doc, except?: string): string | null {
	let top: string | null = null;
	let topId: string | null = null;
	for (const [id, shape] of shapesMap(doc)) {
		const z = shape.get("z");
		// Skip keys fractional-indexing can't build on, so one bad shape (from
		// an old board or another client) can't break moving everything else.
		if (typeof z === "string" && isValidZ(z) && (top === null || z > top)) {
			top = z;
			topId = id;
		}
	}
	if (except && topId === except) return null;
	return generateKeyBetween(top, null);
}

const validZ = new Map<string, boolean>();

function isValidZ(z: string): boolean {
	let valid = validZ.get(z);
	if (valid === undefined) {
		try {
			generateKeyBetween(z, null);
			valid = true;
		} catch {
			valid = false;
		}
		validZ.set(z, valid);
	}
	return valid;
}

export function nextZ(doc: Y.Doc): string {
	return topZ(doc) ?? generateKeyBetween(null, null);
}

/**
 * Set properties on several shapes in one transaction, so a change like
 * recolouring a selection is a single document write (and a single undo
 * step). Keys that already hold the value are left alone, as every write
 * leaves a tombstone.
 */
export function updateShapes(
	doc: Y.Doc,
	ids: Iterable<string>,
	props: Partial<Omit<ShapeProps, "type">>,
	origin: unknown = "local",
): void {
	const shapes = shapesMap(doc);
	doc.transact(() => {
		for (const id of ids) {
			const shape = shapes.get(id);
			if (!shape) continue;
			for (const [key, value] of Object.entries(props)) {
				if (value === undefined) {
					if (shape.has(key)) shape.delete(key);
				} else if (shape.get(key) !== value) {
					shape.set(key, value);
				}
			}
		}
	}, origin);
}
