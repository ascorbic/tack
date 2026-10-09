import { useCallback, useRef, useSyncExternalStore } from "react";
import type * as Y from "yjs";

/**
 * A small value derived from the document, re-read after each transaction
 * and kept by identity until its JSON changes, so components re-render only
 * when what they show changed. For values that are cheap to read: decisions
 * read a handful of shapes and one change this way.
 */
export function useDocValue<T>(doc: Y.Doc | null, read: (doc: Y.Doc) => T, key: string): T | null {
	const cache = useRef<{ key: string; json: string; value: T | null } | null>(null);
	const readRef = useRef(read);
	readRef.current = read;

	const snapshot = useCallback((): T | null => {
		const value = doc ? readRef.current(doc) : null;
		const json = JSON.stringify(value) ?? "null";
		const cached = cache.current;
		if (cached && cached.key === key && cached.json === json) return cached.value;
		cache.current = { key, json, value };
		return value;
	}, [doc, key]);

	const subscribe = useCallback(
		(listener: () => void) => {
			if (!doc) return () => {};
			doc.on("afterTransaction", listener);
			return () => doc.off("afterTransaction", listener);
		},
		[doc],
	);

	return useSyncExternalStore(subscribe, snapshot);
}
