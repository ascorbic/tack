// Planning a push: which staged changes can go, in what order, to which
// repositories, and how each is described in the audit log. Pure, so it's
// unit-tested in Node.

import * as v from "valibot";
import {
	type Operation,
	type PendingChange,
	type Target,
	operationRepo,
	pendingDependencies,
} from "../../shared/changes.ts";
import { parseKey, parseRepoKey } from "../../shared/refs.ts";

// Changes come from the board document, which any editor can write, so
// every operation is checked before it's pushed.

const ItemKey = v.pipe(
	v.string(),
	v.maxLength(512),
	v.check((key) => parseKey(key) !== null, "not an item key"),
);
const RepoKey = v.pipe(
	v.string(),
	v.maxLength(512),
	v.check((key) => parseRepoKey(key) !== null, "not a repository key"),
);
const TargetSchema = v.union([
	v.object({ key: ItemKey }),
	v.object({ pending: v.pipe(v.string(), v.minLength(1), v.maxLength(128)) }),
]);
const Title = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256));
const Body = v.pipe(v.string(), v.maxLength(65_536));
const Name = v.pipe(v.string(), v.minLength(1), v.maxLength(100));
const Names = v.pipe(v.array(Name), v.maxLength(100));
const Login = v.pipe(v.string(), v.regex(/^[a-z\d](?:[a-z\d-]{0,38})$/i));
const Logins = v.pipe(v.array(Login), v.maxLength(10));

const OperationSchema = v.variant("kind", [
	v.object({
		kind: v.literal("issue.create"),
		repo: RepoKey,
		title: Title,
		body: v.optional(Body),
		labels: v.optional(Names),
		assignees: v.optional(Logins),
		milestone: v.optional(Name),
	}),
	v.object({
		kind: v.literal("item.labels"),
		target: TargetSchema,
		add: v.optional(Names),
		remove: v.optional(Names),
	}),
	v.object({
		kind: v.literal("item.milestone"),
		target: TargetSchema,
		milestone: v.nullable(Name),
	}),
	v.object({
		kind: v.literal("item.assignees"),
		target: TargetSchema,
		add: v.optional(Logins),
		remove: v.optional(Logins),
	}),
	v.object({
		kind: v.literal("item.state"),
		target: TargetSchema,
		state: v.picklist(["open", "closed"]),
		reason: v.optional(v.picklist(["completed", "not_planned", "duplicate"])),
	}),
	v.object({
		kind: v.literal("item.subIssue"),
		parent: TargetSchema,
		child: TargetSchema,
		replaceParent: v.optional(v.boolean()),
		previousParent: v.optional(ItemKey),
	}),
	v.object({ kind: v.literal("item.blockedBy"), target: TargetSchema, blockedBy: TargetSchema }),
	v.object({
		kind: v.literal("item.comment"),
		target: TargetSchema,
		body: v.pipe(Body, v.minLength(1)),
	}),
	v.object({
		kind: v.literal("pr.create"),
		repo: RepoKey,
		title: Title,
		body: Body,
		branch: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
		base: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
		files: v.pipe(
			v.array(
				v.object({
					path: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
					content: v.pipe(v.string(), v.maxLength(1_000_000)),
				}),
			),
			v.minLength(1),
			v.maxLength(100),
		),
	}),
	v.object({
		kind: v.literal("discussion.create"),
		repo: RepoKey,
		category: Name,
		title: Title,
		body: v.pipe(Body, v.minLength(1)),
	}),
]);

/** The operation, checked, or why it can't be pushed. */
export function checkOperation(
	op: unknown,
): { ok: true; op: Operation } | { ok: false; error: string } {
	const result = v.safeParse(OperationSchema, op);
	if (result.success) return { ok: true, op: result.output as Operation };
	const issue = result.issues[0];
	const path = issue.path?.map((p) => String(p.key)).join(".");
	return {
		ok: false,
		error: `Tack can't push this change: ${path ? `${path}: ` : ""}${issue.message}.`,
	};
}

/**
 * The repository a change writes to: the operation's own, or for one about
 * an item this push creates, that item's repository.
 */
export function writeRepo(
	op: Operation,
	byId: ReadonlyMap<string, { op: Operation }>,
): string | null {
	const repo = operationRepo(op);
	if (repo) return repo.toLowerCase();
	const [dependency] = pendingDependencies(op);
	const created = dependency ? byId.get(dependency)?.op : undefined;
	return created?.kind === "issue.create" ? created.repo.toLowerCase() : null;
}

export type PlanResult =
	| {
			ok: true;
			/** Changes in the order to apply them: everything after what it depends on. */
			ordered: PlanItem[];
	  }
	| { ok: false; reason: "busy" | "missing_dependency"; message: string };

export interface PlanItem {
	change: PendingChange;
	/** Null if the operation can't be pushed: `error` says why. */
	op: Operation | null;
	error?: string;
	/** The repository it writes to. */
	repo: string | null;
}

/**
 * Check a push: every id is staged (or failed, to retry) and not already
 * being pushed (`active`: change ids the server is pushing or has applied,
 * whatever the document says), and every pending item a change refers to
 * is either in the push or already created (`created`, by change id).
 */
export function planPush(
	changes: readonly PendingChange[],
	ids: readonly string[],
	active: ReadonlySet<string>,
	created: ReadonlyMap<string, string>,
): PlanResult {
	const byId = new Map(changes.map((change) => [change.id, change]));
	const requested = [...new Set(ids)];
	for (const id of requested) {
		const change = byId.get(id);
		if (!change) {
			return {
				ok: false,
				reason: "busy",
				message: "Some of these changes were removed. Review them and push again.",
			};
		}
		if (active.has(id) || (change.status !== "staged" && change.status !== "failed")) {
			return {
				ok: false,
				reason: "busy",
				message: `“${summarize(change.op, byId)}” is already being pushed.`,
			};
		}
	}
	const included = new Set(requested);
	for (const id of requested) {
		const change = byId.get(id)!;
		for (const dependency of dependenciesOf(change.op)) {
			if (included.has(dependency) || created.has(dependency)) continue;
			const needed = byId.get(dependency);
			return {
				ok: false,
				reason: "missing_dependency",
				message: needed
					? `“${summarize(change.op, byId)}” needs “${summarize(needed.op, byId)}”, which isn't in this push.`
					: `“${summarize(change.op, byId)}” refers to an issue that's no longer staged.`,
			};
		}
	}

	// Dependencies first; otherwise in the order they were staged.
	const order = new Map(changes.map((change, i) => [change.id, i]));
	const pending = requested
		.map((id) => byId.get(id)!)
		.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	const placed = new Set<string>();
	const ordered: PlanItem[] = [];
	while (pending.length > 0) {
		const next = pending.findIndex((change) =>
			dependenciesOf(change.op).every((dep) => placed.has(dep) || !included.has(dep)),
		);
		if (next < 0) {
			return {
				ok: false,
				reason: "missing_dependency",
				message: "These changes depend on each other in a circle, so none can go first.",
			};
		}
		const [change] = pending.splice(next, 1);
		if (!change) break;
		placed.add(change.id);
		const gone = DRIFTED[change.drift ?? "edited"];
		const checked = gone ? ({ ok: false, error: gone } as const) : checkOperation(change.op);
		ordered.push(
			checked.ok
				? { change, op: checked.op, repo: writeRepo(checked.op, byId) }
				: { change, op: null, error: checked.error, repo: null },
		);
	}
	return { ok: true, ordered };
}

/**
 * New issues whose sticky can't say what they are any more. (One edited
 * since it was staged is pushed as it reads now: see `followSticky`.)
 */
const DRIFTED: Partial<Record<NonNullable<PendingChange["drift"]>, string>> = {
	deleted: "Its sticky was deleted from the board, so there's nothing to make this issue from.",
	empty:
		"Its sticky is empty now, so this issue would have no title. Write on it, or unstage this.",
};

/** Pending dependencies of an operation that may not be well formed. */
function dependenciesOf(op: Operation): string[] {
	try {
		return pendingDependencies(op).filter((dep): dep is string => typeof dep === "string");
	} catch {
		return [];
	}
}

// --- Describing changes -----------------------------------------------------------

/** `owner/repo#12` for an item key. */
function shortKey(key: string): string {
	const ref = parseKey(key);
	return ref ? `${ref.repo}${ref.item}` : key;
}

function shortRepo(repoKey: string): string {
	return parseRepoKey(repoKey)?.repo ?? repoKey;
}

function describeTarget(target: Target, byId: ReadonlyMap<string, { op: Operation }>): string {
	if ("key" in target) return shortKey(target.key);
	const created = byId.get(target.pending)?.op;
	return created?.kind === "issue.create" ? `new issue “${created.title}”` : "a new issue";
}

function list(names: string[] | undefined, prefix: string): string[] {
	return (names ?? []).map((name) => `${prefix}${name}`);
}

/** One line describing an operation, for the audit log and messages. */
export function summarize(
	op: Operation,
	byId: ReadonlyMap<string, { op: Operation }> = new Map(),
): string {
	try {
		return describe(op, byId);
	} catch {
		// Not a well-formed operation (the document is anyone's to write).
		return "A change";
	}
}

function describe(op: Operation, byId: ReadonlyMap<string, { op: Operation }>): string {
	switch (op.kind) {
		case "issue.create":
			return `Create issue “${op.title}” in ${shortRepo(op.repo)}`;
		case "item.labels":
			return `Label ${describeTarget(op.target, byId)}: ${[...list(op.add, "+"), ...list(op.remove, "−")].join(", ")}`;
		case "item.milestone":
			return op.milestone === null
				? `Clear the milestone of ${describeTarget(op.target, byId)}`
				: `Set the milestone of ${describeTarget(op.target, byId)} to “${op.milestone}”`;
		case "item.assignees": {
			const people = [...list(op.add, "+@"), ...list(op.remove, "−@")].join(", ");
			return `Assign ${describeTarget(op.target, byId)}: ${people}`;
		}
		case "item.state":
			return op.state === "open"
				? `Reopen ${describeTarget(op.target, byId)}`
				: `Close ${describeTarget(op.target, byId)}${op.reason && op.reason !== "completed" ? ` as ${op.reason.replace("_", " ")}` : ""}`;
		case "item.subIssue":
			return op.replaceParent
				? `Move ${describeTarget(op.child, byId)}${op.previousParent ? ` from ${shortKey(op.previousParent)}` : ""} to ${describeTarget(op.parent, byId)}`
				: `Make ${describeTarget(op.child, byId)} a sub-issue of ${describeTarget(op.parent, byId)}`;
		case "item.blockedBy":
			return `Mark ${describeTarget(op.target, byId)} as blocked by ${describeTarget(op.blockedBy, byId)}`;
		case "item.comment":
			return `Comment on ${describeTarget(op.target, byId)}`;
		case "pr.create":
			return `Open pull request “${op.title}” in ${shortRepo(op.repo)}`;
		case "discussion.create":
			return `Start discussion “${op.title}” in ${shortRepo(op.repo)}`;
		default:
			return "A change";
	}
}
