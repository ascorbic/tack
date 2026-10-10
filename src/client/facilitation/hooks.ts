import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type DotVote, dotVotesMap, readVotes } from "../../shared/dotvotes.ts";
import {
	type StampCount,
	type Stamper,
	type Timer,
	facilitationMap,
	readTimer,
	stampCounts,
	stampsMap,
} from "../../shared/facilitation.ts";
import { facilitation } from "./store.ts";

/** A value read from the document, re-read whenever `observe` says it changed. */
function useDocValue<T>(
	doc: Y.Doc,
	read: () => T,
	observe: (callback: () => void) => () => void,
): T {
	const store = useMemo(() => {
		let value = read();
		return {
			get: () => value,
			subscribe: (listener: () => void) => {
				value = read();
				return observe(() => {
					value = read();
					listener();
				});
			},
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [doc]);
	return useSyncExternalStore(store.subscribe, store.get);
}

export function useTimer(doc: Y.Doc): Timer | null {
	return useDocValue(
		doc,
		() => readTimer(doc),
		(callback) => {
			const map = facilitationMap(doc);
			map.observe(callback);
			return () => map.unobserve(callback);
		},
	);
}

export function useVotes(doc: Y.Doc): DotVote[] {
	return useDocValue(
		doc,
		() => readVotes(doc),
		(callback) => {
			const map = dotVotesMap(doc);
			map.observeDeep(callback);
			return () => map.unobserveDeep(callback);
		},
	);
}

/** Stamps by shape, counted, with which are yours. */
export function useStampCounts(doc: Y.Doc, me: Stamper | null): Map<string, StampCount[]> {
	const name = me?.name;
	const color = me?.color ?? "";
	const login = me?.login;
	const raw = useDocValue(
		doc,
		() => [...stampsMap(doc).entries()] as [string, unknown][],
		(callback) => {
			const map = stampsMap(doc);
			map.observe(callback);
			return () => map.unobserve(callback);
		},
	);
	return useMemo(
		() => stampCounts(raw, name === undefined ? null : { name, color, login }),
		[raw, name, color, login],
	);
}

/** The server's clock, ticking every `ms` while something shows it. */
export function useServerNow(ms = 1000, active = true): number {
	const [now, setNow] = useState(() => facilitation.serverNow());
	useEffect(() => {
		if (!active) return;
		setNow(facilitation.serverNow());
		const timer = setInterval(() => setNow(facilitation.serverNow()), ms);
		return () => clearInterval(timer);
	}, [ms, active]);
	return now;
}
