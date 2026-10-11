import { DurableObject } from "cloudflare:workers";
import type { Person } from "../shared/auth.ts";
import {
	BOARD_ID,
	type BoardInfo,
	type BoardList,
	type BoardMember,
	type BoardMembers,
	type BoardResult,
	type CreateBoardRequest,
	type InviteRequest,
	type MemberRole,
	type Role,
	type Thumbnail,
	type UpdateBoardRequest,
	type Visibility,
	DEFAULT_TITLE,
	cleanTitle,
	slugify,
} from "../shared/boards.ts";
import type { Mentionable, Notification, NotificationList } from "../shared/comments.ts";
import type {
	TemplateContent,
	TemplateInfo,
	TemplateList,
	TemplateRepos,
	TemplateSummary,
} from "../shared/templates.ts";
import { normaliseLogins } from "./auth/logins.ts";
import {
	type Policy,
	type Visitor,
	baseRole,
	canManage,
	roleFor,
	visitorKey,
} from "./boards/access.ts";
import { log } from "./log.ts";
import { boards } from "./namespaces.ts";

/** Members shown on a board's tile, owner first. */
const MEMBER_PREVIEW = 4;
const RECENT_LIMIT = 12;
const OPEN_LIMIT = 60;
/** Refresh a person's cached profile at most this often. */
const PROFILE_TTL = 60 * 60_000;
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const ID_LENGTH = 10;
/** People who opened a board lately, besides its members, who can be mentioned on it. */
const MENTIONABLE_VISITORS = 50;
const NOTIFICATIONS_KEPT = 200;
const NOTIFICATIONS_SHOWN = 50;

/** A board as comment commands see it (#58): see `Directory.commandBoards`. */
export interface CommandBoard {
	id: string;
	slug: string;
	title: string;
	visibility: Visibility;
	archived: boolean;
	/** The person's role on it. Archived boards are at most "viewer". */
	role: Role;
	/** Members' GitHub user ids, the owner included. */
	members: number[];
	/** Invites that haven't resolved to anyone yet. */
	pending: number;
}

/** What a public board shows the world: see `Directory.publicBoard`. */
export interface PublicBoard {
	id: string;
	slug: string;
	title: string;
	archived: boolean;
	/** When it last changed (saved, renamed), epoch ms. */
	updatedAt: number;
}

/** A comment notification from a board's object. */
export interface NoticeInput {
	userId: number;
	kind: "mention" | "reply";
	thread: string;
	message: string;
	by: Notification["by"];
	excerpt: string;
	at: number;
}

interface NotificationRow extends Record<string, SqlStorageValue> {
	id: string;
	board_id: string;
	thread: string;
	kind: string;
	by: string;
	excerpt: string;
	at: number;
	read_at: number | null;
}

interface BoardRow extends Record<string, SqlStorageValue> {
	id: string;
	slug: string;
	title: string;
	owner_id: number | null;
	visibility: string;
	instance_role: string;
	created_at: number;
	updated_at: number;
	archived_at: number | null;
	thumbnail: string | null;
}

interface MemberRow extends Record<string, SqlStorageValue> {
	login: string;
	user_id: number | null;
	role: string;
	name: string | null;
	avatar_url: string | null;
	current_login: string | null;
}

interface TemplateRow extends Record<string, SqlStorageValue> {
	id: string;
	title: string;
	description: string;
	owner_id: number | null;
	board_id: string | null;
	content: string;
	repos: string | null;
	summary: string;
	thumbnail: string | null;
	collects: number;
	created_at: number;
}

/** A template being saved: everything but its id, owner and when. */
export interface TemplateInput {
	board: string;
	title: string;
	description: string;
	/** The content as JSON, already checked for size. */
	content: string;
	repos: TemplateRepos | null;
	summary: TemplateSummary;
	thumbnail: Thumbnail | null;
	collectsActions: boolean;
}

/** Saved templates listed, newest first. */
const TEMPLATES_LISTED = 100;

interface PersonRow extends Record<string, SqlStorageValue> {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
}

const ok = <T>(value: T): BoardResult<T> => ({ ok: true, value });

/**
 * The board index: every board's title, slug, owner, visibility and
 * members, who last opened what, and each board's thumbnail sketch. A
 * singleton, like `Instance`, but separate from it: `Instance` holds
 * credentials and serves the session lookup on every request, and keeping
 * board traffic (thumbnail updates on every board save, listings) out of it
 * keeps sign-in fast and its blast radius small. Board documents live in
 * their own `Board` objects, keyed by board id.
 */
export class Directory extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS boards (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				title TEXT NOT NULL,
				owner_id INTEGER,
				visibility TEXT NOT NULL,
				instance_role TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				archived_at INTEGER,
				thumbnail TEXT
			);
			CREATE INDEX IF NOT EXISTS boards_owner ON boards (owner_id);
			CREATE TABLE IF NOT EXISTS members (
				board_id TEXT NOT NULL,
				login TEXT NOT NULL,
				user_id INTEGER,
				role TEXT NOT NULL,
				invited_by INTEGER,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (board_id, login)
			);
			CREATE INDEX IF NOT EXISTS members_user ON members (user_id);
			CREATE INDEX IF NOT EXISTS members_login ON members (login) WHERE user_id IS NULL;
			CREATE TABLE IF NOT EXISTS people (
				id INTEGER PRIMARY KEY,
				login TEXT NOT NULL,
				name TEXT,
				avatar_url TEXT NOT NULL,
				seen_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS people_login ON people (lower(login));
			CREATE TABLE IF NOT EXISTS visits (
				user_id INTEGER NOT NULL,
				board_id TEXT NOT NULL,
				at INTEGER NOT NULL,
				PRIMARY KEY (user_id, board_id)
			);
			CREATE INDEX IF NOT EXISTS visits_board ON visits (board_id, at);
			CREATE TABLE IF NOT EXISTS notifications (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				board_id TEXT NOT NULL,
				thread TEXT NOT NULL,
				kind TEXT NOT NULL,
				by TEXT NOT NULL,
				excerpt TEXT NOT NULL,
				at INTEGER NOT NULL,
				read_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, at);
			CREATE TABLE IF NOT EXISTS templates (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				owner_id INTEGER,
				board_id TEXT,
				content TEXT NOT NULL,
				repos TEXT,
				summary TEXT NOT NULL,
				thumbnail TEXT,
				collects INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			);
		`);
	}

	// ---------------------------------------------------------------------
	// Listing and opening

	list(visitor: Visitor): BoardList {
		this.touch(visitor);
		const who = visitorKey(visitor);
		const userId = who.userId;
		const infos = (rows: BoardRow[]) =>
			rows
				.map((row) => this.info(row, visitor))
				.filter((info): info is BoardInfo => info.role !== null);

		const recent =
			userId === null
				? []
				: infos(
						this.sql
							.exec<BoardRow>(
								`SELECT b.* FROM visits v JOIN boards b ON b.id = v.board_id
								WHERE v.user_id = ? AND b.archived_at IS NULL
								ORDER BY v.at DESC LIMIT ?`,
								userId,
								RECENT_LIMIT,
							)
							.toArray(),
					);
		const membership = (archived: boolean, owner: boolean) =>
			userId === null
				? []
				: infos(
						this.sql
							.exec<BoardRow>(
								`SELECT b.* FROM members m JOIN boards b ON b.id = m.board_id
								WHERE m.user_id = ? AND (m.role = 'owner') = ?
								AND (b.archived_at IS NOT NULL) = ?
								ORDER BY b.updated_at DESC`,
								userId,
								owner ? 1 : 0,
								archived ? 1 : 0,
							)
							.toArray(),
					);
		const archived = [...membership(true, true), ...membership(true, false)].sort(
			(a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0),
		);
		const open = infos(
			this.sql
				.exec<BoardRow>(
					`SELECT * FROM boards WHERE archived_at IS NULL AND visibility IN (${
						visitor.allowed ? "'instance', 'public'" : "'public'"
					}) ORDER BY updated_at DESC LIMIT ?`,
					OPEN_LIMIT,
				)
				.toArray(),
		);

		return {
			recent,
			mine: membership(false, true),
			shared: membership(false, false),
			archived,
			open,
			canCreate: this.canCreate(visitor),
		};
	}

	/** A board, as whoever's asking may see it. */
	get(visitor: Visitor, id: string): BoardResult<BoardInfo> {
		this.touch(visitor);
		const row = this.row(id);
		if (!row) return refuse("not_found");
		const info = this.info(row, visitor);
		return info.role ? ok(info) : this.denied(visitor);
	}

	/**
	 * Someone is opening a live connection to a board: their role, which the
	 * board's object enforces. Remembers the visit, for "Recent".
	 */
	join(visitor: Visitor, id: string): BoardResult<{ role: Role; archived: boolean }> {
		this.touch(visitor);
		const row = this.row(id);
		if (!row) return refuse("not_found");
		const role = roleFor(this.policy(row), visitorKey(visitor));
		if (!role) return this.denied(visitor);
		if (visitor.user) {
			this.sql.exec(
				"INSERT OR REPLACE INTO visits (user_id, board_id, at) VALUES (?, ?, ?)",
				visitor.user.id,
				id,
				Date.now(),
			);
		}
		return ok({ role, archived: row.archived_at !== null });
	}

	/**
	 * Every board someone can open, with their role and who else is on it,
	 * for comment commands (#58): finding the board a comment names, and
	 * checking that a private repository's item can go on it.
	 */
	commandBoards(userId: number, allowed: boolean): CommandBoard[] {
		const who = { userId, allowed };
		const rows = this.sql
			.exec<BoardRow>(
				`SELECT * FROM boards WHERE id IN (SELECT board_id FROM members WHERE user_id = ?)
				OR visibility IN (${allowed ? "'instance', 'public'" : "'public'"})
				ORDER BY updated_at DESC`,
				userId,
			)
			.toArray();
		return rows.flatMap((row) => {
			const policy = this.policy(row);
			const role = roleFor(policy, who);
			if (!role) return [];
			const pending = this.sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM members WHERE board_id = ? AND user_id IS NULL",
					row.id,
				)
				.toArray()[0]?.n;
			return [
				{
					id: row.id,
					slug: row.slug,
					title: row.title,
					visibility: policy.visibility,
					archived: policy.archived,
					role,
					members: Object.keys(policy.members).map(Number),
					pending: pending ?? 0,
				},
			];
		});
	}

	/**
	 * A public board's title and address, for its link preview and images
	 * (#56, #57). Null for every other board, and for boards that don't
	 * exist, alike: nothing about a board that isn't public gets out.
	 */
	publicBoard(id: string): PublicBoard | null {
		const row = this.row(id);
		if (!row || row.visibility !== "public") return null;
		return {
			id: row.id,
			slug: row.slug,
			title: row.title,
			archived: row.archived_at !== null,
			updatedAt: row.updated_at,
		};
	}

	/** The access policy for a board, for its Durable Object. */
	accessPolicy(id: string): Policy | null {
		const row = this.row(id);
		return row ? this.policy(row) : null;
	}

	// ---------------------------------------------------------------------
	// People to mention, and notifications (comments, #51)

	/**
	 * Who can be mentioned on a board, as whoever's asking may see it: its
	 * members who've signed in, then the people who've opened it lately.
	 */
	people(visitor: Visitor, id: string): BoardResult<{ people: Mentionable[] }> {
		this.touch(visitor);
		const row = this.row(id);
		if (!row) return refuse("not_found");
		if (!roleFor(this.policy(row), visitorKey(visitor))) return this.denied(visitor);
		return ok({ people: this.mentionableRows(id) });
	}

	/** For the board's object: mentionable logins (lowercase) and their ids. */
	mentionable(id: string): Map<string, number> {
		return new Map(
			this.mentionableRows(id).map((person) => [person.login.toLowerCase(), person.id]),
		);
	}

	private mentionableRows(id: string): Mentionable[] {
		const out = new Map<number, Mentionable>();
		for (const member of this.memberRows(id)) {
			const person = memberPerson(member);
			if (person) out.set(person.id, { ...person, role: member.role as Role });
		}
		for (const visit of this.sql
			.exec<PersonRow>(
				`SELECT p.id, p.login, p.name, p.avatar_url FROM visits v JOIN people p ON p.id = v.user_id
				WHERE v.board_id = ? ORDER BY v.at DESC LIMIT ?`,
				id,
				MENTIONABLE_VISITORS,
			)
			.toArray()) {
			if (out.has(visit.id)) continue;
			out.set(visit.id, {
				id: visit.id,
				login: visit.login,
				name: visit.name,
				avatarUrl: visit.avatar_url,
				role: null,
			});
		}
		return [...out.values()];
	}

	/** Deliver comment notifications (from a board's object). */
	notify(id: string, notices: NoticeInput[]): void {
		if (!this.row(id) || notices.length === 0) return;
		this.ctx.storage.transactionSync(() => {
			for (const notice of notices) {
				this.sql.exec(
					`INSERT OR REPLACE INTO notifications (id, user_id, board_id, thread, kind, by, excerpt, at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					`${notice.message}:${notice.userId}`,
					notice.userId,
					id,
					notice.thread,
					notice.kind,
					JSON.stringify(notice.by),
					notice.excerpt,
					notice.at,
				);
				// Each person keeps only their latest notifications.
				this.sql.exec(
					`DELETE FROM notifications WHERE user_id = ? AND id NOT IN
					(SELECT id FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT ?)`,
					notice.userId,
					notice.userId,
					NOTIFICATIONS_KEPT,
				);
			}
		});
		log.info("comment.notified", { board: id, people: notices.length });
	}

	/** Someone's notifications, newest first: only from boards they can still open. */
	notifications(visitor: Visitor): NotificationList {
		this.touch(visitor);
		const userId = visitor.user?.id;
		if (userId === undefined) return { notifications: [], unread: 0 };
		const who = visitorKey(visitor);
		const boards = new Map<string, BoardRow | null>();
		const list: Notification[] = [];
		for (const row of this.sql
			.exec<NotificationRow>(
				"SELECT * FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT ?",
				userId,
				NOTIFICATIONS_SHOWN,
			)
			.toArray()) {
			let board = boards.get(row.board_id);
			if (board === undefined) {
				const found = this.row(row.board_id);
				board = found && roleFor(this.policy(found), who) ? found : null;
				boards.set(row.board_id, board);
			}
			if (!board) continue;
			list.push({
				id: row.id,
				kind: row.kind as Notification["kind"],
				board: { id: board.id, slug: board.slug, title: board.title },
				thread: row.thread,
				by: JSON.parse(row.by) as Notification["by"],
				excerpt: row.excerpt,
				at: row.at,
				read: row.read_at !== null,
			});
		}
		return { notifications: list, unread: list.filter((n) => !n.read).length };
	}

	/** Mark notifications read: some by id, those about a board's thread, or all. */
	readNotifications(
		visitor: Visitor,
		which: { ids?: string[]; board?: string; thread?: string; all?: boolean },
	): NotificationList {
		const userId = visitor.user?.id;
		if (userId === undefined) return { notifications: [], unread: 0 };
		const now = Date.now();
		if (which.all) {
			this.sql.exec(
				"UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
				now,
				userId,
			);
		}
		for (const id of which.ids ?? []) {
			this.sql.exec(
				"UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL",
				now,
				userId,
				id,
			);
		}
		if (which.board && which.thread) {
			this.sql.exec(
				`UPDATE notifications SET read_at = ?
				WHERE user_id = ? AND board_id = ? AND thread = ? AND read_at IS NULL`,
				now,
				userId,
				which.board,
				which.thread,
			);
		}
		return this.notifications(visitor);
	}

	// ---------------------------------------------------------------------
	// Creating and changing boards

	create(visitor: Visitor, request: CreateBoardRequest): BoardResult<BoardInfo> {
		this.touch(visitor);
		if (!this.canCreate(visitor)) return this.denied(visitor);
		const owner = visitor.user;
		// Unnamed boards are numbered, so a row of fresh ones can be told apart.
		const title =
			owner && !(request.title ?? "").trim()
				? this.untitledTitle(owner.id)
				: cleanTitle(request.title);
		// Without sign-in (Previews), boards have no owner and stay open to everyone.
		const visibility: Visibility = owner ? (request.visibility ?? "instance") : "instance";
		const now = Date.now();
		const id = this.newId();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO boards (id, slug, title, owner_id, visibility, instance_role, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, 'editor', ?, ?)`,
				id,
				slugify(title),
				title,
				owner?.id ?? null,
				visibility,
				now,
				now,
			);
			if (owner) this.addMember(id, owner.login, owner.id, "owner", owner.id);
		});
		log.info("board.created", { board: id, owner: owner?.login, visibility });
		return this.get(visitor, id);
	}

	/**
	 * Find or adopt a board from before the index (`/?board=name`). Its
	 * document stays where it is: the old name becomes the board's id. It
	 * stays open to everyone on the instance, as it was, and whoever brings
	 * it over owns it.
	 */
	claimLegacy(visitor: Visitor, name: string): BoardResult<BoardInfo> {
		this.touch(visitor);
		if (!BOARD_ID.test(name)) return refuse("not_found");
		const existing = this.row(name);
		if (existing) return this.get(visitor, name);
		if (!this.canCreate(visitor)) return this.denied(visitor);
		const owner = visitor.user;
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO boards (id, slug, title, owner_id, visibility, instance_role, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'instance', 'editor', ?, ?)`,
				name,
				slugify(name),
				name,
				owner?.id ?? null,
				now,
				now,
			);
			if (owner) this.addMember(name, owner.login, owner.id, "owner", owner.id);
		});
		log.info("board.legacy.claimed", { board: name, owner: owner?.login });
		return this.get(visitor, name);
	}

	/**
	 * Rename (editors), or change visibility or archive (owners). The slug
	 * follows the title; old links keep working because they carry the id.
	 */
	async update(
		visitor: Visitor,
		id: string,
		request: UpdateBoardRequest,
	): Promise<BoardResult<BoardInfo>> {
		this.touch(visitor);
		const row = this.row(id);
		if (!row) return refuse("not_found");
		const policy = this.policy(row);
		const who = visitorKey(visitor);
		const role = roleFor(policy, who);
		if (!role) return this.denied(visitor);

		const managing =
			request.visibility !== undefined ||
			request.instanceRole !== undefined ||
			request.archived !== undefined;
		if (managing && !canManage(policy, who)) return refuse("owner_required");
		// Renaming needs edit access, which archived boards don't give.
		if (request.title !== undefined && role !== "owner" && role !== "editor") {
			return refuse("forbidden");
		}

		const sets: string[] = [];
		const values: SqlStorageValue[] = [];
		if (request.title !== undefined) {
			const title = cleanTitle(request.title);
			sets.push("title = ?", "slug = ?");
			values.push(title, slugify(title));
		}
		if (request.visibility !== undefined) {
			sets.push("visibility = ?");
			values.push(request.visibility);
		}
		if (request.instanceRole !== undefined) {
			sets.push("instance_role = ?");
			values.push(request.instanceRole);
		}
		if (request.archived !== undefined) {
			sets.push("archived_at = ?");
			values.push(request.archived ? (row.archived_at ?? Date.now()) : null);
		}
		if (sets.length === 0) return this.get(visitor, id);

		sets.push("updated_at = ?");
		values.push(Date.now());
		this.sql.exec(`UPDATE boards SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
		log.info("board.updated", {
			board: id,
			by: visitor.user?.login,
			fields: Object.keys(request).filter(
				(key) => request[key as keyof UpdateBoardRequest] !== undefined,
			),
			visibility: request.visibility,
			archived: request.archived,
		});
		if (managing) await this.notifyBoard(id);
		if (request.title !== undefined) await this.notifyRenamed(id);
		return this.get(visitor, id);
	}

	/** Called by a board's Durable Object when it saves: last activity, and its thumbnail. */
	saved(id: string, thumbnail: Thumbnail | null): void {
		this.sql.exec(
			"UPDATE boards SET updated_at = ?, thumbnail = ? WHERE id = ?",
			Date.now(),
			thumbnail ? JSON.stringify(thumbnail) : null,
			id,
		);
	}

	// ---------------------------------------------------------------------
	// Templates (#53): saved per instance, for anyone on it to start from

	/** Templates saved on this instance, newest first. Anyone who can make boards can use them. */
	listTemplates(visitor: Visitor): BoardResult<TemplateList> {
		this.touch(visitor);
		if (!this.canCreate(visitor)) return this.denied(visitor);
		const rows = this.sql
			.exec<TemplateRow>(
				"SELECT * FROM templates ORDER BY created_at DESC LIMIT ?",
				TEMPLATES_LISTED,
			)
			.toArray();
		return ok({ templates: rows.map((row) => this.templateInfo(row, visitor)), canSave: true });
	}

	/** A saved template's content, to make a board from. */
	templateContent(
		visitor: Visitor,
		id: string,
	): BoardResult<{ content: TemplateContent; repos: TemplateRepos | null; title: string }> {
		if (!this.canCreate(visitor)) return this.denied(visitor);
		const row = this.templateRow(id);
		if (!row) return refuse("not_found");
		return ok({
			content: JSON.parse(row.content) as TemplateContent,
			repos: row.repos ? (JSON.parse(row.repos) as TemplateRepos) : null,
			title: row.title,
		});
	}

	/**
	 * Save a board as a template, for everyone on the instance. Only people
	 * who can edit the board may: everyone on the instance will see its
	 * structure (never its cards' data, which is fetched per viewer).
	 */
	saveTemplate(visitor: Visitor, input: TemplateInput): BoardResult<TemplateInfo> {
		this.touch(visitor);
		if (!this.canCreate(visitor)) return this.denied(visitor);
		const board = this.row(input.board);
		if (!board) return refuse("not_found");
		const role = roleFor(this.policy(board), visitorKey(visitor));
		if (!role) return this.denied(visitor);
		if (role !== "owner" && role !== "editor") return refuse("forbidden");
		const id = this.newTemplateId();
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO templates (id, title, description, owner_id, board_id, content, repos, summary, thumbnail, collects, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.title,
			input.description,
			visitor.user?.id ?? null,
			input.board,
			input.content,
			input.repos ? JSON.stringify(input.repos) : null,
			JSON.stringify(input.summary),
			input.thumbnail ? JSON.stringify(input.thumbnail) : null,
			input.collectsActions ? 1 : 0,
			now,
		);
		log.info("template.saved", {
			template: id,
			board: input.board,
			by: visitor.user?.login,
			bytes: input.content.length,
			shapes: input.summary.sections + input.summary.widgets + input.summary.stickies,
		});
		return ok(this.templateInfo(this.templateRow(id) as TemplateRow, visitor));
	}

	/** Delete a saved template: whoever saved it, or an admin. */
	deleteTemplate(visitor: Visitor, id: string): BoardResult<{ deleted: true }> {
		this.touch(visitor);
		if (!this.canCreate(visitor)) return this.denied(visitor);
		const row = this.templateRow(id);
		if (!row) return refuse("not_found");
		if (!this.canDeleteTemplate(row, visitor)) return refuse("owner_required");
		this.sql.exec("DELETE FROM templates WHERE id = ?", id);
		log.info("template.deleted", {
			template: id,
			by: visitor.user?.login,
			moderated: row.owner_id !== null && row.owner_id !== visitor.user?.id,
		});
		return ok({ deleted: true });
	}

	private templateRow(id: string): TemplateRow | undefined {
		return this.sql.exec<TemplateRow>("SELECT * FROM templates WHERE id = ?", id).toArray()[0];
	}

	private canDeleteTemplate(row: TemplateRow, visitor: Visitor): boolean {
		// Templates saved without sign-in (Previews) belong to everyone.
		if (row.owner_id === null) return visitor.allowed;
		return row.owner_id === visitor.user?.id || visitor.admin === true;
	}

	private templateInfo(row: TemplateRow, visitor: Visitor): TemplateInfo {
		const owner =
			row.owner_id === null
				? null
				: this.sql.exec<PersonRow>("SELECT * FROM people WHERE id = ?", row.owner_id).toArray()[0];
		return {
			id: row.id,
			title: row.title,
			description: row.description,
			builtIn: false,
			repos: row.repos ? (JSON.parse(row.repos) as TemplateRepos) : null,
			summary: JSON.parse(row.summary) as TemplateSummary,
			thumbnail: row.thumbnail ? (JSON.parse(row.thumbnail) as Thumbnail) : null,
			owner: owner
				? { id: owner.id, login: owner.login, name: owner.name, avatarUrl: owner.avatar_url }
				: null,
			createdAt: row.created_at,
			canDelete: this.canDeleteTemplate(row, visitor),
			collectsActions: row.collects === 1,
		};
	}

	private newTemplateId(): string {
		for (;;) {
			const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
			const id = Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
			if (!this.templateRow(id)) return id;
		}
	}

	// ---------------------------------------------------------------------
	// Members

	members(visitor: Visitor, id: string): BoardResult<BoardMembers> {
		this.touch(visitor);
		const row = this.row(id);
		if (!row) return refuse("not_found");
		if (!roleFor(this.policy(row), visitorKey(visitor))) return this.denied(visitor);
		return ok({ members: this.memberList(id) });
	}

	/** Invite people by GitHub login. Re-inviting someone changes their role. */
	async invite(
		visitor: Visitor,
		id: string,
		request: InviteRequest,
	): Promise<BoardResult<BoardMembers>> {
		const checked = this.managing(visitor, id);
		if (!checked.ok) return checked;
		const logins = normaliseLogins(request.logins);
		if (logins.invalid.length > 0) {
			return { ok: false, error: "invalid_login", logins: logins.invalid };
		}
		if (logins.valid.length === 0) return refuse("invalid");

		const members = new Map(this.memberRows(id).map((member) => [member.login, member]));
		const ownerLogin = [...members.values()].find((member) => member.role === "owner")?.login;
		this.ctx.storage.transactionSync(() => {
			for (const login of logins.valid) {
				if (login === ownerLogin) continue;
				if (members.has(login)) {
					this.sql.exec(
						"UPDATE members SET role = ? WHERE board_id = ? AND login = ?",
						request.role,
						id,
						login,
					);
				} else {
					this.addMember(
						id,
						login,
						this.knownUserId(login),
						request.role,
						visitor.user?.id ?? null,
					);
				}
			}
			this.sql.exec("UPDATE boards SET updated_at = ? WHERE id = ?", Date.now(), id);
		});
		log.info("board.member.invited", {
			board: id,
			by: visitor.user?.login,
			logins: logins.valid,
			role: request.role,
		});
		await this.notifyBoard(id);
		return ok({ members: this.memberList(id) });
	}

	/** Change a member's role. Giving someone "owner" hands the board over; the old owner becomes an editor. */
	async updateMember(
		visitor: Visitor,
		id: string,
		login: string,
		role: Role,
	): Promise<BoardResult<BoardMembers>> {
		const checked = this.managing(visitor, id);
		if (!checked.ok) return checked;
		const target = this.memberRows(id).find((member) => member.login === login.toLowerCase());
		if (!target) return refuse("not_found");
		if (target.role === "owner") return refuse("invalid");

		if (role === "owner") {
			// Only the owner can hand over, and only to someone who has signed in.
			if (checked.value.ownerId !== visitor.user?.id || target.user_id === null) {
				return refuse("owner_required");
			}
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE members SET role = 'editor' WHERE board_id = ? AND role = 'owner'",
					id,
				);
				this.sql.exec(
					"UPDATE members SET role = 'owner' WHERE board_id = ? AND login = ?",
					id,
					target.login,
				);
				this.sql.exec(
					"UPDATE boards SET owner_id = ?, updated_at = ? WHERE id = ?",
					target.user_id,
					Date.now(),
					id,
				);
			});
		} else {
			this.sql.exec(
				"UPDATE members SET role = ? WHERE board_id = ? AND login = ?",
				role,
				id,
				target.login,
			);
		}
		log.info("board.member.updated", { board: id, by: visitor.user?.login, login, role });
		await this.notifyBoard(id);
		return ok({ members: this.memberList(id) });
	}

	/** Remove a member. Anyone can leave a board they were invited to. */
	async removeMember(
		visitor: Visitor,
		id: string,
		login: string,
	): Promise<BoardResult<BoardMembers>> {
		this.touch(visitor);
		login = login.toLowerCase();
		const row = this.row(id);
		if (!row) return refuse("not_found");
		const target = this.memberRows(id).find((member) => member.login === login);
		const leaving = target !== undefined && target.user_id === visitor.user?.id;
		if (!leaving) {
			const checked = this.managing(visitor, id);
			if (!checked.ok) return checked;
		}
		if (!target) return refuse("not_found");
		if (target.role === "owner") return refuse("invalid");
		this.sql.exec("DELETE FROM members WHERE board_id = ? AND login = ?", id, login);
		log.info("board.member.removed", { board: id, by: visitor.user?.login, login });
		await this.notifyBoard(id);
		return ok({ members: this.memberList(id) });
	}

	// ---------------------------------------------------------------------
	// Internals

	/** Whether someone may create boards: anyone allowed on the instance. */
	private canCreate(visitor: Visitor): boolean {
		return visitor.allowed;
	}

	private denied<T>(visitor: Visitor): BoardResult<T> {
		return refuse(visitor.user ? "forbidden" : "sign_in_required");
	}

	private managing(visitor: Visitor, id: string): BoardResult<Policy> {
		this.touch(visitor);
		const row = this.row(id);
		if (!row) return refuse("not_found");
		const policy = this.policy(row);
		const who = visitorKey(visitor);
		if (!roleFor(policy, who)) return this.denied(visitor);
		if (!canManage(policy, who)) return refuse("owner_required");
		return ok(policy);
	}

	/**
	 * Remember who someone is, for showing them to others, and turn invites
	 * to their login into membership: invites resolve to a GitHub id the
	 * first time the invitee signs in and shows up.
	 */
	private touch(visitor: Visitor): void {
		const user = visitor.user;
		if (!user) return;
		const now = Date.now();
		const known = this.sql
			.exec<PersonRow & { seen_at: number }>("SELECT * FROM people WHERE id = ?", user.id)
			.toArray()[0];
		if (
			!known ||
			known.login !== user.login ||
			known.name !== user.name ||
			known.avatar_url !== user.avatarUrl ||
			now - known.seen_at > PROFILE_TTL
		) {
			this.sql.exec(
				"INSERT OR REPLACE INTO people (id, login, name, avatar_url, seen_at) VALUES (?, ?, ?, ?, ?)",
				user.id,
				user.login,
				user.name,
				user.avatarUrl,
				now,
			);
		}

		const login = user.login.toLowerCase();
		const pending = this.sql
			.exec<{ board_id: string; role: string }>(
				"SELECT board_id, role FROM members WHERE login = ? AND user_id IS NULL",
				login,
			)
			.toArray();
		if (pending.length === 0) return;
		const changed: string[] = [];
		this.ctx.storage.transactionSync(() => {
			for (const invite of pending) {
				const existing = this.sql
					.exec<{ login: string }>(
						"SELECT login FROM members WHERE board_id = ? AND user_id = ?",
						invite.board_id,
						user.id,
					)
					.toArray()[0];
				// Already a member under an older login: keep that membership.
				if (existing) {
					this.sql.exec(
						"DELETE FROM members WHERE board_id = ? AND login = ?",
						invite.board_id,
						login,
					);
				} else {
					this.sql.exec(
						"UPDATE members SET user_id = ? WHERE board_id = ? AND login = ?",
						user.id,
						invite.board_id,
						login,
					);
					changed.push(invite.board_id);
				}
			}
		});
		if (changed.length > 0)
			log.info("board.member.resolved", { login, user: user.id, boards: changed });
	}

	private row(id: string): BoardRow | undefined {
		return this.sql.exec<BoardRow>("SELECT * FROM boards WHERE id = ?", id).toArray()[0];
	}

	private memberRows(id: string): MemberRow[] {
		return this.sql
			.exec<MemberRow>(
				`SELECT m.login, m.user_id, m.role, p.name, p.avatar_url, p.login AS current_login
				FROM members m LEFT JOIN people p ON p.id = m.user_id
				WHERE m.board_id = ?
				ORDER BY m.role = 'owner' DESC, m.user_id IS NULL, m.created_at`,
				id,
			)
			.toArray();
	}

	private memberList(id: string): BoardMember[] {
		return this.memberRows(id).map((row) => ({
			login: row.login,
			person: memberPerson(row),
			role: row.role as Role,
		}));
	}

	private policy(row: BoardRow): Policy {
		const members: Record<number, Role> = {};
		for (const member of this.sql
			.exec<{ user_id: number; role: string }>(
				"SELECT user_id, role FROM members WHERE board_id = ? AND user_id IS NOT NULL",
				row.id,
			)
			.toArray()) {
			members[member.user_id] = member.role as Role;
		}
		return {
			ownerId: row.owner_id,
			visibility: row.visibility as Visibility,
			instanceRole: row.instance_role as MemberRole,
			archived: row.archived_at !== null,
			members,
		};
	}

	private info(row: BoardRow, visitor: Visitor): BoardInfo {
		const policy = this.policy(row);
		const who = visitorKey(visitor);
		const members = this.memberRows(row.id);
		const owner = members.find((member) => member.role === "owner");
		const visit =
			who.userId === null
				? undefined
				: this.sql
						.exec<{ at: number }>(
							"SELECT at FROM visits WHERE user_id = ? AND board_id = ?",
							who.userId,
							row.id,
						)
						.toArray()[0];
		return {
			id: row.id,
			slug: row.slug,
			title: row.title,
			owner: owner ? memberPerson(owner) : null,
			visibility: policy.visibility,
			instanceRole: policy.instanceRole,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			archivedAt: row.archived_at,
			thumbnail: row.thumbnail ? (JSON.parse(row.thumbnail) as Thumbnail) : null,
			members: members
				.slice(0, MEMBER_PREVIEW)
				.map(memberPerson)
				.filter((person): person is Person => person !== null),
			memberCount: members.length,
			role: roleFor(policy, who),
			canManage: baseRole(policy, who) !== null && canManage(policy, who),
			visitedAt: visit?.at ?? null,
		};
	}

	private addMember(
		id: string,
		login: string,
		userId: number | null,
		role: Role,
		invitedBy: number | null,
	): void {
		this.sql.exec(
			`INSERT OR REPLACE INTO members (board_id, login, user_id, role, invited_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			login.toLowerCase(),
			userId,
			role,
			invitedBy,
			Date.now(),
		);
	}

	/** "Untitled board", or "Untitled board 3" if you have unnamed boards already. */
	private untitledTitle(ownerId: number): string {
		const taken = this.sql
			.exec<{ title: string }>(
				`SELECT title FROM boards WHERE owner_id = ? AND archived_at IS NULL
				AND (title = ? OR substr(title, 1, ?) = ?)`,
				ownerId,
				DEFAULT_TITLE,
				DEFAULT_TITLE.length + 1,
				`${DEFAULT_TITLE} `,
			)
			.toArray()
			.map(({ title }) =>
				title === DEFAULT_TITLE ? 1 : Number(title.slice(DEFAULT_TITLE.length + 1)),
			)
			.filter((n) => Number.isInteger(n) && n > 0);
		if (taken.length === 0) return DEFAULT_TITLE;
		return `${DEFAULT_TITLE} ${Math.max(...taken) + 1}`;
	}

	/** Someone we've seen with this login, so an invite resolves straight away. */
	private knownUserId(login: string): number | null {
		return (
			this.sql
				.exec<{ id: number }>(
					"SELECT id FROM people WHERE lower(login) = ? ORDER BY seen_at DESC LIMIT 1",
					login,
				)
				.toArray()[0]?.id ?? null
		);
	}

	private newId(): string {
		for (;;) {
			const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
			const id = Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
			if (!this.row(id)) return id;
		}
	}

	/** Tell the board's live connections about new access rules. */
	private async notifyBoard(id: string): Promise<void> {
		const row = this.row(id);
		if (!row) return;
		try {
			await boards(this.env).getByName(id).accessChanged(this.policy(row));
		} catch (error) {
			log.error("board.access.failed", { board: id, error });
		}
	}

	/** Tell everyone on the board its new name. */
	private async notifyRenamed(id: string): Promise<void> {
		const row = this.row(id);
		if (!row) return;
		try {
			await boards(this.env).getByName(id).renamed(row.title, row.slug);
		} catch (error) {
			log.error("board.rename.failed", { board: id, error });
		}
	}
}

function refuse<T>(error: Exclude<BoardResult<T>, { ok: true }>["error"]): BoardResult<T> {
	return { ok: false, error };
}

function memberPerson(row: MemberRow): Person | null {
	if (row.user_id === null) return null;
	const login = row.current_login ?? row.login;
	return {
		id: row.user_id,
		login,
		name: row.name ?? null,
		avatarUrl: row.avatar_url ?? `https://github.com/${login}.png?size=96`,
	};
}
