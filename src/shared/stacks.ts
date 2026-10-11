import type { Point, Rect } from "./geometry.ts";
import type { StackSuggestion, ShapeProps } from "./shapes.ts";

// Stacks (#73): stickies gathered into a stack, as people do when theming a
// planning session, and named from what's in them. A stack is a shape of its
// own (`type: "stack"`), and a sticky in one says so with its own `stack` key,
// as a shape says which section it's in with `parent`. Membership lives on
// the stickies, so two people dragging different stickies onto a stack at
// once both land, and one person dragging a sticky out while another drags
// it somewhere else resolves to one of them, never a mix.
//
// While it's in a stack, a sticky's x and y are the stack's top sticky's, and
// its parent is the stack's: moving a stack writes them on every sticky in it
// (with `stack`, so a concurrent drag out either wins whole or loses whole;
// see `commitMoves`). So containment, placement and everything else that
// reads where shapes are needs to know nothing about stacks. Readers that
// list what's in a section and shouldn't count stacked stickies on their own
// (lists, mini cards) ask `isStacked`.
//
// A stack reads as a neat stack, top sticky first: the stickies' stacking
// order (z) is the stack's order, the last one dropped on top. Opening one
// spreads its stickies into a grid where it is: that's this person's view
// alone (the client's `stackStore`), while what's in the stack is everyone's.
//
// Names: `title` is a name a person gave it, and is never touched by
// anything else. `suggested` is a name the server suggested from the
// stickies' visible text (stacks' naming, src/shared/stackNamer.ts), with a
// hash of that text, so it's made again only when the text changes. Silent
// mode's face-down stickies have no text in the document, so they can't
// lend a stack their words until they're revealed.
//
// Repair (repair.ts) settles what concurrent edits leave behind: a sticky
// pointing at a stack that's gone, a stack left with one sticky (it dissolves
// back into that sticky) or none (it goes), stickies whose parent drifted
// from their stack's.

/** A stack's box: the stack, with room for its name below. */
export const STACK_SIZE = { w: 200, h: 240 } as const;
/** Where its top sticky sits inside its box (and so where a stacked sticky's x and y are). */
export const STACK_INSET = { x: 12, y: 10 } as const;
/** A sticky's size, as drawn. */
export const STICKY = 176;
/** The open grid: a gap between stickies, the tray's padding and its header. */
export const STACK_GRID = { gap: 16, pad: 20, head: 52, maxColumns: 5 } as const;

/** Text sent for naming: at most this many stickies, each cut to this many characters. */
export const NAMING_LIMITS = { stickies: 40, chars: 280 } as const;
/** A name is at most this long. */
export const STACK_NAME_MAX = 60;
/** What a stack without a name is called. */
export const UNTITLED_STACK = "Untitled stack";

type Shapes = ReadonlyMap<string, ShapeProps>;

/** The stack a shape is in, if it's a sticky that says it's in one (which may be gone). */
export function stackKey(shape: Pick<ShapeProps, "type" | "stack"> | undefined): string | null {
	return shape?.type === "sticky" && typeof shape.stack === "string" ? shape.stack : null;
}

/** The stack a sticky is in, if that stack is still there. */
export function stackOf(shapes: Shapes, id: string): string | null {
	const stack = stackKey(shapes.get(id));
	return stack && stack !== id && shapes.get(stack)?.type === "stack" ? stack : null;
}

/** Whether a shape is a sticky in a stack that's there: drawn as part of the stack, not itself. */
export function isStacked(shapes: Shapes, id: string): boolean {
	return stackOf(shapes, id) !== null;
}

/** By z, top of the stack first; ties by id, so everyone agrees. */
function topFirst(shapes: Shapes) {
	return (a: string, b: string) => {
		const za = shapes.get(a)?.z ?? "";
		const zb = shapes.get(b)?.z ?? "";
		return za < zb ? 1 : za > zb ? -1 : a < b ? -1 : a > b ? 1 : 0;
	};
}

/** Every stack's stickies, top of the stack first (stacks with none are left out). */
export function stackMembers(shapes: Shapes): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [id] of shapes) {
		const stack = stackOf(shapes, id);
		if (!stack) continue;
		const list = out.get(stack);
		if (list) list.push(id);
		else out.set(stack, [id]);
	}
	const order = topFirst(shapes);
	for (const list of out.values()) list.sort(order);
	return out;
}

/** One stack's stickies, top of the stack first. */
export function membersOf(shapes: Shapes, stack: string): string[] {
	return stackMembers(shapes).get(stack) ?? [];
}

/** Where a sticky in a stack at `stack` (its top left) sits. */
export function memberAt(stack: Point): Point {
	return { x: stack.x + STACK_INSET.x, y: stack.y + STACK_INSET.y };
}

/** Where a stack goes for a sticky at `sticky` to be its top sticky. */
export function stackAtSticky(sticky: Point): Point {
	return { x: sticky.x - STACK_INSET.x, y: sticky.y - STACK_INSET.y };
}

// --- Names -------------------------------------------------------------------------------

export type NameState = "person" | "suggested" | "none";

/** What a stack's called: a person's name for it, else its suggestion, else null. */
export function stackName(
	shape: Pick<ShapeProps, "title" | "suggested"> | undefined,
): string | null {
	const title = typeof shape?.title === "string" ? shape.title.trim() : "";
	if (title) return title;
	const suggested = readSuggestion(shape?.suggested);
	return suggested ? suggested.title : null;
}

/** Whose name it shows: a person's, a suggestion, or none yet. */
export function nameState(shape: Pick<ShapeProps, "title" | "suggested"> | undefined): NameState {
	if (typeof shape?.title === "string" && shape.title.trim()) return "person";
	return readSuggestion(shape?.suggested) ? "suggested" : "none";
}

export function readSuggestion(value: unknown): StackSuggestion | null {
	if (!value || typeof value !== "object") return null;
	const { title, hash } = value as Partial<StackSuggestion>;
	if (typeof title !== "string" || typeof hash !== "string" || !title.trim()) return null;
	return { title, hash };
}

/**
 * Tidy a name, wherever it came from (a person, or a model): one line, no
 * quotes, emoji or Markdown around it, no trailing full stop, at most
 * `STACK_NAME_MAX` characters (cut at a word). Empty if nothing's left.
 */
export function cleanName(raw: string): string {
	let name = raw
		.normalize("NFC")
		// Control characters and line breaks: one line.
		.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
		// Zero-width and bidirectional controls, which could hide or reorder text.
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	// Leading labels a model might add.
	name = name.replace(/^(?:theme|name|title|group|stack|label)\s*[:\-–—]\s*/i, "");
	// Markdown and quotes around the whole thing, and bullets.
	name = name.replace(/^[\s#>*_`~\-–—•·"'“”‘’«»]+/u, "").replace(/[\s*_`~"'“”‘’«»]+$/u, "");
	// Emoji and pictographs (it gets its ✨ from the board, not the model).
	name = name.replace(/\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|\u{FE0F}|\u{200D}/gu, "");
	// Trailing full stops and quotes, in whichever order they came.
	name = name.replace(/\s+/g, " ").replace(/[\s.;:,!*_`~"'“”‘’«»]+$/u, "");
	if (name.length > STACK_NAME_MAX) {
		const cut = name.slice(0, STACK_NAME_MAX + 1);
		const space = cut.lastIndexOf(" ");
		name = (space > STACK_NAME_MAX / 2 ? cut.slice(0, space) : cut.slice(0, STACK_NAME_MAX)).trim();
		name = name.replace(/[\s,;:–—-]+$/u, "");
	}
	return name;
}

/** Whether a suggested name is one worth showing: 1 to 8 words, with a letter or digit in it. */
export function usableName(name: string): boolean {
	const words = name.split(/\s+/).filter(Boolean);
	return words.length >= 1 && words.length <= 8 && /[\p{L}\p{N}]/u.test(name);
}

// --- What a stack says -------------------------------------------------------------------

/**
 * The text a stack can be named from: its stickies' visible text, never a
 * face-down sticky's (whose text isn't in the document anyway; this makes
 * sure a stray value never is used either), trimmed, cut short, the empty
 * ones left out, top of the stack first.
 */
export function namingTexts(shapes: Shapes, members: readonly string[]): string[] {
	const out: string[] = [];
	for (const id of members) {
		const shape = shapes.get(id);
		if (!shape || shape.type !== "sticky" || shape.silent !== undefined) continue;
		const text = typeof shape.text === "string" ? cleanText(shape.text) : "";
		if (!text) continue;
		out.push(text);
		if (out.length >= NAMING_LIMITS.stickies) break;
	}
	return out;
}

/** A sticky's text as sent for naming: one line, trimmed, at most `NAMING_LIMITS.chars`. */
export function cleanText(text: string): string {
	const line = text
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > NAMING_LIMITS.chars ? `${line.slice(0, NAMING_LIMITS.chars - 1)}…` : line;
}

/**
 * A hash of the text a name's made from, the same whatever order the
 * stickies are stacked in (so restacking a stack doesn't rename it).
 * Synchronous (53-bit cyrb53), as it's checked on every change; it's for
 * noticing changes and caching names, not for security.
 */
export function stackHash(texts: readonly string[]): string {
	const input = [...texts]
		.map((text) => text.toLowerCase())
		.sort()
		.join("\u0000");
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Whether a stack wants a (new) suggestion: no name from a person, and text that's changed. */
export function wantsSuggestion(shape: ShapeProps | undefined, hash: string | null): boolean {
	if (!shape || shape.type !== "stack" || nameState(shape) === "person" || hash === null) {
		return false;
	}
	return readSuggestion(shape.suggested)?.hash !== hash;
}

// --- The open grid ----------------------------------------------------------------------

export interface OpenLayout {
	/** The tray the stickies spread out on, header included. */
	tray: Rect;
	/** Each sticky's top left, in the stack's order. */
	slots: Map<string, Point>;
	columns: number;
}

/** How many columns a grid of `count` stickies has: tidy, and never wider than it's tall by much. */
export function gridColumns(count: number): number {
	if (count <= 3) return Math.max(1, count);
	if (count === 4) return 2;
	return Math.min(STACK_GRID.maxColumns, Math.ceil(Math.sqrt(count)));
}

/**
 * An open stack: its stickies in a grid on a tray centred where the stack
 * is, in the stack's order (top of the stack first, reading left to right).
 */
export function openLayout(stack: Point, members: readonly string[]): OpenLayout {
	const count = Math.max(1, members.length);
	const columns = gridColumns(count);
	const rows = Math.ceil(count / columns);
	const gridW = columns * STICKY + (columns - 1) * STACK_GRID.gap;
	const gridH = rows * STICKY + (rows - 1) * STACK_GRID.gap;
	const w = gridW + STACK_GRID.pad * 2;
	const h = STACK_GRID.head + gridH + STACK_GRID.pad;
	const centre = { x: stack.x + STACK_SIZE.w / 2, y: stack.y + STACK_INSET.y + STICKY / 2 };
	const tray = {
		x: Math.round(centre.x - w / 2),
		y: Math.round(centre.y - (STACK_GRID.head + gridH / 2)),
		w,
		h,
	};
	const slots = new Map<string, Point>();
	members.forEach((id, i) => {
		const column = i % columns;
		const row = Math.floor(i / columns);
		slots.set(id, {
			x: tray.x + STACK_GRID.pad + column * (STICKY + STACK_GRID.gap),
			y: tray.y + STACK_GRID.head + row * (STICKY + STACK_GRID.gap),
		});
	});
	return { tray, slots, columns };
}

/** The slot in an open grid nearest `point` (a dragged sticky's centre), for reordering. */
export function nearestSlot(layout: OpenLayout, point: Point): number {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	[...layout.slots.values()].forEach((slot, i) => {
		const dx = slot.x + STICKY / 2 - point.x;
		const dy = slot.y + STICKY / 2 - point.y;
		const d = dx * dx + dy * dy;
		if (d < bestDistance) {
			bestDistance = d;
			best = i;
		}
	});
	return best;
}

/** A stack in words: "Docs gaps · 5 stickies". */
export function describeStack(shape: ShapeProps | undefined, count: number): string {
	const name = stackName(shape) ?? UNTITLED_STACK;
	return `${name} · ${count} ${count === 1 ? "sticky" : "stickies"}`;
}
