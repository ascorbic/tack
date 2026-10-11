// Weekly digests' routes (#68). The digest itself is sent by the board's
// object (src/server/digests.ts); these check who's asking.
//
//   GET    /api/boards/:id/digest               settings, recent digests, yours, and a preview (can open, signed in)
//   PUT    /api/boards/:id/digest               turn them on, or change them (the owner)
//   DELETE /api/boards/:id/digest               turn them off (the owner)
//   PUT    /api/boards/:id/digest/subscription  email me the digest { email } (signed in, instance users, can open)
//   DELETE /api/boards/:id/digest/subscription  stop emailing me (signed in: their own)
//   POST   /api/digests/confirm                 { token } from the confirmation email (whoever holds it)
//   POST   /api/digests/unsubscribe?token=      from a digest email, one click (whoever holds it)

import { getServerByName } from "partyserver";
import * as v from "valibot";
import { BOARD_ID, type BoardInfo, canEdit } from "../shared/boards.ts";
import {
	type DigestError,
	type Weekday,
	discussionRepoKey,
	validTimeZone,
} from "../shared/digests.ts";
import { unsign } from "./auth/crypto.ts";
import { isCrossSite, json } from "./auth/http.ts";
import type { Board } from "./board.ts";
import { notAllowed, respond, safeDecode, visitorFor } from "./boards/http.ts";
import {
	CONFIRM_PURPOSE,
	type DigestToken,
	UNSUBSCRIBE_PURPOSE,
	checkDiscussionTarget,
} from "./digests.ts";
import { emailAvailable } from "./email.ts";
import { log } from "./log.ts";
import { boards, directory } from "./namespaces.ts";
import { resolveRepo } from "./routing.ts";

const SettingsBody = v.object({
	discussion: v.nullable(
		v.object({
			repo: v.pipe(v.string(), v.maxLength(300)),
			category: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
		}),
	),
	email: v.boolean(),
	weekday: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)),
	hour: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(23)),
	timeZone: v.pipe(v.string(), v.maxLength(64)),
});

const SubscribeBody = v.object({ email: v.pipe(v.string(), v.maxLength(320)) });
const TokenBody = v.object({ token: v.pipe(v.string(), v.maxLength(2000)) });

const STATUS: Record<DigestError, number> = {
	sign_in_required: 401,
	forbidden: 403,
	owner_required: 403,
	not_found: 404,
	invalid: 400,
	invalid_repo: 422,
	invalid_category: 422,
	discussions_off: 422,
	not_installed: 422,
	no_access: 403,
	unreachable: 503,
	email_unavailable: 409,
	email_off: 409,
	invalid_email: 422,
	too_soon: 429,
	expired: 410,
};

function refuse(error: DigestError, message?: string): Response {
	return json({ error, ...(message ? { message } : {}) }, { status: STATUS[error] });
}

export async function handleDigests(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === "/api/digests/confirm" || path === "/api/digests/unsubscribe") {
		if (request.method !== "POST") return notAllowed();
		return tokenRoute(request, env, path.endsWith("confirm") ? "confirm" : "unsubscribe");
	}
	const match = /^\/api\/boards\/([^/]+)\/digest(\/subscription)?$/.exec(path);
	if (!match) return null;
	const id = match[1] ? safeDecode(match[1]) : null;
	if (!id || !BOARD_ID.test(id)) return json({ error: "not_found" }, { status: 404 });
	const subscription = Boolean(match[2]);
	const method = request.method;
	if (
		subscription ? !["PUT", "DELETE"].includes(method) : !["GET", "PUT", "DELETE"].includes(method)
	) {
		return notAllowed();
	}
	if (method !== "GET" && isCrossSite(request)) {
		log.warn("auth.rejected", { path });
		return json({ error: "forbidden" }, { status: 403 });
	}

	const visitor = await visitorFor(request, env);
	const user = visitor.user;
	if (!user) return refuse("sign_in_required");
	const found = await directory(env).get(visitor, id);
	if (!found.ok) return respond(found);
	const board = found.value as BoardInfo;
	const owner = board.role === "owner";
	const stub = await getServerByName<Env, Board>(boards(env), id);
	const origin = url.origin;

	if (subscription) {
		if (method === "DELETE") {
			await stub.unsubscribeDigest(user.id);
			return json(
				await stub.digestView({ userId: user.id, canManage: owner, canEdit: canEdit(board.role) }),
			);
		}
		// Email goes to people who may use the instance, not just anyone who can see a public board.
		if (!visitor.allowed) return refuse("forbidden");
		const body = v.safeParse(SubscribeBody, await request.json().catch(() => null));
		if (!body.success) return refuse("invalid");
		const result = await stub.subscribeDigest({
			userId: user.id,
			login: user.login,
			email: body.output.email,
			origin,
		});
		if (!result.ok) return refuse(result.error);
		return json(
			await stub.digestView({ userId: user.id, canManage: owner, canEdit: canEdit(board.role) }),
		);
	}

	if (method === "GET") {
		return json(
			await stub.digestView({ userId: user.id, canManage: owner, canEdit: canEdit(board.role) }),
		);
	}
	if (!owner) return refuse("owner_required");
	if (method === "DELETE") {
		await stub.disableDigest(user.login);
		return json(await stub.digestView({ userId: user.id, canManage: true, canEdit: true }));
	}

	const parsed = v.safeParse(SettingsBody, await request.json().catch(() => null));
	if (!parsed.success || !validTimeZone(parsed.output.timeZone)) return refuse("invalid");
	const body = parsed.output;
	// Somewhere for it to go.
	if (!body.discussion && !body.email) return refuse("invalid");
	if (body.email && !emailAvailable(env) && !body.discussion) return refuse("email_unavailable");
	let discussion: { repo: string; category: string } | null = null;
	let repoPublic: boolean | null = null;
	if (body.discussion) {
		const repo = discussionRepoKey(body.discussion.repo);
		if (!repo) return refuse("invalid_repo");
		discussion = { repo, category: body.discussion.category };
		const check = await checkDiscussionTarget(env, discussion, user.id, (key) =>
			resolveRepo(env, key),
		);
		if (!check.ok) {
			log.info("digest.refused", { board: id, repo, by: user.login, reason: check.error });
			return refuse(check.error, check.message);
		}
		repoPublic = check.repoPublic;
	}
	await stub.configureDigest({
		settings: {
			discussion,
			email: body.email && emailAvailable(env),
			weekday: body.weekday as Weekday,
			hour: body.hour,
			timeZone: body.timeZone,
		},
		title: board.title,
		origin,
		by: { id: user.id, login: user.login, ...(user.name ? { name: user.name } : {}) },
		repoPublic,
	});
	return json(await stub.digestView({ userId: user.id, canManage: true, canEdit: true }));
}

/** Links from emails: whoever holds a valid token, signed in or not. */
async function tokenRoute(
	request: Request,
	env: Env,
	kind: "confirm" | "unsubscribe",
): Promise<Response> {
	const secret = env.TACK_SECRET;
	if (!secret) return refuse("expired");
	// One-click unsubscribing (RFC 8058) posts a form with the token in the address.
	let token = new URL(request.url).searchParams.get("token");
	if (!token && request.headers.get("content-type")?.includes("application/json")) {
		const body = v.safeParse(TokenBody, await request.json().catch(() => null));
		if (body.success) token = body.output.token;
	}
	const data = await unsign<DigestToken>(
		secret,
		kind === "confirm" ? CONFIRM_PURPOSE : UNSUBSCRIBE_PURPOSE,
		token,
	);
	if (!data || typeof data.b !== "string" || !BOARD_ID.test(data.b) || typeof data.u !== "number") {
		return refuse("expired");
	}
	if (!(await directory(env).accessPolicy(data.b))) return refuse("expired");
	const stub = await getServerByName<Env, Board>(boards(env), data.b);
	if (kind === "confirm") {
		const confirmed = await stub.confirmDigest(data.u, data.n);
		return confirmed ? json({ ok: true, ...confirmed }) : refuse("expired");
	}
	const done = await stub.unsubscribeDigest(data.u, data.n);
	// Already gone is as good as done: say so the same way.
	return json({ ok: true, title: done?.title ?? null });
}
