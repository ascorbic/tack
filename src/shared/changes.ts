import * as Y from "yjs";
import { issueFromText } from "./issueText.ts";
import { LOCAL_ORIGIN, shapesMap } from "./shapes.ts";

// Pending changes: writes to the forge that people stage on a board and then
// push as a batch (docs/plan.md, M2). Moving things on a board never changes
// GitHub; only these do.
//
// Changes live in the board's Yjs document under `changes` (one Y.Map per
// change, keyed by id), so everyone on the board sees them, and staging,
// editing and unstaging are undoable like any other local edit. The server
// (the Board object) owns the status fields once a push starts.

/** An item on a forge, by its canonical key (`github.com/owner/repo#123`). */
export interface ItemTarget {
	key: string;
}

/** An item that a staged `issue.create` in this push will create. */
export interface PendingTarget {
	pending: string;
}

export type Target = ItemTarget | PendingTarget;

/** A repository, by its key (`github.com/owner/repo`). */
export interface RepoTarget {
	repo: string;
}

export type CloseReason = "completed" | "not_planned" | "duplicate";

/**
 * Writes that discussions take too (labels, closing and reopening, comments)
 * say when their item is one, as staged from its card: a key alone can't
 * tell (discussions share their repository's numbers), and on GitHub they're
 * written through another API.
 */
export interface OnDiscussion {
	discussion?: boolean;
}

/** What a discussion calls each reason for closing: resolved, outdated, duplicate. */
export const DISCUSSION_CLOSE: Record<CloseReason, string> = {
	completed: "resolved",
	not_planned: "outdated",
	duplicate: "duplicate",
};

/** A forge-neutral write. Adapters declare which kinds they support. */
export type Operation =
	| ({
			kind: "issue.create";
			title: string;
			body?: string;
			labels?: string[];
			assignees?: string[];
			milestone?: string;
	  } & RepoTarget)
	| ({ kind: "item.labels"; target: Target; add?: string[]; remove?: string[] } & OnDiscussion)
	| { kind: "item.milestone"; target: Target; milestone: string | null }
	| { kind: "item.assignees"; target: Target; add?: string[]; remove?: string[] }
	| ({
			kind: "item.state";
			target: Target;
			state: "open" | "closed";
			/** For a discussion: completed is resolved, not planned is outdated. */
			reason?: CloseReason;
	  } & OnDiscussion)
	| {
			kind: "item.subIssue";
			parent: Target;
			child: Target;
			/**
			 * Move the child here from the parent it has. An issue can only
			 * have one, so without this a child that has one is refused.
			 */
			replaceParent?: boolean;
			/** The parent it's moved from, as staged (an item key), for saying so. */
			previousParent?: string;
	  }
	| { kind: "item.blockedBy"; target: Target; blockedBy: Target }
	| ({ kind: "item.comment"; target: Target; body: string } & OnDiscussion)
	| ({
			kind: "pr.create";
			title: string;
			body: string;
			/** Branch to create, from the default branch unless `base` is set. */
			branch: string;
			base?: string;
			files: { path: string; content: string }[];
	  } & RepoTarget)
	| ({ kind: "discussion.create"; category: string; title: string; body: string } & RepoTarget);

export type OperationKind = Operation["kind"];

export const OPERATION_KINDS: readonly OperationKind[] = [
	"issue.create",
	"item.labels",
	"item.milestone",
	"item.assignees",
	"item.state",
	"item.subIssue",
	"item.blockedBy",
	"item.comment",
	"pr.create",
	"discussion.create",
];

/**
 * - `staged`: waiting to be pushed
 * - `sending`: a push is applying it
 * - `sent`: the forge accepted it; waiting for its webhook to confirm
 * - `applied`: confirmed by a webhook or reconciliation
 * - `failed`: the forge rejected it, or it never confirmed; `error` says why
 */
export type ChangeStatus = "staged" | "sending" | "sent" | "applied" | "failed";

/**
 * `user`: as the person pushing, with their own token (GitHub shows "via
 * Tack"). `app`: as the app's bot, with an installation token.
 */
export type PushAs = "user" | "app";

/** Who staged a change. Signed-out editors have a name and colour only. */
export interface Stager {
	id?: number;
	login?: string;
	name: string;
	color?: string;
}

/**
 * What the board does once a change is applied, so the board reflects what
 * was made. Run by the server (the Board object), not the client.
 *
 * - `replace`: turn these shapes (e.g. the sticky an issue was made from)
 *   into a card for the created item, in place
 * - `connect`: no change to the shapes; the connector between them now
 *   stands for the written relationship (styling only)
 * - `place`: add a card for the created item above these shapes (the
 *   section a parent issue was made from, or what became its sub-issues),
 *   connected to each of them, parent to child (`placeCard` in place.ts)
 * - `link`: point these shapes (action items) at the created item, so their
 *   status follows it from now on (`linkActionItems` in actionItems.ts)
 */
export type ChangeEffect =
	| { kind: "replace"; shapes: string[] }
	| { kind: "connect"; shape: string }
	| { kind: "place"; near: string[] }
	| { kind: "link"; shapes: string[] };

/**
 * How a new issue made from a sticky stands against that sticky now:
 * `edited` since it was staged (the issue follows it), `deleted`, or
 * `empty` (nothing left to make a title from).
 */
export type Drift = "edited" | "deleted" | "empty";

/**
 * Refusals of sub-issue and blocked-by links that the board can offer a
 * way out of, beyond retrying:
 *
 * - `has_parent`: the sub-issue already has a parent (`parent`, when the
 *   forge said which), and an issue can only have one. Move it here
 *   (`replaceParent`), or leave it out
 * - `self`: an issue can't be its own sub-issue, or block itself
 * - `cycle`: the link would make a loop
 * - `too_many`: the parent has as many sub-issues (or the issue as many
 *   dependencies) as the forge allows
 * - `too_deep`: sub-issues would nest deeper than the forge allows
 * - `cross_repo`: the forge won't link items across these repositories
 */
export type ProblemCode = "has_parent" | "self" | "cycle" | "too_many" | "too_deep" | "cross_repo";

export interface ChangeProblem {
	code: ProblemCode;
	/** `has_parent`: the parent it has now, as an item key. */
	parent?: string;
}

/**
 * Whether trying a refused change again, unchanged, could ever work. A
 * child that already has a parent is refused until it's moved (or its
 * parent is changed on the forge, which Tack can do: Move it here), and an
 * issue is always itself. Loops and limits can be sorted out on the forge,
 * after which a retry works.
 */
export function retryCanWork(problem: ChangeProblem | undefined): boolean {
	return problem?.code !== "has_parent" && problem?.code !== "self";
}

/** Changes staged together by one action: which, and in what order they were staged. */
export interface Batch {
	id: string;
	index: number;
}

export interface PendingChange {
	id: string;
	op: Operation;
	status: ChangeStatus;
	stagedBy: Stager;
	stagedAt: string;
	/** Board shapes this change came from or is about, for highlighting. */
	shapes?: string[];
	effect?: ChangeEffect;
	/** Staged with others by one action (Make 40 issues), so they read as one. */
	batch?: Batch;
	/**
	 * Derived when read, never stored: a new issue made from a sticky is the
	 * sticky's text as it is now (`followSticky`), and this says whether the
	 * sticky has changed since it was staged.
	 */
	drift?: Drift;
	/** Set by the server from here on. */
	pushId?: string;
	pushedBy?: Stager;
	/** Whether it was written as the person who pushed it, or as the app. */
	pushedAs?: PushAs;
	/** What the forge made or changed: the created item's key and URL. */
	result?: { key?: string; url?: string };
	/** Why it failed, in words people can act on. */
	error?: string;
	/** What the forge itself said, when that's different, for looking it up. */
	errorDetail?: string;
	/** What kind of refusal it was, when there's a way out other than retrying. */
	problem?: ChangeProblem;
	updatedAt?: string;
}

export function changesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap("changes");
}

/**
 * A change as it reads now. With the document, a new issue made from a
 * sticky takes its title and body from the sticky as it is (see
 * `followSticky`), so editing a sticky after staging it changes the issue.
 */
export function readChange(change: Y.Map<unknown>, doc?: Y.Doc): PendingChange {
	const read = change.toJSON() as PendingChange;
	return doc ? followSticky(doc, read) : read;
}

/**
 * The sticky a staged new issue is made from: its title and body are read
 * from it until a push snapshots them. Null for anything else, and once
 * it's being pushed (the sticky is about to become its card).
 */
export function stickySource(
	change: Pick<PendingChange, "op" | "effect" | "status">,
): string | null {
	if (change.op?.kind !== "issue.create" || change.effect?.kind !== "replace") return null;
	if (change.status !== "staged" && change.status !== "failed") return null;
	const [only, ...rest] = change.effect.shapes;
	return only && rest.length === 0 ? only : null;
}

/**
 * A new issue made from a sticky, as the sticky reads now: its title and
 * body are the sticky's text, whatever it said when staged, and `drift`
 * says it was edited since, or that the sticky is empty or gone (a push
 * leaves those out). Labels, milestone and assignees are the change's own.
 */
export function followSticky(doc: Y.Doc, change: PendingChange): PendingChange {
	const id = stickySource(change);
	if (!id || change.op.kind !== "issue.create") return change;
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("type") !== "sticky") return { ...change, drift: "deleted" };
	const text = shape.get("text");
	const issue = issueFromText(typeof text === "string" ? text : "");
	if (!issue) return { ...change, drift: "empty" };
	const { op } = change;
	if (issue.title === op.title && (issue.body ?? "") === (op.body ?? "")) return change;
	const { body: _body, ...rest } = op;
	return {
		...change,
		op: { ...rest, title: issue.title, ...(issue.body ? { body: issue.body } : {}) },
		drift: "edited",
	};
}

/** Staging order: when, then each batch in the order its action staged it. */
export function stagingOrder(a: PendingChange, b: PendingChange): number {
	if (a.stagedAt !== b.stagedAt) return a.stagedAt < b.stagedAt ? -1 : 1;
	// Within a moment, each batch (or change) together, in its own order.
	const ag = a.batch?.id ?? a.id;
	const bg = b.batch?.id ?? b.id;
	if (ag !== bg) return ag < bg ? -1 : 1;
	return (a.batch?.index ?? 0) - (b.batch?.index ?? 0);
}

export function listChanges(doc: Y.Doc): PendingChange[] {
	return [...changesMap(doc).values()].map((change) => readChange(change, doc)).sort(stagingOrder);
}

let lastStamp = 0;

/**
 * When a change is staged: now, but always later than the last change this
 * client staged, so what one person stages lists in the order they did it.
 */
function stamp(): string {
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return new Date(lastStamp).toISOString();
}

/**
 * Changes staged by one action share a batch: the same time, and their
 * order. Pass the same `Batcher` to every `stageChange` the action makes.
 */
export class Batcher {
	readonly id = crypto.randomUUID();
	readonly at = stamp();
	private next = 0;

	take(): Batch {
		return { id: this.id, index: this.next++ };
	}
}

/** Stage a change, as an undoable local edit. Returns its id. */
export function stageChange(
	doc: Y.Doc,
	op: Operation,
	stagedBy: Stager,
	options: { shapes?: string[]; effect?: ChangeEffect; id?: string; batch?: Batcher } = {},
): string {
	const id = options.id ?? crypto.randomUUID();
	doc.transact(() => {
		const change = new Y.Map<unknown>();
		change.set("id", id);
		change.set("op", op);
		change.set("status", "staged" satisfies ChangeStatus);
		change.set("stagedBy", stagedBy);
		change.set("stagedAt", options.batch?.at ?? stamp());
		if (options.batch) change.set("batch", options.batch.take());
		if (options.shapes?.length) change.set("shapes", options.shapes);
		if (options.effect) change.set("effect", options.effect);
		changesMap(doc).set(id, change);
	}, LOCAL_ORIGIN);
	return id;
}

/** Remove staged changes. Only `staged` and `failed` changes can be unstaged. */
export function unstageChanges(doc: Y.Doc, ids: string[]): void {
	const changes = changesMap(doc);
	doc.transact(() => {
		for (const id of ids) {
			const status = changes.get(id)?.get("status");
			if (status === "staged" || status === "failed") changes.delete(id);
		}
	}, LOCAL_ORIGIN);
}

const CREATES: ReadonlySet<OperationKind> = new Set([
	"issue.create",
	"pr.create",
	"discussion.create",
]);

/**
 * The shapes a staged change is made from, which it can't outlive: the
 * sticky a new issue's text comes from, the section or cluster a parent
 * issue stands for, the decision a write-back records, the connector a
 * blocked-by link was drawn as, the action items an issue is for. Changes
 * about items already on the forge (labels on a card) aren't made from
 * their card: the item is still there when the card goes.
 */
function madeFrom(change: Y.Map<unknown>): string[] {
	const effect = change.get("effect") as ChangeEffect | undefined;
	const op = change.get("op") as Operation | undefined;
	switch (effect?.kind) {
		case "replace":
		case "link":
			return effect.shapes;
		case "connect":
			return [effect.shape];
	}
	const shapes = change.get("shapes");
	return op && CREATES.has(op.kind) && Array.isArray(shapes) ? (shapes as string[]) : [];
}

/**
 * The staged (or failed) changes that go when these shapes are deleted:
 * those made from them (`madeFrom`, every one of its shapes deleted), and
 * the changes that refer to the issues those would have made.
 */
export function changesMadeFrom(doc: Y.Doc, deleted: ReadonlySet<string>): string[] {
	const changes = changesMap(doc);
	const out = new Set<string>();
	const pending = (change: Y.Map<unknown>) => {
		const status = change.get("status");
		return status === "staged" || status === "failed";
	};
	for (const [id, change] of changes) {
		if (!pending(change)) continue;
		const from = madeFrom(change);
		if (from.length > 0 && from.every((shape) => deleted.has(shape))) out.add(id);
	}
	let grew = out.size > 0;
	while (grew) {
		grew = false;
		for (const [id, change] of changes) {
			if (out.has(id) || !pending(change)) continue;
			const op = change.get("op") as Operation | undefined;
			if (op && safeDependencies(op).some((dep) => out.has(dep))) {
				out.add(id);
				grew = true;
			}
		}
	}
	return [...out];
}

/** Dependencies of an operation anyone could have written into the document. */
function safeDependencies(op: Operation): string[] {
	try {
		return pendingDependencies(op);
	} catch {
		return [];
	}
}

function targetsOf(op: Operation): Target[] {
	switch (op.kind) {
		case "item.subIssue":
			return [op.parent, op.child];
		case "item.blockedBy":
			return [op.target, op.blockedBy];
		default:
			return "target" in op ? [op.target] : [];
	}
}

/**
 * The ids of staged `issue.create` changes this one refers to. It can only
 * be pushed with them, and is applied after them.
 */
export function pendingDependencies(op: Operation): string[] {
	return targetsOf(op).flatMap((t) => ("pending" in t ? [t.pending] : []));
}

/**
 * Replace pending targets with the keys of the items they created. Returns
 * null if any is still unresolved.
 */
export function resolveTargets(
	op: Operation,
	created: ReadonlyMap<string, string>,
): Operation | null {
	let unresolved = false;
	const resolve = (t: Target): ItemTarget => {
		if ("key" in t) return t;
		const key = created.get(t.pending);
		if (!key) unresolved = true;
		return { key: key ?? "" };
	};
	let resolved: Operation;
	switch (op.kind) {
		case "item.subIssue":
			resolved = { ...op, parent: resolve(op.parent), child: resolve(op.child) };
			break;
		case "item.blockedBy":
			resolved = { ...op, target: resolve(op.target), blockedBy: resolve(op.blockedBy) };
			break;
		default:
			resolved = "target" in op ? { ...op, target: resolve(op.target) } : op;
	}
	return unresolved ? null : resolved;
}

/** The repository a change writes to, as a key (`github.com/owner/repo`). */
export function operationRepo(op: Operation): string | null {
	if ("repo" in op) return op.repo;
	const [first] = targetsOf(op);
	if (!first || !("key" in first)) return null;
	return first.key.replace(/[#!]\d+$/, "");
}
