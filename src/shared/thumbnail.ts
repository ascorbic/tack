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
import {
	type DisplayLayout,
	type SectionLayout,
	type Slot,
	emptyState,
	layoutDisplays,
} from "./display.ts";
import { LINK_CARD, linkHue, readPreview } from "./linkPreview.ts";
import { imageSize } from "./images.ts";
import { readStructure } from "./sections.ts";
import { stackSize } from "./stacks.ts";
import { type ShapeProps, shapesMap } from "./shapes.ts";

/** Rendered sizes of shapes the document doesn't size, from styles.css. */
const CARD = { width: 252, height: 128 };
const ACTION = { width: 296, height: 104 };
const WIDGET = { width: 360, height: 440 };
const DECISION = { width: 320, height: 230 };
const STICKY = 176;
/** A link card without a picture: the band, and a line or two of title. */
const LINK_BANDED = { width: LINK_CARD.w, height: 176 };
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

/** A stack: a theme card, as big as what it holds, tinted by its top sticky's colour. */
function stackBox(
	props: Record<string, unknown>,
	top: { color: string; count: number } | undefined,
): Box | null {
	const { x, y } = props;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
	const size = stackSize(top?.count ?? 2, 2);
	return { kind: "stack", x, y, width: size.w, height: size.h, tone: top?.color ?? "" };
}

/** A sticky, card or link card that says it's in a stack. */
function isMember(shape: Record<string, unknown>): boolean {
	return (
		(shape.type === "sticky" || shape.type === "card" || shape.type === "link") &&
		typeof shape.stack === "string"
	);
}

export interface SketchOptions {
	/**
	 * Draw an empty list or grid of mini cards at the size it was given, with
	 * a few rows or cards outlined: a template's, which has nothing in it yet
	 * but says what it's for. Otherwise it's drawn as the board shows it.
	 */
	outlineEmpty?: boolean;
}

/**
 * Sketch shapes given as plain properties (a document's, or a template's),
 * each with its `id` (for stacks, whose stickies say which stack they're in).
 */
export function sketch(
	shapes: Iterable<Record<string, unknown>>,
	cardTone: (ref: string) => string = () => "",
	{ outlineEmpty = false }: SketchOptions = {},
): Thumbnail | null {
	const all = [...shapes];
	const displays = displayLayout(all);
	// A stack draws as one theme card, in its top sticky's colour (stacks.ts).
	const stackTops = new Map<string, { z: string; color: string; count: number }>();
	for (const shape of all) {
		if (!isMember(shape)) continue;
		const stack = shape.stack as string;
		const z = typeof shape.z === "string" ? shape.z : "";
		const top = stackTops.get(stack) ?? { z: "", color: "", count: 0 };
		top.count++;
		if (shape.type === "sticky" && (!top.color || z > top.z)) {
			top.z = z;
			top.color = typeof shape.color === "string" ? shape.color : "yellow";
		}
		stackTops.set(stack, top);
	}
	const boxes: Box[] = [];
	for (const shape of all) {
		if (isMember(shape)) continue;
		const id = typeof shape.id === "string" ? shape.id : "";
		// Sections showing a list or mini cards, and what's in them, as the board lays them out.
		const slot = displays?.slots.get(id);
		if (slot) {
			const box = slotBox(slot, shape, cardTone);
			if (box) boxes.push(box);
			continue;
		}
		const list = displays?.sections.get(id);
		if (list) {
			boxes.push(...displayBoxes(list, shape, outlineEmpty));
			continue;
		}
		const box =
			shape.type === "stack"
				? stackBox(shape, stackTops.get(typeof shape.id === "string" ? shape.id : ""))
				: shapeBox(shape, cardTone);
		if (box) boxes.push(box);
	}
	if (boxes.length === 0) return null;

	// Frames sit behind everything; otherwise keep the biggest shapes, which
	// are the ones that read at thumbnail size (a list's rows last of all).
	const kept = boxes
		.sort((a, b) => rank(b) - rank(a) || b.width * b.height - a.width * a.height)
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

/** Frames first, then most shapes, then a list's rows and mini cards, which say least alone. */
function rank(box: Box): number {
	return box.kind === "frame" ? 2 : box.kind === "row" || box.kind === "tile" ? 0 : 1;
}

/** Where the board shows lists and grids of mini cards, if it has any. */
function displayLayout(all: readonly Record<string, unknown>[]): DisplayLayout | null {
	const shapes = new Map<string, ShapeProps>();
	let any = false;
	for (const shape of all) {
		if (typeof shape.id !== "string" || typeof shape.type !== "string") continue;
		if (!isFiniteNumber(shape.x) || !isFiniteNumber(shape.y)) continue;
		shapes.set(shape.id, shape as unknown as ShapeProps);
		if (shape.type === "section" && (shape.display === "list" || shape.display === "mini")) {
			any = true;
		}
	}
	return any ? layoutDisplays(shapes, readStructure(shapes)) : null;
}

/** A row of a list or a mini card, toned like what it shows; a section inside, as a frame. */
function slotBox(
	slot: Slot,
	shape: Record<string, unknown>,
	cardTone: (ref: string) => string,
): Box | null {
	const { x, y, w: width, h: height } = slot.rect;
	if (slot.kind === "group") {
		return { kind: "frame", x, y, width, height, tone: toneOf(shape.color) };
	}
	const kind = slot.kind === "mini" ? "tile" : "row";
	const tone =
		shape.type === "card" && typeof shape.ref === "string"
			? cardTone(shape.ref)
			: shape.type === "sticky"
				? `sticky:${toneOf(shape.color) || "yellow"}`
				: "";
	return { kind, x, y, width, height, tone };
}

/** How big an empty list's outlined rows are drawn, for its width: bigger than life, to read in a sketch. */
const OUTLINE = { pad: 0.05, row: 0.13, gap: 0.035, rows: 4, columns: 3, tile: 0.64 } as const;

/**
 * A section showing a list or mini cards: its frame, as tall as what's in
 * it (an empty one as tall as its empty state, with its placeholders
 * outlined, as the board draws it), or with `outline`, an empty one at its
 * own size with a few rows or mini cards outlined in it, bigger than life.
 */
function displayBoxes(
	list: SectionLayout,
	shape: Record<string, unknown>,
	outline: boolean,
): Box[] {
	const tone = toneOf(shape.color);
	const own = explicitSize(shape);
	if (!outline || list.order.length > 0 || !own) {
		const { x, y, w: width, h: height } = list.box;
		// An empty one as the board draws it: its placeholders, outlined.
		const placeholders = (emptyState(list)?.placeholders ?? []).map((rect): Box => ({
			kind: list.mode === "mini" ? "tile" : "row",
			x: rect.x,
			y: rect.y,
			width: rect.w,
			height: rect.h,
			tone: "outline",
		}));
		return [{ kind: "frame", x, y, width, height, tone }, ...placeholders];
	}
	const { x, y, w: width } = list.box;
	const frame: Box = { kind: "frame", x, y, width, height: own.height, tone };
	const pad = width * OUTLINE.pad;
	const gap = width * OUTLINE.gap;
	const inner = width - pad * 2;
	const fits = (size: number) =>
		Math.max(1, Math.floor((own.height - pad * 2 + gap) / (size + gap)));
	if (list.mode === "list") {
		const height = width * OUTLINE.row;
		return [
			frame,
			...Array.from({ length: Math.min(OUTLINE.rows, fits(height)) }, (_, i): Box => ({
				kind: "row",
				x: x + pad,
				y: y + pad + i * (height + gap),
				width: inner,
				height,
				tone: "outline",
			})),
		];
	}
	const tileW = (inner - gap * (OUTLINE.columns - 1)) / OUTLINE.columns;
	const tileH = tileW * OUTLINE.tile;
	const lines = Math.min(2, fits(tileH));
	return [
		frame,
		...Array.from({ length: OUTLINE.columns * lines }, (_, i): Box => ({
			kind: "tile",
			x: x + pad + (i % OUTLINE.columns) * (tileW + gap),
			y: y + pad + Math.floor(i / OUTLINE.columns) * (tileH + gap),
			width: tileW,
			height: tileH,
			tone: "outline",
		})),
	];
}

function toneOf(color: unknown): string {
	return typeof color === "string" ? color : "";
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
		case "link": {
			// A link card's tone is its site's hue, for the tint where its
			// picture is; empty for a page that couldn't be read, drawn neutral.
			const preview = readPreview(props.preview);
			const url = typeof props.url === "string" ? props.url : "";
			const unread = preview?.status === "failed" || preview?.status === "blocked";
			const size = preview?.image ? { width: LINK_CARD.w, height: LINK_CARD.h } : LINK_BANDED;
			return {
				kind: "link",
				x,
				y,
				...(sized ?? size),
				tone: url && !unread ? String(linkHue(url)) : "",
			};
		}
		case "image": {
			// Where a picture is, never what it shows: the home page never loads
			// a board's files, and the sketch has no room for them anyway.
			const { w, h } = imageSize(props as { w?: number; h?: number });
			return { kind: "image", x, y, width: w, height: h, tone: "" };
		}
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
