import * as Y from "yjs";

// Edits that may not have reached the board's server yet, kept on this
// device so closing or reloading a tab can't lose them (canvas review 37).
//
// Every local edit is kept until the server has surely had it: until the
// connection has been synced for a while since it was made (the server
// saves a couple of seconds after an edit, so a little longer than that).
// Edits made while disconnected are "waiting", which the status pill
// counts and which make leaving the page ask first. Opening the board
// again puts whatever's kept back into the document: Yjs updates merge, so
// applying ones the server already has changes nothing.

/** How long an edit is kept after the server's had it, to outlast its save. */
export const KEEP_MS = 10_000;
/** Edits closer together than this count as one, for "3 edits waiting". */
const BURST_MS = 1500;
/** How often what's kept is written down while edits keep coming. */
const SAVE_MS = 400;

const PREFIX = "tack:pending:";

/** Somewhere to keep things, as `localStorage` is. */
export interface KeptStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	key(index: number): string | null;
	readonly length: number;
}

interface Kept {
	/** The edits, as one Yjs update, base64. */
	update: string;
	/** How many of them hadn't reached the server. */
	waiting: number;
}

interface Entry {
	at: number;
	update: Uint8Array;
	/** Made while disconnected, and not yet synced since. */
	waiting: boolean;
}

/** Where edits that came back from storage are applied from, so they count as this tab's own. */
export const RESTORED = Symbol("restored edits");

export class PendingEdits {
	private entries: Entry[] = [];
	private synced = false;
	/** Bursts of waiting edits. */
	private bursts = 0;
	private lastWaiting = -Infinity;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private pruneTimer: ReturnType<typeof setTimeout> | undefined;
	private listeners = new Set<() => void>();
	private readonly key: string;

	constructor(
		private readonly doc: Y.Doc,
		board: string,
		/** Updates from here are the server's, not edits. */
		private readonly remote: unknown,
		private readonly store: KeptStore | null = defaultStore(),
		private readonly now: () => number = Date.now,
		tab: string = tabId(),
		/**
		 * Sends an update to the server. Edits brought back from storage can
		 * depend on the server's state, so they only take their place in the
		 * document once that arrives, and arrive as the server's: they're
		 * sent again then, as are any edits made while disconnected.
		 */
		private readonly send: (update: Uint8Array) => void = () => {},
	) {
		this.key = `${PREFIX}${board}:${tab}`;
		this.restore(board);
		doc.on("update", this.onUpdate);
	}

	/** How many edits are waiting for the connection (bursts of typing count once). */
	get waiting(): number {
		return this.bursts;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** The connection's state: synced with the server or not. */
	setSynced(synced: boolean): void {
		if (synced === this.synced) return;
		this.synced = synced;
		if (synced) {
			// Everything's been exchanged: the server has it all now, and only
			// needs a moment to save it.
			const at = this.now();
			const waiting = this.entries.filter((entry) => entry.waiting);
			if (waiting.length > 0) {
				try {
					this.send(Y.mergeUpdates(waiting.map((entry) => entry.update)));
				} catch {
					// Sync has already sent what the document has.
				}
			}
			for (const entry of this.entries) {
				if (entry.waiting) {
					entry.waiting = false;
					entry.at = at;
				}
			}
			this.bursts = 0;
			this.lastWaiting = -Infinity;
			this.schedulePrune();
			this.save();
			this.emit();
		}
	}

	/** Write down what's kept now, as the page goes away. */
	flush(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		this.save();
	}

	destroy(): void {
		this.doc.off("update", this.onUpdate);
		this.flush();
		clearTimeout(this.pruneTimer);
		this.listeners.clear();
	}

	/** Drop edits the server has had for long enough. */
	prune(): void {
		if (!this.synced) return;
		const cutoff = this.now() - KEEP_MS;
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => entry.waiting || entry.at > cutoff);
		if (this.entries.length !== before) this.save();
		if (this.entries.length > 0) this.schedulePrune();
	}

	private onUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === this.remote) return;
		const at = this.now();
		const waiting = !this.synced || origin === RESTORED;
		this.entries.push({ at, update, waiting });
		if (waiting) {
			if (at - this.lastWaiting > BURST_MS) this.bursts++;
			this.lastWaiting = at;
			this.emit();
		} else {
			this.schedulePrune();
		}
		this.scheduleSave();
	};

	private restore(board: string): void {
		if (!this.store) return;
		const updates: Uint8Array[] = [];
		let waiting = 0;
		try {
			// Every tab's, this one's from before a reload included.
			const keys: string[] = [];
			for (let i = 0; i < this.store.length; i++) {
				const key = this.store.key(i);
				if (key?.startsWith(`${PREFIX}${board}:`)) keys.push(key);
			}
			for (const key of keys) {
				const kept = JSON.parse(this.store.getItem(key) ?? "null") as Kept | null;
				if (kept?.update) {
					updates.push(fromBase64(kept.update));
					waiting += kept.waiting;
				}
				this.store.removeItem(key);
			}
		} catch {
			// Storage is off, or what's there isn't ours.
		}
		if (updates.length === 0) return;
		const update = Y.mergeUpdates(updates);
		this.entries.push({ at: this.now(), update, waiting: true });
		this.bursts = waiting;
		Y.applyUpdate(this.doc, update, RESTORED);
		this.save();
	}

	private scheduleSave(): void {
		if (this.saveTimer !== undefined) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.save();
		}, SAVE_MS);
	}

	private schedulePrune(): void {
		clearTimeout(this.pruneTimer);
		const oldest = this.entries.find((entry) => !entry.waiting);
		if (!oldest) return;
		this.pruneTimer = setTimeout(() => this.prune(), oldest.at + KEEP_MS - this.now() + 50);
	}

	private save(): void {
		if (!this.store) return;
		try {
			if (this.entries.length === 0) {
				this.store.removeItem(this.key);
				return;
			}
			// Merged as they're written, so a long time offline stays one update.
			const update = Y.mergeUpdates(this.entries.map((entry) => entry.update));
			const waiting = this.entries.some((entry) => entry.waiting);
			this.entries = this.entries.length > 1 ? this.collapse(update) : this.entries;
			this.store.setItem(
				this.key,
				JSON.stringify({
					update: toBase64(update),
					waiting: waiting ? this.bursts : 0,
				} satisfies Kept),
			);
		} catch {
			// Full or off: kept in memory only, then.
		}
	}

	/**
	 * Waiting edits merged into one entry, and the rest into another, so
	 * there's never more than two to merge on the next save.
	 */
	private collapse(all: Uint8Array): Entry[] {
		const waiting = this.entries.filter((entry) => entry.waiting);
		const sent = this.entries.filter((entry) => !entry.waiting);
		// Sent edits are kept as long as the newest of them needs to be.
		const newest = (entries: Entry[]) => Math.max(...entries.map((entry) => entry.at));
		if (waiting.length === 0 || sent.length === 0) {
			return [{ at: newest(this.entries), update: all, waiting: waiting.length > 0 }];
		}
		return [
			{
				at: newest(sent),
				update: Y.mergeUpdates(sent.map((entry) => entry.update)),
				waiting: false,
			},
			{
				at: newest(waiting),
				update: Y.mergeUpdates(waiting.map((entry) => entry.update)),
				waiting: true,
			},
		];
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function defaultStore(): KeptStore | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/** This tab, the same across reloads (sessionStorage outlives them). */
function tabId(): string {
	try {
		const existing = sessionStorage.getItem("tack:tab");
		if (existing) return existing;
		const id = Math.random().toString(36).slice(2, 10);
		sessionStorage.setItem("tack:tab", id);
		return id;
	} catch {
		return "tab";
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
