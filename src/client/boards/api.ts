import type {
	BoardError,
	BoardInfo,
	BoardList,
	BoardMembers,
	CarryRequest,
	CarryResponse,
	CreateBoardRequest,
	CreatedBoard,
	InviteRequest,
	Role,
	UpdateBoardRequest,
} from "../../shared/boards.ts";

// The board index API (`/api/boards`, see src/server/boards/routes.ts).

export type ApiResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ApiError; logins?: string[] };

/** The server's errors, plus not being able to reach it at all. */
export type ApiError = BoardError | "offline";

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
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
			| { error: BoardError; logins?: string[] }
			| null;
		if (response.ok && body) return { ok: true, value: body as T };
		const error = body && "error" in body && body.error ? body.error : "offline";
		return { ok: false, error, logins: body && "logins" in body ? body.logins : undefined };
	} catch {
		return { ok: false, error: "offline" };
	}
}

const send = (method: string, body?: unknown): RequestInit => ({
	method,
	body: body === undefined ? undefined : JSON.stringify(body),
});

const boardUrl = (id: string) => `/api/boards/${encodeURIComponent(id)}`;
const memberUrl = (id: string, login: string) =>
	`${boardUrl(id)}/members/${encodeURIComponent(login)}`;

export const boardsApi = {
	list: () => call<BoardList>("/api/boards"),
	create: (request: CreateBoardRequest = {}) =>
		call<CreatedBoard>("/api/boards", send("POST", request)),
	/** Carry a board's open action items over to another (#52). */
	carry: (id: string, request: CarryRequest) =>
		call<CarryResponse>(`${boardUrl(id)}/carry`, send("POST", request)),
	claimLegacy: (name: string) => call<BoardInfo>("/api/boards/legacy", send("POST", { name })),
	get: (id: string) => call<BoardInfo>(boardUrl(id)),
	update: (id: string, request: UpdateBoardRequest) =>
		call<BoardInfo>(boardUrl(id), send("PATCH", request)),
	members: (id: string) => call<BoardMembers>(`${boardUrl(id)}/members`),
	invite: (id: string, request: InviteRequest) =>
		call<BoardMembers>(`${boardUrl(id)}/members`, send("POST", request)),
	setRole: (id: string, login: string, role: Role) =>
		call<BoardMembers>(memberUrl(id, login), send("PATCH", { role })),
	remove: (id: string, login: string) => call<BoardMembers>(memberUrl(id, login), send("DELETE")),
};

/** The board's shareable link. */
export function boardUrlFor(board: { id: string; slug: string }): string {
	return `${location.origin}/b/${encodeURIComponent(board.id)}/${board.slug}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 hours ago", "yesterday", or a date. */
export function relativeTime(at: number, now = Date.now()): string {
	const ago = Math.max(0, now - at);
	if (ago < MINUTE) return "just now";
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
	if (ago < HOUR) return rtf.format(-Math.floor(ago / MINUTE), "minute");
	if (ago < DAY) return rtf.format(-Math.floor(ago / HOUR), "hour");
	if (ago < 7 * DAY) return rtf.format(-Math.floor(ago / DAY), "day");
	const date = new Date(at);
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
	});
}
