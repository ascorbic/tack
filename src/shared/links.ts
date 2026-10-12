import type * as Y from "yjs";
import { PLACE_GAP, spotNear } from "./placement.ts";
import type { SizeOf } from "./sections.ts";
import { addShape, nextZ, shapesMap } from "./shapes.ts";
import { placeInSections, readShapes } from "./structure.ts";
import { type CardRun, RUN_COLUMNS } from "./addCards.ts";

import { LINK_CARD, type LinkPreview } from "./linkPreview.ts";

export * from "./linkPreview.ts";

// Link cards: a web page on the board, shown as its Open Graph preview.
//
// A link card is its own shape type (`link`), not a card. Cards are items on
// a forge, keyed by `ref`, whose data lives outside the document (the card
// store, fed by each repository's `Repo` object, filtered per viewer). A link
// is just an address: what it looks like is the same for everyone who can
// see the board, so its preview lives in the document itself, on the shape
// (`preview`), and the board draws it at once, offline, for everyone.
//
// Pasting or dropping a bare address that isn't an item a forge adapter
// recognises (`parseRef` first, always) makes one. An editor's client asks
// the Worker to read the page (`POST /api/boards/:id/unfurl`, see
// src/server/links/), and writes what came back with `UNFURL_ORIGIN`, which
// isn't undoable: the undo step is placing the card, and the preview is
// something that happened to it. Previews older than a day are read again,
// quietly, by the next editor to look. Images are never loaded from the page's
// own host: the board loads them through the instance
// (`GET /api/boards/:id/links/image?src=…`), so viewers' addresses never reach
// a third party and the app's policy needn't trust one.

/** The link card already showing each address on the board (the first, if there are copies). */
export function linksOnBoard(doc: Y.Doc): Map<string, string> {
	const out = new Map<string, string>();
	for (const [id, shape] of shapesMap(doc)) {
		if (shape.get("type") !== "link") continue;
		const url = shape.get("url");
		if (typeof url === "string" && !out.has(url)) out.set(url, id);
	}
	return out;
}

/** Add a link card. Call inside a transaction (`transactLocal`), so it's one undo step. */
export function addLinkShape(
	doc: Y.Doc,
	id: string,
	link: { url: string; x: number; y: number; preview?: LinkPreview; parent?: string | null },
): void {
	addShape(doc, id, {
		type: "link",
		url: link.url,
		x: Math.round(link.x),
		y: Math.round(link.y),
		z: nextZ(doc),
		...(link.preview ? { preview: link.preview } : {}),
		...(link.parent !== undefined ? { parent: link.parent } : {}),
	});
}

export interface AddedLinks {
	run: CardRun;
	added: { url: string; id: string }[];
	/** Addresses already on the board, and the link card showing each. */
	existing: { url: string; id: string }[];
}

/**
 * Add link cards for `urls` (from `linkUrl`), continuing `run` as cards do
 * (shared/addCards.ts): rows of four, each sliding to free space, and never a
 * second card for an address already on the board unless `copies` says so.
 * Call inside a transaction (`transactLocal`), so it's one undo step.
 */
export function addLinksInRun(
	doc: Y.Doc,
	urls: readonly string[],
	run: CardRun,
	{ sizeOf, copies = false }: { sizeOf?: SizeOf; copies?: boolean } = {},
): AddedLinks {
	const onBoard = linksOnBoard(doc);
	const added: AddedLinks["added"] = [];
	const existing: AddedLinks["existing"] = [];
	const seen = new Set<string>();
	let count = run.count;
	for (const url of urls) {
		if (seen.has(url)) continue;
		seen.add(url);
		const there = onBoard.get(url);
		if (there && !copies) {
			existing.push({ url, id: there });
			continue;
		}
		const slot = count++;
		const ideal = {
			x: Math.round(run.origin.x + (slot % RUN_COLUMNS) * (LINK_CARD.w + PLACE_GAP)),
			y: Math.round(run.origin.y + Math.floor(slot / RUN_COLUMNS) * (LINK_CARD.h + PLACE_GAP)),
		};
		const at = spotNear(readShapes(doc), ideal, LINK_CARD, sizeOf) ?? ideal;
		const id = crypto.randomUUID();
		addLinkShape(doc, id, { url, x: at.x, y: at.y });
		placeInSections(doc, [id], sizeOf);
		onBoard.set(url, id);
		added.push({ url, id });
	}
	return { run: { origin: run.origin, count }, added, existing };
}
