import { type ImageService, pretendToSend } from "../images/service.ts";
import { TRY_SCENARIOS } from "./scenarios.ts";
import { restore } from "./persist.ts";

// The demo's image files (#75): kept in this browser's IndexedDB, so a
// board kept in localStorage still has its pictures after a refresh, and
// nothing ever leaves the browser. Files are shared by the demo's boards
// (copying between them needs nothing), and Reset lets go of the ones no
// board or its history mentions any more. Without IndexedDB (private
// windows, previews) they're kept for the page's life, as the playground's are.

const DATABASE = "tack-try-images";
const STORE = "files";

function open(): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(DATABASE, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

function run<T>(
	db: IDBDatabase,
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
	return new Promise((resolve) => {
		try {
			const request = fn(db.transaction(STORE, mode).objectStore(STORE));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export function tryImages(): ImageService & { sweep(): Promise<number> } {
	const database = open();
	const urls = new Map<string, string>();
	const blobs = new Map<string, Blob>();
	/** Files looked for and not found, so `src` says missing rather than loading. */
	const absent = new Set<string>();
	const looking = new Set<string>();
	const listeners = new Set<() => void>();
	const changed = () => {
		for (const listener of listeners) listener();
	};
	const keep = (hash: string, blob: Blob) => {
		blobs.set(hash, blob);
		if (!urls.has(hash)) urls.set(hash, URL.createObjectURL(blob));
		absent.delete(hash);
		changed();
	};
	const find = async (hash: string): Promise<Blob | null> => {
		const known = blobs.get(hash);
		if (known) return known;
		const db = await database;
		const blob = db
			? await run<Blob | undefined>(db, "readonly", (store) => store.get(hash))
			: null;
		if (blob instanceof Blob) keep(hash, blob);
		return blob instanceof Blob ? blob : null;
	};
	return {
		src(hash) {
			const url = urls.get(hash);
			if (url) return url;
			if (absent.has(hash)) return null;
			if (!looking.has(hash)) {
				looking.add(hash);
				void find(hash).then((blob) => {
					looking.delete(hash);
					if (!blob) {
						absent.add(hash);
						changed();
					}
				});
			}
			return undefined;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async upload(image, onProgress, signal) {
			if (!(await find(image.hash))) {
				// A moment's pretend upload, so it's seen arriving.
				await pretendToSend(700, onProgress, signal);
				const db = await database;
				if (db) await run(db, "readwrite", (store) => store.put(image.blob, image.hash));
				keep(image.hash, image.blob);
			}
			onProgress?.(1);
		},
		async adopt(_from, hashes) {
			const missing: string[] = [];
			for (const hash of hashes) if (!(await find(hash))) missing.push(hash);
			return missing;
		},
		blob: find,
		async sweep() {
			const db = await database;
			if (!db) return 0;
			const wanted = mentioned();
			const keys = (await run<IDBValidKey[]>(db, "readonly", (store) => store.getAllKeys())) ?? [];
			let removed = 0;
			for (const key of keys) {
				if (typeof key !== "string" || wanted.has(key) || blobs.has(key)) continue;
				await run(db, "readwrite", (store) => store.delete(key));
				removed++;
			}
			return removed;
		},
	};
}

/** Every file hash a kept board's document or history mentions. */
function mentioned(): Set<string> {
	const hashes = new Set<string>();
	const decoder = new TextDecoder("latin1");
	const scan = (bytes: Uint8Array | null | undefined) => {
		if (!bytes) return;
		for (const match of decoder.decode(bytes).matchAll(/[0-9a-f]{64}/g)) hashes.add(match[0]);
	};
	for (const scenario of Object.keys(TRY_SCENARIOS)) {
		const kept = restore(scenario);
		if (!kept) continue;
		scan(kept.update);
		const history = kept.history;
		if (!history) continue;
		for (const step of history.steps()) scan(history.update(step.id));
		for (const frame of history.keyframes()) scan(history.keyframe(frame.step));
	}
	return hashes;
}

let shared: ReturnType<typeof tryImages> | null = null;

/** The page's one store of the demo's files. */
export function demoImages(): ReturnType<typeof tryImages> {
	shared ??= tryImages();
	return shared;
}
