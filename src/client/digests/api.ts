import type {
	DigestError,
	DigestRequest,
	DigestView,
	SubscribeRequest,
} from "../../shared/digests.ts";

// Weekly digests (#68): `src/server/digestRoutes.ts`. Swappable, so the
// gallery and the playground can answer without a server.

export type DigestResult =
	| { ok: true; value: DigestView }
	| { ok: false; error: DigestError | "offline"; message?: string };

export type TokenResult =
	| { ok: true; title: string | null; path?: string; schedule?: string }
	| { ok: false; error: DigestError | "offline" };

export interface DigestApi {
	get(board: string): Promise<DigestResult>;
	set(board: string, settings: DigestRequest): Promise<DigestResult>;
	off(board: string): Promise<DigestResult>;
	subscribe(board: string, body: SubscribeRequest): Promise<DigestResult>;
	unsubscribe(board: string): Promise<DigestResult>;
}

async function request<T>(
	path: string,
	init: RequestInit = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string; message?: string }> {
	try {
		const response = await fetch(path, {
			...init,
			headers: {
				accept: "application/json",
				...(init.body ? { "content-type": "application/json" } : {}),
			},
		});
		const body = (await response.json().catch(() => null)) as
			| (T & { error?: undefined })
			| { error: string; message?: string }
			| null;
		if (response.ok && body) return { ok: true, value: body as T };
		if (body && "error" in body && body.error) {
			return { ok: false, error: body.error, ...(body.message ? { message: body.message } : {}) };
		}
		return { ok: false, error: "offline" };
	} catch {
		return { ok: false, error: "offline" };
	}
}

const digestUrl = (board: string) => `/api/boards/${encodeURIComponent(board)}/digest`;

export const digestApi: DigestApi = {
	get: (board) => request<DigestView>(digestUrl(board)) as Promise<DigestResult>,
	set: (board, settings) =>
		request<DigestView>(digestUrl(board), {
			method: "PUT",
			body: JSON.stringify(settings),
		}) as Promise<DigestResult>,
	off: (board) =>
		request<DigestView>(digestUrl(board), { method: "DELETE" }) as Promise<DigestResult>,
	subscribe: (board, body) =>
		request<DigestView>(`${digestUrl(board)}/subscription`, {
			method: "PUT",
			body: JSON.stringify(body),
		}) as Promise<DigestResult>,
	unsubscribe: (board) =>
		request<DigestView>(`${digestUrl(board)}/subscription`, {
			method: "DELETE",
		}) as Promise<DigestResult>,
};

/** The links in digest emails: confirming an address, and stopping. */
export async function followToken(
	kind: "confirm" | "unsubscribe",
	token: string,
): Promise<TokenResult> {
	const result = await request<{ title: string | null; path?: string; schedule?: string }>(
		`/api/digests/${kind}`,
		{ method: "POST", body: JSON.stringify({ token }) },
	);
	if (!result.ok) return { ok: false, error: result.error as DigestError | "offline" };
	return { ok: true, ...result.value };
}

/** This browser's time zone, for when a new digest goes out. */
export function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}
