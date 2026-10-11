// Since you were here (#46): what changed on a board between someone's
// visits. Pure types and helpers, shared by the board's server (which keeps
// a bounded change log and card history, see src/server/since.ts) and the
// client's digest panel and canvas highlights.
//
// Costs stay bounded however big the board or long the absence: the change
// log keeps one row per shape and kind of change (the latest), card history
// a few rows per card, and the digest caps how many edits it lists.

import type * as Y from "yjs";
import type { Card } from "./cards.ts";
import type { CommentThread } from "./comments.ts";
import { isVisible, liveMessages } from "./comments.ts";

export type EditKind = "added" | "moved" | "changed" | "removed";

/** Who made a change: a person (or a guest, on boards without sign-in), or Tack itself. */
export interface Actor {
	kind: "person" | "guest" | "rule" | "push";
	id?: number;
	login?: string;
	name?: string | null;
	avatarUrl?: string;
}

export interface EditEntry {
	shape: string;
	kind: EditKind;
	/** The shape's type when it changed: `sticky`, `card`, … */
	type: string;
	/** When, ms since the epoch. */
	at: number;
	by: Actor;
}

export type CardActivityKind =
	| "closed"
	| "merged"
	| "reopened"
	| "comments"
	| "ci_failing"
	| "ci_passing"
	| "approved"
	| "changes_requested";

/** Something that happened on GitHub to a card on the board. */
export interface CardActivity {
	key: string;
	kind: CardActivityKind;
	at: number;
	/** New comments: how many. */
	count?: number;
}

export interface PushDigest {
	pushId: string;
	at: number;
	by: { login: string; name: string | null };
	applied: number;
	failed: number;
	/** The first few changes, in words. */
	summaries: string[];
}

/** What changed since `since`, as one viewer may see it. */
export interface Digest {
	/** The visit it's since: null on a first visit (nothing to show). */
	since: number | null;
	/** When the digest was made. */
	at: number;
	/** Edits by other people, newest first, at most `MAX_DIGEST_EDITS`. */
	edits: EditEntry[];
	/** How many more edits there were than listed. */
	more: number;
	cards: CardActivity[];
	pushes: PushDigest[];
}

export const MAX_DIGEST_EDITS = 400;
/** A new visit starts after this long away; reloading within it doesn't. */
export const VISIT_GAP_MS = 15 * 60_000;

/** Requests from a client. `since` is for signed-out people, who keep their last visit locally. */
export type SinceRequest = { type: "since-request"; since?: number } | { type: "since-seen" };

export type SinceEvent = { type: "since"; digest: Digest };

export function isSinceRequest(value: unknown): value is SinceRequest {
	const type = (value as { type?: unknown } | null)?.type;
	return type === "since-request" || type === "since-seen";
}

// --- Edits ----------------------------------------------------------------------

/** Keys whose change is a move; `z` alone (bringing to front) isn't worth telling anyone. */
const MOVE_KEYS = new Set(["x", "y", "parent"]);
const IGNORED_KEYS = new Set(["z"]);

export interface ShapeChange {
	shape: string;
	kind: EditKind;
}

/**
 * What a transaction did to shapes, from `observeDeep` events on the shapes
 * map: added, removed, moved (only position or section changed) or changed
 * (anything else, nested maps like votes included). `moved` lists shapes
 * whose position changed, moved or not.
 */
export function shapeChanges(
	events: Y.YEvent<Y.AbstractType<unknown>>[],
	shapes: Y.Map<Y.Map<unknown>>,
): { changes: ShapeChange[]; moved: string[] } {
	const changes: ShapeChange[] = [];
	const moved = new Set<string>();
	for (const event of events) {
		if (event.target === shapes) {
			for (const [shape, change] of event.changes.keys) {
				const kind =
					change.action === "delete" ? "removed" : change.action === "add" ? "added" : "changed";
				changes.push({ shape, kind });
			}
			continue;
		}
		const shape = event.path[0];
		if (typeof shape !== "string") continue;
		// A nested map (votes, dismissals) changed: the shape changed.
		if (event.path.length > 1) {
			changes.push({ shape, kind: "changed" });
			continue;
		}
		const keys = [...event.changes.keys.keys()].filter((key) => !IGNORED_KEYS.has(key));
		if (keys.length === 0) continue;
		if (keys.some((key) => key === "x" || key === "y")) moved.add(shape);
		changes.push({ shape, kind: keys.every((key) => MOVE_KEYS.has(key)) ? "moved" : "changed" });
	}
	return { changes, moved: [...moved] };
}

/** Whether a change is worth telling anyone: a connector's ends following shapes isn't. */
export function isNews(type: string, kind: EditKind): boolean {
	return !(type === "connector" && kind === "moved");
}

// --- Card history -------------------------------------------------------------

/** What the board remembers of a card over time: just enough to say what changed. */
export interface CardSnapshot {
	state: string;
	comments: number;
	/** CI rollup: passing, failing, pending, none, or "" for issues. */
	ci: string;
	/** Review decision, or "". */
	review: string;
}

export function snapshotOf(card: Card): CardSnapshot {
	return {
		state: card.state,
		comments: card.comments,
		ci: card.pull?.checks?.state ?? "",
		review: card.pull?.review ?? "",
	};
}

export function sameSnapshot(a: CardSnapshot, b: CardSnapshot): boolean {
	return a.state === b.state && a.comments === b.comments && a.ci === b.ci && a.review === b.review;
}

/**
 * What happened to a card between two snapshots, each change dated by when
 * it was first seen (`history` is every snapshot after `before`, oldest first).
 */
export function cardActivity(
	key: string,
	before: CardSnapshot,
	history: { at: number; snapshot: CardSnapshot }[],
): CardActivity[] {
	const after = history.at(-1)?.snapshot;
	if (!after) return [];
	const when = (changed: (snapshot: CardSnapshot) => boolean) =>
		history.find((entry) => changed(entry.snapshot))?.at ?? history.at(-1)?.at ?? 0;
	const out: CardActivity[] = [];
	if (after.state !== before.state) {
		const at = when((s) => s.state === after.state);
		if (after.state === "merged") out.push({ key, kind: "merged", at });
		else if (after.state === "closed") out.push({ key, kind: "closed", at });
		else if (before.state === "closed" || before.state === "merged")
			out.push({ key, kind: "reopened", at });
	}
	if (after.comments > before.comments) {
		out.push({
			key,
			kind: "comments",
			// When the latest of them arrived.
			at: when((s) => s.comments === after.comments),
			count: after.comments - before.comments,
		});
	}
	if (after.ci !== before.ci && (after.ci === "failing" || after.ci === "passing")) {
		out.push({
			key,
			kind: after.ci === "failing" ? "ci_failing" : "ci_passing",
			at: when((s) => s.ci === after.ci),
		});
	}
	if (
		after.review !== before.review &&
		(after.review === "approved" || after.review === "changes_requested")
	) {
		out.push({ key, kind: after.review, at: when((s) => s.review === after.review) });
	}
	return out;
}

// --- Reading a digest -----------------------------------------------------------

/** How a shape looks on the canvas once someone's back: new, changed, moved or closed. */
export type HighlightKind = "new" | "changed" | "moved" | "closed";

export interface Highlight {
	shape: string;
	kind: HighlightKind;
	at: number;
	/** Who, for the label: "Priya". */
	by?: string;
}

const RANK: Record<HighlightKind, number> = { closed: 4, new: 3, changed: 2, moved: 1 };

/**
 * One highlight per shape still on the board: the most telling of what
 * happened to it (closed beats new beats changed beats moved). Card activity
 * applies to every card shape showing that item.
 */
export function highlightsFor(
	digest: Digest,
	shapeExists: (id: string) => boolean,
	shapesFor: (key: string) => string[],
): Highlight[] {
	const out = new Map<string, Highlight>();
	const put = (highlight: Highlight) => {
		const existing = out.get(highlight.shape);
		if (!existing || RANK[highlight.kind] > RANK[existing.kind])
			out.set(highlight.shape, highlight);
	};
	for (const edit of digest.edits) {
		if (edit.kind === "removed" || !shapeExists(edit.shape)) continue;
		put({
			shape: edit.shape,
			kind: edit.kind === "added" ? "new" : edit.kind,
			at: edit.at,
			by: actorName(edit.by),
		});
	}
	for (const activity of digest.cards) {
		const kind: HighlightKind =
			activity.kind === "closed" || activity.kind === "merged" ? "closed" : "changed";
		for (const shape of shapesFor(activity.key)) put({ shape, kind, at: activity.at });
	}
	return [...out.values()].sort((a, b) => b.at - a.at);
}

export function actorName(actor: Actor): string {
	if (actor.kind === "rule") return "A rule";
	if (actor.kind === "push") return "Tack";
	if (actor.kind === "guest") return "A guest";
	return actor.name || actor.login || "Someone";
}

/** A key for grouping edits by who made them. */
export function actorKey(actor: Actor): string {
	return actor.id !== undefined ? `id:${actor.id}` : actor.kind;
}

const NOUNS: Record<string, [string, string]> = {
	sticky: ["sticky", "stickies"],
	card: ["card", "cards"],
	text: ["text block", "text blocks"],
	section: ["section", "sections"],
	connector: ["connector", "connectors"],
	decision: ["decision", "decisions"],
	widget: ["widget", "widgets"],
	action: ["action item", "action items"],
	stack: ["stack", "stacks"],
};

export function noun(type: string, count: number): string {
	const [one, many] = NOUNS[type] ?? ["shape", "shapes"];
	return `${count} ${count === 1 ? one : many}`;
}

const VERBS: Record<EditKind, string> = {
	added: "added",
	moved: "moved",
	changed: "edited",
	removed: "removed",
};

/** Someone's edits in words: "added 4 stickies and a section, moved 2 cards". */
export function describeEdits(edits: EditEntry[]): string {
	const byKind = new Map<EditKind, Map<string, number>>();
	for (const edit of edits) {
		let types = byKind.get(edit.kind);
		if (!types) byKind.set(edit.kind, (types = new Map()));
		types.set(edit.type, (types.get(edit.type) ?? 0) + 1);
	}
	const phrases: string[] = [];
	for (const kind of ["added", "changed", "moved", "removed"] as const) {
		const types = byKind.get(kind);
		if (!types) continue;
		const things = [...types].sort((a, b) => b[1] - a[1]).map(([type, n]) => noun(type, n));
		phrases.push(`${VERBS[kind]} ${list(things)}`);
	}
	return phrases.join(", ");
}

function list(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Edits grouped by who made them, most active first. */
export function editsByPerson(edits: EditEntry[]): { by: Actor; edits: EditEntry[] }[] {
	const groups = new Map<string, { by: Actor; edits: EditEntry[] }>();
	for (const edit of edits) {
		const key = actorKey(edit.by);
		let group = groups.get(key);
		if (!group) groups.set(key, (group = { by: edit.by, edits: [] }));
		group.edits.push(edit);
	}
	return [...groups.values()].sort((a, b) => b.edits.length - a.edits.length);
}

const CARD_WORDS: Record<CardActivityKind, string> = {
	closed: "closed",
	merged: "merged",
	reopened: "reopened",
	comments: "new comments",
	ci_failing: "CI failing",
	ci_passing: "CI passing",
	approved: "approved",
	changes_requested: "changes requested",
};

/** A card's activity in words: "merged", "3 new comments". */
export function describeCardActivity(activity: CardActivity): string {
	if (activity.kind === "comments") {
		const n = activity.count ?? 1;
		return `${n} new comment${n === 1 ? "" : "s"}`;
	}
	return CARD_WORDS[activity.kind];
}

/** New comments since a visit: threads started, replies, and threads that mention you. */
export function commentDigest(
	threads: Iterable<CommentThread>,
	since: number | null,
	you: { id: number | null; login?: string },
): { started: CommentThread[]; replied: CommentThread[]; mentioned: CommentThread[] } {
	const started: CommentThread[] = [];
	const replied: CommentThread[] = [];
	const mentioned: CommentThread[] = [];
	if (since === null) return { started, replied, mentioned };
	const login = you.login?.toLowerCase();
	for (const thread of threads) {
		if (!isVisible(thread)) continue;
		const fresh = liveMessages(thread).filter(
			(message) => message.at > since && message.author.id !== you.id,
		);
		if (fresh.length === 0) continue;
		if (login && fresh.some((message) => message.mentions?.includes(login))) mentioned.push(thread);
		const first = thread.messages[0];
		if (first && first.at > since && first.author.id !== you.id) started.push(thread);
		else replied.push(thread);
	}
	const newest = (a: CommentThread, b: CommentThread) => b.updatedAt - a.updatedAt;
	return {
		started: started.sort(newest),
		replied: replied.sort(newest),
		mentioned: mentioned.sort(newest),
	};
}

/** Whether a digest has anything to show. */
export function isEmptyDigest(digest: Digest, comments = 0): boolean {
	return (
		digest.since === null ||
		(digest.edits.length === 0 &&
			digest.cards.length === 0 &&
			digest.pushes.length === 0 &&
			comments === 0)
	);
}
