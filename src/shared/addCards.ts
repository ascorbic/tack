import type * as Y from "yjs";
import { boardRepos } from "./actions.ts";
import type { Point } from "./geometry.ts";
import { inboxSections } from "./inbox.ts";
import { PLACE_GAP, PLACED_CARD, spotNear } from "./placement.ts";
import { addCardShape } from "./provenance.ts";
import { DEFAULT_HOST, parseRepoKey } from "./refs.ts";
import { queryRepos } from "./search.ts";
import type { SizeOf } from "./sections.ts";
import { readShape, shapesMap } from "./shapes.ts";
import { placeInSections, readShapes } from "./structure.ts";
import { queryScope, widgetQueries } from "./widgetRegistry.ts";

// Cards a person adds by reference or search (the card tool, pasting links):
// laid out in rows of four from where the run started, each sliding to the
// nearest free space so it never lands on anything, and never a second card
// for an item already on the board unless they ask for a copy.

/** Cards in a row before the next row starts. */
export const RUN_COLUMNS = 4;

/** A run of cards someone is adding: where it started, and how many so far. */
export interface CardRun {
	/** The first card's top left. */
	origin: Point;
	count: number;
}

export interface AddedCards {
	/** The run, with these counted, to carry on from. */
	run: CardRun;
	added: { key: string; id: string }[];
	/** Items already on the board, and the card showing each. */
	existing: { key: string; id: string }[];
}

/**
 * Where the card tool searches: the board's repositories on its usual forge,
 * those with most cards first, then any its inboxes and widgets search (a
 * board just made from a template has those before it has cards).
 */
export function searchScopeOf(doc: Y.Doc): { host: string; repos: string[] } {
	const weight = new Map<string, number>();
	const count = (repoKey: string, by: number) =>
		weight.set(repoKey.toLowerCase(), (weight.get(repoKey.toLowerCase()) ?? 0) + by);
	for (const { repo, cards } of boardRepos(doc)) count(repo, cards);
	for (const query of inboxSections(doc).values()) {
		for (const repo of queryRepos(query)) count(repo, 0.5);
	}
	for (const shape of shapesMap(doc).values()) {
		if (shape.get("type") !== "widget") continue;
		for (const query of Object.values(widgetQueries(readShape(shape)))) {
			for (const repo of queryScope(query).repos) count(repo, 0.5);
		}
	}
	const ranked = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const host = parseRepoKey(ranked[0]?.[0] ?? "")?.host ?? DEFAULT_HOST;
	const repos = ranked.flatMap(([repoKey]) => {
		const parsed = parseRepoKey(repoKey);
		return parsed && parsed.host === host ? [parsed.repo] : [];
	});
	return { host, repos };
}

/** The card already showing each item on the board (the first, if there are copies). */
export function cardsOnBoard(doc: Y.Doc): Map<string, string> {
	const out = new Map<string, string>();
	for (const [id, shape] of shapesMap(doc)) {
		if (shape.get("type") !== "card") continue;
		const ref = shape.get("ref");
		if (typeof ref === "string" && !out.has(ref.toLowerCase())) out.set(ref.toLowerCase(), id);
	}
	return out;
}

/**
 * Add cards for `keys`, continuing `run`. Items already on the board are
 * left where they are and reported, unless `copies` says to add another.
 * Call inside a transaction (`transactLocal`), so it's one undo step.
 */
export function addCardsInRun(
	doc: Y.Doc,
	keys: readonly string[],
	run: CardRun,
	{ sizeOf, copies = false }: { sizeOf?: SizeOf; copies?: boolean } = {},
): AddedCards {
	const onBoard = cardsOnBoard(doc);
	const added: AddedCards["added"] = [];
	const existing: AddedCards["existing"] = [];
	let count = run.count;
	const seen = new Set<string>();
	for (const raw of keys) {
		const key = raw.toLowerCase();
		// The same item twice in one go is one card.
		if (seen.has(key)) continue;
		seen.add(key);
		const there = onBoard.get(key);
		if (there && !copies) {
			existing.push({ key, id: there });
			continue;
		}
		const slot = count++;
		const ideal = {
			x: Math.round(run.origin.x + (slot % RUN_COLUMNS) * (PLACED_CARD.w + PLACE_GAP)),
			y: Math.round(run.origin.y + Math.floor(slot / RUN_COLUMNS) * (PLACED_CARD.h + PLACE_GAP)),
		};
		const at = spotNear(readShapes(doc), ideal, PLACED_CARD, sizeOf) ?? ideal;
		const id = crypto.randomUUID();
		addCardShape(doc, id, { ref: key, x: Math.round(at.x), y: Math.round(at.y) });
		placeInSections(doc, [id], sizeOf);
		onBoard.set(key, id);
		added.push({ key, id });
	}
	return { run: { origin: run.origin, count }, added, existing };
}
