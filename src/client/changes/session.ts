import { useEffect, useMemo, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type PendingChange, type PushAs, unstageChanges } from "../../shared/changes.ts";
import type { CreditBoard } from "../../shared/credit.ts";
import { type PushClient, type PushRefusal, type RepoMetaCache, useRepoMeta } from "./api.ts";
import {
	type ChangeIndex,
	changeRepo,
	isPending,
	withDependencies,
	withDependents,
} from "./describe.ts";

// Staging edits that keep dependencies whole, and the push in progress.

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
	private out: ReadonlySet<string> = new Set();
	/** Changes this person has chosen about (or Tack has, for them), so a default never overrides them. */
	private decided = new Set<string>();

	constructor(private client: PushClient | null) {}

	get canPush(): boolean {
		return this.client !== null;
	}

	getSnapshot = (): PushState => this.state;

	/**
	 * What this person has left out of their next push. It's theirs alone,
	 * never on the board: the Changes panel is everyone's list, but nobody
	 * can quietly take something out of someone else's push.
	 */
	leftOut = (): ReadonlySet<string> => this.out;

	/**
	 * Leave changes out of the next push, or put them back, taking
	 * dependencies along: including a change includes the new issue it
	 * refers to; leaving out a new issue leaves out the changes about it.
	 * Returns the ids that changed.
	 */
	setIncluded(ids: Iterable<string>, included: boolean, index: ChangeIndex): string[] {
		const closure = included ? withDependencies(ids, index) : withDependents(ids, index);
		for (const id of closure) this.decided.add(id);
		const affected = [...closure].filter((id) => {
			const change = index.get(id);
			return change && isPending(change) && this.out.has(id) === included;
		});
		if (affected.length === 0) return affected;
		const next = new Set(this.out);
		for (const id of affected) {
			if (included) next.delete(id);
			else next.add(id);
		}
		this.out = next;
		this.notify();
		return affected;
	}

	/**
	 * Leave changes out unless this person has already chosen about them:
	 * for changes that can't go yet, like those to a repository without the
	 * app. Ticking one back in sticks.
	 */
	leaveOutByDefault(ids: Iterable<string>, index: ChangeIndex): string[] {
		const fresh = [...ids].filter((id) => !this.decided.has(id));
		return fresh.length > 0 ? this.setIncluded(fresh, false, index) : [];
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/**
	 * Push these changes, with whatever they depend on. A push started (or
	 * retried) while another is under way joins it, so their progress shows
	 * together.
	 */
	async push(
		ids: string[],
		as: PushAs,
		index: ChangeIndex,
		credit?: CreditBoard,
	): Promise<PushState> {
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
		const result = await this.client.push({ ids: all, as, ...(credit ? { credit } : {}) });
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
		// Once pushed, a change has gone: nothing to leave out any more.
		if (state.phase === "pushing" && state.ids.some((id) => this.out.has(id))) {
			this.out = new Set([...this.out].filter((id) => !state.ids.includes(id)));
		}
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

export function usePushState(session: PushSession | null): PushState {
	return useSyncExternalStore(session?.subscribe ?? noop, session?.getSnapshot ?? idle);
}

/** What this person has left out of their next push (see `PushSession.leftOut`). */
export function useLeftOut(session: PushSession | null): ReadonlySet<string> {
	return useSyncExternalStore(session?.subscribe ?? noop, session?.leftOut ?? none);
}

const NONE: ReadonlySet<string> = new Set();
const none = () => NONE;

const IDLE: PushState = { phase: "idle" };
const noop = () => () => {};
const idle = () => IDLE;

/**
 * Leave changes to repositories Tack can't write to (no app) out of this
 * person's push, once each, as soon as that's known: they'd only be refused.
 * The push sheet says why, and they can be ticked back in.
 */
export function useUnwritableLeftOut(
	session: PushSession | null,
	cache: RepoMetaCache | null,
	changes: readonly PendingChange[],
	index: ChangeIndex,
): void {
	const pending = useMemo(() => changes.filter(isPending), [changes]);
	const repos = useMemo(
		() => [
			...new Set(
				pending.map((change) => changeRepo(change, index)).filter((r): r is string => !!r),
			),
		],
		[pending, index],
	);
	const meta = useRepoMeta(session ? cache : null, repos);
	const unwritable = repos.filter((repo) => meta(repo)?.writable === false).join("\n");
	useEffect(() => {
		if (!session || !unwritable) return;
		const blocked = new Set(unwritable.split("\n"));
		const ids = pending
			.filter((change) => blocked.has(changeRepo(change, index) ?? ""))
			.map((change) => change.id);
		session.leaveOutByDefault(ids, index);
	}, [session, unwritable, pending, index]);
}
