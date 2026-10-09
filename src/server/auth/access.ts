// Instance access control. Every instance is self-hosted, so its admins
// decide who may use it: allowed users, and members of allowed orgs
// (checked at sign-in). Board-level permissions build on top of this.

import type { Viewer } from "../identity.ts";
import { log } from "../log.ts";
import { instance } from "../namespaces.ts";
import { knownSession, lookupRequest } from "./session.ts";

/** Whether a viewer may use this instance: an admin, an allowed user, or in an allowed org. */
export async function canUseInstance(env: Env, viewer: Viewer | null): Promise<boolean> {
	if (!viewer) return false;
	const known = knownSession(viewer);
	if (known) return known.allowed;
	if (!env.TACK_SECRET) return false;
	return instance(env).canUse(viewer.id);
}

/**
 * Turn away anyone who may not use the instance, for routes that need it
 * (board connections, for now). Access control is on once the GitHub App is
 * set up; before that, and on Previews, everything is open and anonymous.
 */
export async function requireInstanceAccess(
	request: Request,
	env: Env,
): Promise<Response | undefined> {
	const { configured, session } = await lookupRequest(request, env);
	if (!configured || session?.allowed) return;
	log.warn("access.denied", {
		path: new URL(request.url).pathname,
		reason: session ? "not_allowed" : "signed_out",
		login: session?.viewer.login,
	});
	return session
		? Response.json({ error: "not_allowed" }, { status: 403 })
		: Response.json({ error: "sign_in_required" }, { status: 401 });
}
