import { useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type Volunteer, readVolunteers, volunteersMap } from "../../shared/volunteers.ts";

// The board's volunteers (volunteers.ts), read once per change for every
// shape that shows them, rather than once per shape: a board can have
// hundreds of cards. Each shape's list keeps its identity until its own
// volunteers change, so a hand going up on one card re-renders that card.

const NONE: readonly Volunteer[] = [];

interface Store {
	subscribe: (listener: () => void) => () => void;
	all: () => ReadonlyMap<string, readonly Volunteer[]>;
	on: (shape: string) => readonly Volunteer[];
}

const stores = new WeakMap<Y.Doc, Store>();

function storeFor(doc: Y.Doc): Store {
	const existing = stores.get(doc);
	if (existing) return existing;
	const listeners = new Set<() => void>();
	let byShape: ReadonlyMap<string, readonly Volunteer[]> = new Map();
	let keys = new Map<string, string>();
	const read = () => {
		const next = readVolunteers(volunteersMap(doc).entries());
		const nextKeys = new Map<string, string>();
		const out = new Map<string, readonly Volunteer[]>();
		for (const [shape, list] of next) {
			const key = JSON.stringify(list);
			nextKeys.set(shape, key);
			const before = byShape.get(shape);
			out.set(shape, before && keys.get(shape) === key ? before : list);
		}
		byShape = out;
		keys = nextKeys;
	};
	read();
	const onChange = () => {
		read();
		for (const listener of listeners) listener();
	};
	const store: Store = {
		subscribe: (listener) => {
			if (listeners.size === 0) {
				read();
				volunteersMap(doc).observe(onChange);
			}
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) volunteersMap(doc).unobserve(onChange);
			};
		},
		all: () => byShape,
		on: (shape) => byShape.get(shape) ?? NONE,
	};
	stores.set(doc, store);
	return store;
}

const noop = () => () => {};

/** One shape's volunteers, in the order they put their hands up; none without a document. */
export function useVolunteersOn(doc: Y.Doc | null, shape: string): readonly Volunteer[] {
	const store = doc ? storeFor(doc) : null;
	return useSyncExternalStore(
		store ? store.subscribe : noop,
		() => (store ? store.on(shape) : NONE),
		() => NONE,
	);
}

/** Every shape's volunteers. */
export function useVolunteers(doc: Y.Doc | null): ReadonlyMap<string, readonly Volunteer[]> {
	const store = doc ? storeFor(doc) : null;
	return useSyncExternalStore(
		store ? store.subscribe : noop,
		() => (store ? store.all() : EMPTY),
		() => EMPTY,
	);
}

const EMPTY: ReadonlyMap<string, readonly Volunteer[]> = new Map();
