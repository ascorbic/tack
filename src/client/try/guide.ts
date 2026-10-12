import type * as Y from "yjs";
import { changesMap } from "../../shared/changes.ts";
import { dotVotesMap } from "../../shared/dotvotes.ts";
import { LOCAL_ORIGIN, shapesMap } from "../../shared/shapes.ts";

// The demo's guided first run (#75): five steps, each done by doing it on the
// board, not by pressing Next. Each step watches the document (or the page,
// for History) for what it asks for, and points at what to use. Watching the
// document rather than the UI keeps the guide working however the UI it
// points at changes.

export const STEPS = ["stack", "issues", "push", "vote", "history"] as const;
export type StepId = (typeof STEPS)[number];

/** What a step learned that a later one needs: the stack you made. */
export interface GuideMemo {
	stack?: string;
}

/** Called when a step's been done, with a word about how it went. */
export type Done = (note?: string) => void;

function stacks(doc: Y.Doc): Set<string> {
	const ids = new Set<string>();
	for (const [id, shape] of shapesMap(doc)) if (shape.get("type") === "stack") ids.add(id);
	return ids;
}

function suggestedName(doc: Y.Doc, id: string): string | null {
	const shape = shapesMap(doc).get(id);
	const title = shape?.get("title");
	if (typeof title === "string" && title.trim()) return title;
	const suggested = shape?.get("suggested") as { title?: string } | undefined;
	return suggested?.title ?? null;
}

/**
 * Step 1: a new stack, then its name ✨ (or, if naming's slow, carrying on
 * without it after a few seconds).
 */
export function watchStack(doc: Y.Doc, memo: GuideMemo, done: Done): () => void {
	const before = stacks(doc);
	const map = shapesMap(doc);
	let made: string | null = null;
	let timer = 0;
	const check = () => {
		if (!made) {
			made = [...stacks(doc)].find((id) => !before.has(id)) ?? null;
			if (!made) return;
			memo.stack = made;
			timer = window.setTimeout(() => finish(), 4000);
		}
		const name = suggestedName(doc, made);
		if (name) finish(name);
	};
	let finished = false;
	const finish = (name?: string) => {
		if (finished) return;
		finished = true;
		done(name ? `Named “${name}”` : undefined);
	};
	map.observeDeep(check);
	return () => {
		map.unobserveDeep(check);
		clearTimeout(timer);
	};
}

/** Step 2: a new issue staged (a stack makes a parent issue and one per sticky). */
export function watchStaged(doc: Y.Doc, done: Done): () => void {
	const map = changesMap(doc);
	const before = new Set(map.keys());
	const check = () => {
		const fresh = [...map].filter(
			([id, change]) => !before.has(id) && change.get("op") && kindOf(change) === "issue.create",
		);
		if (fresh.length > 0) done(`${fresh.length} ${fresh.length === 1 ? "issue" : "issues"} staged`);
	};
	map.observeDeep(check);
	return () => map.unobserveDeep(check);
}

function kindOf(change: Y.Map<unknown>): string | undefined {
	return (change.get("op") as { kind?: string } | undefined)?.kind;
}

/** The push sheet, while it's open: a modal, which the guide can't show over. */
const pushSheetOpen = () => document.querySelector("dialog.push-dialog[open]") !== null;

/**
 * Step 3: something pushed has landed (the pretend forge confirmed it), and
 * the push sheet's been closed, so the step's cheer is seen.
 */
export function watchLanded(doc: Y.Doc, done: Done): () => void {
	const map = changesMap(doc);
	const landed = () =>
		new Set([...map].filter(([, change]) => change.get("status") === "applied").map(([id]) => id));
	const before = landed();
	let timer = 0;
	const finish = () => {
		if (pushSheetOpen()) {
			timer = window.setTimeout(finish, 250);
			return;
		}
		const all = [...landed()].filter((id) => !before.has(id)).length;
		done(`${all} ${all === 1 ? "change" : "changes"} landed`);
	};
	const check = () => {
		const now = [...landed()].filter((id) => !before.has(id));
		if (now.length === 0) return;
		// Let the rest of the push land before moving on.
		clearTimeout(timer);
		timer = window.setTimeout(finish, 1200);
	};
	map.observeDeep(check);
	return () => {
		map.unobserveDeep(check);
		clearTimeout(timer);
	};
}

/** Step 4: a dot of yours placed. */
export function watchDots(doc: Y.Doc, done: Done): () => void {
	const map = dotVotesMap(doc);
	const check = (_events: unknown, transaction: Y.Transaction) => {
		if (transaction.origin === LOCAL_ORIGIN) done();
	};
	map.observeDeep(check);
	return () => map.unobserveDeep(check);
}

/** Step 5: History open (the canvas says so while it is). */
export function watchHistory(done: Done): () => void {
	const open = () => document.querySelector("#board[data-history]") !== null;
	if (open()) {
		done();
		return () => {};
	}
	const observer = new MutationObserver(() => {
		if (open()) done();
	});
	const board = document.getElementById("board");
	if (board) observer.observe(board, { attributes: true, attributeFilter: ["data-history"] });
	return () => observer.disconnect();
}

/** A sticky on the board by what it says. */
export function stickyNode(text: string): HTMLElement | null {
	for (const node of document.querySelectorAll<HTMLElement>(".react-flow__node-sticky")) {
		if (node.textContent?.includes(text)) return node;
	}
	return null;
}

/** A shape on the board by id. */
export function shapeNode(id: string | undefined): HTMLElement | null {
	if (!id) return null;
	return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
}
