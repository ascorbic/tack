import type * as Y from "yjs";
import { parseRepoKey, repoKeyOf } from "./refs.ts";

// Volunteers: people putting their hand up for something on the board ("✋
// I'll take it"), so a planning session can see who's doing what before
// anything's assigned on the forge. An issue's or pull request's card, a
// discussion's, or a sticky can have them.
//
// They're board data only. Nothing here writes to the forge: "Assign
// volunteers" stages an ordinary `item.assignees` change (`planAssignments`,
// then `stageSetEdits`), and a sticky's volunteers become the assignees of
// the issue "Make issue" stages from it (`stickyAssignees`). Either is
// written only when someone pushes.
//
// The document keeps them in their own root map, as stamps are kept, so two
// people volunteering at once never conflict:
//
// | map        | key                     | value                                  |
// | ---------- | ----------------------- | -------------------------------------- |
// | volunteers | `{shape}\n@{login}`     | `Volunteer`: the shape, who (login,    |
// |            | (login in lower case)   | name, colour, avatar) and when         |
//
// Only people signed in volunteer: a volunteer is a GitHub login, which is
// what makes one assignable. Deleting a shape leaves its volunteers behind,
// unread, so undoing the delete brings them back; when a sticky becomes its
// issue's card, the push moves them onto the card (`moveVolunteers`).
//
// A volunteer the item has as an assignee is shown as one, among the card's
// assignees, rather than as a volunteer: so once "Assign volunteers" is
// pushed and lands, the volunteers chip empties into the assignees, and it
// does the same when someone assigns them on GitHub.

/** Someone who's put their hand up for a shape. */
export interface Volunteer {
	shape: string;
	/** Their GitHub login, as they signed in. */
	login: string;
	name: string;
	color: string;
	/** Their avatar, when their sign-in has one. */
	avatar?: string;
	/** When they volunteered, ISO 8601. */
	at: string;
}

/** Who's volunteering: you, as you're signed in. */
export interface VolunteerPerson {
	login?: string;
	name: string;
	color: string;
	avatarUrl?: string;
}

/** GitHub can't assign an issue to more people than this. */
export const MAX_ASSIGNEES = 10;

export function volunteersMap(doc: Y.Doc): Y.Map<Volunteer> {
	return doc.getMap("volunteers");
}

/** The key for one person's hand up on one shape. */
export function volunteerKey(shape: string, login: string): string {
	return `${shape}\n@${login.toLowerCase()}`;
}

export function isVolunteer(value: unknown): value is Volunteer {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Partial<Volunteer>;
	return (
		typeof v.shape === "string" &&
		typeof v.login === "string" &&
		v.login !== "" &&
		typeof v.name === "string" &&
		typeof v.at === "string"
	);
}

/** Whether two logins are the same person: GitHub's aren't case-sensitive. */
export function sameLogin(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

const has = (logins: readonly string[], login: string) => logins.some((l) => sameLogin(l, login));

/**
 * Put your hand up for a shape, or take it down if it's up. Returns whether
 * it's up now. Only signed-in people can (it needs a login): for anyone
 * else it does nothing and returns false. Call inside `transactLocal` so
 * it can be undone.
 */
export function toggleVolunteer(
	doc: Y.Doc,
	shape: string,
	person: VolunteerPerson,
	at = new Date().toISOString(),
): boolean {
	if (!person.login) return false;
	const map = volunteersMap(doc);
	const key = volunteerKey(shape, person.login);
	if (map.has(key)) {
		map.delete(key);
		return false;
	}
	map.set(key, {
		shape,
		login: person.login,
		name: person.name || person.login,
		color: person.color,
		...(person.avatarUrl && person.avatarUrl.startsWith("https://")
			? { avatar: person.avatarUrl }
			: {}),
		at,
	});
	return true;
}

/** Volunteers by shape, each shape's in the order they put their hands up. */
export function readVolunteers(entries: Iterable<[string, unknown]>): Map<string, Volunteer[]> {
	const out = new Map<string, Volunteer[]>();
	for (const [, value] of entries) {
		if (!isVolunteer(value)) continue;
		const list = out.get(value.shape);
		if (list) list.push(value);
		else out.set(value.shape, [value]);
	}
	for (const list of out.values()) {
		list.sort((a, b) => (a.at === b.at ? a.login.localeCompare(b.login) : a.at < b.at ? -1 : 1));
	}
	return out;
}

/** One shape's volunteers, in the order they put their hands up. */
export function volunteersOn(doc: Y.Doc, shape: string): Volunteer[] {
	return readVolunteers(volunteersMap(doc).entries()).get(shape) ?? [];
}

/**
 * Move volunteers from shapes onto another: a sticky's onto the card it
 * became. Someone on both keeps the earlier hand. Call inside the
 * transaction that replaces the shapes.
 */
export function moveVolunteers(doc: Y.Doc, from: ReadonlySet<string>, to: string): number {
	const map = volunteersMap(doc);
	let moved = 0;
	// A copy: the map changes as they move.
	const entries = Array.from(map.entries());
	for (const [key, value] of entries) {
		if (!isVolunteer(value) || !from.has(value.shape)) continue;
		map.delete(key);
		const next = volunteerKey(to, value.login);
		const there = map.get(next);
		if (!there || !isVolunteer(there) || there.at > value.at) {
			map.set(next, { ...value, shape: to });
		}
		moved++;
	}
	return moved;
}

/** Volunteers of shapes that no longer exist. For tidying, never needed for reading. */
export function staleVolunteers(doc: Y.Doc, shapes: { has(id: string): boolean }): string[] {
	const stale: string[] = [];
	for (const [key, value] of volunteersMap(doc)) {
		if (!isVolunteer(value) || !shapes.has(value.shape)) stale.push(key);
	}
	return stale;
}

/**
 * Whether a repository's people are GitHub logins, as volunteers are:
 * GitHub's, and the test forge that stands in for it. On other forges a
 * login can be someone else's, so volunteers there aren't assigned.
 */
export function assignsByLogin(repo: string): boolean {
	const forge = parseRepoKey(repoKeyOf(repo))?.forge;
	return forge === "github" || forge === "fake";
}

/** Why a volunteer isn't in an assignment. */
export type LeftOutReason =
	/** The item has them already, or they're staged. */
	| "assigned"
	/** The repository doesn't let them be assigned. */
	| "unassignable"
	/** The item has as many assignees as GitHub allows. */
	| "full";

/** One item to assign its volunteers to. */
export interface AssignTarget {
	/** The item's key. */
	key: string;
	/** Its card, for the change's highlight. */
	shape: string;
	volunteers: readonly Volunteer[];
	/** Who it has on the forge now. */
	current: readonly string[];
	/** Who it'll have once what's staged lands (`withStaged`): those aren't added again. */
	staged: readonly string[];
	/**
	 * Who the repository lets be assigned, when that's known; null when it
	 * isn't (they're tried, and the push says if one can't be).
	 */
	assignable: readonly string[] | null;
}

export interface AssignPlan {
	/** Assignees to add, per item; items with nobody to add are left out. */
	edits: { key: string; shape: string; add: string[]; current: string[] }[];
	/** Volunteers left out, and why. */
	leftOut: { key: string; volunteer: Volunteer; reason: LeftOutReason }[];
}

/**
 * Who "Assign volunteers" adds to each item: every volunteer it doesn't
 * have (or have staged), who the repository lets be assigned, up to
 * GitHub's limit. It only ever adds: whoever's assigned stays.
 */
export function planAssignments(targets: readonly AssignTarget[]): AssignPlan {
	const plan: AssignPlan = { edits: [], leftOut: [] };
	for (const target of targets) {
		const add: string[] = [];
		const total = new Set(target.staged.map((l) => l.toLowerCase()));
		for (const volunteer of target.volunteers) {
			let reason: LeftOutReason | null = null;
			if (has(target.staged, volunteer.login) || has(add, volunteer.login)) reason = "assigned";
			else if (target.assignable && !has(target.assignable, volunteer.login))
				reason = "unassignable";
			else if (total.size >= MAX_ASSIGNEES) reason = "full";
			if (reason) {
				if (reason !== "assigned") plan.leftOut.push({ key: target.key, volunteer, reason });
				continue;
			}
			add.push(volunteer.login);
			total.add(volunteer.login.toLowerCase());
		}
		if (add.length > 0) {
			plan.edits.push({ key: target.key, shape: target.shape, add, current: [...target.current] });
		}
	}
	return plan;
}

/**
 * The people a sticky's issue is made with: the assignees picked for every
 * new issue, then the sticky's volunteers the repository lets be assigned
 * (`assignable`, when known), up to GitHub's limit.
 */
export function stickyAssignees(
	volunteers: readonly Volunteer[],
	repo: string,
	picked: readonly string[],
	assignable: readonly string[] | null,
): string[] {
	const out = [...picked];
	if (!assignsByLogin(repo)) return out;
	for (const volunteer of volunteers) {
		if (out.length >= MAX_ASSIGNEES) break;
		if (has(out, volunteer.login)) continue;
		if (assignable && !has(assignable, volunteer.login)) continue;
		out.push(volunteer.login);
	}
	return out;
}

/** Who's volunteered, you first (it's who you look for): "You, Kai Andersen". */
export function namesInWords(volunteers: readonly Volunteer[], me: string | null): string {
	const names = volunteers.map((v) => (me && sameLogin(v.login, me) ? "You" : v.name));
	const you = names.indexOf("You");
	if (you > 0) names.unshift(...names.splice(you, 1));
	return names.join(", ");
}
