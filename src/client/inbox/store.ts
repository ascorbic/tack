import { useSyncExternalStore } from "react";
import { INBOX_QUERY, type InboxPreviewRequest, previewId } from "../../shared/inbox.ts";
import type {
	QueryError,
	SearchQuery,
	SearchResult,
	WidgetMessage,
	WidgetRequest,
} from "../../shared/widgets.ts";

// Inbox results, fed by the board's `widget-data` messages (one per inbox
// section, searched as you), kept outside the document like card data: two
// people can see different matches in the same inbox.
//
// Inboxes in view are watched (reference counted, so a section and its tray
// can both ask); the server sends their results, and again whenever they
// change. The live board wires `channel` to its connection; the playground
// swaps in a simulated one.

export type InboxOutcome = SearchResult | QueryError;

export interface InboxEntry {
	result: InboxOutcome;
	/** When the server searched, ISO 8601. */
	at: string;
	/** When this browser received it (performance.now), to animate arrivals. */
	received: number;
}

export interface InboxChannel {
	send(request: WidgetRequest | InboxPreviewRequest): void;
}

class InboxStore {
	private entries = new Map<string, InboxEntry>();
	private listeners = new Map<string, Set<() => void>>();
	private watched = new Map<string, number>();
	private refreshing = new Set<string>();
	/** Listeners to every inbox's results, for what overlapping inboxes share. */
	private everyListeners = new Set<() => void>();

	channel: InboxChannel = { send: () => {} };

	apply(message: WidgetMessage): void {
		const result = message.results[INBOX_QUERY];
		if (!result || (result.kind !== "search" && result.kind !== "error")) return;
		this.refreshing.delete(message.id);
		this.entries.set(message.id, { result, at: message.at, received: performance.now() });
		this.emit(message.id);
	}

	get(id: string): InboxEntry | undefined {
		return this.entries.get(id);
	}

	isRefreshing(id: string): boolean {
		return this.refreshing.has(id);
	}

	subscribe(id: string, listener: () => void): () => void {
		let set = this.listeners.get(id);
		if (!set) this.listeners.set(id, (set = new Set()));
		set.add(listener);
		return () => set.delete(listener);
	}

	/** Watch an inbox while something shows it. Returns the stop function. */
	watch(id: string): () => void {
		const count = this.watched.get(id) ?? 0;
		this.watched.set(id, count + 1);
		if (count === 0) this.channel.send({ type: "widget-watch", ids: [id] });
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			const left = (this.watched.get(id) ?? 1) - 1;
			if (left > 0) {
				this.watched.set(id, left);
				return;
			}
			this.watched.delete(id);
			this.channel.send({ type: "widget-unwatch", ids: [id] });
		};
	}

	/** Ask again for every watched inbox, e.g. after reconnecting, or when the query changed. */
	rewatch(ids: string[] = [...this.watched.keys()]): void {
		const watched = ids.filter((id) => this.watched.has(id));
		if (watched.length > 0) this.channel.send({ type: "widget-watch", ids: watched });
	}

	refresh(id: string): void {
		this.refreshing.add(id);
		this.emit(id);
		this.channel.send({ type: "widget-refresh", id });
		// The server throttles refreshes: stop spinning even if nothing comes back.
		setTimeout(() => {
			if (this.refreshing.delete(id)) this.emit(id);
		}, 4000);
	}

	preview(id: string, query: SearchQuery): void {
		this.channel.send({ type: "inbox-preview", id, query });
	}

	/** Forget everything, for a new board (the playground switching scenario). */
	reset(): void {
		const ids = [...this.entries.keys()];
		this.entries.clear();
		this.refreshing.clear();
		for (const id of ids) this.emit(id);
	}

	/** Hear about any inbox's results. Returns the way to stop. */
	subscribeEvery(listener: () => void): () => void {
		this.everyListeners.add(listener);
		return () => this.everyListeners.delete(listener);
	}

	private emit(id: string): void {
		for (const listener of this.listeners.get(id) ?? []) listener();
		for (const listener of this.everyListeners) listener();
	}
}

export const inboxStore = new InboxStore();

export function useInbox(id: string): InboxEntry | undefined {
	return useSyncExternalStore(
		(listener) => inboxStore.subscribe(id, listener),
		() => inboxStore.get(id),
	);
}

export function usePreview(id: string): InboxEntry | undefined {
	return useInbox(previewId(id));
}

export function useRefreshing(id: string): boolean {
	return useSyncExternalStore(
		(listener) => inboxStore.subscribe(id, listener),
		() => inboxStore.isRefreshing(id),
	);
}
