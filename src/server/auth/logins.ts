// GitHub logins: normalising allowlist entries, and dev sign-in users' ids.

const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;

/** Normalise a list of GitHub logins: trimmed, without `@`, lowercase, unique. */
export function normaliseLogins(logins: string[]): { valid: string[]; invalid: string[] } {
	const valid = new Set<string>();
	const invalid: string[] = [];
	for (const raw of logins) {
		const login = raw.trim().replace(/^@/, "").toLowerCase();
		if (!login) continue;
		if (LOGIN.test(login)) valid.add(login);
		else invalid.push(raw);
	}
	return { valid: [...valid].sort(), invalid };
}

/** A stable, negative id for dev users, so they never collide with GitHub's. */
export function devUserId(login: string): number {
	let hash = 0x811c9dc5;
	for (const char of login.toLowerCase()) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return -((hash >>> 0) % 2_000_000_000) - 1;
}
