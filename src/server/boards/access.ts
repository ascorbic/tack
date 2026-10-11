// Who can do what on a board. One pure function decides, used both by the
// Directory (when someone opens a board or lists boards) and by the board's
// own Durable Object (when membership changes under live connections).
//
// Board roles only decide what someone can do with the board itself: open
// it, edit it, share it. They never grant access to repo data. Filtering
// what each viewer sees of private repos is per viewer, on top of this
// (#10): see `Board.cardsFor`.

import type { MemberRole, Role, Visibility } from "../../shared/boards.ts";
import type { Viewer } from "../identity.ts";

/** Who's asking, as far as boards are concerned. */
export interface Visitor {
	/** Signed in as. */
	user: Viewer | null;
	/**
	 * Whether they may use this instance: signed in and allowed, or anyone
	 * at all before the GitHub App is set up (and on Previews).
	 */
	allowed: boolean;
	/** Whether they're one of the instance's admins (who may delete anyone's templates). */
	admin?: boolean;
}

/** The parts of a board that decide access. */
export interface Policy {
	ownerId: number | null;
	visibility: Visibility;
	instanceRole: MemberRole;
	archived: boolean;
	/** Whether custom widgets' code runs on the board (#66). Never decides access. */
	customWidgets?: boolean;
	/** Members' roles by user id, the owner included. Pending invites aren't here. */
	members: Record<number, Role>;
}

/** Just who someone is, for checking a policy: what a live connection remembers. */
export interface VisitorKey {
	userId: number | null;
	allowed: boolean;
}

export function visitorKey(visitor: Visitor): VisitorKey {
	return { userId: visitor.user?.id ?? null, allowed: visitor.allowed };
}

/**
 * Someone's role before archiving is taken into account. Membership needs
 * instance access too: the instance's allowlist is the outer gate, and
 * only public boards reach past it.
 */
export function baseRole(policy: Policy, who: VisitorKey): Role | null {
	if (who.allowed) {
		const member = who.userId === null ? undefined : policy.members[who.userId];
		if (member) return member;
		if (policy.visibility !== "private") return policy.instanceRole;
	}
	return policy.visibility === "public" ? "viewer" : null;
}

/** What someone can do on the board right now. Archived boards are read-only. */
export function roleFor(policy: Policy, who: VisitorKey): Role | null {
	const role = baseRole(policy, who);
	return role && policy.archived ? "viewer" : role;
}

/**
 * Whether someone can share the board, change its visibility, and archive
 * it: its owner, or any editor of a board with no owner (made by a guest
 * where there's no sign-in, as on Previews).
 */
export function canManage(policy: Policy, who: VisitorKey): boolean {
	const role = baseRole(policy, who);
	return role === "owner" || (policy.ownerId === null && role === "editor");
}
