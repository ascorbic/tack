import type { BoardMember, PersonLookup } from "../../shared/boards.ts";

// Reading the Share dialog's invite field: GitHub logins, separated by
// spaces or commas, `@` optional. Pure, so it's unit-tested.

export const LOGIN = /^@?[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const SEPARATOR = /[\s,]+/;

export interface ParsedInvite {
	/** Every login typed, as typed (`@` dropped), the first of each kept. */
	logins: string[];
	/** Those that can't be GitHub logins. */
	invalid: string[];
	/**
	 * The login still being typed (no separator after it yet), which
	 * suggestions complete. Null after a separator, or in an empty field.
	 */
	current: string | null;
	/** The login being typed is one typed out earlier, too. */
	currentRepeats: boolean;
}

export function parseInvite(text: string): ParsedInvite {
	const parts = text.split(SEPARATOR).filter(Boolean);
	const typing = text.length > 0 && !SEPARATOR.test(text.at(-1) ?? "");
	const seen = new Set<string>();
	const logins: string[] = [];
	const invalid: string[] = [];
	for (const part of parts) {
		if (!LOGIN.test(part)) {
			invalid.push(part);
			continue;
		}
		const login = part.replace(/^@/, "");
		if (seen.has(login.toLowerCase())) continue;
		seen.add(login.toLowerCase());
		logins.push(login);
	}
	const last = parts.at(-1);
	const current = typing && last !== undefined ? last.replace(/^@/, "") : null;
	const key = current?.toLowerCase();
	return {
		logins,
		invalid,
		current,
		currentRepeats:
			key !== undefined &&
			parts.slice(0, -1).some((part) => part.replace(/^@/, "").toLowerCase() === key),
	};
}

/** The field with the login being typed replaced by a suggestion, ready for the next. */
export function completeInvite(text: string, login: string): string {
	const typing = text.length > 0 && !SEPARATOR.test(text.at(-1) ?? "");
	const kept = typing ? text.replace(/[^\s,]+$/, "") : text;
	const joined = kept.trim() ? `${kept.replace(/[\s,]*$/, "")}, ` : "";
	return `${joined}${login}, `;
}

/** The logins that are done being typed: what the preview shows. */
export function finishedLogins(parsed: ParsedInvite): string[] {
	if (parsed.current === null) return parsed.logins;
	const current = parsed.current.toLowerCase();
	// The one still being typed, unless it repeats one already typed out.
	return parsed.currentRepeats
		? parsed.logins
		: parsed.logins.filter((login) => login.toLowerCase() !== current);
}

/** “a”, “b” */
export function quoted(logins: string[]): string {
	return `“${logins.join("”, “")}”`;
}

/** Logins GitHub has no user by (or that are organisations, which can't be invited). */
export function notOnGitHub(logins: string[]): string {
	return `${quoted(logins)} ${logins.length === 1 ? "isn’t a GitHub user" : "aren’t GitHub users"}. Check the spelling?`;
}

/** A stable number for a login, for a colour before we know who they are. */
export function loginHash(login: string): number {
	let hash = 0;
	for (const char of login) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
	return hash;
}

/** Logins an invite can't go to: GitHub has no such user, or it's an organisation. */
export function refused(lookups: (PersonLookup | null | undefined)[]): string[] {
	return lookups
		.filter((lookup): lookup is PersonLookup => Boolean(lookup))
		.filter((lookup) => lookup.status === "unknown" || lookup.status === "organization")
		.map((lookup) => lookup.login);
}

export type InviteTone = "ok" | "warn" | "bad" | "quiet";

/** What the preview says about someone about to be invited. */
export function describeInvitee(
	login: string,
	lookup: PersonLookup | "checking" | undefined,
	member: BoardMember | undefined,
): { note: string; tone: InviteTone } {
	if (member) {
		return member.role === "owner"
			? { note: "Owns this board", tone: "quiet" }
			: { note: "Already here: this changes what they can do", tone: "quiet" };
	}
	if (lookup === "checking") return { note: "Checking GitHub…", tone: "quiet" };
	if (!lookup || lookup.status === "unchecked") return { note: `@${login}`, tone: "quiet" };
	switch (lookup.status) {
		case "unknown":
			return { note: "No GitHub user by that name", tone: "bad" };
		case "organization":
			return { note: "That’s an organisation, not a person", tone: "bad" };
		case "known":
			return lookup.allowed === false
				? { note: "Can’t sign in to this Tack yet: an admin needs to let them in", tone: "warn" }
				: { note: "On this Tack", tone: "ok" };
		case "github":
			return { note: "Hasn’t used Tack yet", tone: "ok" };
	}
}
