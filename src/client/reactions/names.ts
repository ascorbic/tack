import { peopleSource } from "../comments/people.ts";
import type { User } from "../presence.ts";

// The names Tack knows for GitHub logins, for naming who reacted: people on
// the board now (presence), then the board's members and recent visitors
// (`peopleSource`, its user records). A forge's reactor who isn't any of
// these is named as the forge names them, or by their login.

/** Names of people on the board now, by lowercase login. Kept up by `usePresence`. */
const present = new Map<string, string>();

/** Note who's on the board now (everyone with a login), for `knownName`. */
export function notePresent(users: readonly (User | undefined)[]): void {
	for (const user of users) {
		if (user?.login && user.name) present.set(user.login.toLowerCase(), user.name);
	}
}

/** The name Tack knows for a login, if it knows one. */
export function knownName(login: string): string | null {
	const lower = login.toLowerCase();
	const here = present.get(lower);
	if (here) return here;
	const person = peopleSource.get().find((p) => p.login.toLowerCase() === lower);
	return person?.name || null;
}

/** Your own login, for naming you "You" among a forge's reactors. */
export function selfLogin(): string | undefined {
	return peopleSource.self;
}
