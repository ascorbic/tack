import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import {
	type DotVote,
	cursorsHidden,
	dotVotesMap,
	nextVoteEnd,
	readVotes,
} from "../../shared/dotvotes.ts";
import {
	type StampCount,
	type Stamper,
	type Timer,
	facilitationMap,
	readTimer,
	stampCounts,
	stampsMap,
} from "../../shared/facilitation.ts";
import { facilitation, useClockOffset } from "./store.ts";

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

/** setTimeout's longest wait; a vote ending later is woken for in steps. */
const LONGEST_WAIT = 2 ** 31 - 1;

/**
 * The server's clock for anything reading whether votes are open: it ticks
 * every `ms`, and also wakes the moment the next of `votes` ends by itself,
 * or the moment our idea of the server's clock moves, so the bar, the
 * results and the ranks all see a vote close together.
 */
export function useVoteNow(votes: readonly DotVote[], ms: number): number {
	const [now, setNow] = useState(() => facilitation.serverNow());
	const offset = useClockOffset();
	const active = votes.length > 0;
	useEffect(() => {
		if (!active) return;
		setNow(facilitation.serverNow());
		const timer = setInterval(() => setNow(facilitation.serverNow()), ms);
		return () => clearInterval(timer);
	}, [ms, active, offset]);
	const end = nextVoteEnd(votes, now);
	// Waking a little early (the wait was too long for one timer) just waits
	// again for what's left.
	useEffect(() => {
		if (end === null) return;
		const wait = Math.min(LONGEST_WAIT, Math.max(0, end - facilitation.serverNow()) + 1);
		const timer = setTimeout(() => setNow(facilitation.serverNow()), wait);
		return () => clearTimeout(timer);
	}, [end, now]);
	return now;
}

/**
 * Whether a vote with hidden results is on in the room, so nobody's cursor
 * is sent or shown (`cursorsHidden`). On the votes' clock, it changes the
 * moment a timed vote ends; a minute's tick is plenty for a live vote
 * reaching a working day.
 */
export function useCursorsHidden(doc: Y.Doc): boolean {
	const votes = useVotes(doc);
	const now = useVoteNow(votes, 60_000);
	return cursorsHidden(votes, now);
}
