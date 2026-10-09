import { useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type PushAs, includeChanges, unstageChanges } from "../../shared/changes.ts";
import type { PushClient, PushRefusal } from "./api.ts";
import { type ChangeIndex, isPending, withDependencies, withDependents } from "./describe.ts";

// Staging edits that keep dependencies whole, and the push in progress.

/**
 * Include or leave out changes, taking dependencies along: including a
 * change includes the new issue it refers to; leaving out a new issue
 * leaves out the changes about it. One undo step.
 */
export function setIncluded(
	doc: Y.Doc,
	ids: Iterable<string>,
	included: boolean,
	index: ChangeIndex,
): string[] {
	const closure = included ? withDependencies(ids, index) : withDependents(ids, index);
	const affected = [...closure].filter((id) => {
		const change = index.get(id);
		return change && isPending(change) && (change.included !== false) !== included;
	});
	if (affected.length > 0) includeChanges(doc, affected, included);
	return affected;
}

/**
 * Unstage changes, and the changes that refer to them (a label on an issue
 * that won't be made has nothing to go on). One undo step. Returns the ids
 * unstaged.
 */
export function unstage(doc: Y.Doc, ids: Iterable<string>, index: ChangeIndex): string[] {
	const affected = [...withDependents(ids, index)].filter((id) => {
		const change = index.get(id);
		return change && isPending(change);
	});
	if (affected.length > 0) unstageChanges(doc, affected);
	return affected;
}

export type PushState =
	| { phase: "idle" }
	/** Asking the server to start. */
	| { phase: "requesting"; ids: string[]; as: PushAs }
	| { phase: "refused"; ids: string[]; as: PushAs; refusal: PushRefusal }
	/** The server accepted; statuses arrive through the document. */
	| {
			phase: "pushing";
			ids: string[];
			as: PushAs;
			pushIds: string[];
			startedAt: number;
			/** A retry during the push that the server refused, and what it was for. */
			refusal?: PushRefusal;
			refused?: string[];
	  };

/**
 * This person's push: what they asked for and what the server said. The
 * changes' own progress comes from the document, so everyone sees it; this
 * only remembers which changes this push is following.
 */
export class PushSession {
	private state: PushState = { phase: "idle" };
	private listeners = new Set<() => void>();

	constructor(private client: PushClient | null) {}

	get canPush(): boolean {
		return this.client !== null;
	}

	getSnapshot = (): PushState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/**
	 * Push these changes, with whatever they depend on. A push started (or
	 * retried) while another is under way joins it, so their progress shows
	 * together.
	 */
	async push(ids: string[], as: PushAs, index: ChangeIndex): Promise<PushState> {
		if (!this.client) return this.state;
		const all = [...withDependencies(ids, index)];
		const previous = this.state;
		if (previous.phase === "pushing") {
			this.set({
				...previous,
				ids: [...new Set([...previous.ids, ...all])],
				refusal: undefined,
				refused: undefined,
			});
		} else {
			this.set({ phase: "requesting", ids: all, as });
		}
		const result = await this.client.push({ ids: all, as });
		const now = this.state;
		if (now.phase === "pushing") {
			const before = previous.phase === "pushing" ? previous.ids : [];
			this.set(
				result.ok
					? { ...now, pushIds: [...now.pushIds, result.pushId] }
					: {
							...now,
							// Changes that only joined for this attempt leave again.
							ids: now.ids.filter((id) => !all.includes(id) || before.includes(id)),
							refusal: result,
							refused: all,
						},
			);
		} else if (result.ok) {
			this.set({ phase: "pushing", ids: all, as, pushIds: [result.pushId], startedAt: Date.now() });
		} else {
			this.set({ phase: "refused", ids: all, as, refusal: result });
		}
		return this.state;
	}

	/** Forget the push (its changes carry on regardless). */
	reset(): void {
		this.set({ phase: "idle" });
	}

	private set(state: PushState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

export function usePushState(session: PushSession | null): PushState {
	return useSyncExternalStore(session?.subscribe ?? noop, session?.getSnapshot ?? idle);
}

const IDLE: PushState = { phase: "idle" };
const noop = () => () => {};
const idle = () => IDLE;
