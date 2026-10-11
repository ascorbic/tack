import { useSyncExternalStore } from "react";
import type { ProposedPile } from "../../shared/pileEdits.ts";
import type { PileMessage, PileRequest } from "../../shared/pileNamer.ts";

// Piles on the client (#73): what's this person's own (which pile they've
// opened, a "Group these" proposal they're looking at) and what the board's
// server says (whether AI suggestions are on, and its answers). Opening a
// pile is a way of looking, so it's never in the document: someone else's
// pile stays a neat stack for you while they read theirs spread out.
//
// The live board wires `channel` to its connection; the playground to its
// pretend server (play/piles.ts).

export interface PileChannel {
	send(request: PileRequest): void;
}

export type GroupFailure = "off" | "too_few" | "limited" | "failed" | "not_editor" | "offline";

export type GroupAnswer = { ok: true; piles: ProposedPile[] } | { ok: false; reason: GroupFailure };

/** How long to wait for an answer before saying it didn't come. */
const GROUP_TIMEOUT_MS = 30_000;

export interface PileSnapshot {
	/** Whether the board's server suggests names (null until it's said). */
	ai: boolean | null;
	/** The pile spread open here, if any: one at a time. */
	open: string | null;
}

class PileStore {
	channel: PileChannel | null = null;
	private snapshot: PileSnapshot = { ai: null, open: null };
	private listeners = new Set<() => void>();
	private waiting = new Map<
		string,
		{ resolve: (answer: GroupAnswer) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private next = 0;

	readonly subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly getSnapshot = () => this.snapshot;

	private set(next: Partial<PileSnapshot>) {
		this.snapshot = { ...this.snapshot, ...next };
		for (const listener of this.listeners) listener();
	}

	/** Spread a pile open (closing any other), or gather it back with null. */
	setOpen(id: string | null): void {
		if (this.snapshot.open !== id) this.set({ open: id });
	}

	/** Whether suggestions are on, as the playground's pretend server says. */
	setAi(enabled: boolean | null): void {
		if (this.snapshot.ai !== enabled) this.set({ ai: enabled });
	}

	/** A connection closed, or a new board opened: what the server said no longer holds. */
	reset(): void {
		for (const [request, { resolve, timer }] of this.waiting) {
			clearTimeout(timer);
			resolve({ ok: false, reason: "offline" });
			this.waiting.delete(request);
		}
		this.set({ ai: null, open: null });
	}

	apply(message: PileMessage): void {
		if (message.type === "piles-ai") {
			this.setAi(message.enabled);
			return;
		}
		const waiting = this.waiting.get(message.request);
		if (!waiting) return;
		clearTimeout(waiting.timer);
		this.waiting.delete(message.request);
		waiting.resolve(
			message.type === "pile-groups"
				? { ok: true, piles: message.piles }
				: { ok: false, reason: message.reason },
		);
	}

	/** Ask the board's server to propose piles for these stickies. */
	group(ids: readonly string[]): Promise<GroupAnswer> {
		const channel = this.channel;
		if (!channel) return Promise.resolve({ ok: false, reason: "offline" });
		const request = `g${++this.next}-${Date.now().toString(36)}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiting.delete(request);
				resolve({ ok: false, reason: "failed" });
			}, GROUP_TIMEOUT_MS);
			this.waiting.set(request, { resolve, timer });
			channel.send({ type: "pile-group", request, ids: [...ids] });
		});
	}
}

export const pileStore = new PileStore();

export function usePiles(): PileSnapshot {
	return useSyncExternalStore(pileStore.subscribe, pileStore.getSnapshot);
}

export function isPileMessage(message: { type?: unknown }): message is PileMessage {
	return (
		message.type === "piles-ai" ||
		message.type === "pile-groups" ||
		message.type === "pile-group-failed"
	);
}

/** Why "Group these" didn't, in words. */
export function groupFailure(reason: GroupFailure): string {
	switch (reason) {
		case "off":
			return "AI suggestions are off on this Tack: an admin can turn them on at /setup";
		case "too_few":
			return "Select at least three stickies with something written on them";
		case "limited":
			return "That’s a lot of asking: try again in a minute";
		case "not_editor":
			return "Only people who can edit this board can group its stickies";
		case "offline":
			return "You’re offline: try again once you’re back";
		case "failed":
			return "Couldn’t come up with piles just now: try again, or pile them up by hand";
	}
}
