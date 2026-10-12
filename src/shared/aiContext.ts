import type * as Y from "yjs";
import { type Card, kindNoun } from "./cards.ts";
import { boardOrder, type Placed } from "./a11y.ts";
import { searchScopeOf } from "./addCards.ts";
import { AI_ITEMS_MAX, type AiItem, type AiLeftOut, type WidgetContext } from "./ai.ts";
import { linkText } from "./linkPreview.ts";
import { readShapes } from "./structure.ts";
import { boxOf, descendantsOf, readStructure } from "./sections.ts";
import type { ShapeProps } from "./shapes.ts";

// What the AI reads of a selection (#64), from the board's document and the
// cards the person asking may read. Pure, so the server and the playground
// read a selection the same way, and it's unit-tested.

/** A card as the person asking may see it: its data, hidden from them, or not known. */
export type CardFor = (key: string) => { card: Card } | "hidden" | null;

/**
 * The items in `ids` (sections bring everything in them), in reading order:
 * text from stickies, text blocks, decisions and action items, and cards'
 * titles and state. Face-down stickies have no text on the board (silent
 * mode keeps it on the server until the reveal), and cards `cardFor` hides
 * are left out entirely: both are counted, never read.
 */
export function collectItems(
	shapes: ReadonlyMap<string, ShapeProps>,
	ids: readonly string[],
	cardFor: CardFor,
): { items: AiItem[]; leftOut: AiLeftOut } {
	const structure = readStructure(shapes);
	const wanted = selection(shapes, ids, structure);
	const placed: Placed[] = [];
	for (const id of wanted) {
		const shape = shapes.get(id);
		if (!shape || shape.type === "connector" || shape.type === "widget") continue;
		const box = boxOf(id, shape);
		placed.push({
			id,
			type: shape.type,
			parent: structure.parentOf.get(id) ?? null,
			...box,
		});
	}
	const leftOut: AiLeftOut = { faceDown: 0, private: 0 };
	const items: AiItem[] = [];
	for (const id of boardOrder(placed)) {
		if (items.length >= AI_ITEMS_MAX) break;
		const shape = shapes.get(id);
		if (!shape) continue;
		const parent = structure.parentOf.get(id);
		const section = parent ? shapes.get(parent)?.title?.trim() || undefined : undefined;
		const item = itemOf(shape, cardFor, leftOut);
		if (item) items.push({ ...item, ...(section ? { section } : {}) });
	}
	return { items, leftOut };
}

/** The shapes in `ids`, and everything inside the sections among them. */
export function selection(
	shapes: ReadonlyMap<string, ShapeProps>,
	ids: readonly string[],
	structure = readStructure(shapes),
): Set<string> {
	const wanted = new Set<string>();
	for (const id of ids) {
		if (!shapes.has(id)) continue;
		wanted.add(id);
		if (shapes.get(id)?.type === "section") {
			for (const inside of descendantsOf(structure, id)) wanted.add(inside);
		}
	}
	return wanted;
}

/** The items of the cards in a selection, to look up as the asker may see them. */
export function selectedCardKeys(
	shapes: ReadonlyMap<string, ShapeProps>,
	ids: readonly string[],
): string[] {
	const keys = new Set<string>();
	for (const id of selection(shapes, ids)) {
		const shape = shapes.get(id);
		if (shape?.type === "card" && shape.ref) keys.add(shape.ref);
	}
	return [...keys];
}

function itemOf(shape: ShapeProps, cardFor: CardFor, leftOut: AiLeftOut): AiItem | null {
	switch (shape.type) {
		case "sticky": {
			// Face down: whatever's written is its author's until the reveal.
			if (shape.silent) {
				leftOut.faceDown++;
				return null;
			}
			const text = shape.text?.trim();
			return text
				? { kind: "sticky", text, ...(shape.author?.name ? { by: shape.author.name } : {}) }
				: null;
		}
		case "text": {
			const text = shape.text?.trim();
			return text ? { kind: "text", text } : null;
		}
		case "section": {
			const text = shape.title?.trim();
			return text ? { kind: "section", text: `Section: ${text}` } : null;
		}
		case "decision": {
			const text = [shape.title, shape.status ? `(${shape.status})` : "", shape.text]
				.map((part) => part?.trim())
				.filter(Boolean)
				.join(" ");
			return text ? { kind: "decision", text } : null;
		}
		case "action": {
			const text = shape.text?.trim();
			return text ? { kind: "action", text: `Action item: ${text}` } : null;
		}
		case "link": {
			// What the page says about itself is on the board for everyone, as a sticky's words are.
			if (typeof shape.url !== "string") return null;
			const { title, description, host } = linkText(shape);
			return {
				kind: "text",
				text: `Link: ${title}${description ? ` — ${description}` : ""} (${host})`,
			};
		}
		case "card": {
			if (!shape.ref) return null;
			const found = cardFor(shape.ref);
			if (found === "hidden") {
				leftOut.private++;
				return null;
			}
			if (!found) return null;
			return { kind: "card", text: cardLine(found.card) };
		}
		default:
			return null;
	}
}

/** A card in a line: `owner/repo#12 (open issue; bug, docs) Its title`. */
export function cardLine(card: Card): string {
	const kind = kindNoun(card.kind);
	const labels = card.labels.map((label) => label.name).slice(0, 6);
	const details = [`${card.state} ${kind}`, ...(labels.length > 0 ? [labels.join(", ")] : [])];
	return `${card.repo}${card.item} (${details.join("; ")}) ${card.title}`;
}

/** What a widget request may know about the board: its forge, repositories and sections. */
export function widgetContext(doc: Y.Doc, login: string | null, now = Date.now()): WidgetContext {
	const { host, repos } = searchScopeOf(doc);
	const sections: WidgetContext["sections"] = [];
	for (const [id, shape] of readShapes(doc)) {
		if (shape.type === "section") sections.push({ id, title: shape.title?.trim() ?? "" });
	}
	return { today: new Date(now).toISOString().slice(0, 10), host, repos, sections, login };
}
