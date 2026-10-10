import * as Y from "yjs";
import type { Card } from "./cards.ts";
import type { Point } from "./geometry.ts";
import { addCardShape, updateMatches } from "./provenance.ts";
import { type ShapeProps, LOCAL_ORIGIN, shapesMap } from "./shapes.ts";
import { placeInSections } from "./structure.ts";
import type { SearchQuery, SearchResult, WidgetMessage } from "./widgets.ts";

// Inbox frames (#40): a section with a query (`inbox` on the section). The
// server runs the query for each person looking (with their permissions)
// and sends the results as `widget-data` keyed by the section's id, under
// the query name `inbox`. New matches (not on the board yet, and not
// dismissed) wait in a tray on the section's edge, marked new; people sort
// them onto the board, where they're ordinary cards with provenance
// `{ via: "inbox", source: sectionId }`, or dismiss them. Automation never
// moves what people placed: a card that stops matching is marked as no
// longer matching (`unmatched`, see provenance.ts), never moved or removed.
// Whether a card still matches is decided from what everyone can agree on:
// webhook data, checked against the query locally (`refreshMatches` in
// rules.ts), and any viewer's results that include it (`confirmMatches`).
// One viewer's results leaving a card out prove nothing: they may not be
// able to read it.
//
// Dismissals live on the section as a nested Y.Map (`dismissed`, item key →
// `Dismissal`), so two people dismissing at once both stick.

/** The origin of the server's writes for inboxes (match marks): never undoable. */
export const INBOX_ORIGIN = "inbox";

/** The query name an inbox's results arrive under in `widget-data`. */
export const INBOX_QUERY = "inbox";

/** Most matches an inbox asks for. */
export const INBOX_LIMIT = 50;

/** Someone dismissed an item from an inbox's tray. */
export interface Dismissal {
	by: string;
	/** ISO 8601. */
	at: string;
}

/**
 * Client to server: run an inbox's query as it's being written, for its live
 * count. Answered with `widget-data` for `previewId(id)`.
 */
export interface InboxPreviewRequest {
	type: "inbox-preview";
	/** The section's id. */
	id: string;
	query: SearchQuery;
}

/** The id a preview's results arrive under. */
export function previewId(sectionId: string): string {
	return `${sectionId}:preview`;
}

/** A query with an inbox's defaults filled in. */
export function inboxQuery(q: string, host = "github.com"): SearchQuery {
	return { kind: "search", host, q: q.trim(), sort: "created", order: "desc", limit: INBOX_LIMIT };
}

/** Make a section an inbox, change its query, or (null) make it a plain section again. */
export function setInbox(
	doc: Y.Doc,
	id: string,
	query: SearchQuery | null,
	origin: unknown = LOCAL_ORIGIN,
): void {
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("type") !== "section") return;
	doc.transact(() => {
		if (query) {
			shape.set("inbox", { query });
			// Dismissals only merge as a Y.Map that's already there: two made at
			// once would replace each other.
			if (!(shape.get("dismissed") instanceof Y.Map)) shape.set("dismissed", new Y.Map());
		} else if (shape.has("inbox")) shape.delete("inbox");
	}, origin);
}

function dismissedMap(shape: Y.Map<unknown>): Y.Map<Dismissal> {
	const existing = shape.get("dismissed");
	if (existing instanceof Y.Map) return existing as Y.Map<Dismissal>;
	const fresh = new Y.Map<Dismissal>();
	shape.set("dismissed", fresh);
	return fresh;
}

/** Dismiss items from an inbox's tray: they don't come back while they match. */
export function dismissFromInbox(
	doc: Y.Doc,
	id: string,
	keys: string[],
	by: string,
	origin: unknown = LOCAL_ORIGIN,
): void {
	const shape = shapesMap(doc).get(id);
	if (!shape || keys.length === 0) return;
	doc.transact(() => {
		const dismissed = dismissedMap(shape);
		const at = new Date().toISOString();
		for (const key of keys) if (!dismissed.has(key)) dismissed.set(key, { by, at });
	}, origin);
}

/** Bring dismissed items back to the tray. */
export function restoreToInbox(
	doc: Y.Doc,
	id: string,
	keys: string[],
	origin: unknown = LOCAL_ORIGIN,
): void {
	const shape = shapesMap(doc).get(id);
	const dismissed = shape?.get("dismissed");
	if (!(dismissed instanceof Y.Map)) return;
	doc.transact(() => {
		for (const key of keys) if (dismissed.has(key)) dismissed.delete(key);
	}, origin);
}

/** The keys dismissed from an inbox, from a shape as read with `readShape`. */
export function dismissedKeys(shape: Pick<ShapeProps, "dismissed">): Set<string> {
	const value = shape.dismissed as unknown;
	const plain =
		value instanceof Y.Map
			? (value.toJSON() as Record<string, unknown>)
			: ((value ?? {}) as Record<string, unknown>);
	return new Set(Object.keys(plain));
}

/** Matches waiting in an inbox's tray: not on the board, and not dismissed, newest first as the forge sorted them. */
export function inboxTray(
	result: Pick<SearchResult, "items">,
	onBoard: ReadonlySet<string>,
	dismissed: ReadonlySet<string>,
): Card[] {
	return result.items.filter((card) => !onBoard.has(card.key) && !dismissed.has(card.key));
}

/**
 * Cards an inbox brought that appear in a search's results do match: clear
 * any "no longer matches" mark on them. Results never mark a card (see
 * above). Returns the shapes unmarked.
 */
export function confirmMatches(
	doc: Y.Doc,
	sectionId: string,
	result: Pick<SearchResult, "items">,
	origin: unknown = INBOX_ORIGIN,
): string[] {
	const keys = new Set(result.items.map((card) => card.key));
	return updateMatches(doc, sectionId, (key) => (keys.has(key) ? true : undefined), { origin })
		.cleared;
}

/**
 * Sort a match out of an inbox's tray onto the board at `at` (its top-left
 * corner), as a card with the inbox's provenance. Returns the new shape's id.
 */
export function sortFromInbox(
	doc: Y.Doc,
	sectionId: string,
	key: string,
	at: Point,
	origin: unknown = LOCAL_ORIGIN,
): string {
	const id = crypto.randomUUID();
	doc.transact(() => {
		addCardShape(doc, id, { ref: key, x: at.x, y: at.y }, { via: "inbox", source: sectionId });
		placeInSections(doc, [id]);
	}, origin);
	return id;
}

/** Inbox sections on a board, by id, with their queries. */
export function inboxSections(doc: Y.Doc): Map<string, SearchQuery> {
	const out = new Map<string, SearchQuery>();
	for (const [id, shape] of shapesMap(doc)) {
		if (shape.get("type") !== "section") continue;
		const inbox = shape.get("inbox") as { query?: SearchQuery } | undefined;
		if (inbox?.query?.kind === "search" && typeof inbox.query.q === "string") {
			out.set(id, inbox.query);
		}
	}
	return out;
}

/** The search result for an inbox in a `widget-data` message, if it has one. */
export function inboxResult(message: WidgetMessage): SearchResult | null {
	const result = message.results[INBOX_QUERY];
	return result?.kind === "search" ? result : null;
}
