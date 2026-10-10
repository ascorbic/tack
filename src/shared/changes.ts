import * as Y from "yjs";
import { LOCAL_ORIGIN } from "./shapes.ts";

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
	| { kind: "item.labels"; target: Target; add?: string[]; remove?: string[] }
	| { kind: "item.milestone"; target: Target; milestone: string | null }
	| { kind: "item.assignees"; target: Target; add?: string[]; remove?: string[] }
	| { kind: "item.state"; target: Target; state: "open" | "closed"; reason?: CloseReason }
	| { kind: "item.subIssue"; parent: Target; child: Target }
	| { kind: "item.blockedBy"; target: Target; blockedBy: Target }
	| { kind: "item.comment"; target: Target; body: string }
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

export interface PendingChange {
	id: string;
	op: Operation;
	status: ChangeStatus;
	stagedBy: Stager;
	stagedAt: string;
	/** Board shapes this change came from or is about, for highlighting. */
	shapes?: string[];
	effect?: ChangeEffect;
	/** Whether this change is included in the next push (the push sheet's toggle). */
	included?: boolean;
	/** Set by the server from here on. */
	pushId?: string;
	pushedBy?: Stager;
	/** Whether it was written as the person who pushed it, or as the app. */
	pushedAs?: PushAs;
	/** What the forge made or changed: the created item's key and URL. */
	result?: { key?: string; url?: string };
	error?: string;
	updatedAt?: string;
}

export function changesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap("changes");
}

export function readChange(change: Y.Map<unknown>): PendingChange {
	return change.toJSON() as PendingChange;
}

export function listChanges(doc: Y.Doc): PendingChange[] {
	return [...changesMap(doc).values()]
		.map(readChange)
		.sort((a, b) => (a.stagedAt < b.stagedAt ? -1 : a.stagedAt > b.stagedAt ? 1 : 0));
}

/** Stage a change, as an undoable local edit. Returns its id. */
export function stageChange(
	doc: Y.Doc,
	op: Operation,
	stagedBy: Stager,
	options: { shapes?: string[]; effect?: ChangeEffect; id?: string } = {},
): string {
	const id = options.id ?? crypto.randomUUID();
	doc.transact(() => {
		const change = new Y.Map<unknown>();
		change.set("id", id);
		change.set("op", op);
		change.set("status", "staged" satisfies ChangeStatus);
		change.set("stagedBy", stagedBy);
		change.set("stagedAt", new Date().toISOString());
		change.set("included", true);
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

/** Include or leave out staged changes from the next push. */
export function includeChanges(doc: Y.Doc, ids: string[], included: boolean): void {
	const changes = changesMap(doc);
	doc.transact(() => {
		for (const id of ids) changes.get(id)?.set("included", included);
	}, LOCAL_ORIGIN);
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
