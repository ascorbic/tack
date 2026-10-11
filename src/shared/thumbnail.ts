// A board's thumbnail: a compact sketch of where its shapes are and what
// colour they are, computed by the board's Durable Object on save. The home
// page draws it as SVG (see `BoardThumbnail.tsx`), so it never loads a board
// document and the sketch follows the light or dark theme. Templates (#53)
// are sketched the same way, from their content.

import type * as Y from "yjs";
import {
	THUMBNAIL_MAX_SHAPES,
	THUMBNAIL_SIZE,
	type Thumbnail,
	type ThumbnailKind,
	type ThumbnailShape,
} from "./boards.ts";
import { PILE_SIZE } from "./piles.ts";
import { shapesMap } from "./shapes.ts";

/** Rendered sizes of shapes the document doesn't size, from styles.css. */
const CARD = { width: 252, height: 128 };
const ACTION = { width: 296, height: 104 };
const WIDGET = { width: 360, height: 440 };
const DECISION = { width: 320, height: 230 };
const STICKY = 176;
const TEXT_SIZES: Record<string, number> = { s: 14, m: 20, l: 34, xl: 56 };
const TEXT_MAX_WIDTH = 520;

interface Box {
	kind: ThumbnailKind;
	x: number;
	y: number;
	width: number;
	height: number;
	tone: string;
}

/**
 * Sketch a board. `cardTone` gives a card's state (open, merged, …) from
 * the live card data, so cards are tinted like the real thing.
 */
export function boardThumbnail(
	doc: Y.Doc,
	cardTone: (ref: string) => string = () => "",
): Thumbnail | null {
	return sketch(
		[...shapesMap(doc)].map(([id, shape]) => ({ ...shape.toJSON(), id })),
		cardTone,
	);
}

/** A pile: a sticky's size and colour (its top one's), with the stack's room around it. */
function pileBox(props: Record<string, unknown>, top: { color: string } | undefined): Box | null {
	const { x, y } = props;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	return { kind: "pile", x, y, width: PILE_SIZE.w, height: PILE_SIZE.w, tone: top?.color ?? "" };
}

/**
 * Sketch shapes given as plain properties (a document's, or a template's),
 * each with its `id` (for piles, whose stickies say which pile they're in).
 */
export function sketch(
	shapes: Iterable<Record<string, unknown>>,
	cardTone: (ref: string) => string = () => "",
): Thumbnail | null {
	const all = [...shapes];
	// A pile draws as one stack, in its top sticky's colour (piles.ts).
	const pileTops = new Map<string, { z: string; color: string }>();
	for (const shape of all) {
		if (shape.type !== "sticky" || typeof shape.pile !== "string") continue;
		const z = typeof shape.z === "string" ? shape.z : "";
		const top = pileTops.get(shape.pile);
		if (!top || z > top.z) {
			pileTops.set(shape.pile, {
				z,
				color: typeof shape.color === "string" ? shape.color : "yellow",
			});
		}
	}
	const boxes: Box[] = [];
	for (const shape of all) {
		if (shape.type === "sticky" && typeof shape.pile === "string") continue;
		const box =
			shape.type === "pile"
				? pileBox(shape, pileTops.get(typeof shape.id === "string" ? shape.id : ""))
				: shapeBox(shape, cardTone);
		if (box) boxes.push(box);
	}
	if (boxes.length === 0) return null;

	// Frames sit behind everything; otherwise keep the biggest shapes, which
	// are the ones that read at thumbnail size.
	const kept = boxes
		.sort((a, b) => b.width * b.height - a.width * a.height)
		.slice(0, THUMBNAIL_MAX_SHAPES)
		.sort((a, b) => Number(b.kind === "frame") - Number(a.kind === "frame"));

	const minX = Math.min(...kept.map((box) => box.x));
	const minY = Math.min(...kept.map((box) => box.y));
	const maxX = Math.max(...kept.map((box) => box.x + box.width));
	const maxY = Math.max(...kept.map((box) => box.y + box.height));
	const scale = THUMBNAIL_SIZE / Math.max(maxX - minX, maxY - minY, 1);
	const at = (n: number) => Math.round(n * scale);

	return {
		width: Math.max(1, at(maxX - minX)),
		height: Math.max(1, at(maxY - minY)),
		shapes: kept.map((box): ThumbnailShape => [
			box.kind,
			at(box.x - minX),
			at(box.y - minY),
			Math.max(1, at(box.width)),
			Math.max(1, at(box.height)),
			box.tone,
		]),
	};
}

function shapeBox(props: Record<string, unknown>, cardTone: (ref: string) => string): Box | null {
	const { type, x, y } = props;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	const sized = explicitSize(props);
	switch (type) {
		case "card": {
			const ref = typeof props.ref === "string" ? props.ref : "";
			return { kind: "card", x, y, ...(sized ?? CARD), tone: cardTone(ref) };
		}
		case "sticky":
			return {
				kind: "sticky",
				x,
				y,
				...(sized ?? { width: STICKY, height: STICKY }),
				tone: typeof props.color === "string" ? props.color : "yellow",
			};
		case "text": {
			// A text block's tone is how many lines it has, to draw them.
			const { lines, ...size } = textSize(props);
			return { kind: "text", x, y, ...(sized ?? size), tone: String(lines) };
		}
		case "widget":
			// A widget's tone is its kind, which picks how its body is drawn.
			return {
				kind: "widget",
				x,
				y,
				...(sized ?? WIDGET),
				tone: typeof props.widget === "string" ? props.widget : "",
			};
		case "action":
			// An action item's tone says whether it's done (on the board; linked
			// items' status needs the live issue).
			return { kind: "action", x, y, ...(sized ?? ACTION), tone: props.done ? "done" : "" };
		case "decision":
			return { kind: "card", x, y, ...(sized ?? DECISION), tone: "" };
		case "section":
		case "frame":
			return sized
				? {
						kind: "frame",
						x,
						y,
						...sized,
						tone: typeof props.color === "string" ? props.color : "",
					}
				: null;
		default:
			// Connectors (and anything newer) are left out: lines don't read at this size.
			return null;
	}
}

function explicitSize(props: Record<string, unknown>): { width: number; height: number } | null {
	const width = props.width ?? props.w;
	const height = props.height ?? props.h;
	return isFiniteNumber(width) && isFiniteNumber(height) && width > 0 && height > 0
		? { width, height }
		: null;
}

/** Roughly how much room a text block takes: wrapped lines of average-width glyphs. */
export function textSize(props: Record<string, unknown>): {
	width: number;
	height: number;
	lines: number;
} {
	const size = TEXT_SIZES[typeof props.size === "string" ? props.size : "m"] ?? 20;
	const text = typeof props.text === "string" && props.text ? props.text : "Text";
	const charWidth = size * 0.55;
	const perLine = Math.max(1, Math.floor(TEXT_MAX_WIDTH / charWidth));
	let lines = 0;
	let longest = 0;
	for (const line of text.split("\n")) {
		lines += Math.max(1, Math.ceil(line.length / perLine));
		longest = Math.max(longest, Math.min(line.length, perLine));
	}
	return {
		width: Math.max(size * 2, longest * charWidth + 12),
		height: lines * size * 1.3 + 8,
		lines,
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
