import { useEffect, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { shapesMap } from "../../shared/shapes.ts";
import type { WidgetMessage } from "../../shared/widgets.ts";

// Live widget data (#37), fed by the board's `widget-data` messages: kept
// outside the document and React Flow's node data, like card data, so a
// list refreshing re-renders that list and nothing else.
//
// A widget asks for its data while it's mounted (React Flow only renders
// what's in view), and keeps watching for a little while after it leaves
// the view, so panning back and forth doesn't churn the server.

/** How long a widget that left the view keeps watching. */
const LINGER_MS = 10_000;

export interface WidgetData {
	results: WidgetMessage["results"];
	/** When the server fetched them, ms since the epoch. */
	at: number;
}

/** How a board asks its server (or the playground's stand-in) for widget data. */
export interface WidgetTransport {
	watch(ids: string[]): void;
	unwatch(ids: string[]): void;
	refresh(id: string): void;
}

class WidgetStore {
	private data = new Map<string, WidgetData>();
	private listeners = new Map<string, Set<() => void>>();
	/** How many mounted views want each widget's data. */
	private wanted = new Map<string, number>();
	private lingering = new Map<string, ReturnType<typeof setTimeout>>();
	/** Widgets asked to refresh, until their next results arrive. */
	private refreshing = new Set<string>();
	private transport: WidgetTransport | null = null;

	/** Connect to a board (or the playground). Everything wanted is watched again. */
	connect(transport: WidgetTransport | null): void {
		this.transport = transport;
		this.rewatch();
	}

	/** Watch everything wanted again, e.g. after the connection came back. */
	rewatch(): void {
		const ids = [...this.wanted.keys()];
		if (ids.length > 0) this.transport?.watch(ids);
	}

	apply(message: WidgetMessage): void {
		this.data.set(message.id, { results: message.results, at: Date.parse(message.at) });
		this.refreshing.delete(message.id);
		this.emit(message.id);
	}

	/** Put data in directly (the gallery and tests). */
	set(id: string, data: WidgetData | undefined): void {
		if (data) this.data.set(id, data);
		else this.data.delete(id);
		this.emit(id);
	}

	get(id: string): WidgetData | undefined {
		return this.data.get(id);
	}

	isRefreshing(id: string): boolean {
		return this.refreshing.has(id);
	}

	refresh(id: string): void {
		this.refreshing.add(id);
		this.emit(id);
		this.transport?.refresh(id);
		// Nothing new may come back (the results didn't change): stop spinning anyway.
		setTimeout(() => {
			if (this.refreshing.delete(id)) this.emit(id);
		}, 4000);
	}

	/** Want a widget's data while the returned function hasn't been called. */
	want(id: string): () => void {
		const timer = this.lingering.get(id);
		if (timer) {
			clearTimeout(timer);
			this.lingering.delete(id);
		}
		const count = this.wanted.get(id) ?? 0;
		this.wanted.set(id, count + 1);
		if (count === 0 && !timer) this.transport?.watch([id]);
		return () => {
			const left = (this.wanted.get(id) ?? 1) - 1;
			if (left > 0) {
				this.wanted.set(id, left);
				return;
			}
			this.lingering.set(
				id,
				setTimeout(() => {
					this.lingering.delete(id);
					if (this.wanted.get(id)) return;
					this.wanted.delete(id);
					this.transport?.unwatch([id]);
				}, LINGER_MS),
			);
			this.wanted.set(id, 0);
		};
	}

	subscribe(id: string, listener: () => void): () => void {
		let set = this.listeners.get(id);
		if (!set) this.listeners.set(id, (set = new Set()));
		set.add(listener);
		return () => set.delete(listener);
	}

	private emit(id: string): void {
		for (const listener of this.listeners.get(id) ?? []) listener();
	}
}

export const widgetStore = new WidgetStore();

/** A widget's latest data, asking for it while mounted. */
export function useWidgetData(id: string, watch = true): WidgetData | undefined {
	useEffect(() => (watch ? widgetStore.want(id) : undefined), [id, watch]);
	return useSyncExternalStore(
		(listener) => widgetStore.subscribe(id, listener),
		() => widgetStore.get(id),
	);
}

export function useRefreshing(id: string): boolean {
	return useSyncExternalStore(
		(listener) => widgetStore.subscribe(id, listener),
		() => widgetStore.isRefreshing(id),
	);
}

// --- Linked highlighting (#38) -------------------------------------------------------

/**
 * The item someone's pointing at, in a list or on the board: rows and the
 * cards for the same item light up together.
 */
class LinkStore {
	private key: string | null = null;
	private source: "row" | "card" | null = null;
	private listeners = new Set<() => void>();

	set(key: string | null, source: "row" | "card"): void {
		if (key === null && this.source !== source) return;
		if (this.key === key && this.source === source) return;
		this.key = key;
		this.source = key === null ? null : source;
		for (const listener of this.listeners) listener();
	}

	get(): { key: string | null; source: "row" | "card" | null } {
		return { key: this.key, source: this.source };
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Whether an item is being pointed at from `from`. */
	is(key: string, from: "row" | "card"): boolean {
		return this.key === key && this.source === from;
	}
}

export const linkStore = new LinkStore();

/** Whether this item is being pointed at from elsewhere: a row (for cards), or a card (for rows). */
export function useLinked(key: string | undefined, from: "row" | "card"): boolean {
	return useSyncExternalStore(linkStore.subscribe, () => (key ? linkStore.is(key, from) : false));
}

// --- Cards on the board ------------------------------------------------------------------

/**
 * Which items have cards on the board, and which shapes they are, read
 * from the document once for every list on the board.
 */
class BoardCards {
	private cards = new Map<string, string[]>();
	private listeners = new Set<() => void>();
	private version = 0;

	constructor(private doc: Y.Doc) {
		const shapes = shapesMap(doc);
		this.read();
		shapes.observeDeep((events) => {
			const relevant = events.some(
				(event) =>
					event.target === shapes ||
					[...event.changes.keys.keys()].some((key) => key === "ref" || key === "type"),
			);
			if (!relevant) return;
			this.read();
			this.version++;
			for (const listener of this.listeners) listener();
		});
	}

	private read(): void {
		const cards = new Map<string, string[]>();
		for (const [id, shape] of shapesMap(this.doc)) {
			const ref = shape.get("ref");
			if (shape.get("type") !== "card" || typeof ref !== "string") continue;
			const list = cards.get(ref);
			if (list) list.push(id);
			else cards.set(ref, [id]);
		}
		this.cards = cards;
	}

	shapesFor(key: string): string[] {
		return this.cards.get(key) ?? [];
	}

	getVersion = () => this.version;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

const boards = new WeakMap<Y.Doc, BoardCards>();

export function boardCards(doc: Y.Doc): BoardCards {
	let cards = boards.get(doc);
	if (!cards) boards.set(doc, (cards = new BoardCards(doc)));
	return cards;
}

/** Re-renders when cards are added to or removed from the board. */
export function useBoardCards(doc: Y.Doc | null): BoardCards | null {
	const cards = doc ? boardCards(doc) : null;
	useSyncExternalStore(
		(listener) => cards?.subscribe(listener) ?? (() => {}),
		() => cards?.getVersion() ?? 0,
	);
	return cards;
}
