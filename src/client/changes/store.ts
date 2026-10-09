import { useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type PendingChange, changesMap, readChange } from "../../shared/changes.ts";

const EMPTY: readonly PendingChange[] = Object.freeze([]);

/**
 * The board's pending changes, read from the document's `changes` map and
 * kept as stable snapshots: a change's object only changes when it does,
 * and each shape's list only changes when one of its changes does, so the
 * marks on 500 cards don't all re-render when one change is staged.
 *
 * Also holds which shapes to highlight (hovering a change in the panel),
 * which is local UI, never in the document.
 */
export class ChangesStore {
	private changes = new Map<string, PendingChange>();
	private snapshot: readonly PendingChange[] = EMPTY;
	private byShape = new Map<string, readonly PendingChange[]>();
	private listeners = new Set<() => void>();
	private highlighted: ReadonlySet<string> = new Set();
	private highlightListeners = new Set<() => void>();
	private readonly map: Y.Map<Y.Map<unknown>>;

	constructor(doc: Y.Doc) {
		this.map = changesMap(doc);
		this.read();
		this.map.observeDeep(this.onChange);
	}

	destroy(): void {
		this.map.unobserveDeep(this.onChange);
		this.listeners.clear();
		this.highlightListeners.clear();
	}

	list = (): readonly PendingChange[] => this.snapshot;

	get(id: string): PendingChange | undefined {
		return this.changes.get(id);
	}

	forShape(id: string): readonly PendingChange[] {
		return this.byShape.get(id) ?? EMPTY;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Highlight these shapes on the board, e.g. while hovering their change. */
	highlight(ids: Iterable<string>): void {
		const next = new Set(ids);
		if (next.size === 0 && this.highlighted.size === 0) return;
		this.highlighted = next;
		for (const listener of this.highlightListeners) listener();
	}

	isHighlighted(id: string): boolean {
		return this.highlighted.has(id);
	}

	subscribeHighlight = (listener: () => void): (() => void) => {
		this.highlightListeners.add(listener);
		return () => this.highlightListeners.delete(listener);
	};

	private onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		const touched = new Set<string>();
		for (const event of events) {
			if (event.target === this.map) for (const key of event.keys.keys()) touched.add(key);
			else if (typeof event.path[0] === "string") touched.add(event.path[0]);
		}
		this.read(touched);
		for (const listener of this.listeners) listener();
	};

	/** Re-read the changes that were touched (or all of them), keeping the rest. */
	private read(touched?: Set<string>): void {
		const next = new Map<string, PendingChange>();
		for (const [id, change] of this.map) {
			const previous = this.changes.get(id);
			next.set(id, previous && touched && !touched.has(id) ? previous : readChange(change));
		}
		this.changes = next;
		this.snapshot = [...next.values()].sort((a, b) =>
			a.stagedAt < b.stagedAt ? -1 : a.stagedAt > b.stagedAt ? 1 : a.id < b.id ? -1 : 1,
		);

		const grouped = new Map<string, PendingChange[]>();
		for (const change of this.snapshot) {
			for (const shape of change.shapes ?? []) {
				let group = grouped.get(shape);
				if (!group) grouped.set(shape, (group = []));
				group.push(change);
			}
		}
		const byShape = new Map<string, readonly PendingChange[]>();
		for (const [shape, group] of grouped) {
			const previous = this.byShape.get(shape);
			const same =
				previous?.length === group.length && previous.every((change, i) => change === group[i]);
			byShape.set(shape, same && previous ? previous : group);
		}
		this.byShape = byShape;
	}
}

export function useChangeList(store: ChangesStore | null): readonly PendingChange[] {
	return useSyncExternalStore(store?.subscribe ?? noop, store?.list ?? empty);
}

export function useShapeChanges(
	store: ChangesStore | null,
	shape: string,
): readonly PendingChange[] {
	return useSyncExternalStore(store?.subscribe ?? noop, () => store?.forShape(shape) ?? EMPTY);
}

export function useHighlighted(store: ChangesStore | null, shape: string): boolean {
	return useSyncExternalStore(
		store?.subscribeHighlight ?? noop,
		() => store?.isHighlighted(shape) ?? false,
	);
}

const noop = () => () => {};
const empty = () => EMPTY;
