import { generateKeyBetween } from "fractional-indexing";
import * as Y from "yjs";
import type { ListSort, SectionDisplay } from "./display.ts";
import type { Anchor } from "./geometry.ts";
import type { Dismissal } from "./inbox.ts";
import type { LinkPreview } from "./linkPreview.ts";
import type { ImageUpload } from "./images.ts";
import type { SilentSession } from "./silent.ts";
import type { InboxConfig, Provenance } from "./widgets.ts";

// The board document: `shapes` is a map of shape id → Y.Map of properties.
// Each property is its own key so concurrent edits to different properties
// of the same shape merge cleanly.
//
// The schema is renderer-independent: nothing here is React Flow's. In
// particular, positions are always absolute board coordinates (never
// relative to a section), containment is our own `parent` key rather than
// React Flow's `parentId`, and connectors are shapes rather than edges.
//
// | key          | shapes             | meaning                                       |
// | ------------ | ------------------ | --------------------------------------------- |
// | type         | all                | `card`, `sticky`, `text`, `section`,          |
// |              |                    | `connector`, `decision`, `widget`, `action`,  |
// |              |                    | `stack`, `link` or `image`                    |
// | x, y         | all but connectors | top-left corner, absolute; 0 on connectors    |
// | z            | all                | fractional index for stacking order           |
// | parent       | all but connectors | id of the containing section, or null         |
// | ref          | card, decision,    | the card key, `{host}/{repo}#{n}`; on a       |
// |              | action             | decision, the PR its record was written to;   |
// |              |                    | on an action item, the issue it's linked to,  |
// |              |                    | whose state is its status                     |
// | text         | sticky, text,      | plain text; on a decision, its body: the      |
// |              | decision, action   | decision and its context; on an action item,  |
// |              |                    | what's to be done                             |
// | font         | sticky, text       | `sans` (default) or `hand`                    |
// | size         | text               | `s`, `m` (default), `l` or `xl`               |
// | color        | sticky, section,   | a palette name                                |
// |              | connector          |                                               |
// | author       | sticky, decision,  | who made it (who proposed a decision)         |
// |              | action             |                                               |
// | w, h         | section, widget,   | size (cards and stickies size to content)     |
// |              | image              |                                               |
// | title        | section, decision, | the section's name; the decision's title; a   |
// |              | stack               | stack's name as a person wrote it (stacks.ts)   |
// | from, to     | connector          | each end, see `ConnectorEnd`                  |
// | label        | connector          | text at the middle of the line                |
// | route        | connector          | `curved` (default), `straight` or `elbow`     |
// | arrow        | connector          | `end` (default), `both` or `none`             |
// | dash         | connector          | dashed line when true                         |
// | status       | decision           | `proposed` (default), `decided` or            |
// |              |                    | `superseded`                                  |
// | supersededBy | decision           | id of the decision that superseded it         |
// | decidedAt    | decision           | when it was decided, ISO 8601                 |
// | decidedBy    | decision           | who marked it decided                         |
// | votes        | decision           | nested Y.Map of voter key → `Vote`, so votes  |
// |              |                    | from different people merge (decisions.ts)    |
// | writeback    | decision           | id of its write-back in `changes`             |
// | outcome      | decision           | what was decided, in words for its record,    |
// |              |                    | when that's more than its title               |
// | consequences | decision           | what becomes easier or harder because of it   |
// | inbox        | section            | an inbox frame's query (`InboxConfig`)        |
// | dismissed    | section            | nested Y.Map of item key → `Dismissal`: items |
// |              |                    | dismissed from an inbox's tray (inbox.ts)     |
// | provenance   | card               | how it arrived (`Provenance`); absent means   |
// |              |                    | placed by hand. See provenance.ts             |
// | unmatched    | card               | when it stopped matching the inbox or rule    |
// |              |                    | that brought it, ISO 8601; absent if it still |
// |              |                    | matches (or nothing brought it)               |
// | widget       | widget             | its kind, e.g. `list` (see widgetRegistry.ts) |
// | config       | widget             | the kind's config, read with its schema       |
// | silent       | section            | its silent session (`SilentSession`), written |
// |              |                    | only by the server (silent.ts)                |
// | silent       | sticky             | the silent session it was made in: it's face  |
// |              |                    | down, and has no `text` in the document until |
// |              |                    | the reveal                                    |
// | display      | section            | how its contents show: `list` (compact rows), |
// |              |                    | `mini` (a grid of mini cards), or absent for  |
// |              |                    | cards, as placed (display.ts)                 |
// | sort         | section            | a list's sort (`ListSort`: `by` state, number |
// |              |                    | or title, and `desc`); absent means by hand   |
// | order        | all but connectors | its place in its section's manual order, a    |
// |              |                    | fractional index; absent sorts after those    |
// |              |                    | with one, in reading order. x and y stay the  |
// |              |                    | free-form position while a list shows it      |
// | owner        | action             | who'll do it (`ActionOwner`: a GitHub login,  |
// |              |                    | with a name and avatar when known)            |
// | due          | action             | when it's due, a calendar day `YYYY-MM-DD`    |
// | done         | action             | when it was ticked done, ISO 8601; only for   |
// |              |                    | items not linked to an issue (actionItems.ts) |
// | issue        | action             | id of the `issue.create` staged for it in     |
// |              |                    | `changes`, which links it once it's made      |
// | carried      | action             | where it was carried over from                |
// |              |                    | (`CarriedFrom`: board, title, shape, when)    |
// | stack         | sticky             | id of the stack it's in (stacks.ts), or null    |
// |              |                    | once it's left one; its x, y and parent       |
// |              |                    | follow the stack's while it's in one           |
// | suggested    | stack               | a name suggested from its stickies' text      |
// |              |                    | (`StackSuggestion`: title, and a hash of the   |
// |              |                    | text it was made from), written only by the   |
// |              |                    | server, so it never overwrites `title`        |
// | url          | link               | the page's address, http(s) (links.ts)        |
// | preview      | link               | what the page says about itself, once read    |
// |              |                    | (`LinkPreview`: status, title, description,   |
// |              |                    | site name, image and icon addresses, when),   |
// |              |                    | replaced whole, written with `UNFURL_ORIGIN`  |
// | unnameable   | stack               | the server found nothing in it everyone on    |
// |              |                    | the board may read to name it from (only      |
// |              |                    | cards whose titles can't be shared), so no    |
// |              |                    | name's coming (`StackUnnameable`: a hash of   |
// |              |                    | its members' ids, `membersHash`, when it      |
// |              |                    | looked); written only by the server           |
// | image        | image              | its file's id: the hex SHA-256 of the bytes,  |
// |              |                    | kept beside the board (images.ts); absent     |
// |              |                    | while it uploads                              |
// | mime         | image              | the file's type, e.g. `image/png`             |
// | iw, ih       | image              | the file's natural size, in pixels            |
// | alt          | image              | what it shows, in words: read to screen       |
// |              |                    | readers and AI, never the picture itself      |
// | caption      | image              | show `alt` beneath it as a caption            |
// | upload       | image              | who's uploading its file (`ImageUpload`),     |
// |              |                    | until it's stored                             |
// | preview      | image              | a tiny blurred data URL others see while it   |
// |              |                    | uploads; cleared with `upload`                |
//
// Beside `shapes`, the document has these root maps:
//
// | map          | meaning                                                      |
// | ------------ | ------------------------------------------------------------ |
// | changes      | staged changes for the forge (changes.ts)                    |
// | rules        | the board's rules, and `ruleLog` their activity (rules.ts)    |
// | facilitation | `timer`: the shared timer (`Timer`), written by the server   |
// |              | in its own clock (facilitation.ts)                           |
// | stamps       | one key per person, shape and stamp → `Stamp`, so stamps     |
// |              | never conflict (facilitation.ts)                             |
// | dotVotes     | vote id → Y.Map of its settings and a nested `ballots` map   |
// |              | of voter key → `Ballot` (dotvotes.ts)                         |
// | prepared     | step id → `PreparedStep`: facilitation a template set up,    |
// |              | ready to start: a timer, silent writing, a dot vote          |
// |              | (prepared.ts)                                                |
//
// Decisions link to items with ordinary connectors: a connector between a
// decision and a card links that card (see `linkedItems` in decisions.ts).
//
// Every committed move writes x, y and `parent` together, even when the
// parent is unchanged and even when it's null, so a concurrent move always
// resolves to one client's x, y and parent rather than a mix: Yjs picks the
// same winner for every key two clients set concurrently. (Deleting the key
// would not: a delete never beats a concurrent set.)
//
// References between shapes (`parent`, connector ends) can dangle after
// concurrent edits, e.g. one person deletes a section while another drops a
// sticky into it. Readers must tolerate that, and `repair.ts` fixes it up on
// the server.
//
// Comments (#51) aren't in the document: they live in the board object's
// SQLite storage, pinned to a shape by its id (see comments.ts), as does
// what "since you were here" (#46) remembers about edits and visits.

export type ShapeType =
	| "card"
	| "sticky"
	| "text"
	| "section"
	| "connector"
	| "decision"
	| "widget"
	| "action"
	| "stack"
	| "link"
	| "image";

/** Where a decision stands. */
export type DecisionStatus = "proposed" | "decided" | "superseded";

export type VoteChoice = "agree" | "disagree";

/** One person's vote on a decision, stored whole under their voter key. */
export interface Vote {
	choice: VoteChoice;
	name: string;
	color?: string;
	login?: string;
	/** When they voted, ISO 8601. */
	at: string;
}

/** Typeface for stickies and text: the UI sans, or a handwriting face. */
export type ShapeFont = "sans" | "hand";

/** Text block sizes, small to extra large. */
export type TextSize = "s" | "m" | "l" | "xl";

/** Who an action item belongs to: one of the board's people, by GitHub login. */
export interface ActionOwner {
	login: string;
	name?: string | null;
	avatarUrl?: string;
}

/** Where an action item was carried over from (actionItems.ts). */
export interface CarriedFrom {
	/** The board's id, and its title then. */
	board: string;
	title: string;
	/** The action item's id on that board. */
	shape: string;
	/** When it was carried over, ISO 8601. */
	at: string;
}

/** A stack's suggested name (stacks.ts): what it was, and the contents it was made from. */
export interface StackSuggestion {
	title: string;
	/** A hash of the visible text it was made from (`stackHash`). */
	hash: string;
}

/**
 * A stack the server can't name (stacks.ts): nothing in it may be read by
 * everyone on the board, so no suggestion's coming for these members.
 */
export interface StackUnnameable {
	/** Its members when the server looked (`membersHash`): it holds only while they're the same. */
	hash: string;
}

export interface ShapeProps {
	type: ShapeType;
	/** Top-left corner in board coordinates. Unused (0) on connectors. */
	x: number;
	y: number;
	/** Fractional index for stacking order. */
	z: string;
	/** The section this shape sits in, if any. */
	parent?: string | null;
	/**
	 * Card shapes: the card key, `owner/repo#number`. Decisions: the pull
	 * request their record was written to, once it's applied.
	 */
	ref?: string;
	/** Sticky and text shapes: plain text for now. Decisions: the body. */
	text?: string;
	color?: string;
	/** Sticky and text shapes: the typeface. Absent means sans. */
	font?: ShapeFont;
	/** Text shapes: the type size. Absent means medium. */
	size?: TextSize;
	/** Who made it, shown on stickies. */
	author?: Author;
	/** Sections: size. */
	w?: number;
	h?: number;
	/** Sections and decisions: the title. Stacks: their name, as a person wrote it. */
	title?: string;
	/** Connectors: where each end is. */
	from?: ConnectorEnd;
	to?: ConnectorEnd;
	/** Connectors: text at the middle of the line. */
	label?: string;
	route?: ConnectorRoute;
	arrow?: ConnectorArrow;
	dash?: boolean;
	/** Decisions: where it stands. Absent means proposed. */
	status?: DecisionStatus;
	/** Decisions: the decision that superseded this one. */
	supersededBy?: string;
	decidedAt?: string;
	decidedBy?: Author;
	/** Decisions: votes by voter key (a Y.Map in the document). */
	votes?: Record<string, Vote>;
	/** Decisions: the id of its write-back in the board's `changes`. */
	writeback?: string;
	/** Decisions: what was decided, for its record, when that's more than its title. */
	outcome?: string;
	/** Decisions: what becomes easier or harder because of it. */
	consequences?: string;
	/** Widgets: the kind (see src/shared/widgets.ts). */
	widget?: string;
	/** Widgets: the kind's config. */
	config?: unknown;
	/** Sections: an inbox frame's query (`InboxConfig`). */
	inbox?: InboxConfig;
	/** Cards: how the card arrived. Absent means placed by hand. */
	provenance?: Provenance;
	/**
	 * Cards: when it stopped matching the inbox or rule that brought it (ISO
	 * 8601). People decide whether to keep or remove it (see provenance.ts).
	 */
	unmatched?: string;
	/** Inbox sections: items dismissed from the tray, by key (a Y.Map in the document). */
	dismissed?: Record<string, Dismissal>;
	/**
	 * Silent mode (silent.ts): on a section, its session; on a sticky, the
	 * id of the session it was made in, while it's face down.
	 */
	silent?: string | SilentSession;
	/** Sections: how their contents show (display.ts). Absent means cards. */
	display?: SectionDisplay;
	/** Sections: how a list or grid is sorted. Absent means by hand. */
	sort?: ListSort;
	/** Its place in its section's manual order (a fractional index). */
	order?: string;
	/** Action items: who'll do it. */
	owner?: ActionOwner;
	/** Action items: when it's due, `YYYY-MM-DD`. */
	due?: string;
	/** Action items not linked to an issue: when they were ticked done, ISO 8601. */
	done?: string;
	/** Action items: the id of the issue staged for it, in `changes`. */
	issue?: string;
	/** Action items: where it was carried over from. */
	carried?: CarriedFrom;
	/** Stickies: the stack it's in, if any (stacks.ts). Null once it's left one. */
	stack?: string | null;
	/** Stacks: a name suggested from its stickies, written by the server. */
	suggested?: StackSuggestion;
	/** Stacks: nothing in it the server may name it from, written by the server. */
	unnameable?: StackUnnameable;
	/** Link cards: the page's address (links.ts). */
	url?: string;
	/** Link cards: what the page says about itself, once it's been read. */
	preview?: LinkPreview;
	/** Images: the file's hash (images.ts). Absent while it uploads. */
	image?: string;
	/** Images: the file's type. */
	mime?: string;
	/** Images: the file's natural size, in pixels. */
	iw?: number;
	ih?: number;
	/** Images: what it shows, in words. */
	alt?: string;
	/** Images: show the alt text beneath it. */
	caption?: boolean;
	/** Images: who's uploading the file, until it's stored. */
	upload?: ImageUpload;
	/** Images: a tiny blurred stand-in, while it uploads. */
	blur?: string;
}

/**
 * One end of a connector. A loose end is just a point. A bound end names a
 * shape and follows it: `anchor` pins it to a point on the shape's outline;
 * without one, the end floats around the outline, aiming at the other end.
 * `x` and `y` are always set: on a bound end they're where the end was when
 * it was last placed, which is where it's left if the shape disappears.
 */
export interface ConnectorEnd {
	x: number;
	y: number;
	shape?: string;
	anchor?: Anchor;
}

export type ConnectorRoute = "curved" | "straight" | "elbow";
export type ConnectorArrow = "end" | "both" | "none";

export interface Author {
	name: string;
	color: string;
	/** Their GitHub login, when they were signed in: an issue made from it credits them. */
	login?: string;
}

/**
 * The transaction origin for every document write a client makes itself.
 * The client's undo manager tracks exactly this origin (see
 * src/client/undo.ts), so writes under any other origin can't be undone.
 */
export const LOCAL_ORIGIN = "local";

/**
 * Run `fn` as a single local transaction: one undo step, tracked as this
 * person's change. Nested calls join the outer transaction.
 */
export function transactLocal<T>(doc: Y.Doc, fn: () => T): T {
	let result: T | undefined;
	doc.transact(() => {
		result = fn();
	}, LOCAL_ORIGIN);
	return result as T;
}

export function shapesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap("shapes");
}

export function readShape(shape: Y.Map<unknown>): ShapeProps {
	return shape.toJSON() as ShapeProps;
}

export function addShape(doc: Y.Doc, id: string, props: ShapeProps): void {
	doc.transact(() => {
		const shape = new Y.Map<unknown>();
		for (const [key, value] of Object.entries(props)) {
			if (value !== undefined) shape.set(key, value);
		}
		shapesMap(doc).set(id, shape);
	});
}

/**
 * The set of card keys referenced anywhere on the board: every card, the
 * pull request each written-back decision shows the live state of, and the
 * issue each linked action item takes its status from.
 */
export function cardRefs(doc: Y.Doc): Set<string> {
	const refs = new Set<string>();
	for (const shape of shapesMap(doc).values()) {
		const ref = shape.get("ref");
		const type = shape.get("type");
		if ((type === "card" || type === "decision" || type === "action") && typeof ref === "string") {
			refs.add(ref);
		}
	}
	return refs;
}

/**
 * A z-index above every other shape, or null if `except` is already on top.
 */
export function topZ(doc: Y.Doc, except?: string): string | null {
	let top: string | null = null;
	let topId: string | null = null;
	for (const [id, shape] of shapesMap(doc)) {
		const z = shape.get("z");
		// Skip keys fractional-indexing can't build on, so one bad shape (from
		// an old board or another client) can't break moving everything else.
		if (typeof z === "string" && isValidZ(z) && (top === null || z > top)) {
			top = z;
			topId = id;
		}
	}
	if (except && topId === except) return null;
	return generateKeyBetween(top, null);
}

const validZ = new Map<string, boolean>();

/** Whether `z` is a key fractional-indexing can build on (see the `z-keys` migration). */
export function isValidZ(z: string): boolean {
	let valid = validZ.get(z);
	if (valid === undefined) {
		try {
			generateKeyBetween(z, null);
			valid = true;
		} catch {
			valid = false;
		}
		validZ.set(z, valid);
	}
	return valid;
}

export function nextZ(doc: Y.Doc): string {
	return topZ(doc) ?? generateKeyBetween(null, null);
}

/**
 * Set properties on several shapes in one transaction, so a change like
 * recolouring a selection is a single document write (and a single undo
 * step). Keys that already hold the value are left alone, as every write
 * leaves a tombstone.
 */
export function updateShapes(
	doc: Y.Doc,
	ids: Iterable<string>,
	props: Partial<Omit<ShapeProps, "type">>,
	origin: unknown = LOCAL_ORIGIN,
): void {
	const shapes = shapesMap(doc);
	doc.transact(() => {
		for (const id of ids) {
			const shape = shapes.get(id);
			if (!shape) continue;
			for (const [key, value] of Object.entries(props)) {
				if (value === undefined) {
					if (shape.has(key)) shape.delete(key);
				} else if (shape.get(key) !== value) {
					shape.set(key, value);
				}
			}
		}
	}, origin);
}
