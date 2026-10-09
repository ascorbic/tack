// Sessions: a signed, HTTP-only cookie holding a random session id. The
// Instance object stores only the id's hash, so sign-out and expiry are
// enforced server-side, and a leaked database can't be replayed as cookies.

import type { Viewer } from "../identity.ts";
import { type Lookup, SESSION_TTL, type SessionInfo } from "../instance.ts";
import { instance } from "../namespaces.ts";
import { clearCookie, readCookie, serializeCookie } from "./cookies.ts";
import { sign, unsign } from "./crypto.ts";

export const SESSION_COOKIE = "tack_session";

const lookups = new WeakMap<Request, Promise<Lookup>>();
const sessions = new WeakMap<Viewer, SessionInfo>();

/** The raw session id from a request's cookie, if its signature checks out. */
export function sessionId(request: Request, env: Env): Promise<string | null> {
	if (!env.TACK_SECRET) return Promise.resolve(null);
	return unsign<string>(env.TACK_SECRET, "session", readCookie(request, SESSION_COOKIE));
}

/**
 * Who's making this request and whether access control is on, in one call
 * to the Instance object, memoised per request.
 */
export function lookupRequest(request: Request, env: Env): Promise<Lookup> {
	let lookup = lookups.get(request);
	if (!lookup) {
		lookup = (async () => {
			const result = await instance(env).lookup(await sessionId(request, env));
			if (result.session) sessions.set(result.session.viewer, result.session);
			return result;
		})();
		lookups.set(request, lookup);
	}
	return lookup;
}

/** The session info `lookupRequest` found for this viewer, if it came from there. */
export function knownSession(viewer: Viewer): SessionInfo | undefined {
	return sessions.get(viewer);
}

export async function sessionCookie(request: Request, secret: string, id: string): Promise<string> {
	const maxAge = Math.floor(SESSION_TTL / 1000);
	const value = await sign(secret, "session", id, maxAge);
	return serializeCookie(request, SESSION_COOKIE, value, { maxAge });
}

export function clearSessionCookie(request: Request): string {
	return clearCookie(request, SESSION_COOKIE);
}
