import * as Y from "yjs";
import { forgeName } from "./refs.ts";
import { type ShapeProps, addShape, nextZ, shapesMap } from "./shapes.ts";
import type { Provenance } from "./widgets.ts";

// Provenance (#41): how each card arrived on the board, and what happens
// when it stops matching whatever brought it.
//
// | via    | how it arrived                               | stops matching          |
// | ------ | -------------------------------------------- | ----------------------- |
// | manual | someone placed it: a pasted or typed link,   | nothing: it's theirs    |
// |        | Expand related, a copy of another card       |                         |
// | list   | dragged out of a list widget                 | nothing: it's a copy    |
// | inbox  | landed in (and sorted out of) an inbox frame | marked "no longer       |
// | rule   | placed by a rule                             | matches", never removed |
// | comment| someone mentioned the app on GitHub (#58)    | nothing: it's theirs    |
//
// Manual is the default and is never written: a card without `provenance`
// was placed by hand (as every card from before M3 was). Read it with
// `provenanceOf`, which also tolerates junk from other clients.
//
// "No longer matches" is the card's `unmatched` key: when it stopped
// matching, ISO 8601. Whatever runs an inbox's or rule's query (on the
// server, with nobody's undo history) calls `updateMatches` with what
// matches now, which marks and unmarks the cards that source brought. People
// then decide: remove the card (an ordinary delete) or keep it
// (`keepCard`), which makes it their own, so it's never marked again.
// Automation never removes a card, and never moves one.
//
// Copies of a card (paste, duplicate) are placed by whoever made them, so
// `provenance` and `unmatched` stay with the original (see CARD_UNCOPIED).

export type { Provenance };

const MANUAL: Provenance = { via: "manual" };
/** A forge login, as the cards a comment brought name who asked. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** How a card arrived. Anything missing or malformed reads as manual. */
export function provenanceOf(shape: Pick<ShapeProps, "provenance"> | undefined): Provenance {
	const value = shape?.provenance as unknown;
	if (typeof value !== "object" || value === null) return MANUAL;
	const { via, source, by } = value as { via?: unknown; source?: unknown; by?: unknown };
	if (typeof source !== "string" || !source) return MANUAL;
	if (via === "list" || via === "inbox" || via === "rule") return { via, source };
	if (via === "comment") {
		// Only links to the forge's own pages: the card's foot links to it.
		if (!source.startsWith("https://")) return MANUAL;
		return typeof by === "string" && LOGIN.test(by) ? { via, source, by } : { via, source };
	}
	return MANUAL;
}

/** Properties a copy of a card doesn't take: whoever pastes it placed it. */
export const CARD_UNCOPIED: readonly string[] = ["provenance", "unmatched"];

export interface NewCard {
	ref: string;
	x: number;
	y: number;
	/** Stacking order; on top of everything by default. */
	z?: string;
	/** Its section, if known. Usually left to `placeInSections`. */
	parent?: string | null;
}

/**
 * Add a card shape, recording how it arrived. Every way a card is made goes
 * through here (or the client's `addCard`, which does), so provenance is
 * never forgotten. Manual cards don't store it. Call inside a transaction
 * (`transactLocal` on the client), then `placeInSections`.
 */
export function addCardShape(
	doc: Y.Doc,
	id: string,
	card: NewCard,
	provenance: Provenance = MANUAL,
): void {
	addShape(doc, id, {
		type: "card",
		ref: card.ref,
		x: Math.round(card.x),
		y: Math.round(card.y),
		z: card.z ?? nextZ(doc),
		...(card.parent !== undefined ? { parent: card.parent } : {}),
		...(provenance.via === "manual" ? {} : { provenance }),
	});
}

/**
 * What happens to a card when it stops matching what brought it: one a
 * person placed (or dragged out of a list, which only ever copies) stays as
 * it is; one an inbox or a rule added is marked, for people to decide.
 */
export function whenUnmatched(provenance: Provenance): "keep" | "mark" {
	return provenance.via === "inbox" || provenance.via === "rule" ? "mark" : "keep";
}

/** When a card stopped matching, if it's marked as no longer matching. */
export function unmatchedSince(shape: Pick<ShapeProps, "unmatched"> | undefined): string | null {
	return typeof shape?.unmatched === "string" && shape.unmatched ? shape.unmatched : null;
}

export interface MatchUpdate {
	/** Cards newly marked as no longer matching. */
	marked: string[];
	/** Cards that match again, unmarked. */
	cleared: string[];
}

/**
 * Bring the "no longer matches" marks up to date for every card `source`
 * (an inbox section's id, or a rule's) brought to the board. `matches`
 * says whether an item still matches: true, false, or undefined when it
 * isn't known (it wasn't in the results fetched, say, because they were
 * cut short), which leaves the card as it is. Never removes or moves a card.
 *
 * Run it with the origin of whatever is doing it (the server's own, which
 * nobody can undo), in one transaction.
 */
export function updateMatches(
	doc: Y.Doc,
	source: string,
	matches: (key: string) => boolean | undefined,
	{ origin = null, at = new Date().toISOString() }: { origin?: unknown; at?: string } = {},
): MatchUpdate {
	const update: MatchUpdate = { marked: [], cleared: [] };
	doc.transact(() => {
		for (const [id, shape] of shapesMap(doc)) {
			if (shape.get("type") !== "card") continue;
			const ref = shape.get("ref");
			const provenance = provenanceOf({ provenance: shape.get("provenance") as Provenance });
			if (typeof ref !== "string" || provenance.via === "manual") continue;
			if (provenance.source !== source || whenUnmatched(provenance) !== "mark") continue;
			const matching = matches(ref);
			const marked = shape.has("unmatched");
			if (matching === false && !marked) {
				shape.set("unmatched", at);
				update.marked.push(id);
			} else if (matching === true && marked) {
				shape.delete("unmatched");
				update.cleared.push(id);
			}
		}
	}, origin);
	return update;
}

/**
 * Keep a card that no longer matches: it becomes the person's own, as if
 * they'd placed it, so it's never marked again. Call inside `transactLocal`.
 */
export function keepCard(doc: Y.Doc, id: string): void {
	const shape = shapesMap(doc).get(id);
	if (!shape) return;
	doc.transact(() => {
		if (shape.has("provenance")) shape.delete("provenance");
		if (shape.has("unmatched")) shape.delete("unmatched");
	});
}

/**
 * The name of what brought a card: a list widget's title, an inbox
 * section's title, a rule's name, or the login of whoever asked for it in a
 * comment. Null when it has none or is gone.
 *
 * Rules are looked for in the document's `rules` map, by id, as a Y.Map or
 * plain object with a `name` (or `title`).
 */
export function provenanceSourceName(doc: Y.Doc, provenance: Provenance): string | null {
	if (provenance.via === "manual") return null;
	// Who asked for it, from the forge: nothing in the document names them.
	if (provenance.via === "comment") return provenance.by ?? null;
	if (provenance.via === "rule") {
		return nameIn(doc.getMap<unknown>("rules").get(provenance.source), ["name", "title"]);
	}
	const shape = shapesMap(doc).get(provenance.source);
	if (!shape) return null;
	if (provenance.via === "inbox") return nameIn(shape, ["title"]);
	return nameIn(shape.get("config"), ["title", "name"]) ?? nameIn(shape, ["title"]);
}

function nameIn(value: unknown, keys: string[]): string | null {
	for (const key of keys) {
		const name =
			value instanceof Y.Map
				? value.get(key)
				: typeof value === "object" && value !== null
					? (value as Record<string, unknown>)[key]
					: undefined;
		if (typeof name === "string" && name.trim()) return name.trim();
	}
	return null;
}

export interface ProvenanceText {
	/** One line for the card: "From the “Triage” inbox". */
	label: string;
	/** When it no longer matches: "No longer matches the “Triage” inbox". */
	unmatched: string;
}

/**
 * How to say where a card came from, given the name of what brought it (see
 * `provenanceSourceName`). Null for cards people placed: those say nothing.
 */
export function describeProvenance(
	provenance: Provenance,
	name: string | null,
): ProvenanceText | null {
	const quoted = name ? `“${name}”` : null;
	switch (provenance.via) {
		case "manual":
			return null;
		case "list":
			return {
				label: quoted ? `From the ${quoted} list` : "From a list",
				unmatched: quoted ? `No longer in the ${quoted} list` : "No longer in its list",
			};
		case "inbox":
			return {
				label: quoted ? `From the ${quoted} inbox` : "From an inbox",
				unmatched: quoted ? `No longer matches the ${quoted} inbox` : "No longer matches its inbox",
			};
		case "rule":
			return {
				label: name ? `Placed by rule: ${name}` : "Placed by a rule",
				unmatched: quoted ? `No longer matches the rule ${quoted}` : "No longer matches its rule",
			};
		case "comment": {
			const forge = forgeName(hostOf(provenance.source));
			return {
				label: name ? `Added from ${forge} by @${name}` : `Added from a comment on ${forge}`,
				// Never marked: it's as if they'd placed it.
				unmatched: "",
			};
		}
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}
