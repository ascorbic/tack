import { type CardState } from "./cards.ts";
import { readingOrder } from "./display.ts";
import type { ShapeProps, ShapeType } from "./shapes.ts";
import { nameState, stackName } from "./stacks.ts";

// The board for people who don't see it (#61): the order the keyboard meets
// shapes in, the nearest shape in a direction, and shapes and boards in
// words, for screen readers. Pure, so it's unit-tested in Node
// (test/a11y.test.ts) and the client only wires it up.

/** A shape where it's drawn, for moving between shapes. */
export interface Placed {
	id: string;
	type: ShapeType;
	/** The section it's in, if any. */
	parent: string | null;
	x: number;
	y: number;
	w: number;
	h: number;
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * Shapes in the order a reader meets them: the board's top level in reading
 * order (rows, top to bottom, each left to right), each section followed by
 * what's in it, in turn. A section showing a list goes in its list's order
 * (`listOrder`, given what's in it in reading order). Shapes whose section
 * has gone (references can dangle) count as top level.
 */
export function boardOrder(
	shapes: readonly Placed[],
	listOrder?: (section: string, ids: string[]) => string[] | undefined,
): string[] {
	const known = new Set(shapes.map((shape) => shape.id));
	const children = new Map<string | null, Placed[]>();
	for (const shape of shapes) {
		const parent = shape.parent && known.has(shape.parent) ? shape.parent : null;
		const list = children.get(parent);
		if (list) list.push(shape);
		else children.set(parent, [shape]);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (parent: string | null) => {
		const inside = children.get(parent) ?? [];
		let order = readingOrder(inside);
		if (parent !== null) {
			const custom = listOrder?.(parent, order);
			if (custom) {
				const here = new Set(order);
				const listed = custom.filter((id) => here.has(id));
				const listedSet = new Set(listed);
				order = [...listed, ...order.filter((id) => !listedSet.has(id))];
			}
		}
		for (const id of order) {
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(id);
			if (children.has(id)) visit(id);
		}
	};
	visit(null);
	// A loop of sections (concurrent edits can make one) is reached by nothing.
	for (const shape of readingOrder(shapes.filter((s) => !seen.has(s.id)))) out.push(shape);
	return out;
}

const centre = (shape: Placed) => ({ x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 });

/**
 * The shape to move to from `from` with an arrow key: the closest one that
 * way, preferring ones in line with it. Shapes in the same section come
 * first; past the last of them, the nearest anything else that way (never a
 * section it's inside, or anything inside it).
 */
export function nearestInDirection(
	from: Placed,
	shapes: readonly Placed[],
	direction: Direction,
): string | null {
	const byId = new Map(shapes.map((shape) => [shape.id, shape]));
	const ancestors = new Set<string>();
	for (let at = from.parent; at && !ancestors.has(at); at = byId.get(at)?.parent ?? null) {
		ancestors.add(at);
	}
	const insideFrom = (shape: Placed) => {
		const seen = new Set<string>();
		for (let at = shape.parent; at && !seen.has(at); at = byId.get(at)?.parent ?? null) {
			if (at === from.id) return true;
			seen.add(at);
		}
		return false;
	};
	const candidates = shapes.filter(
		(shape) => shape.id !== from.id && !ancestors.has(shape.id) && !insideFrom(shape),
	);
	const siblings = candidates.filter((shape) => (shape.parent ?? null) === (from.parent ?? null));
	return best(from, siblings, direction) ?? best(from, candidates, direction);
}

/**
 * The closest of `candidates` that way: first among those within 45° of
 * straight ahead (centre to centre), else among those wholly past `from`'s
 * edge that way, scoring distance ahead plus three times how far out of
 * line.
 */
function best(from: Placed, candidates: readonly Placed[], direction: Direction): string | null {
	const a = centre(from);
	const horizontal = direction === "left" || direction === "right";
	const sign = direction === "right" || direction === "down" ? 1 : -1;
	const scored = candidates.flatMap((shape) => {
		const b = centre(shape);
		const along = (horizontal ? b.x - a.x : b.y - a.y) * sign;
		if (along <= 1) return [];
		const offset = Math.abs(horizontal ? b.y - a.y : b.x - a.x);
		// Wholly past from's far edge that way.
		const past = horizontal
			? sign > 0
				? shape.x >= from.x + from.w - 1
				: shape.x + shape.w <= from.x + 1
			: sign > 0
				? shape.y >= from.y + from.h - 1
				: shape.y + shape.h <= from.y + 1;
		// How far out of line: nothing if the two overlap across the way you're going.
		const [lo, hi, otherLo, otherHi] = horizontal
			? [from.y, from.y + from.h, shape.y, shape.y + shape.h]
			: [from.x, from.x + from.w, shape.x, shape.x + shape.w];
		const across = otherHi < lo ? lo - otherHi : otherLo > hi ? otherLo - hi : 0;
		return [{ id: shape.id, ahead: offset <= along, past, value: along + across * 3 }];
	});
	const pick = (pool: typeof scored) =>
		pool.reduce<(typeof scored)[number] | null>(
			(winner, each) =>
				!winner || each.value < winner.value || (each.value === winner.value && each.id < winner.id)
					? each
					: winner,
			null,
		)?.id ?? null;
	return pick(scored.filter((each) => each.ahead)) ?? pick(scored.filter((each) => each.past));
}

// Words ---------------------------------------------------------------------------------

/** What a shape is, as a screen reader says it ("sticky note, Ship the docs"). */
export const ROLE_NAMES: Record<ShapeType, [one: string, many: string]> = {
	sticky: ["sticky note", "sticky notes"],
	card: ["card", "cards"],
	text: ["text", "texts"],
	section: ["section", "sections"],
	connector: ["connector", "connectors"],
	decision: ["decision", "decisions"],
	widget: ["widget", "widgets"],
	action: ["action item", "action items"],
	stack: ["stack", "stacks"],
};

export function roleName(type: ShapeType): string {
	return ROLE_NAMES[type]?.[0] ?? "shape";
}

/** "3 sticky notes, 2 cards and 1 section", in the order types first appear. */
export function countWords(types: readonly ShapeType[]): string {
	const counts = new Map<ShapeType, number>();
	for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
	const parts = [...counts].map(([type, n]) => {
		const [one, many] = ROLE_NAMES[type] ?? ["shape", "shapes"];
		return `${n} ${n === 1 ? one : many}`;
	});
	return listWords(parts) || "nothing";
}

/** "Moved 2 sticky notes 10 right and 1 up": a nudge, in words. */
export function describeNudge(types: readonly ShapeType[], dx: number, dy: number): string {
	const ways = [
		dx !== 0 ? `${Math.abs(dx)} ${dx > 0 ? "right" : "left"}` : "",
		dy !== 0 ? `${Math.abs(dy)} ${dy > 0 ? "down" : "up"}` : "",
	].filter(Boolean);
	return ways.length > 0
		? `Moved ${countWords(types)} ${listWords(ways)}`
		: `${capitalise(countWords(types))} back where ${types.length === 1 ? "it was" : "they were"}`;
}

/** "a, b and c". */
export function listWords(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What a card's item is, as far as the board knows. */
export interface CardWords {
	/** `#412` or `!12`. */
	item?: string;
	/** The repository's name, without its owner. */
	repo?: string;
	title?: string;
	state?: CardState;
	kind?: "issue" | "pull";
	missing?: boolean;
}

export interface DescribeContext {
	/** A card's live data, by key. */
	card?: (key: string) => CardWords | undefined;
	/** A section's title, by id: to say where a shape is. */
	sectionTitle?: (id: string) => string | undefined;
	/** What's directly inside a section, by id. */
	contents?: (id: string) => readonly ShapeType[];
	/** A widget kind's name ("List", "Timeline"). */
	widgetName?: (kind: string) => string | undefined;
	/** Whether a face-down (silent) sticky's text is yours to see, and what it is. */
	hiddenText?: (id: string) => string | undefined;
}

/** How long a label may run before it's cut short. */
const MAX_TEXT = 160;

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1).trimEnd()}…` : flat;
}

const STATE_WORDS: Record<CardState, string> = {
	open: "open",
	closed: "closed",
	merged: "merged",
	draft: "draft",
};

/** The item a card shows, from its key alone: `unpic #412`. */
export function itemFromKey(key: string): { repo: string; item: string } | null {
	const match = /^[^/]+\/(?:[^/#!]+\/)*([^/#!]+)([#!]\d+)$/.exec(key);
	return match ? { repo: match[1] ?? "", item: match[2] ?? "" } : null;
}

/**
 * A shape in words, for its accessible name: what it says first, then what
 * else matters (who wrote it, its state, where it is). The role ("sticky
 * note") is said separately, as its role description.
 */
export function describeShape(
	id: string,
	shape: Pick<
		ShapeProps,
		| "type"
		| "text"
		| "title"
		| "ref"
		| "author"
		| "parent"
		| "status"
		| "silent"
		| "widget"
		| "config"
		| "done"
		| "due"
		| "owner"
		| "suggested"
	>,
	context: DescribeContext = {},
): string {
	const parts: string[] = [];
	switch (shape.type) {
		case "sticky": {
			const faceDown = typeof shape.silent === "string" && !shape.text;
			const hidden = faceDown ? context.hiddenText?.(id) : undefined;
			if (faceDown && hidden === undefined) parts.push("face down");
			else parts.push(clip(hidden ?? shape.text ?? "") || "empty");
			if (faceDown && hidden !== undefined) parts.push("hidden until it’s revealed");
			if (shape.author?.name) parts.push(`by ${shape.author.name}`);
			break;
		}
		case "text":
			parts.push(clip(shape.text ?? "") || "empty");
			break;
		case "card": {
			const key = shape.ref ?? "";
			const card = context.card?.(key);
			const fallback = itemFromKey(key);
			const item = card?.item ?? fallback?.item ?? "";
			const repo = card?.repo ?? fallback?.repo ?? "";
			const name = [repo, item].filter(Boolean).join(" ");
			if (card?.missing) parts.push(`${name || key}, couldn’t be loaded`);
			else if (card?.title) parts.push(`${name}: ${clip(card.title)}`);
			else parts.push(name || key || "loading");
			if (card?.state) {
				const kind = card.kind === "pull" ? "pull request" : "issue";
				parts.push(`${STATE_WORDS[card.state]} ${kind}`);
			}
			break;
		}
		case "section": {
			parts.push(clip(shape.title ?? "") || "untitled");
			const inside = context.contents?.(id);
			if (inside) parts.push(inside.length > 0 ? countWords(inside) : "empty");
			break;
		}
		case "decision":
			parts.push(clip(shape.title ?? "") || "untitled");
			parts.push(shape.status ?? "proposed");
			break;
		case "stack": {
			// A stack (#73): its name, whether that's only a suggestion, and how many stickies.
			const name = clip(stackName(shape) ?? "");
			parts.push(name || "untitled");
			if (nameState(shape) === "suggested") parts.push("suggested name");
			const inside = context.contents?.(id);
			if (inside) parts.push(inside.length > 0 ? countWords(inside) : "empty");
			break;
		}
		case "widget": {
			const config = shape.config as { title?: unknown } | undefined;
			const title = typeof config?.title === "string" ? config.title.trim() : "";
			const kind = context.widgetName?.(String(shape.widget ?? "")) ?? "widget";
			parts.push(title ? `${title}, ${kind.toLowerCase()}` : kind);
			break;
		}
		case "action": {
			parts.push(clip(shape.text ?? "") || "empty");
			// Linked to an issue, it's done when the issue is closed (actionItems.ts).
			const linked = shape.ref ? context.card?.(shape.ref) : undefined;
			const closed = linked?.state === "closed" || linked?.state === "merged";
			if (shape.ref ? closed : shape.done) parts.push("done");
			if (shape.owner?.login) parts.push(`for @${shape.owner.login}`);
			if (shape.due) parts.push(`due ${shape.due}`);
			break;
		}
		default:
			parts.push(roleName(shape.type));
	}
	const parent =
		typeof shape.parent === "string" ? context.sectionTitle?.(shape.parent) : undefined;
	if (parent !== undefined) parts.push(`in ${clip(parent) || "an untitled section"}`);
	return parts.join(", ");
}

/** The shapes a board summary needs. */
export interface SummaryShape {
	id: string;
	type: ShapeType;
	parent: string | null;
	title?: string;
	x: number;
	y: number;
}

/** How many sections a summary names before it says "and N more". */
const SUMMARY_SECTIONS = 12;

/**
 * A board in a few sentences, for its accessible description: what's on it,
 * then each section (in reading order) and what's in it, then what's in no
 * section. "3 sections, 12 sticky notes and 4 cards. Went well: 5 sticky
 * notes. …"
 */
export function describeBoard(shapes: readonly SummaryShape[]): string {
	if (shapes.length === 0) return "The board is empty.";
	const known = new Set(shapes.map((shape) => shape.id));
	const parentOf = (shape: SummaryShape) =>
		shape.parent && known.has(shape.parent) ? shape.parent : null;
	const sentences = [`${capitalise(countWords(shapes.map((shape) => shape.type)))}.`];
	const sections = readingOrder(shapes.filter((shape) => shape.type === "section"));
	const byId = new Map(shapes.map((shape) => [shape.id, shape]));
	for (const id of sections.slice(0, SUMMARY_SECTIONS)) {
		const inside = shapes.filter((shape) => parentOf(shape) === id).map((shape) => shape.type);
		const title = clip(byId.get(id)?.title ?? "") || "Untitled section";
		sentences.push(`${title}: ${inside.length > 0 ? countWords(inside) : "empty"}.`);
	}
	if (sections.length > SUMMARY_SECTIONS) {
		const more = sections.length - SUMMARY_SECTIONS;
		sentences.push(`And ${more} more ${more === 1 ? "section" : "sections"}.`);
	}
	const loose = shapes
		.filter((shape) => parentOf(shape) === null && shape.type !== "section")
		.map((shape) => shape.type);
	if (loose.length > 0 && sections.length > 0) {
		sentences.push(`Outside any section: ${countWords(loose)}.`);
	}
	return sentences.join(" ");
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
