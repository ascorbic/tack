import { useSyncExternalStore } from "react";
import type { ProposedStack } from "../../shared/stackEdits.ts";
import type { StackMessage, StackRequest } from "../../shared/stackNamer.ts";

// Stacks on the client (#73): what's this person's own (which stack they've
// opened, a "Group these" proposal they're looking at) and what the board's
// server says (whether AI suggestions are on, and its answers). Opening a
// stack is a way of looking, so it's never in the document: someone else's
// stack stays a neat stack for you while they read theirs spread out.
//
// The live board wires `channel` to its connection; the playground to its
// pretend server (play/stacks.ts).

export interface StackChannel {
	send(request: StackRequest): void;
}

export type GroupFailure = "off" | "too_few" | "limited" | "failed" | "not_editor" | "offline";

export type GroupAnswer =
	| {
			ok: true;
			stacks: ProposedStack[];
			/** Cards whose titles couldn't be shared with everyone here, so weren't asked about. */
			withheld?: number;
	  }
	| { ok: false; reason: GroupFailure };

/** How long to wait for an answer before saying it didn't come. */
const GROUP_TIMEOUT_MS = 30_000;

export interface StackSnapshot {
	/** Whether the board's server suggests names (null until it's said). */
	ai: boolean | null;
	/** The stack spread open here, if any: one at a time. */
	open: string | null;
	/** "Group these" stacks being previewed here, before they're made: the board marks their stickies. */
	proposal: readonly ProposedStack[] | null;
}

class StackStore {
	channel: StackChannel | null = null;
	private snapshot: StackSnapshot = { ai: null, open: null, proposal: null };
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

	private set(next: Partial<StackSnapshot>) {
		this.snapshot = { ...this.snapshot, ...next };
		for (const listener of this.listeners) listener();
	}

	/** Spread a stack open (closing any other), or gather it back with null. */
	setOpen(id: string | null): void {
		if (this.snapshot.open !== id) this.set({ open: id });
	}

	/** Show (or with null, stop showing) proposed stacks on the board. */
	setProposal(proposal: readonly ProposedStack[] | null): void {
		if (this.snapshot.proposal !== proposal) this.set({ proposal });
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
		this.set({ ai: null, open: null, proposal: null });
	}

	apply(message: StackMessage): void {
		if (message.type === "stacks-ai") {
			this.setAi(message.enabled);
			return;
		}
		const waiting = this.waiting.get(message.request);
		if (!waiting) return;
		clearTimeout(waiting.timer);
		this.waiting.delete(message.request);
		waiting.resolve(
			message.type === "stack-groups"
				? { ok: true, stacks: message.stacks, withheld: message.withheld }
				: { ok: false, reason: message.reason },
		);
	}

	/** Ask the board's server to propose stacks for these stickies. */
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
			channel.send({ type: "stack-group", request, ids: [...ids] });
		});
	}
}

export const stackStore = new StackStore();

export function useStacks(): StackSnapshot {
	return useSyncExternalStore(stackStore.subscribe, stackStore.getSnapshot);
}

export function isStackMessage(message: { type?: unknown }): message is StackMessage {
	return (
		message.type === "stacks-ai" ||
		message.type === "stack-groups" ||
		message.type === "stack-group-failed"
	);
}

/** Why "Group these" didn't, in words. */
export function groupFailure(reason: GroupFailure): string {
	switch (reason) {
		case "off":
			return "AI suggestions are off on this Tack, so there’s nothing to ask: stack them up by hand";
		case "too_few":
			return "Select at least three stickies (or cards) with something to read";
		case "limited":
			return "That’s a lot of asking: try again in a minute";
		case "not_editor":
			return "Only people who can edit this board can group its stickies";
		case "offline":
			return "You’re offline: try again once you’re back";
		case "failed":
			return "Couldn’t come up with stacks just now: try again, or stack them up by hand";
	}
}
