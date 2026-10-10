// What the board and template routes share: who's asking, reading bodies,
// and answering with a board result's status.

import * as v from "valibot";
import type { BoardError, BoardResult } from "../../shared/boards.ts";
import { json } from "../auth/http.ts";
import { lookupRequest } from "../auth/session.ts";
import type { Visitor } from "./access.ts";

export const STATUS: Record<BoardError, number> = {
	sign_in_required: 401,
	forbidden: 403,
	owner_required: 403,
	not_found: 404,
	invalid: 400,
	invalid_login: 422,
	too_large: 413,
};

/**
 * Who's making a request, for boards: signed in or not, and whether they
 * may use the instance (everyone may before setup, and on Previews).
 */
export async function visitorFor(request: Request, env: Env): Promise<Visitor> {
	if (!env.TACK_SECRET) return { user: null, allowed: true };
	const { configured, session } = await lookupRequest(request, env);
	return {
		user: session?.viewer ?? null,
		allowed: !configured || (session?.allowed ?? false),
		admin: session?.admin ?? false,
	};
}

export function respond<T>(result: BoardResult<T>, status = 200): Response {
	if (result.ok) return json(result.value, { status });
	return json(
		{ error: result.error, ...(result.logins ? { logins: result.logins } : {}) },
		{ status: STATUS[result.error] },
	);
}

export async function parse<S extends v.GenericSchema>(
	request: Request,
	schema: S,
): Promise<v.InferOutput<S> | null> {
	const body = v.safeParse(schema, await request.json().catch(() => null));
	return body.success ? body.output : null;
}

export function invalid(): Response {
	return json({ error: "invalid" }, { status: 400 });
}

export function notAllowed(): Response {
	return json({ error: "method_not_allowed" }, { status: 405 });
}

export function safeDecode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}
