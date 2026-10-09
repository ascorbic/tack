import * as Y from "yjs";
import {
	type ChangeStatus,
	type Operation,
	type PendingChange,
	type Stager,
	changesMap,
	readChange,
	stageChange,
} from "./changes.ts";
import { isEnd } from "./connectors.ts";
import {
	type Author,
	type DecisionStatus,
	LOCAL_ORIGIN,
	type ShapeProps,
	type Vote,
	type VoteChoice,
	nextZ,
	shapesMap,
} from "./shapes.ts";

// Decisions: a title and body, a status (proposed → decided → superseded),
// votes from people on the board, and items linked with connectors. These
// are the document edits; adr.ts turns a decision into a record to write
// back.
//
// Votes are a nested Y.Map keyed by voter, each value a whole `Vote`, so two
// people voting at once both count, and changing your mind replaces your
// own vote rather than adding another. The map is made with the decision,
// never lazily: two clients creating it at once would each make their own,
// and one would win and drop the other's vote.

export type { DecisionStatus, Vote, VoteChoice };

export const DECISION_STATUSES: readonly DecisionStatus[] = ["proposed", "decided", "superseded"];

/**
 * A decision's properties that a copy doesn't take: its write-back and the
 * pull request that wrote it belong to the original.
 */
export const DECISION_UNCOPIED: readonly string[] = ["writeback", "ref"];

/** Who's voting: the signed-in login when there is one, else a name. */
export interface Voter {
	name: string;
	color?: string;
	login?: string;
}

/**
 * The key a person's vote is stored under: their login (case-insensitive,
 * as GitHub's are), or for signed-out editors their name.
 */
export function voterKey(voter: Voter): string {
	return voter.login ? `@${voter.login.toLowerCase()}` : `~${voter.name}`;
}

export interface NewDecision {
	x: number;
	y: number;
	title?: string;
	text?: string;
	author?: Author;
	status?: DecisionStatus;
	parent?: string | null;
}

/** Add a decision with its (empty) votes map. Wrap in a transaction to set its origin. */
export function addDecision(doc: Y.Doc, id: string, decision: NewDecision): void {
	doc.transact(() => {
		const shape = new Y.Map<unknown>();
		shape.set("type", "decision");
		shape.set("x", Math.round(decision.x));
		shape.set("y", Math.round(decision.y));
		shape.set("z", nextZ(doc));
		shape.set("parent", decision.parent ?? null);
		shape.set("title", decision.title ?? "");
		shape.set("text", decision.text ?? "");
		shape.set("status", decision.status ?? "proposed");
		if (decision.author) shape.set("author", decision.author);
		shape.set("votes", new Y.Map<Vote>());
		shapesMap(doc).set(id, shape);
	});
}

function decisionMap(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
	const shape = shapesMap(doc).get(id);
	return shape?.get("type") === "decision" ? shape : undefined;
}

function votesMap(shape: Y.Map<unknown>): Y.Map<Vote> {
	const votes = shape.get("votes");
	if (votes instanceof Y.Map) return votes as Y.Map<Vote>;
	// Only reached for a decision made without one (see the note above).
	const fresh = new Y.Map<Vote>();
	for (const [key, vote] of Object.entries(readVotes(votes))) fresh.set(key, vote);
	shape.set("votes", fresh);
	return fresh;
}

/**
 * Cast, change or withdraw (`null`) a vote, as a local edit. Votes are only
 * taken while a decision is proposed.
 */
export function castVote(
	doc: Y.Doc,
	id: string,
	voter: Voter,
	choice: VoteChoice | null,
	origin: unknown = LOCAL_ORIGIN,
): void {
	doc.transact(() => {
		const shape = decisionMap(doc, id);
		if (!shape || (shape.get("status") ?? "proposed") !== "proposed") return;
		const votes = votesMap(shape);
		const key = voterKey(voter);
		if (choice === null) {
			if (votes.has(key)) votes.delete(key);
			return;
		}
		const vote: Vote = { choice, name: voter.name, at: new Date().toISOString() };
		if (voter.color) vote.color = voter.color;
		if (voter.login) vote.login = voter.login;
		votes.set(key, vote);
	}, origin);
}

function isVote(value: unknown): value is Vote {
	if (typeof value !== "object" || value === null) return false;
	const { choice, name } = value as Partial<Vote>;
	return (choice === "agree" || choice === "disagree") && typeof name === "string";
}

/** Votes from a shape's `votes` (as read with `readShape`), skipping anything malformed. */
export function readVotes(value: unknown): Record<string, Vote> {
	const source =
		value instanceof Y.Map ? (value.toJSON() as Record<string, unknown>) : (value ?? {});
	if (typeof source !== "object") return {};
	const out: Record<string, Vote> = {};
	for (const [key, vote] of Object.entries(source as Record<string, unknown>)) {
		if (isVote(vote)) out[key] = vote;
	}
	return out;
}

export interface Tally {
	agree: Vote[];
	disagree: Vote[];
	total: number;
}

/** Votes counted by choice, earliest first within each. */
export function tally(votes: Record<string, Vote> | undefined): Tally {
	const all = Object.values(readVotes(votes)).sort((a, b) =>
		a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
	);
	const agree = all.filter((vote) => vote.choice === "agree");
	const disagree = all.filter((vote) => vote.choice === "disagree");
	return { agree, disagree, total: all.length };
}

/** A decision's status, defaulting anything unknown to proposed. */
export function statusOf(shape: Pick<ShapeProps, "status">): DecisionStatus {
	return DECISION_STATUSES.includes(shape.status as DecisionStatus)
		? (shape.status as DecisionStatus)
		: "proposed";
}

/**
 * Move a decision to a new status, as a local edit. Deciding records when
 * and by whom; going back to proposed clears that; superseding records
 * which decision superseded it, if one's given.
 */
export function setDecisionStatus(
	doc: Y.Doc,
	id: string,
	status: DecisionStatus,
	{ by, supersededBy }: { by?: Author; supersededBy?: string } = {},
	origin: unknown = LOCAL_ORIGIN,
): void {
	doc.transact(() => {
		const shape = decisionMap(doc, id);
		if (!shape) return;
		if (shape.get("status") !== status) shape.set("status", status);
		if (status === "decided") {
			shape.set("decidedAt", new Date().toISOString());
			if (by) shape.set("decidedBy", by);
		} else if (status === "proposed") {
			if (shape.has("decidedAt")) shape.delete("decidedAt");
			if (shape.has("decidedBy")) shape.delete("decidedBy");
		}
		if (status === "superseded" && supersededBy && supersededBy !== id) {
			shape.set("supersededBy", supersededBy);
		} else if (status !== "superseded" && shape.has("supersededBy")) {
			shape.delete("supersededBy");
		}
	}, origin);
}

/** Connector ends' shapes, for each connector touching `id`. */
function neighbours(shapes: ReadonlyMap<string, ShapeProps>, id: string): string[] {
	const out: string[] = [];
	for (const shape of shapes.values()) {
		if (shape.type !== "connector") continue;
		const from = isEnd(shape.from) ? shape.from.shape : undefined;
		const to = isEnd(shape.to) ? shape.to.shape : undefined;
		if (from === id && to && to !== id) out.push(to);
		else if (to === id && from && from !== id) out.push(from);
	}
	return out;
}

/**
 * The items a decision is linked to: the cards at the other end of any
 * connector touching it, either way round, by card key, without repeats.
 */
export function linkedItems(shapes: ReadonlyMap<string, ShapeProps>, id: string): string[] {
	const keys = new Set<string>();
	for (const other of neighbours(shapes, id)) {
		const shape = shapes.get(other);
		if (shape?.type === "card" && typeof shape.ref === "string") keys.add(shape.ref);
	}
	return [...keys];
}

/** Other decisions on the board, for choosing what superseded this one. */
export function otherDecisions(
	shapes: ReadonlyMap<string, ShapeProps>,
	id: string,
): { id: string; title: string; status: DecisionStatus }[] {
	const out: { id: string; title: string; status: DecisionStatus }[] = [];
	for (const [other, shape] of shapes) {
		if (other === id || shape.type !== "decision") continue;
		out.push({ id: other, title: shape.title ?? "", status: statusOf(shape) });
	}
	return out;
}

/**
 * The write-back staged for a decision, if it's still in the board's
 * changes. A write-back that was unstaged is simply gone, and the decision
 * can be written back again.
 */
export function writeBackOf(
	doc: Y.Doc,
	shape: Pick<ShapeProps, "writeback">,
): PendingChange | null {
	if (!shape.writeback) return null;
	const change = changesMap(doc).get(shape.writeback);
	return change ? readChange(change) : null;
}

/**
 * Stage writing a decision back, and remember the change on the decision:
 * one local edit, so undo takes back both.
 */
export function stageWriteBack(
	doc: Y.Doc,
	id: string,
	op: Operation,
	stagedBy: Stager,
): string | null {
	let changeId: string | null = null;
	doc.transact(() => {
		const shape = decisionMap(doc, id);
		if (!shape) return;
		changeId = stageChange(doc, op, stagedBy, { shapes: [id] });
		shape.set("writeback", changeId);
	}, LOCAL_ORIGIN);
	return changeId;
}

/** Statuses at which a write-back is on its way or done, so it can't be staged again. */
export function isWriteBackActive(status: ChangeStatus | undefined): boolean {
	return status !== undefined && status !== "failed";
}

/** Transaction origin for `linkWrittenDecisions`: derived state, never undone. */
export const DECISION_LINK_ORIGIN = "decision-link";

/**
 * Point each decision whose record was written as a pull request at that
 * pull request (`ref`), once the write-back is applied. The decision then
 * shows the pull request's live state, as the board fetches and follows
 * every `ref` (see `cardRefs`), and keeps its link even after the applied
 * change is cleared from the board's changes.
 *
 * The client runs this when it sees a write-back applied; the board's
 * Durable Object can run it after applying changes too. It's idempotent and
 * only writes what's missing. Returns how many decisions it linked.
 */
export function linkWrittenDecisions(doc: Y.Doc, origin: unknown = DECISION_LINK_ORIGIN): number {
	let linked = 0;
	const changes = changesMap(doc);
	doc.transact(() => {
		for (const shape of shapesMap(doc).values()) {
			if (shape.get("type") !== "decision") continue;
			const writeback = shape.get("writeback");
			if (typeof writeback !== "string") continue;
			const change = changes.get(writeback);
			if (!change || change.get("status") !== "applied") continue;
			const op = change.get("op") as Operation | undefined;
			const key = (change.get("result") as PendingChange["result"])?.key;
			if (op?.kind !== "pr.create" || !key || shape.get("ref") === key) continue;
			shape.set("ref", key);
			linked++;
		}
	}, origin);
	return linked;
}
