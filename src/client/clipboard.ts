import { generateNKeysBetween } from "fractional-indexing";
import * as v from "valibot";
import * as Y from "yjs";
import { ACTION_UNCOPIED } from "../shared/actionItems.ts";
import { DECISION_UNCOPIED } from "../shared/decisions.ts";
import { CARD_UNCOPIED } from "../shared/provenance.ts";
import { MAX_PASTED_LINKS, linkUrl } from "../shared/linkPreview.ts";
import { itemKey, parseRef } from "../shared/refs.ts";
import { nextZ, shapesMap } from "../shared/shapes.ts";

// Copy and paste for shapes, within a board and between boards. Shapes are
// copied with every property they have, whatever their type, so new shape
// types work without changes here. The payload travels on the system
// clipboard three ways: as a custom MIME type, embedded in HTML (which
// survives where custom types don't), and as plain text for pasting into
// anything else.

/** The custom clipboard type for copied shapes. */
export const CLIPBOARD_TYPE = "application/x-tack+json";

const HTML_ATTRIBUTE = "data-tack-clipboard";

export interface ClipboardShape {
	/** The shape's id on the board it was copied from. */
	id: string;
	/** Every property of the shape, with nested Yjs types encoded (see toPlain). */
	props: Record<string, unknown>;
	/** Rendered size when copied, for placing the paste. */
	width?: number;
	height?: number;
}

export interface ClipboardPayload {
	tack: 1;
	/** The board the shapes came from. */
	board?: string;
	shapes: ClipboardShape[];
}

export interface Size {
	width: number;
	height: number;
}

export interface Rect extends Size {
	x: number;
	y: number;
}

const finite = v.pipe(v.number(), v.finite());

const PayloadSchema = v.object({
	tack: v.literal(1),
	board: v.optional(v.string()),
	shapes: v.array(
		v.object({
			id: v.string(),
			props: v.looseObject({ type: v.string(), x: finite, y: finite }),
			width: v.optional(finite),
			height: v.optional(finite),
		}),
	),
});

/** Copy shapes out of the document, bottom to top. */
export function copyShapes(
	doc: Y.Doc,
	ids: Iterable<string>,
	{
		board,
		sizes,
		positions,
	}: {
		board?: string;
		sizes?: (id: string) => Size | undefined;
		/**
		 * Where shapes are drawn, if not where the document says: a row in a
		 * list (#72), copied without its section, is copied from where it shows.
		 */
		positions?: (id: string) => { x: number; y: number } | undefined;
	} = {},
): ClipboardPayload {
	const shapes = shapesMap(doc);
	const copied: ClipboardShape[] = [];
	const all = new Set(ids);
	for (const id of all) {
		const shape = shapes.get(id);
		if (!shape) continue;
		const size = sizes?.(id);
		const props = Object.fromEntries([...shape.entries()].map(([k, v]) => [k, toPlain(v)]));
		const parent = props.parent;
		const drawn = typeof parent === "string" && all.has(parent) ? undefined : positions?.(id);
		if (drawn) {
			props.x = Math.round(drawn.x);
			props.y = Math.round(drawn.y);
			delete props.order;
		}
		copied.push({ id, props, ...size });
	}
	copied.sort((a, b) => compareZ(a.props.z, b.props.z));
	return { tack: 1, board, shapes: copied };
}

/** Parse a payload from untrusted clipboard text, or null if it isn't one. */
export function parsePayload(text: string | undefined | null): ClipboardPayload | null {
	if (!text) return null;
	try {
		const result = v.safeParse(PayloadSchema, JSON.parse(text));
		if (!result.success || result.output.shapes.length === 0) return null;
		return result.output as ClipboardPayload;
	} catch {
		return null;
	}
}

/**
 * HTML for the clipboard: the payload rides along in an attribute, around a
 * readable rendering for rich-text editors.
 */
export function toHtml(payload: ClipboardPayload, text: string): string {
	const encoded = base64Encode(JSON.stringify(payload));
	const body = text
		.split("\n\n")
		.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
		.join("");
	return `<div ${HTML_ATTRIBUTE}="${encoded}">${body}</div>`;
}

export function fromHtml(html: string | undefined | null): ClipboardPayload | null {
	if (!html) return null;
	const match = new RegExp(`${HTML_ATTRIBUTE}="([A-Za-z0-9+/=]+)"`).exec(html);
	if (!match?.[1]) return null;
	try {
		return parsePayload(base64Decode(match[1]));
	} catch {
		return null;
	}
}

/**
 * Plain text for pasting outside Tack: each sticky's text, each card's link,
 * each decision's title and body, each list's title and search, and each
 * action item as a task (with its owner and due date), one per paragraph.
 */
export function toPlainText(
	payload: ClipboardPayload,
	cardUrl: (key: string) => string | undefined = () => undefined,
): string {
	const parts: string[] = [];
	for (const { props } of payload.shapes) {
		if (props.type === "decision" && typeof props.title === "string" && props.title.trim()) {
			parts.push(props.title.trim());
		}
		// A list: its title and search.
		if (props.type === "widget" && props.config && typeof props.config === "object") {
			const { title, q } = props.config as { title?: unknown; q?: unknown };
			const line = [title, q].filter((s): s is string => typeof s === "string" && s.trim() !== "");
			if (line.length > 0) parts.push(line.join(": "));
		}
		if (props.type === "action") {
			const text = plainString(props.text)?.trim() ?? "";
			const owner = props.owner as { login?: unknown } | undefined;
			const facts = [
				typeof owner?.login === "string" ? `@${owner.login}` : "",
				typeof props.due === "string" ? `due ${props.due}` : "",
				typeof props.ref === "string" ? (cardUrl(props.ref) ?? props.ref) : "",
			].filter(Boolean);
			parts.push(
				`- [${props.done ? "x" : " "}] ${text}${facts.length ? ` (${facts.join(", ")})` : ""}`,
			);
			continue;
		}
		if (typeof props.ref === "string") parts.push(cardUrl(props.ref) ?? props.ref);
		const text = plainString(props.text);
		if (text?.trim()) parts.push(text.trim());
	}
	return parts.join("\n\n");
}

/** The bounding box of the copied shapes, at their original positions. */
export function payloadBounds(payload: ClipboardPayload): Rect | null {
	let bounds: { x1: number; y1: number; x2: number; y2: number } | null = null;
	for (const { props, width = 0, height = 0 } of payload.shapes) {
		const x = Number(props.x);
		const y = Number(props.y);
		bounds = bounds
			? {
					x1: Math.min(bounds.x1, x),
					y1: Math.min(bounds.y1, y),
					x2: Math.max(bounds.x2, x + width),
					y2: Math.max(bounds.y2, y + height),
				}
			: { x1: x, y1: y, x2: x + width, y2: y + height };
	}
	return (
		bounds && {
			x: bounds.x1,
			y: bounds.y1,
			width: bounds.x2 - bounds.x1,
			height: bounds.y2 - bounds.y1,
		}
	);
}

/**
 * Properties that stay with the original rather than travel with a copy: a
 * decision's write-back, and the pull request it was written to, belong to
 * that decision. A pasted one can be written back on its own. A card's
 * provenance stays too: whoever pastes a copy placed it.
 */
const UNCOPIED: Record<string, readonly string[]> = {
	decision: DECISION_UNCOPIED,
	card: CARD_UNCOPIED,
	// Silent mode belongs to the original: a copied section isn't silent, and
	// a copy of a face-down sticky (which has no text here) is a fresh one.
	section: ["silent"],
	sticky: ["silent"],
	// An action item's staged issue is the original's; its link to an issue
	// that exists travels, so a copy follows the same issue.
	action: ACTION_UNCOPIED,
};

/**
 * Add copied shapes to the document, moved by `offset`, with new ids and on
 * top of everything else (keeping their order). Properties that refer to
 * another copied shape by id, such as a connector's ends, are pointed at the
 * new copy. Returns the new ids, in the same order as the payload.
 *
 * Call inside a local transaction so the paste is a single undo step.
 */
export function pasteShapes(
	doc: Y.Doc,
	payload: ClipboardPayload,
	offset: { x: number; y: number },
): string[] {
	const ids = new Map(payload.shapes.map(({ id }) => [id, crypto.randomUUID()] as const));
	const first = nextZ(doc);
	const zs = [first, ...generateNKeysBetween(first, null, payload.shapes.length - 1)];
	const shapes = shapesMap(doc);
	const added: string[] = [];
	payload.shapes.forEach((copied, i) => {
		const id = ids.get(copied.id) ?? crypto.randomUUID();
		const shape = new Y.Map<unknown>();
		const uncopied = UNCOPIED[String(copied.props.type)];
		// Votes merge only as a Y.Map, so a decision always gets one. (A new
		// Y.Map can't be read back until it's in the document, so track it.)
		let hasVotes = false;
		for (const [key, value] of Object.entries(copied.props)) {
			if (key === "x" || key === "y" || key === "z" || value === undefined) continue;
			if (uncopied?.includes(key)) continue;
			// A shape's type is never a reference, whatever its id happens to be.
			const plain = fromPlain(key === "type" ? value : remapIds(value, ids));
			if (key === "votes" && !(plain instanceof Y.Map)) continue;
			if (key === "votes") hasVotes = true;
			shape.set(key, plain);
		}
		if (copied.props.type === "decision" && !hasVotes) shape.set("votes", new Y.Map());
		shape.set("x", Math.round(Number(copied.props.x) + offset.x));
		shape.set("y", Math.round(Number(copied.props.y) + offset.y));
		shape.set("z", zs[i]);
		shapes.set(id, shape);
		added.push(id);
	});
	return added;
}

/**
 * What a piece of pasted plain text should become: cards for items a forge
 * recognises, link cards for any other web address (links.ts), or a sticky.
 */
export type TextPaste =
	| { kind: "cards"; keys: string[]; links: string[] }
	| { kind: "sticky"; text: string };

/** Longest text a pasted sticky takes; anything longer is cut short. */
export const MAX_PASTED_TEXT = 5000;
const MAX_PASTED_CARDS = 50;

/**
 * Text that's nothing but references and addresses (one per line, or
 * between spaces) becomes cards: an issue's or pull request's (anything
 * `parseRef` reads, always asked first) as its card, any other web address
 * as a link card. Any other text becomes a sticky, addresses and all.
 */
export function interpretText(text: string): TextPaste | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const words = trimmed.split(/\s+/);
	if (words.length <= MAX_PASTED_CARDS) {
		const keys = new Set<string>();
		const links = new Set<string>();
		const items = words.every((word) => {
			const ref = parseRef(word);
			if (ref) return keys.add(itemKey(ref));
			const url = linkUrl(word);
			return url !== null && links.add(url);
		});
		if (items && links.size <= MAX_PASTED_LINKS) {
			return { kind: "cards", keys: [...keys], links: [...links] };
		}
	}
	return { kind: "sticky", text: trimmed.slice(0, MAX_PASTED_TEXT) };
}

// Nested Yjs types can't go through JSON as they are, so they're tagged.

type Tagged =
	| { $y: "text"; value: string }
	| { $y: "map"; value: Record<string, unknown> }
	| { $y: "array"; value: unknown[] };

export function toPlain(value: unknown): unknown {
	if (value instanceof Y.Text) return { $y: "text", value: value.toJSON() } satisfies Tagged;
	if (value instanceof Y.Array) {
		return { $y: "array", value: value.toArray().map(toPlain) } satisfies Tagged;
	}
	if (value instanceof Y.Map) {
		const entries = Object.fromEntries([...value.entries()].map(([k, v]) => [k, toPlain(v)]));
		return { $y: "map", value: entries } satisfies Tagged;
	}
	return value;
}

export function fromPlain(value: unknown): unknown {
	if (!isTagged(value)) return value;
	switch (value.$y) {
		case "text":
			return new Y.Text(value.value);
		case "array": {
			const array = new Y.Array<unknown>();
			array.push(value.value.map(fromPlain));
			return array;
		}
		case "map": {
			const map = new Y.Map<unknown>();
			for (const [k, v] of Object.entries(value.value)) map.set(k, fromPlain(v));
			return map;
		}
	}
}

function isTagged(value: unknown): value is Tagged {
	if (typeof value !== "object" || value === null || !("$y" in value) || !("value" in value)) {
		return false;
	}
	const { $y, value: inner } = value as { $y: unknown; value: unknown };
	return (
		($y === "text" && typeof inner === "string") ||
		($y === "array" && Array.isArray(inner)) ||
		($y === "map" && typeof inner === "object" && inner !== null && !Array.isArray(inner))
	);
}

function plainString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isTagged(value) && value.$y === "text") return value.value;
	return undefined;
}

/** Replace any string that's exactly a copied shape's id with its copy's id. */
function remapIds(value: unknown, ids: Map<string, string>): unknown {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => remapIds(item, ids));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapIds(v, ids)]));
	}
	return value;
}

function compareZ(a: unknown, b: unknown): number {
	const za = typeof a === "string" ? a : "";
	const zb = typeof b === "string" ? b : "";
	return za < zb ? -1 : za > zb ? 1 : 0;
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function base64Encode(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64Decode(encoded: string): string {
	const binary = atob(encoded);
	return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
