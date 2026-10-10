import type * as Y from "yjs";
import { TITLE_MAX, extrasOf, issueFromText, type IssueExtras } from "./actions.ts";
import type { Card, MissingCard } from "./cards.ts";
import {
	type ChangeStatus,
	type PendingChange,
	type Stager,
	changesMap,
	listChanges,
	readChange,
	stageChange,
	unstageChanges,
} from "./changes.ts";
import { type Size, boxOf, type SizeOf } from "./sections.ts";
import { spotBelow, spotInSection } from "./placement.ts";
import {
	type ActionOwner,
	type Author,
	type CarriedFrom,
	LOCAL_ORIGIN,
	type ShapeProps,
	addShape,
	nextZ,
	readShape,
	shapesMap,
} from "./shapes.ts";
import { addSection, placeInSections, readShapes } from "./structure.ts";

// Action items (#52): something someone will do, with an owner (one of the
// board's people) and a due date. An action item is its own shape type
// (`action`) rather than a sticky with a mode: it carries a status, an owner
// and a link that stickies don't, it renders as a row with a checkbox rather
// than a square of paper, and keeping it apart leaves stickies' own
// behaviour (silent mode, text fitting, "stickies to issues") untouched.
// Stickies become action items with `stickyToAction`.
//
// An action item stands on its own until it's linked to an issue: then the
// issue's state is its status (closed is done), the board follows it like a
// card (`ref`, see `cardRefs`), and ticking it stages closing the issue
// rather than writing anything to the board. It can be linked to an issue
// that exists, or staged as a new one (assigned to its owner), which the
// push engine links once it's made (the `link` change effect).
//
// "Carry over" copies the open ones into another board, e.g. the next retro,
// keeping their owners, due dates and links (`carryable`, `placeCarried`).

export type { ActionOwner, CarriedFrom };

/** Room an action item takes before it's been measured. */
export const ACTION_SIZE: Size = { w: 296, h: 104 };

/** How soon a due date counts as "soon", in days. */
export const DUE_SOON_DAYS = 3;

/** An action item's properties that a copy doesn't take: its staged issue is the original's. */
export const ACTION_UNCOPIED: readonly string[] = ["issue"];

/** Transaction origin for the push engine linking items to the issues made for them. */
export const ACTION_LINK_ORIGIN = "action-link";

export interface NewActionItem {
	x: number;
	y: number;
	text?: string;
	owner?: ActionOwner | null;
	due?: string | null;
	ref?: string;
	author?: Author;
	parent?: string | null;
	z?: string;
	carried?: CarriedFrom;
}

/** Add an action item. Wrap in a transaction to set its origin. */
export function addActionItem(doc: Y.Doc, id: string, item: NewActionItem): void {
	addShape(doc, id, {
		type: "action",
		x: Math.round(item.x),
		y: Math.round(item.y),
		z: item.z ?? nextZ(doc),
		parent: item.parent ?? null,
		text: item.text ?? "",
		...(item.owner ? { owner: cleanOwner(item.owner) } : {}),
		...(item.due && isDate(item.due) ? { due: item.due } : {}),
		...(item.ref ? { ref: item.ref } : {}),
		...(item.author ? { author: item.author } : {}),
		...(item.carried ? { carried: item.carried } : {}),
	});
}

function actionMap(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
	const shape = shapesMap(doc).get(id);
	return shape?.get("type") === "action" ? shape : undefined;
}

// --- Owners and due dates ---------------------------------------------------------

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** An owner as stored: a GitHub login, with a name and avatar when known. */
export function cleanOwner(owner: ActionOwner): ActionOwner {
	const login = owner.login.replace(/^@/, "").trim();
	return {
		login,
		...(owner.name ? { name: owner.name } : {}),
		...(owner.avatarUrl ? { avatarUrl: owner.avatarUrl } : {}),
	};
}

/** Whether a value is an owner this code would have written. */
export function isOwner(value: unknown): value is ActionOwner {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ActionOwner).login === "string" &&
		LOGIN.test((value as ActionOwner).login)
	);
}

/** Whether a login typed in could be someone on GitHub. */
export function isLogin(text: string): boolean {
	return LOGIN.test(text.replace(/^@/, "").trim());
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is a calendar date, `YYYY-MM-DD`. */
export function isDate(value: unknown): value is string {
	if (typeof value !== "string" || !DATE.test(value)) return false;
	const [y, m, d] = value.split("-").map(Number) as [number, number, number];
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** A date, `YYYY-MM-DD`, in the viewer's own time zone. Due dates are calendar days. */
export function localDate(at: number | Date = Date.now()): string {
	const date = typeof at === "number" ? new Date(at) : at;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A calendar date `days` after another. */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const next = new Date(Date.UTC(y, m - 1, d + days));
	return next.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
	const at = (date: string) => {
		const [y, m, d] = date.split("-").map(Number) as [number, number, number];
		return Date.UTC(y, m - 1, d);
	};
	return Math.round((at(to) - at(from)) / 86_400_000);
}

/** The weekday of a calendar date, 0 for Sunday. */
function weekday(date: string): number {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * - `none`: no due date, or it's done
 * - `later`: more than `DUE_SOON_DAYS` away
 * - `soon`: within `DUE_SOON_DAYS`
 * - `today`: due today
 * - `overdue`: the day has passed and it's still open
 */
export type DueState = "none" | "later" | "soon" | "today" | "overdue";

export function dueState(due: string | undefined, today: string, done = false): DueState {
	if (!due || !isDate(due) || done) return "none";
	const days = daysBetween(today, due);
	if (days < 0) return "overdue";
	if (days === 0) return "today";
	return days <= DUE_SOON_DAYS ? "soon" : "later";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A due date in words, relative to today: "Today", "Tomorrow", "Fri", "18 Oct", "3 days late". */
export function describeDue(due: string, today: string, done = false): string {
	const days = daysBetween(today, due);
	const [y, m, d] = due.split("-").map(Number) as [number, number, number];
	const date = `${d} ${MONTHS[m - 1]}${y === Number(today.slice(0, 4)) ? "" : ` ${y}`}`;
	if (done) return date;
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	if (days < 0) return `${-days} days late`;
	if (days < 7) return WEEKDAYS[weekday(due)] ?? date;
	return date;
}

/** Quick picks for a due date, from today: tomorrow, Friday (or next week's), next Monday, in two weeks. */
export function duePresets(today: string): { label: string; date: string }[] {
	const day = weekday(today);
	const toFriday = (5 - day + 7) % 7 || 7;
	const toMonday = (1 - day + 7) % 7 || 7;
	const presets = [
		{ label: "Today", date: today },
		{ label: "Tomorrow", date: addDays(today, 1) },
		{ label: toFriday < 7 ? "Friday" : "Next Friday", date: addDays(today, toFriday) },
		{ label: "Next week", date: addDays(today, toMonday) },
		{ label: "In 2 weeks", date: addDays(today, 14) },
	];
	const seen = new Set<string>();
	return presets.filter((preset) => !seen.has(preset.date) && seen.add(preset.date));
}

// --- Status ---------------------------------------------------------------------

export type ActionStatus = "open" | "done";

export interface ActionState {
	status: ActionStatus;
	/**
	 * Where the status comes from: the linked issue (`issue`), the board
	 * (`board`, for items not linked to anything), or nowhere yet (`unknown`:
	 * linked, but the issue hasn't loaded or can't be read, so it reads open).
	 */
	from: "issue" | "board" | "unknown";
	/** Linked items: how the issue was closed, where the forge says. */
	reason?: string | null;
}

/** An action item's status: from its linked issue's state once linked, else ticked on the board. */
export function actionState(
	shape: Pick<ShapeProps, "ref" | "done">,
	card: Card | MissingCard | null | undefined,
): ActionState {
	if (shape.ref) {
		if (!card || "missing" in card) return { status: "open", from: "unknown" };
		const done = card.state === "closed" || card.state === "merged";
		return {
			status: done ? "done" : "open",
			from: "issue",
			...(done ? { reason: card.stateReason } : {}),
		};
	}
	return { status: shape.done ? "done" : "open", from: "board" };
}

// --- Editing ------------------------------------------------------------------------

/** Set fields on an action item, as one local edit. `null` clears a field. */
export function updateActionItem(
	doc: Y.Doc,
	id: string,
	changes: { text?: string; owner?: ActionOwner | null; due?: string | null },
	origin: unknown = LOCAL_ORIGIN,
): void {
	doc.transact(() => {
		const shape = actionMap(doc, id);
		if (!shape) return;
		if (changes.text !== undefined && shape.get("text") !== changes.text) {
			shape.set("text", changes.text);
		}
		if (changes.owner === null) {
			if (shape.has("owner")) shape.delete("owner");
		} else if (changes.owner) {
			const owner = cleanOwner(changes.owner);
			const current = shape.get("owner") as ActionOwner | undefined;
			if (JSON.stringify(current) !== JSON.stringify(owner)) shape.set("owner", owner);
		}
		if (changes.due === null) {
			if (shape.has("due")) shape.delete("due");
		} else if (
			changes.due !== undefined &&
			isDate(changes.due) &&
			shape.get("due") !== changes.due
		) {
			shape.set("due", changes.due);
		}
	}, origin);
}

/**
 * Tick or untick an action item that isn't linked to an issue. (A linked
 * one's status is its issue's: see `stageActionState`.)
 */
export function setActionDone(
	doc: Y.Doc,
	id: string,
	done: boolean,
	at: string = new Date().toISOString(),
	origin: unknown = LOCAL_ORIGIN,
): void {
	doc.transact(() => {
		const shape = actionMap(doc, id);
		if (!shape || typeof shape.get("ref") === "string") return;
		if (done && !shape.get("done")) shape.set("done", at);
		else if (!done && shape.has("done")) shape.delete("done");
	}, origin);
}

/** Changes still on their way: staged, being pushed, or waiting to confirm (or failed, to retry). */
const LIVE: ReadonlySet<ChangeStatus> = new Set(["staged", "sending", "sent", "failed"]);

/** The issue staged for an action item, while it's on its way. */
export function stagedIssueOf(doc: Y.Doc, shape: Pick<ShapeProps, "issue">): PendingChange | null {
	if (!shape.issue) return null;
	const change = changesMap(doc).get(shape.issue);
	if (!change) return null;
	const read = readChange(change);
	return LIVE.has(read.status) || read.status === "applied" ? read : null;
}

/**
 * Link an action item to an issue that exists, by key. Anything staged to
 * make one for it is unstaged (if it can still be), and a tick on the board
 * gives way to the issue's state. One local edit.
 */
export function linkActionItem(doc: Y.Doc, id: string, key: string): void {
	doc.transact(() => {
		const shape = actionMap(doc, id);
		if (!shape) return;
		const issue = shape.get("issue");
		if (typeof issue === "string") {
			unstageChanges(doc, [issue]);
			shape.delete("issue");
		}
		if (shape.get("ref") !== key) shape.set("ref", key);
		if (shape.has("done")) shape.delete("done");
	}, LOCAL_ORIGIN);
}

/** Unlink an action item from its issue: it keeps the status it had, as a tick on the board. */
export function unlinkActionItem(doc: Y.Doc, id: string, done: boolean): void {
	doc.transact(() => {
		const shape = actionMap(doc, id);
		if (!shape) return;
		if (shape.has("ref")) shape.delete("ref");
		const issue = shape.get("issue");
		if (typeof issue === "string") {
			unstageChanges(doc, [issue]);
			shape.delete("issue");
		}
		if (done) shape.set("done", new Date().toISOString());
	}, LOCAL_ORIGIN);
}

/** What a new issue for an action item says. */
export function actionIssue(
	item: Pick<ShapeProps, "text" | "due" | "owner">,
	{ boardUrl, boardTitle }: { boardUrl?: string; boardTitle?: string } = {},
): { title: string; body?: string } | null {
	const issue = issueFromText(item.text ?? "");
	if (!issue) return null;
	const lines: string[] = [];
	if (issue.body) lines.push(issue.body, "");
	const facts: string[] = [];
	if (item.due && isDate(item.due)) facts.push(`**Due** ${item.due}`);
	if (item.owner?.login) facts.push(`**Owner** @${item.owner.login}`);
	if (facts.length > 0) lines.push(facts.join(" · "));
	if (boardUrl) {
		lines.push(
			"",
			`<sub>An action item from [${(boardTitle ?? "a Tack board").replace(/[[\]]/g, "")}](${boardUrl})</sub>`,
		);
	}
	const body = lines.join("\n").trim();
	return { title: issue.title.slice(0, TITLE_MAX), ...(body ? { body } : {}) };
}

/**
 * Stage a new issue for an action item, assigned to its owner (plus any
 * `extras`), and remember it on the item: once it's made, the push engine
 * links the item to it (the `link` effect), and its status follows the
 * issue's. One local edit, so undo takes back both. Null when the item has
 * nothing written on it, or already has an issue.
 */
export function stageActionIssue(
	doc: Y.Doc,
	id: string,
	repo: string,
	stager: Stager,
	options: { extras?: IssueExtras; boardUrl?: string; boardTitle?: string } = {},
): string | null {
	let changeId: string | null = null;
	doc.transact(() => {
		const shape = actionMap(doc, id);
		if (!shape) return;
		const props = readShape(shape);
		if (props.ref || stagedIssueOf(doc, props)) return;
		const issue = actionIssue(props, options);
		if (!issue) return;
		const owner = isOwner(props.owner) ? [props.owner.login] : [];
		const fields = extrasOf({
			...options.extras,
			assignees: [...owner, ...(options.extras?.assignees ?? [])],
		});
		changeId = stageChange(doc, { kind: "issue.create", repo, ...issue, ...fields }, stager, {
			shapes: [id],
			effect: { kind: "link", shapes: [id] },
		});
		shape.set("issue", changeId);
	}, LOCAL_ORIGIN);
	return changeId;
}

/** A staged close or reopen of an item, if there is one. */
export function stagedStateOf(doc: Y.Doc, key: string): PendingChange | null {
	for (const change of listChanges(doc)) {
		if (change.op.kind !== "item.state" || change.status !== "staged") continue;
		if ("key" in change.op.target && change.op.target.key === key) return change;
	}
	return null;
}

/**
 * Tick (or untick) a linked action item: stage closing (or reopening) its
 * issue. Ticking it again while that's still staged takes it back instead.
 * Returns what's staged now, or null if it was taken back.
 */
export function stageActionState(
	doc: Y.Doc,
	id: string,
	done: boolean,
	stager: Stager,
): { change: string; state: "open" | "closed" } | null {
	const shape = actionMap(doc, id);
	const key = shape?.get("ref");
	if (!shape || typeof key !== "string") return null;
	let result: { change: string; state: "open" | "closed" } | null = null;
	doc.transact(() => {
		const staged = stagedStateOf(doc, key);
		if (staged) {
			unstageChanges(doc, [staged.id]);
			const op = staged.op as { state: "open" | "closed" };
			// Taking back the opposite of what's asked for is enough.
			if ((op.state === "closed") !== done) return;
		}
		const state = done ? "closed" : "open";
		const change = stageChange(
			doc,
			{
				kind: "item.state",
				target: { key },
				state,
				...(done ? { reason: "completed" as const } : {}),
			},
			stager,
			{ shapes: [id] },
		);
		result = { change, state };
	}, LOCAL_ORIGIN);
	return result;
}

/**
 * The `link` change effect: point these action items at the item a change
 * made, so they follow it from now on. Run by the push engine (and the
 * playground's pretend push), with an origin no one can undo. Idempotent.
 * Returns how many it linked.
 */
export function linkActionItems(
	doc: Y.Doc,
	ids: readonly string[],
	key: string,
	origin: unknown = ACTION_LINK_ORIGIN,
): number {
	let linked = 0;
	doc.transact(() => {
		for (const id of ids) {
			const shape = actionMap(doc, id);
			if (!shape || shape.get("ref") === key) continue;
			shape.set("ref", key);
			if (shape.has("done")) shape.delete("done");
			linked++;
		}
	}, origin);
	return linked;
}

/**
 * Turn stickies into action items, in place: their text, author, section
 * and stacking order carry over. One local edit. Returns the new ids.
 */
export function stickiesToActions(doc: Y.Doc, ids: readonly string[], sizeOf?: SizeOf): string[] {
	const added: string[] = [];
	doc.transact(() => {
		const shapes = shapesMap(doc);
		for (const id of ids) {
			const shape = shapes.get(id);
			if (!shape || shape.get("type") !== "sticky" || typeof shape.get("silent") === "string") {
				continue;
			}
			const props = readShape(shape);
			const next = crypto.randomUUID();
			addActionItem(doc, next, {
				x: props.x,
				y: props.y,
				z: props.z,
				parent: props.parent ?? null,
				text: props.text ?? "",
				...(props.author ? { author: props.author } : {}),
			});
			// Connectors that pointed at the sticky point at the action item.
			for (const other of shapes.values()) {
				if (other.get("type") !== "connector") continue;
				for (const end of ["from", "to"] as const) {
					const value = other.get(end) as { shape?: string } | undefined;
					if (value?.shape === id) other.set(end, { ...value, shape: next });
				}
			}
			shapes.delete(id);
			added.push(next);
		}
		if (added.length > 0) placeInSections(doc, added, sizeOf);
	}, LOCAL_ORIGIN);
	return added;
}

// --- Carrying over ------------------------------------------------------------------

/** An action item on its way to another board. */
export interface CarriedItem {
	/** Its id on the board it's coming from. */
	id: string;
	text: string;
	owner?: ActionOwner;
	due?: string;
	ref?: string;
	author?: Author;
}

/**
 * The action items to carry over: the open ones (or, with `only`, just those
 * of them), in reading order, top to bottom then left to right.
 */
export function carryable(
	shapes: ReadonlyMap<string, ShapeProps>,
	stateOf: (shape: ShapeProps) => ActionState,
	only?: ReadonlySet<string>,
): CarriedItem[] {
	const items: (CarriedItem & { x: number; y: number })[] = [];
	for (const [id, shape] of shapes) {
		if (shape.type !== "action" || (only && !only.has(id))) continue;
		if (stateOf(shape).status === "done") continue;
		items.push({
			id,
			x: shape.x,
			y: shape.y,
			text: typeof shape.text === "string" ? shape.text : "",
			...(isOwner(shape.owner) ? { owner: cleanOwner(shape.owner) } : {}),
			...(isDate(shape.due) ? { due: shape.due } : {}),
			...(typeof shape.ref === "string" ? { ref: shape.ref } : {}),
			...(shape.author ? { author: shape.author } : {}),
		});
	}
	return items.sort((a, b) => a.y - b.y || a.x - b.x).map(({ x: _x, y: _y, ...item }) => item);
}

/** Section titles that collect action items, for carrying over into. */
const ACTIONS_TITLE = /\b(actions?|action items?|follow[- ]?ups?|next steps|to ?dos?)\b/i;

/** The section carried items go into: the first whose title says it holds actions. */
export function actionsSection(shapes: ReadonlyMap<string, ShapeProps>): string | null {
	let best: { id: string; y: number; x: number } | null = null;
	for (const [id, shape] of shapes) {
		if (shape.type !== "section" || !ACTIONS_TITLE.test(shape.title ?? "")) continue;
		if (!best || shape.y < best.y || (shape.y === best.y && shape.x < best.x)) {
			best = { id, y: shape.y, x: shape.x };
		}
	}
	return best?.id ?? null;
}

export interface CarryResult {
	/** The new action items' ids. */
	added: string[];
	/** Items left out because they're on this board already (carried before, or linked to the same issue). */
	skipped: number;
	/** The section they went into (made for them if the board had none). */
	section: string | null;
}

/**
 * Put carried items on a board: into its actions section (`actionsSection`)
 * where there's room, below it where there isn't, or into a new "Carried
 * over" section beside everything else when the board has none. Each
 * remembers where it came from. Items already here (carried from the same
 * item before, or linked to the same issue) are skipped, so carrying over
 * twice doesn't double up. Call inside a transaction for its origin.
 */
export function placeCarried(
	doc: Y.Doc,
	items: readonly CarriedItem[],
	from: { board: string; title: string },
	{ at = new Date().toISOString(), sizeOf }: { at?: string; sizeOf?: SizeOf } = {},
): CarryResult {
	const result: CarryResult = { added: [], skipped: 0, section: null };
	doc.transact(() => {
		let shapes = readShapes(doc);
		const here = new Set<string>();
		for (const shape of shapes.values()) {
			if (shape.type !== "action") continue;
			if (shape.carried) here.add(`${shape.carried.board}:${shape.carried.shape}`);
			if (shape.ref) here.add(shape.ref);
		}
		const fresh = items.filter((item) => {
			const known = here.has(`${from.board}:${item.id}`) || (item.ref && here.has(item.ref));
			if (known) result.skipped++;
			return !known;
		});
		if (fresh.length === 0) return;

		let section = actionsSection(shapes);
		if (!section) section = makeCarrySection(doc, shapes, fresh.length, from.title, sizeOf);
		result.section = section;
		shapes = readShapes(doc);
		for (const item of fresh) {
			const spot = spotInSection(shapes, section, ACTION_SIZE, sizeOf) ??
				spotBelow(shapes, section, ACTION_SIZE, sizeOf) ?? { x: 0, y: 0 };
			const id = crypto.randomUUID();
			addActionItem(doc, id, {
				...spot,
				text: item.text,
				...(item.owner ? { owner: item.owner } : {}),
				...(item.due ? { due: item.due } : {}),
				...(item.ref ? { ref: item.ref } : {}),
				...(item.author ? { author: item.author } : {}),
				carried: { board: from.board, title: from.title, shape: item.id, at },
			});
			placeInSections(doc, [id], sizeOf);
			shapes = readShapes(doc);
			result.added.push(id);
		}
	});
	return result;
}

/** A section to the right of everything, big enough for `count` items in two columns. */
function makeCarrySection(
	doc: Y.Doc,
	shapes: ReadonlyMap<string, ShapeProps>,
	count: number,
	title: string,
	sizeOf?: SizeOf,
): string {
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	for (const [id, shape] of shapes) {
		if (shape.type === "connector") continue;
		const box = boxOf(id, shape, sizeOf);
		right = Math.max(right, box.x + box.w);
		top = Math.min(top, box.y);
	}
	const columns = count > 3 ? 2 : 1;
	const rows = Math.ceil(count / columns);
	const gap = 24;
	const w = columns * (ACTION_SIZE.w + gap) + gap + 24;
	const h = rows * (ACTION_SIZE.h + 12) + gap * 2 + 24;
	const x = Number.isFinite(right) ? right + 120 : 0;
	const y = Number.isFinite(top) ? top : 0;
	return addSection(doc, { x, y, w, h }, { title: `Carried over from ${title}`.slice(0, 120) });
}
