import type * as Y from "yjs";
import {
	canWrite,
	itemsInWords,
	setEditsInWords,
	stageSetEdits,
	withStaged,
} from "../../shared/actions.ts";
import type { Card } from "../../shared/cards.ts";
import type { Stager } from "../../shared/changes.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import {
	type AssignPlan,
	type AssignTarget,
	type Unassigned,
	type Volunteer,
	assignsByLogin,
	planAssignments,
	sameLogin,
} from "../../shared/volunteers.ts";
import { repoName } from "../actions/selection.ts";

// "Assign volunteers", from a card's volunteers chip or the selection bar:
// stage each card's volunteers as its assignees (planAssignments in
// volunteers.ts), as one undoable step, like the Assign picker does.

/** A card with volunteers, as the bar or the card knows it. */
export interface VolunteeredCard {
	shape: string;
	card: Card;
	volunteers: readonly Volunteer[];
}

/** A volunteer as their card shows them: still volunteering, or staged to be assigned. */
export interface ShownVolunteer extends Volunteer {
	staged?: boolean;
}

/**
 * Whether a card's item can take its volunteers as assignees at all: an
 * issue or pull request Tack can write to, on GitHub (where a volunteer's
 * login is theirs), in a repository that takes assignees.
 */
export function canAssign(card: Card, meta: RepoMeta | null | undefined): boolean {
	return (
		card.kind !== "discussion" &&
		card.writable !== false &&
		assignsByLogin(repoKeyOf(card.key)) &&
		canWrite(meta, "item.assignees")
	);
}

/**
 * A card's volunteers as it shows them: those its item has as assignees
 * are shown among them instead, and those staged to be are marked.
 */
export function shownVolunteers(
	doc: Y.Doc,
	card: Card | null,
	volunteers: readonly Volunteer[],
): ShownVolunteer[] {
	if (!card || card.kind === "discussion") return [...volunteers];
	const current = card.assignees.map((a) => a.login);
	const staged = withStaged(doc, card.key, "item.assignees", current);
	return volunteers.flatMap((v) => {
		if (current.some((login) => sameLogin(login, v.login))) return [];
		return [staged.some((login) => sameLogin(login, v.login)) ? { ...v, staged: true } : v];
	});
}

/** Each card's assignment, with what the repository lets be assigned (`metaOf`, when known). */
export function planFor(
	doc: Y.Doc,
	cards: readonly VolunteeredCard[],
	metaOf: (repo: string) => RepoMeta | null | undefined,
): AssignPlan {
	const targets: AssignTarget[] = cards.flatMap(({ shape, card, volunteers }) => {
		const meta = metaOf(repoKeyOf(card.key));
		if (!canAssign(card, meta) || volunteers.length === 0) return [];
		const current = card.assignees.map((a) => a.login);
		return [
			{
				key: card.key,
				shape,
				volunteers,
				current,
				staged: withStaged(doc, card.key, "item.assignees", current),
				assignable: meta?.assignees ?? null,
			},
		];
	});
	return planAssignments(targets);
}

/** Why some volunteers weren't staged, in a sentence; empty when none were left out. */
export function leftOutInWords(plan: AssignPlan): string {
	const unassignable = new Map<string, string[]>();
	const full: string[] = [];
	for (const { key, volunteer, reason } of plan.leftOut) {
		if (reason === "full") {
			if (!full.includes(key)) full.push(key);
			continue;
		}
		const repo = repoName(repoKeyOf(key));
		const names = unassignable.get(repo) ?? [];
		if (!names.includes(volunteer.name)) names.push(volunteer.name);
		unassignable.set(repo, names);
	}
	const parts = [...unassignable].map(
		([repo, names]) =>
			`${names.length > 2 ? `${names.length} volunteers` : names.join(" and ")} can’t be assigned in ${repo}`,
	);
	if (full.length > 0) {
		parts.push(
			`${itemsInWords(full)} ${full.length === 1 ? "has" : "have"} as many assignees as GitHub allows`,
		);
	}
	return parts.join("; ");
}

/**
 * Stage the plan as one undoable step. Returns what to say: what was
 * staged, and who was left out and why.
 */
export function stagePlan(
	doc: Y.Doc,
	plan: AssignPlan,
	stager: Stager,
): { staged: number; message: string } {
	const why = leftOutInWords(plan);
	if (plan.edits.length === 0) {
		return {
			staged: 0,
			message: why ? `Nothing staged: ${why}` : "Every volunteer is assigned already",
		};
	}
	// Marked as volunteers, so withdrawing takes them back out.
	const ids = stageSetEdits(
		doc,
		"item.assignees",
		plan.edits.map((edit) => ({ ...edit, remove: [], volunteered: edit.add })),
		stager,
	);
	const staged = setEditsInWords(
		"item.assignees",
		plan.edits.map((edit) => ({ ...edit, remove: [] })),
	);
	return { staged: ids.length, message: why ? `${staged}. ${why}` : staged };
}

/**
 * What withdrawing took back, for its toast: "Withdrawn — no longer staged
 * to assign you to #412", or to the new issue a sticky becomes.
 */
export function withdrawnInWords(unassigned: readonly Unassigned[]): string {
	const keys = [...new Set(unassigned.flatMap((u) => (u.key ? [u.key] : [])))];
	const what = keys.length > 0 ? itemsInWords(keys) : "the sticky’s new issue";
	return `Withdrawn — no longer staged to assign you to ${what}`;
}
