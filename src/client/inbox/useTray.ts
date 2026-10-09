import { useEffect, useMemo, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { dismissedKeys, inboxTray } from "../../shared/inbox.ts";
import { cardRefs, type ShapeProps, shapesMap } from "../../shared/shapes.ts";
import type { QueryError } from "../../shared/widgets.ts";
import { type InboxEntry, inboxStore, useInbox } from "./store.ts";

// What an inbox section shows: its tray of new matches, worked out from the
// latest results (per viewer) and the document (what's on the board, and
// what was dismissed).

/**
 * Card keys on the board, re-read once per document change that adds,
 * removes or re-points a card, shared by every inbox on the board.
 */
const refsStores = new WeakMap<
	Y.Doc,
	{ get(): Set<string>; subscribe(l: () => void): () => void }
>();

function refsStore(doc: Y.Doc) {
	let store = refsStores.get(doc);
	if (store) return store;
	let refs = cardRefs(doc);
	const listeners = new Set<() => void>();
	const shapes = shapesMap(doc);
	shapes.observeDeep((events) => {
		const relevant = events.some(
			(event) => event.target === shapes || event.changes.keys.has("ref"),
		);
		if (!relevant) return;
		const next = cardRefs(doc);
		if (next.size === refs.size && [...next].every((key) => refs.has(key))) return;
		refs = next;
		for (const listener of listeners) listener();
	});
	store = {
		get: () => refs,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	refsStores.set(doc, store);
	return store;
}

export function useBoardRefs(doc: Y.Doc | null): Set<string> {
	const store = useMemo(() => (doc ? refsStore(doc) : null), [doc]);
	return useSyncExternalStore(
		(listener) => store?.subscribe(listener) ?? (() => {}),
		() => store?.get() ?? EMPTY,
	);
}

const EMPTY = new Set<string>();

export interface Tray {
	entry: InboxEntry | undefined;
	/** New matches, waiting to be sorted. */
	items: Card[];
	/** Every match, for counts. */
	total: number;
	error: QueryError | null;
	dismissed: Set<string>;
	loading: boolean;
}

/** An inbox section's tray, watching its results while mounted. */
export function useTray(doc: Y.Doc | null, id: string, shape: ShapeProps): Tray {
	const isInbox = Boolean(shape.inbox);
	useEffect(() => (isInbox ? inboxStore.watch(id) : undefined), [id, isInbox]);
	const entry = useInbox(id);
	const refs = useBoardRefs(doc);
	// Keyed on the keys, so a re-read shape with the same dismissals doesn't recompute.
	const dismissedJson = JSON.stringify([...dismissedKeys(shape)].sort());
	const dismissed = useMemo(() => new Set<string>(JSON.parse(dismissedJson)), [dismissedJson]);
	return useMemo(() => {
		const result = entry?.result;
		if (!isInbox || !result) {
			return { entry, items: [], total: 0, error: null, dismissed, loading: isInbox };
		}
		if (result.kind === "error") {
			return { entry, items: [], total: 0, error: result, dismissed, loading: false };
		}
		return {
			entry,
			items: inboxTray(result, refs, dismissed),
			total: result.total,
			error: null,
			dismissed,
			loading: false,
		};
	}, [entry, refs, dismissed, isInbox]);
}

// Per-viewer UI state for inboxes: whether a tray is folded away, and which
// one is being set up. Not in the document: it's yours alone.

type InboxUI = { collapsed: Set<string>; editing: string | null };

let ui: InboxUI = { collapsed: new Set(), editing: null };
const uiListeners = new Set<() => void>();

function setUI(next: InboxUI) {
	ui = next;
	for (const listener of uiListeners) listener();
}

export const inboxUI = {
	toggle(id: string): void {
		const collapsed = new Set(ui.collapsed);
		if (collapsed.has(id)) collapsed.delete(id);
		else collapsed.add(id);
		setUI({ ...ui, collapsed });
	},
	expand(id: string): void {
		if (!ui.collapsed.has(id)) return;
		const collapsed = new Set(ui.collapsed);
		collapsed.delete(id);
		setUI({ ...ui, collapsed });
	},
	edit(id: string | null): void {
		if (id) inboxUI.expand(id);
		setUI({ ...ui, editing: id });
	},
	get: getUI,
	subscribe: subscribeUI,
};

function getUI(): InboxUI {
	return ui;
}

function subscribeUI(listener: () => void): () => void {
	uiListeners.add(listener);
	return () => uiListeners.delete(listener);
}

export function useInboxUI(): InboxUI {
	return useSyncExternalStore(subscribeUI, getUI);
}
