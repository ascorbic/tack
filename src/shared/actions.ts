import type * as Y from "yjs";
import {
	Batcher,
	type ChangeEffect,
	type ChangeStatus,
	type CloseReason,
	type Operation,
	type OperationKind,
	type PendingChange,
	type Stager,
	type Target,
	changesMap,
	listChanges,
	readChange,
	stageChange,
	stickySource,
	unstageChanges,
} from "./changes.ts";
import { readConnector } from "./connectors.ts";
import { readingOrder } from "./display.ts";
import type { RepoMeta } from "./push.ts";
import { forgeForHost, repoKeyOf } from "./refs.ts";
import { TITLE_MAX, issueFromText, textFromIssue } from "./issueText.ts";
import { readShape, shapesMap, transactLocal } from "./shapes.ts";

// Built-in actions (#32): what the selection actions stage. Pure document
// logic, so it's unit-tested in Node; the UI is in src/client/actions/.
//
// Nothing here writes to a forge. Each function stages pending changes
// (src/shared/changes.ts) in one local transaction, so one action is one undo
// step, and the push sheet decides when they're written.

export { TITLE_MAX, issueFromText } from "./issueText.ts";

/** Changes that are still on their way: an issue that will exist, or is being made. */
const LIVE: ReadonlySet<ChangeStatus> = new Set(["staged", "sending", "sent", "failed"]);

/** Whether a repository's forge can do this kind of write (unknown means yes). */
export function canWrite(meta: Pick<RepoMeta, "writes"> | null | undefined, kind: OperationKind) {
	return !meta?.writes || meta.writes.includes(kind);
}

// Stickies to issues --------------------------------------------------------

/**
 * The live `issue.create` change that will turn this shape into a card, if
 * one is staged (or on its way). Stickies are only ever made into one issue.
 */
export function pendingIssueFor(doc: Y.Doc, shape: string): PendingChange | null {
	for (const change of listChanges(doc)) {
		if (change.op.kind !== "issue.create" || !LIVE.has(change.status)) continue;
		if (change.effect?.kind === "replace" && change.effect.shapes.includes(shape)) return change;
	}
	return null;
}

export interface StickyInput {
	id: string;
	text: string;
}

export type SkipReason =
	/** Nothing written on the sticky. */
	| "empty"
	/** Already staged to become an issue. */
	| "staged"
	/** Pull requests can't be sub-issues or blocked. */
	| "pull"
	/** Not something that can be part of an issue: text, sections, unknown cards. */
	| "unsupported";

export interface StageResult {
	/** Ids of the changes staged. */
	staged: string[];
	skipped: { shape: string; reason: SkipReason }[];
}

/** What new issues start with, besides their text: written as part of the create. */
export interface IssueExtras {
	labels?: readonly string[];
	milestone?: string | null;
	assignees?: readonly string[];
}

/** Extras as `issue.create` fields, leaving out anything empty. */
export function extrasOf(extras: IssueExtras | undefined): {
	labels?: string[];
	milestone?: string;
	assignees?: string[];
} {
	const labels = [...new Set(extras?.labels ?? [])];
	const assignees = [...new Set(extras?.assignees ?? [])];
	return {
		...(labels.length ? { labels } : {}),
		...(extras?.milestone ? { milestone: extras.milestone } : {}),
		...(assignees.length ? { assignees } : {}),
	};
}

/**
 * Stage an `issue.create` in `repo` for each sticky, which becomes the card
 * for its issue, in place, once it's made. Each starts with `extras`
 * (labels, a milestone, assignees), so they need no second push.
 */
export function stageStickyIssues(
	doc: Y.Doc,
	stickies: StickyInput[],
	repo: string,
	stager: Stager,
	extras?: IssueExtras,
): StageResult {
	const result: StageResult = { staged: [], skipped: [] };
	const fields = extrasOf(extras);
	const batch = new Batcher();
	transactLocal(doc, () => {
		// In the order people read the board, so the Changes panel and the
		// push sheet list them the way they're laid out.
		for (const sticky of inReadingOrder(doc, stickies)) {
			if (pendingIssueFor(doc, sticky.id)) {
				result.skipped.push({ shape: sticky.id, reason: "staged" });
				continue;
			}
			const issue = issueFromText(sticky.text);
			if (!issue) {
				result.skipped.push({ shape: sticky.id, reason: "empty" });
				continue;
			}
			const id = stageChange(doc, { kind: "issue.create", repo, ...issue, ...fields }, stager, {
				shapes: [sticky.id],
				effect: { kind: "replace", shapes: [sticky.id] },
				batch,
			});
			result.staged.push(id);
		}
	});
	return result;
}

/** Shapes by their place on the board: top to bottom in rows, then left to right. */
function inReadingOrder<T extends { id: string }>(doc: Y.Doc, items: readonly T[]): T[] {
	const shapes = shapesMap(doc);
	const at = items.map((item) => {
		const shape = shapes.get(item.id);
		return { id: item.id, x: Number(shape?.get("x") ?? 0), y: Number(shape?.get("y") ?? 0) };
	});
	const rank = new Map(readingOrder(at).map((id, i) => [id, i]));
	return [...items].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** A correction to a staged new issue, made in review. */
export interface IssueEdit {
	title?: string;
	body?: string;
	labels?: readonly string[];
	milestone?: string | null;
	assignees?: readonly string[];
}

/**
 * Correct a staged new issue: its title and body, labels, milestone and
 * assignees. One made from a sticky has its words written back to the
 * sticky, which is where they come from (`followSticky`), so the board and
 * the issue never disagree. One undo step. False if it can't be edited
 * (it's on its way, or the title would be empty).
 */
export function editStagedIssue(doc: Y.Doc, id: string, edit: IssueEdit): boolean {
	const raw = changesMap(doc).get(id);
	if (!raw) return false;
	const change = readChange(raw, doc);
	if (change.op.kind !== "issue.create") return false;
	if (change.status !== "staged" && change.status !== "failed") return false;
	const op = change.op;
	const words = edit.title !== undefined || edit.body !== undefined;
	const title = (edit.title ?? op.title).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
	if (!title) return false;
	const body = (edit.body ?? op.body ?? "").trim();
	const sticky = stickySource(change);
	const text = textFromIssue({ title, body });
	// Read back the way the sticky will be, so it doesn't count as drifting.
	const issue = (sticky ? issueFromText(text) : null) ?? { title, ...(body ? { body } : {}) };
	const { body: _body, labels: _l, milestone: _m, assignees: _a, ...rest } = op;
	const extras = extrasOf({
		labels: edit.labels ?? op.labels,
		milestone: edit.milestone === undefined ? op.milestone : edit.milestone,
		assignees: edit.assignees ?? op.assignees,
	});
	transactLocal(doc, () => {
		if (words && sticky) shapesMap(doc).get(sticky)?.set("text", text);
		raw.set("op", { ...rest, ...issue, ...extras });
	});
	return true;
}

// Parent issues --------------------------------------------------------------

/** Something to become a sub-issue: a card already on the forge, or a sticky. */
export type ChildInput =
	| { shape: string; card: { key: string; kind: "issue" | "pull" } }
	| { shape: string; sticky: string };

export interface ParentInput {
	repo: string;
	title: string;
	body?: string;
	/** Shapes the parent stands for, e.g. the section, for highlighting. */
	shapes?: string[];
	/**
	 * Where its card goes once it's made: above these shapes (a section), or
	 * above the shapes that become its sub-issues (`"children"`), connected
	 * to them. Without it, the parent gets no card on the board.
	 */
	near?: string[] | "children";
}

export interface ParentResult extends StageResult {
	/** The parent's `issue.create` change. */
	parent: string | null;
	/** How many sub-issues it'll have. */
	children: number;
}

/**
 * Stage a parent issue with sub-issues: an `issue.create` for the parent,
 * one for each sticky (made in the parent's repository, and turned into its
 * card in place), and an `item.subIssue` linking each child to the parent.
 * Stickies already staged as issues are reused rather than made twice.
 */
export function stageParentIssue(
	doc: Y.Doc,
	parent: ParentInput,
	children: ChildInput[],
	stager: Stager,
): ParentResult {
	const result: ParentResult = { staged: [], skipped: [], parent: null, children: 0 };
	const title = parent.title.trim();
	if (!title) return result;
	const batch = new Batcher();
	transactLocal(doc, () => {
		const parentId = stageChange(
			doc,
			{
				kind: "issue.create",
				repo: parent.repo,
				title: title.slice(0, TITLE_MAX),
				...(parent.body?.trim() ? { body: parent.body.trim() } : {}),
			},
			stager,
			{ shapes: parent.shapes, batch },
		);
		result.parent = parentId;
		result.staged.push(parentId);
		const seen = new Set<string>();
		const subIssues: string[] = [];
		for (const child of children) {
			let target: Target;
			if ("card" in child) {
				if (child.card.kind !== "issue") {
					result.skipped.push({ shape: child.shape, reason: "pull" });
					continue;
				}
				if (seen.has(child.card.key)) continue;
				seen.add(child.card.key);
				target = { key: child.card.key };
			} else {
				const pending = pendingIssueFor(doc, child.shape);
				if (pending) {
					target = { pending: pending.id };
				} else {
					const issue = issueFromText(child.sticky);
					if (!issue) {
						result.skipped.push({ shape: child.shape, reason: "empty" });
						continue;
					}
					const id = stageChange(
						doc,
						{ kind: "issue.create", repo: parent.repo, ...issue },
						stager,
						{
							shapes: [child.shape],
							effect: { kind: "replace", shapes: [child.shape] },
							batch,
						},
					);
					result.staged.push(id);
					target = { pending: id };
				}
			}
			result.staged.push(
				stageChange(
					doc,
					{ kind: "item.subIssue", parent: { pending: parentId }, child: target },
					stager,
					{ shapes: [child.shape], batch },
				),
			);
			subIssues.push(child.shape);
			result.children++;
		}
		const near = parent.near === "children" ? subIssues : parent.near;
		if (near?.length) {
			const effect: ChangeEffect = { kind: "place", near };
			changesMap(doc).get(parentId)?.set("effect", effect);
		}
	});
	return result;
}

/** A section's title, as a parent issue's title. */
export function sectionTitle(doc: Y.Doc, section: string): string {
	const shape = shapesMap(doc).get(section);
	const title = shape?.get("title");
	return typeof title === "string" ? title.trim() : "";
}

// Blocked-by ------------------------------------------------------------------

/** One end of a connector, as something that can block or be blocked. */
export interface BlockEnd {
	shape: string | null;
	/** The item, or the pending issue a sticky will become. Absent if it can't be either. */
	target?: Target;
	/** How to show it: `#412`, or the sticky's first line. */
	label: string;
	/** Why it can't take part, when it can't. */
	problem?: "loose" | "pull" | "sticky" | "unsupported" | "loading";
	/** The card's key, for cards. */
	key?: string;
}

/**
 * Read a connector's ends as blocked-by candidates. `kindOf` says whether a
 * card is an issue or a pull request (undefined while it's loading).
 */
export function blockEnds(
	doc: Y.Doc,
	connector: string,
	kindOf: (key: string) => "issue" | "pull" | undefined,
): { from: BlockEnd; to: BlockEnd; arrow: "end" | "both" | "none" } | null {
	const shapes = shapesMap(doc);
	const raw = shapes.get(connector);
	const read = raw ? readConnector(readShape(raw)) : null;
	if (!read) return null;
	const end = (id: string | undefined): BlockEnd => {
		const shape = id ? shapes.get(id) : undefined;
		if (!id || !shape) return { shape: null, label: "nothing", problem: "loose" };
		const props = readShape(shape);
		if (props.type === "card" && props.ref) {
			const kind = kindOf(props.ref);
			const label = props.ref.slice(props.ref.search(/[#!]\d+$/));
			if (kind === "pull") return { shape: id, key: props.ref, label, problem: "pull" };
			if (kind === undefined) return { shape: id, key: props.ref, label, problem: "loading" };
			return { shape: id, key: props.ref, label, target: { key: props.ref } };
		}
		if (props.type === "sticky") {
			const label = issueFromText(props.text ?? "")?.title ?? "an empty sticky";
			const pending = pendingIssueFor(doc, id);
			return pending
				? { shape: id, label, target: { pending: pending.id } }
				: { shape: id, label, problem: "sticky" };
		}
		return { shape: id, label: props.type, problem: "unsupported" };
	};
	return { from: end(read.from.shape), to: end(read.to.shape), arrow: read.arrow };
}

const sameTarget = (a: Target, b: Target) =>
	"key" in a ? "key" in b && a.key === b.key : "pending" in b && a.pending === b.pending;

/**
 * Stage `blocked` as blocked by `blocker`, drawn by `connector`: once it's
 * written, the connector stands for the relationship. Staging the same link
 * twice returns the existing change.
 */
export function stageBlockedBy(
	doc: Y.Doc,
	link: { blocked: Target; blocker: Target; connector: string; shapes?: string[] },
	stager: Stager,
): string {
	for (const change of listChanges(doc)) {
		const op = change.op;
		if (
			op.kind === "item.blockedBy" &&
			LIVE.has(change.status) &&
			sameTarget(op.target, link.blocked) &&
			sameTarget(op.blockedBy, link.blocker)
		) {
			return change.id;
		}
	}
	return transactLocal(doc, () =>
		stageChange(
			doc,
			{ kind: "item.blockedBy", target: link.blocked, blockedBy: link.blocker },
			stager,
			{ shapes: link.shapes, effect: { kind: "connect", shape: link.connector } },
		),
	);
}

// Triage ------------------------------------------------------------------------

export type Triage =
	| { kind: "item.labels"; add?: string[]; remove?: string[] }
	| { kind: "item.assignees"; add?: string[]; remove?: string[] }
	| { kind: "item.milestone"; milestone: string | null }
	| { kind: "item.state"; state: "open" | "closed"; reason?: CloseReason };

export interface TriageTarget {
	/** The card's item key. */
	key: string;
	/** The card's shape, for highlighting. */
	shape?: string;
	/**
	 * Labels or assignees: what the item has on the forge now, so edits that
	 * would change nothing (removing a label it doesn't have) are dropped.
	 */
	current?: readonly string[];
}

const sameStager = (a: Stager, b: Stager) =>
	a.login || b.login ? a.login === b.login : a.name === b.name;

/** Merge two set edits: the later one wins for names in both. */
function mergeSets(
	before: { add?: string[]; remove?: string[] },
	after: { add?: string[]; remove?: string[] },
): { add: string[]; remove: string[] } {
	const add = new Set(before.add);
	const remove = new Set(before.remove);
	for (const name of after.add ?? []) {
		remove.delete(name);
		add.add(name);
	}
	for (const name of after.remove ?? []) {
		add.delete(name);
		remove.add(name);
	}
	return { add: [...add], remove: [...remove] };
}

function triageOp(triage: Triage, target: Target): Operation {
	switch (triage.kind) {
		case "item.labels":
		case "item.assignees":
			return {
				kind: triage.kind,
				target,
				...(triage.add?.length ? { add: triage.add } : {}),
				...(triage.remove?.length ? { remove: triage.remove } : {}),
			};
		case "item.milestone":
			return { kind: "item.milestone", target, milestone: triage.milestone };
		case "item.state":
			return {
				kind: "item.state",
				target,
				state: triage.state,
				...(triage.state === "closed" && triage.reason ? { reason: triage.reason } : {}),
			};
	}
}

/**
 * Stage a triage edit on each card's item. Your own staged edit of the same
 * kind on the same item is updated rather than duplicated: labels and
 * assignees merge (adding then removing a label cancels out, and an edit
 * that ends up empty is unstaged), milestones and open/closed are replaced.
 * Returns the ids of the changes staged or updated.
 */
export function stageTriage(
	doc: Y.Doc,
	targets: TriageTarget[],
	triage: Triage,
	stager: Stager,
	options: { batch?: Batcher } = {},
): string[] {
	const ids: string[] = [];
	const existing = listChanges(doc).filter(
		(change) =>
			change.status === "staged" &&
			change.op.kind === triage.kind &&
			"target" in change.op &&
			"key" in change.op.target &&
			sameStager(change.stagedBy, stager),
	);
	const batch = options.batch ?? new Batcher();
	transactLocal(doc, () => {
		const changes = changesMap(doc);
		for (const { key, shape, current } of targets) {
			const target: Target = { key };
			const mine = existing.find(
				(change) => "target" in change.op && sameTarget(change.op.target, target),
			);
			let op = triageOp(triage, target);
			if (mine && (op.kind === "item.labels" || op.kind === "item.assignees")) {
				const merged = mergeSets(mine.op as typeof op, op);
				if (current) {
					merged.add = merged.add.filter((name) => !current.includes(name));
					merged.remove = merged.remove.filter((name) => current.includes(name));
				}
				if (merged.add.length === 0 && merged.remove.length === 0) {
					unstageChanges(doc, [mine.id]);
					continue;
				}
				op = triageOp({ kind: op.kind, ...merged }, target);
			} else if (op.kind === "item.labels" || op.kind === "item.assignees") {
				if (!op.add?.length && !op.remove?.length) continue;
			}
			if (mine) {
				changes.get(mine.id)?.set("op", op);
				ids.push(mine.id);
			} else {
				ids.push(stageChange(doc, op, stager, { shapes: shape ? [shape] : undefined, batch }));
			}
		}
	});
	return ids;
}

/** Whether every item has it, some do, or none do. */
export type Presence = "all" | "some" | "none";

/** How many of the items have each name (a label, an assignee). */
export function presenceOf(sets: readonly (readonly string[])[], name: string): Presence {
	const count = sets.filter((set) => set.includes(name)).length;
	return count === 0 ? "none" : count === sets.length ? "all" : "some";
}

/**
 * What to add and remove so each item ends up as chosen: names chosen `all`
 * are added where missing, `none` removed where present, and `some` (left
 * mixed) untouched. Items that need nothing are left out.
 */
export function setEdits(
	items: { key: string; names: readonly string[] }[],
	chosen: ReadonlyMap<string, Presence>,
): { key: string; add: string[]; remove: string[] }[] {
	const out: { key: string; add: string[]; remove: string[] }[] = [];
	for (const item of items) {
		const add: string[] = [];
		const remove: string[] = [];
		for (const [name, presence] of chosen) {
			const has = item.names.includes(name);
			if (presence === "all" && !has) add.push(name);
			if (presence === "none" && has) remove.push(name);
		}
		if (add.length || remove.length) out.push({ key: item.key, add, remove });
	}
	return out;
}

/**
 * An item's labels or assignees as they'll be once staged and pushed
 * changes land: the forge's `names`, with every live edit applied in order.
 */
export function withStaged(
	doc: Y.Doc,
	key: string,
	kind: "item.labels" | "item.assignees",
	names: readonly string[],
): string[] {
	const out = new Set(names);
	for (const change of listChanges(doc)) {
		const op = change.op;
		if (op.kind !== kind || !LIVE.has(change.status) || change.status === "failed") continue;
		if (!("key" in op.target) || op.target.key !== key) continue;
		for (const name of op.add ?? []) out.add(name);
		for (const name of op.remove ?? []) out.delete(name);
	}
	return [...out];
}

/** Stage per-item set edits (labels or assignees), one change per item. */
export function stageSetEdits(
	doc: Y.Doc,
	kind: "item.labels" | "item.assignees",
	edits: {
		key: string;
		add: string[];
		remove: string[];
		shape?: string;
		/** What the item has on the forge now (see `TriageTarget`). */
		current?: readonly string[];
	}[],
	stager: Stager,
): string[] {
	const batch = new Batcher();
	return transactLocal(doc, () =>
		edits.flatMap(({ key, shape, current, add, remove }) =>
			stageTriage(doc, [{ key, shape, current }], { kind, add, remove }, stager, { batch }),
		),
	);
}

// Backlinks ---------------------------------------------------------------------

/** Stage a comment on each item. */
export function stageComments(
	doc: Y.Doc,
	comments: { key: string; body: string; shape?: string }[],
	stager: Stager,
): string[] {
	const batch = new Batcher();
	return transactLocal(doc, () =>
		comments.map(({ key, body, shape }) =>
			stageChange(doc, { kind: "item.comment", target: { key }, body }, stager, {
				shapes: shape ? [shape] : undefined,
				batch,
			}),
		),
	);
}

/** The repository keys of the cards on a board, most cards first. */
export function boardRepos(doc: Y.Doc): { repo: string; cards: number }[] {
	const counts = new Map<string, number>();
	for (const shape of shapesMap(doc).values()) {
		const ref = shape.get("ref");
		if (shape.get("type") !== "card" || typeof ref !== "string") continue;
		const repo = repoKeyOf(ref);
		counts.set(repo, (counts.get(repo) ?? 0) + 1);
	}
	return [...counts]
		.map(([repo, cards]) => ({ repo, cards }))
		.sort((a, b) => b.cards - a.cards || a.repo.localeCompare(b.repo));
}

/**
 * A repository someone typed or pasted: `owner/repo` (on `host`, the board's
 * usual forge), `host/owner/repo`, a URL of the repository or of anything in
 * it (an issue, a pull request, a file), or an item's key. Null unless it's
 * on a known forge.
 */
export function parseRepoInput(text: string, host: string): string | null {
	let trimmed = text
		.trim()
		.replace(/^https?:\/\//i, "")
		// A query, an anchor, or the item in a key (`owner/repo#12`, `…!3`).
		.replace(/[?#].*$/, "")
		.replace(/!\d+$/, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	// A link to something in a repository (an issue, a pull request, a file):
	// the repository it's in.
	const deep = trimmed.split("/");
	if (deep.length > 3 && forgeForHost(deep[0] ?? "")) trimmed = deep.slice(0, 3).join("/");
	const parts = trimmed.split("/");
	const name = /^[\w.-]+$/;
	if (parts.length === 2 && parts.every((part) => name.test(part))) {
		return forgeForHost(host) ? `${host}/${trimmed}`.toLowerCase() : null;
	}
	if (parts.length === 3 && parts.slice(1).every((part) => name.test(part))) {
		return forgeForHost(parts[0] ?? "") ? trimmed.toLowerCase() : null;
	}
	return null;
}
