// Comment notifications (#51): mentions, and replies in threads you're in.
// Boards deliver them to the Directory; this is the inbox in the top bar.
//
//   GET  /api/notifications          your latest, newest first, and how many are unread
//   POST /api/notifications/read     mark read { ids? } | { board, thread } | { all: true }
//
// Signed-in only. Notifications from boards you can no longer open are left out.

import * as v from "valibot";
import { isCrossSite, json } from "./auth/http.ts";
import { visitorFor } from "./boards/routes.ts";
import { log } from "./log.ts";
import { directory } from "./namespaces.ts";

const ReadBody = v.object({
	ids: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(100))),
	board: v.optional(v.pipe(v.string(), v.maxLength(64))),
	thread: v.optional(v.pipe(v.string(), v.maxLength(64))),
	all: v.optional(v.boolean()),
});

export async function handleNotifications(request: Request, env: Env): Promise<Response | null> {
	const path = new URL(request.url).pathname;
	if (path !== "/api/notifications" && path !== "/api/notifications/read") return null;
	const visitor = await visitorFor(request, env);
	if (!visitor.user) return json({ error: "sign_in_required" }, { status: 401 });

	if (path === "/api/notifications") {
		if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
		return json(await directory(env).notifications(visitor));
	}
	if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
	if (isCrossSite(request)) {
		log.warn("auth.rejected", { path });
		return json({ error: "forbidden" }, { status: 403 });
	}
	const body = v.safeParse(ReadBody, await request.json().catch(() => null));
	if (!body.success) return json({ error: "invalid" }, { status: 400 });
	return json(await directory(env).readNotifications(visitor, body.output));
}
