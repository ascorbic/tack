import type { Point, Rect } from "./geometry.ts";
import type { PileSuggestion, ShapeProps } from "./shapes.ts";

// Piles (#73): stickies gathered into a stack, as people do when theming a
// planning session, and named from what's in them. A pile is a shape of its
// own (`type: "pile"`), and a sticky in one says so with its own `pile` key,
// as a shape says which section it's in with `parent`. Membership lives on
// the stickies, so two people dragging different stickies onto a pile at
// once both land, and one person dragging a sticky out while another drags
// it somewhere else resolves to one of them, never a mix.
//
// While it's in a pile, a sticky's x and y are the pile's top sticky's, and
// its parent is the pile's: moving a pile writes them on every sticky in it
// (with `pile`, so a concurrent drag out either wins whole or loses whole;
// see `commitMoves`). So containment, placement and everything else that
// reads where shapes are needs to know nothing about piles. Readers that
// list what's in a section and shouldn't count piled stickies on their own
// (lists, mini cards) ask `isPiled`.
//
// A pile reads as a neat stack, top sticky first: the stickies' stacking
// order (z) is the pile's order, the last one dropped on top. Opening one
// spreads its stickies into a grid where it is: that's this person's view
// alone (the client's `pileStore`), while what's in the pile is everyone's.
//
// Names: `title` is a name a person gave it, and is never touched by
// anything else. `suggested` is a name the server suggested from the
// stickies' visible text (piles' naming, src/shared/pileNamer.ts), with a
// hash of that text, so it's made again only when the text changes. Silent
// mode's face-down stickies have no text in the document, so they can't
// lend a pile their words until they're revealed.
//
// Repair (repair.ts) settles what concurrent edits leave behind: a sticky
// pointing at a pile that's gone, a pile left with one sticky (it dissolves
// back into that sticky) or none (it goes), stickies whose parent drifted
// from their pile's.

/** A pile's box: the stack, with room for its name below. */
export const PILE_SIZE = { w: 200, h: 240 } as const;
/** Where its top sticky sits inside its box (and so where a piled sticky's x and y are). */
export const PILE_INSET = { x: 12, y: 10 } as const;
/** A sticky's size, as drawn. */
export const STICKY = 176;
/** The open grid: a gap between stickies, the tray's padding and its header. */
export const PILE_GRID = { gap: 16, pad: 20, head: 52, maxColumns: 5 } as const;

/** Text sent for naming: at most this many stickies, each cut to this many characters. */
export const NAMING_LIMITS = { stickies: 40, chars: 280 } as const;
/** A name is at most this long. */
export const PILE_NAME_MAX = 60;
/** What a pile without a name is called. */
export const UNTITLED_PILE = "Untitled pile";

type Shapes = ReadonlyMap<string, ShapeProps>;

/** The pile a shape is in, if it's a sticky that says it's in one (which may be gone). */
export function pileKey(shape: Pick<ShapeProps, "type" | "pile"> | undefined): string | null {
	return shape?.type === "sticky" && typeof shape.pile === "string" ? shape.pile : null;
}

/** The pile a sticky is in, if that pile is still there. */
export function pileOf(shapes: Shapes, id: string): string | null {
	const pile = pileKey(shapes.get(id));
	return pile && pile !== id && shapes.get(pile)?.type === "pile" ? pile : null;
}

/** Whether a shape is a sticky in a pile that's there: drawn as part of the pile, not itself. */
export function isPiled(shapes: Shapes, id: string): boolean {
	return pileOf(shapes, id) !== null;
}

/** By z, top of the stack first; ties by id, so everyone agrees. */
function topFirst(shapes: Shapes) {
	return (a: string, b: string) => {
		const za = shapes.get(a)?.z ?? "";
		const zb = shapes.get(b)?.z ?? "";
		return za < zb ? 1 : za > zb ? -1 : a < b ? -1 : a > b ? 1 : 0;
	};
}

/** Every pile's stickies, top of the stack first (piles with none are left out). */
export function pileMembers(shapes: Shapes): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [id] of shapes) {
		const pile = pileOf(shapes, id);
		if (!pile) continue;
		const list = out.get(pile);
		if (list) list.push(id);
		else out.set(pile, [id]);
	}
	const order = topFirst(shapes);
	for (const list of out.values()) list.sort(order);
	return out;
}

/** One pile's stickies, top of the stack first. */
export function membersOf(shapes: Shapes, pile: string): string[] {
	return pileMembers(shapes).get(pile) ?? [];
}

/** Where a sticky in a pile at `pile` (its top left) sits. */
export function memberAt(pile: Point): Point {
	return { x: pile.x + PILE_INSET.x, y: pile.y + PILE_INSET.y };
}

/** Where a pile goes for a sticky at `sticky` to be its top sticky. */
export function pileAtSticky(sticky: Point): Point {
	return { x: sticky.x - PILE_INSET.x, y: sticky.y - PILE_INSET.y };
}

// --- Names -------------------------------------------------------------------------------

export type NameState = "person" | "suggested" | "none";

/** What a pile's called: a person's name for it, else its suggestion, else null. */
export function pileName(
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

export function readSuggestion(value: unknown): PileSuggestion | null {
	if (!value || typeof value !== "object") return null;
	const { title, hash } = value as Partial<PileSuggestion>;
	if (typeof title !== "string" || typeof hash !== "string" || !title.trim()) return null;
	return { title, hash };
}

/**
 * Tidy a name, wherever it came from (a person, or a model): one line, no
 * quotes, emoji or Markdown around it, no trailing full stop, at most
 * `PILE_NAME_MAX` characters (cut at a word). Empty if nothing's left.
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
	name = name.replace(/^(?:theme|name|title|group|pile|label)\s*[:\-–—]\s*/i, "");
	// Markdown and quotes around the whole thing, and bullets.
	name = name.replace(/^[\s#>*_`~\-–—•·"'“”‘’«»]+/u, "").replace(/[\s*_`~"'“”‘’«»]+$/u, "");
	// Emoji and pictographs (it gets its ✨ from the board, not the model).
	name = name.replace(/\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|\u{FE0F}|\u{200D}/gu, "");
	// Trailing full stops and quotes, in whichever order they came.
	name = name.replace(/\s+/g, " ").replace(/[\s.;:,!*_`~"'“”‘’«»]+$/u, "");
	if (name.length > PILE_NAME_MAX) {
		const cut = name.slice(0, PILE_NAME_MAX + 1);
		const space = cut.lastIndexOf(" ");
		name = (space > PILE_NAME_MAX / 2 ? cut.slice(0, space) : cut.slice(0, PILE_NAME_MAX)).trim();
		name = name.replace(/[\s,;:–—-]+$/u, "");
	}
	return name;
}

/** Whether a suggested name is one worth showing: 1 to 8 words, with a letter or digit in it. */
export function usableName(name: string): boolean {
	const words = name.split(/\s+/).filter(Boolean);
	return words.length >= 1 && words.length <= 8 && /[\p{L}\p{N}]/u.test(name);
}

// --- What a pile says -------------------------------------------------------------------

/**
 * The text a pile can be named from: its stickies' visible text, never a
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
 * stickies are stacked in (so restacking a pile doesn't rename it).
 * Synchronous (53-bit cyrb53), as it's checked on every change; it's for
 * noticing changes and caching names, not for security.
 */
export function pileHash(texts: readonly string[]): string {
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

/** Whether a pile wants a (new) suggestion: no name from a person, and text that's changed. */
export function wantsSuggestion(shape: ShapeProps | undefined, hash: string | null): boolean {
	if (!shape || shape.type !== "pile" || nameState(shape) === "person" || hash === null) {
		return false;
	}
	return readSuggestion(shape.suggested)?.hash !== hash;
}

// --- The open grid ----------------------------------------------------------------------

export interface OpenLayout {
	/** The tray the stickies spread out on, header included. */
	tray: Rect;
	/** Each sticky's top left, in the pile's order. */
	slots: Map<string, Point>;
	columns: number;
}

/** How many columns a grid of `count` stickies has: tidy, and never wider than it's tall by much. */
export function gridColumns(count: number): number {
	if (count <= 3) return Math.max(1, count);
	if (count === 4) return 2;
	return Math.min(PILE_GRID.maxColumns, Math.ceil(Math.sqrt(count)));
}

/**
 * An open pile: its stickies in a grid on a tray centred where the stack
 * is, in the pile's order (top of the stack first, reading left to right).
 */
export function openLayout(pile: Point, members: readonly string[]): OpenLayout {
	const count = Math.max(1, members.length);
	const columns = gridColumns(count);
	const rows = Math.ceil(count / columns);
	const gridW = columns * STICKY + (columns - 1) * PILE_GRID.gap;
	const gridH = rows * STICKY + (rows - 1) * PILE_GRID.gap;
	const w = gridW + PILE_GRID.pad * 2;
	const h = PILE_GRID.head + gridH + PILE_GRID.pad;
	const centre = { x: pile.x + PILE_SIZE.w / 2, y: pile.y + PILE_INSET.y + STICKY / 2 };
	const tray = {
		x: Math.round(centre.x - w / 2),
		y: Math.round(centre.y - (PILE_GRID.head + gridH / 2)),
		w,
		h,
	};
	const slots = new Map<string, Point>();
	members.forEach((id, i) => {
		const column = i % columns;
		const row = Math.floor(i / columns);
		slots.set(id, {
			x: tray.x + PILE_GRID.pad + column * (STICKY + PILE_GRID.gap),
			y: tray.y + PILE_GRID.head + row * (STICKY + PILE_GRID.gap),
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

/** A pile in words: "Docs gaps · 5 stickies". */
export function describePile(shape: ShapeProps | undefined, count: number): string {
	const name = pileName(shape) ?? UNTITLED_PILE;
	return `${name} · ${count} ${count === 1 ? "sticky" : "stickies"}`;
}
