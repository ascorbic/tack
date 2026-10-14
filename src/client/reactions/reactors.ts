import { useContext, useEffect, useState } from "react";
import type { ReactionGroup } from "../../shared/reactions.ts";
import { ServicesContext, type WriteServices } from "../actions/services.ts";

// Who reacted to a card's item on its forge: asked only when someone hovers
// or focuses its reaction count, never with the card's own data, and kept a
// while per item so moving the pointer back and forth asks once. A new
// reaction changes the card's count (a webhook, or the next check), and a
// different count asks again.

/** How long an answer is good for while the count stays the same. */
const FRESH_MS = 5 * 60_000;
/** How long before asking again after the forge couldn't say. */
const RETRY_MS = 30_000;

interface Entry {
	count: number;
	at: number;
	/** Resolves to the groups, or null when they can't be had (no token, another forge, an error). */
	pending: Promise<ReactionGroup[] | null>;
	settled?: ReactionGroup[] | null;
}

const caches = new WeakMap<WriteServices, Map<string, Entry>>();

function cached(services: WriteServices, key: string, count: number): Entry | undefined {
	const entry = caches.get(services)?.get(key);
	if (!entry || entry.count !== count) return undefined;
	const age = Date.now() - entry.at;
	if (entry.settled === null && age > RETRY_MS) return undefined;
	return age > FRESH_MS ? undefined : entry;
}

/** Who reacted to `key` (whose card counts `count`), from the cache or the services. */
export function loadReactors(
	services: WriteServices,
	key: string,
	count: number,
): Promise<ReactionGroup[] | null> {
	const hit = cached(services, key, count);
	if (hit) return hit.pending;
	let cache = caches.get(services);
	if (!cache) caches.set(services, (cache = new Map()));
	const entry: Entry = {
		count,
		at: Date.now(),
		pending: (services.reactors?.(key) ?? Promise.resolve(null)).then(
			(result) => (result?.kind === "reactors" ? result.groups : null),
			() => null,
		),
	};
	void entry.pending.then((groups) => {
		entry.settled = groups;
	});
	cache.set(key, entry);
	return entry.pending;
}

export type ReactorsState =
	| { status: "idle" | "loading" | "unavailable" }
	| { status: "ready"; groups: ReactionGroup[] };

/**
 * Who reacted to a card's item, once `active` (its count is hovered or
 * focused). Without a way to ask (a gallery, an embed), or when the forge
 * can't say, it's "unavailable", and the count speaks for itself.
 */
export function useReactors(key: string, count: number, active: boolean): ReactorsState {
	const services = useContext(ServicesContext);
	const [state, setState] = useState<ReactorsState>(() => initial(services, key, count));
	useEffect(() => {
		// Not looked at: only what's known for this count, so a stale list
		// never names the wrong people in the count's accessible name.
		if (!active) return setState(initial(services, key, count));
		if (!services?.reactors || count <= 0) {
			setState({ status: "unavailable" });
			return;
		}
		const hit = cached(services, key, count);
		if (hit?.settled !== undefined) {
			setState(hit.settled ? { status: "ready", groups: hit.settled } : { status: "unavailable" });
			return;
		}
		let live = true;
		setState({ status: "loading" });
		void loadReactors(services, key, count).then((groups) => {
			if (live) setState(groups ? { status: "ready", groups } : { status: "unavailable" });
		});
		return () => {
			live = false;
		};
	}, [services, key, count, active]);
	return state;
}

function initial(services: WriteServices | null, key: string, count: number): ReactorsState {
	const hit = services ? cached(services, key, count) : undefined;
	if (hit?.settled) return { status: "ready", groups: hit.settled };
	return { status: "idle" };
}
