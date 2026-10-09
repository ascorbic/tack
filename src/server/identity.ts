// Who is making a request. Sessions live in the Instance Durable Object and
// are carried by a signed cookie (see `auth/session.ts`).

import { lookupRequest } from "./auth/session.ts";
import { instance } from "./namespaces.ts";

export { canUseInstance } from "./auth/access.ts";

export interface Viewer {
	/** GitHub user id. Dev sign-in (`/auth/dev`) users have negative ids. */
	id: number;
	login: string;
	name: string | null;
	avatarUrl: string;
}

/** The signed-in viewer for a request (HTTP or WebSocket upgrade), if any. */
export async function getViewer(request: Request, env: Env): Promise<Viewer | null> {
	if (!env.TACK_SECRET) return null;
	return (await lookupRequest(request, env)).session?.viewer ?? null;
}

/**
 * The viewer's own GitHub token (user-to-server), for checks that must use
 * their permissions, such as whether they can read a private repo (#10).
 * Refreshed automatically; null if they have none (or it was revoked).
 */
export async function viewerToken(env: Env, viewer: Viewer): Promise<string | null> {
	return userToken(env, viewer.id);
}

/** The same, by GitHub user id (as board connections know their viewer). */
export async function userToken(env: Env, userId: number): Promise<string | null> {
	if (!env.TACK_SECRET || userId <= 0) return null;
	return instance(env).userToken(userId);
}
