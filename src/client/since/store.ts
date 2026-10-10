import { clock } from "../clock.ts";
import { useSyncExternalStore } from "react";
import {
	type Digest,
	type SinceEvent,
	type SinceRequest,
	VISIT_GAP_MS,
} from "../../shared/since.ts";

// Since you were here (#46): the digest the board's server sends when you
// arrive, which shapes on the canvas are highlighted, and which of those
// you've seen. Highlights fade once they've been on screen a moment, and
// stay faded (remembered per visit in this browser). "Mark all as seen"
// tells the server, so the next digest starts from now.
//
// Signed-out people have no server-side visits: this browser remembers
// their last one, with the same rule as the server (a new visit after
// `VISIT_GAP_MS` away), and asks for a digest since then.

export interface SinceChannel {
	send(request: SinceRequest): void;
}

export interface SinceState {
	digest: Digest | null;
	/** Highlights already seen, by shape id. */
	seen: ReadonlySet<string>;
	panel: boolean;
	/** Whether the panel was closed this visit, so it doesn't open again by itself. */
	dismissed: boolean;
}

interface LocalVisit {
	seenAt: number;
	baseline: number | null;
}

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export class SinceStore {
	channel: SinceChannel = { send: () => {} };
	/** The board's id, for remembering things in this browser. */
	board = "";
	/** For the playground: what time it is. */
	now: () => number = () => clock.now();

	private state: SinceState = { digest: null, seen: new Set(), panel: false, dismissed: false };
	private listeners = new Set<() => void>();

	apply(event: SinceEvent): void {
		const digest = event.digest;
		const seen = new Set(this.readSeen(digest.since));
		const fresh = digest.since !== this.state.digest?.since;
		this.state = {
			...this.state,
			digest,
			seen,
			// A new digest with something in it opens the panel, once.
			panel: fresh ? !this.state.dismissed && hasNews(digest) : this.state.panel,
		};
		this.emit();
	}

	/**
	 * Ask for the digest, e.g. once synced. The server keeps signed-in
	 * people's visits itself, and only uses `since` for everyone else.
	 */
	request(): void {
		const visit = this.arriveLocally();
		this.channel.send(
			visit.baseline === null
				? { type: "since-request" }
				: { type: "since-request", since: visit.baseline },
		);
	}

	/** Mark everything as seen: the next digest starts from now. */
	markAllSeen(): void {
		this.writeVisit({ seenAt: this.now(), baseline: this.now() });
		this.channel.send({ type: "since-seen" });
		this.state = { ...this.state, panel: false, dismissed: true };
		this.emit();
	}

	/** A highlight has been on screen long enough: it fades. */
	see(ids: string[]): void {
		const fresh = ids.filter((id) => !this.state.seen.has(id));
		if (fresh.length === 0) return;
		const seen = new Set([...this.state.seen, ...fresh]);
		this.state = { ...this.state, seen };
		this.writeSeen(this.state.digest?.since ?? null, seen);
		this.emit();
	}

	/** New comments count as news too (the board knows them; the digest doesn't). */
	openForComments(count: number): void {
		const { digest, panel, dismissed } = this.state;
		if (count === 0 || panel || dismissed || digest?.since == null) return;
		this.state = { ...this.state, panel: true };
		this.emit();
	}

	setPanel(panel: boolean): void {
		this.state = { ...this.state, panel, dismissed: this.state.dismissed || !panel };
		this.emit();
	}

	/** Still here, so this visit carries on (for signed-out people). */
	touch(): void {
		if (!this.board) return;
		const visit = this.readVisit();
		this.writeVisit({ seenAt: this.now(), baseline: visit?.baseline ?? null });
	}

	reset(): void {
		this.state = { digest: null, seen: new Set(), panel: false, dismissed: false };
		this.emit();
	}

	get = (): SinceState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private arriveLocally(): LocalVisit {
		const now = this.now();
		const known = this.readVisit();
		const visit: LocalVisit = !known
			? { seenAt: now, baseline: null }
			: {
					seenAt: now,
					baseline: now - known.seenAt > VISIT_GAP_MS ? known.seenAt : known.baseline,
				};
		this.writeVisit(visit);
		return visit;
	}

	private readVisit(): LocalVisit | null {
		try {
			const raw = storage()?.getItem(`tack:visit:${this.board}`);
			return raw ? (JSON.parse(raw) as LocalVisit) : null;
		} catch {
			return null;
		}
	}

	private writeVisit(visit: LocalVisit): void {
		try {
			storage()?.setItem(`tack:visit:${this.board}`, JSON.stringify(visit));
		} catch {
			// Private windows and full storage: this visit just isn't remembered.
		}
	}

	private readSeen(since: number | null): string[] {
		if (since === null) return [];
		try {
			const raw = storage()?.getItem(`tack:seen:${this.board}:${since}`);
			return raw ? (JSON.parse(raw) as string[]) : [];
		} catch {
			return [];
		}
	}

	private writeSeen(since: number | null, seen: Set<string>): void {
		if (since === null) return;
		try {
			const store = storage();
			if (!store) return;
			// One visit's worth at a time per board.
			for (let i = store.length - 1; i >= 0; i--) {
				const key = store.key(i);
				if (key?.startsWith(`tack:seen:${this.board}:`) && !key.endsWith(`:${since}`)) {
					store.removeItem(key);
				}
			}
			store.setItem(`tack:seen:${this.board}:${since}`, JSON.stringify([...seen]));
		} catch {
			// As above.
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function hasNews(digest: Digest): boolean {
	return (
		digest.since !== null &&
		(digest.edits.length > 0 || digest.cards.length > 0 || digest.pushes.length > 0)
	);
}

export const sinceStore = new SinceStore();

export function useSince(store: SinceStore = sinceStore): SinceState {
	return useSyncExternalStore(store.subscribe, store.get);
}
