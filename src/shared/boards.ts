import type { Person } from "./auth.ts";

// The board index, membership and visibility: types shared by the server's
// `/api/boards` routes and the client. Boards are independent of repos (see
// docs/plan.md, principle 8): membership decides who can open and edit a
// board, and never grants access to repo data.

/** What someone can do on a board. Owners also manage it: sharing, visibility, archiving. */
export type Role = "owner" | "editor" | "viewer";

/** Roles that can be given to members. Ownership moves with `transfer` instead. */
export type MemberRole = Exclude<Role, "owner">;

/**
 * Who can open a board besides its members:
 * - private: members only
 * - instance: anyone allowed on this instance, at the board's `instanceRole`
 * - public: that, plus anyone at all, read-only and without signing in
 */
export type Visibility = "private" | "instance" | "public";

export const VISIBILITIES: readonly Visibility[] = ["private", "instance", "public"];
export const MEMBER_ROLES: readonly MemberRole[] = ["editor", "viewer"];

/** Whether a role can change the board's content. */
export function canEdit(role: Role | null): boolean {
	return role === "owner" || role === "editor";
}

/**
 * A compact sketch of a board for its thumbnail: shape rectangles and
 * colours, normalised so the largest side is `THUMBNAIL_SIZE`. Kept by the
 * board's Durable Object on save, so the home page never loads a document.
 */
export interface Thumbnail {
	width: number;
	height: number;
	shapes: ThumbnailShape[];
}

/**
 * `[kind, x, y, width, height, tone]`. The tone is a sticky's colour, a
 * card's state, a frame's colour, or how many lines a text block has.
 */
export type ThumbnailShape = [
	kind: ThumbnailKind,
	x: number,
	y: number,
	width: number,
	height: number,
	tone: string,
];

export type ThumbnailKind = "card" | "sticky" | "text" | "frame";

export const THUMBNAIL_SIZE = 1000;
/** Thumbnails keep the largest shapes, up to this many. */
export const THUMBNAIL_MAX_SHAPES = 120;

/** A board as listed on the home page and described to whoever opens it. */
export interface BoardInfo {
	id: string;
	slug: string;
	title: string;
	owner: Person | null;
	visibility: Visibility;
	/** What people on the instance who aren't members get, unless it's private. */
	instanceRole: MemberRole;
	createdAt: number;
	/** Last change to the board's content or settings. */
	updatedAt: number;
	archivedAt: number | null;
	thumbnail: Thumbnail | null;
	/** A few members, owner first, for the avatar stack. */
	members: Person[];
	memberCount: number;
	/** The viewer's own role. Archived boards are read-only, so at most "viewer". */
	role: Role | null;
	/** Whether the viewer can share, change visibility, and archive. */
	canManage: boolean;
	/** When the viewer last opened it, if they're signed in and have. */
	visitedAt: number | null;
}

/** `GET /api/boards` */
export interface BoardList {
	/** Recently opened, most recent first. */
	recent: BoardInfo[];
	/** Owned by the viewer. */
	mine: BoardInfo[];
	/** Boards the viewer was invited to. */
	shared: BoardInfo[];
	/** Archived boards the viewer owns or was invited to. */
	archived: BoardInfo[];
	/**
	 * Boards anyone may open without being a member. For people who can't
	 * have boards of their own (signed out, or not allowed on the instance),
	 * only public ones; for guests before setup, every open board.
	 */
	open: BoardInfo[];
	/** Whether the viewer may create boards. */
	canCreate: boolean;
}

export interface BoardMember {
	/** Lowercase GitHub login. Members are invited by login. */
	login: string;
	/** Null until they first sign in (or open a board) and the login resolves. */
	person: Person | null;
	role: Role;
}

/** `GET /api/boards/:id/members` */
export interface BoardMembers {
	members: BoardMember[];
}

/** `POST /api/boards` */
export interface CreateBoardRequest {
	title?: string;
	visibility?: Visibility;
}

/** `PATCH /api/boards/:id` */
export interface UpdateBoardRequest {
	title?: string;
	visibility?: Visibility;
	instanceRole?: MemberRole;
	archived?: boolean;
}

/** `POST /api/boards/:id/members` */
export interface InviteRequest {
	logins: string[];
	role: MemberRole;
}

/** `PATCH /api/boards/:id/members/:login`: a member role, or "owner" to transfer ownership. */
export interface MemberUpdateRequest {
	role: Role;
}

export type BoardError =
	| "sign_in_required"
	| "forbidden"
	| "not_found"
	| "invalid"
	| "invalid_login"
	| "owner_required";

export type BoardResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: BoardError; logins?: string[] };

/**
 * Custom messages from a board's Durable Object about the board itself:
 * your role changed, or someone renamed it. (Card data travels as
 * `CardMessage`s on the same channel.)
 */
export type BoardMessage =
	| { type: "access"; role: Role }
	| { type: "renamed"; title: string; slug: string };

export const MAX_TITLE = 120;
export const DEFAULT_TITLE = "Untitled board";

/** A board's title, tidied: single spaces, trimmed, and not too long. */
export function cleanTitle(title: string | undefined): string {
	const clean = (title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim();
	return clean || DEFAULT_TITLE;
}

/** The URL slug for a title: lowercase ASCII words joined by hyphens. */
export function slugify(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return slug || "board";
}

/** Where a board lives: `/b/{id}/{slug}`. */
export function boardPath(board: { id: string; slug: string }): string {
	return `/b/${encodeURIComponent(board.id)}/${board.slug}`;
}

/** The board id from a `/b/{id}/{slug}` path, if it is one. */
export function boardIdFromPath(pathname: string): string | null {
	const match = /^\/b\/([^/]+)(?:\/[^/]*)?\/?$/.exec(pathname);
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

/**
 * Board ids are the board Durable Object's name. New boards get random ids;
 * boards from before the index (`?board=name`) keep their old name as id,
 * so their documents carry over untouched.
 */
export const BOARD_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
