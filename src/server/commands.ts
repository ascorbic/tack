import { getServerByName } from "partyserver";
import { boardPath, canEdit } from "../shared/boards.ts";
import {
	type BoardLink,
	type CommandOutcome,
	commandReply,
	matchBoard,
	succeeded,
} from "../shared/commands.ts";
import type { Board } from "./board.ts";
import type { CommandBoard } from "./directory.ts";
import { type CommentCommand, forge, type RepoIdentity } from "./forges/index.ts";
import { userToken } from "./identity.ts";
import type { Logger } from "./log.ts";
import { boards, directory, instance } from "./namespaces.ts";

// Comment commands (#58), on the server: each `Repo` runs the commands left
// in comments on its items (`@tack add to roadmap in Next up`), once per
// comment, from its alarm, and answers on the forge as the app: 👀 on the
// comment while it works, a reply, then 🚀 (or 😕 when it couldn't).
//
// Who can do what:
// - The commenter is whoever the forge says wrote the comment, by user id,
//   which on GitHub is a Tack user's id. They must have signed in to this
//   instance at least once, and be allowed on it.
// - They can only add to boards they can edit. Boards are found among the
//   ones they can open; one they can only view gets a "no permission" reply.
// - An item from a repository that isn't known to be public only goes on a
//   private board whose members (all of them, by their own tokens) can read
//   the repository, with no invites outstanding (nobody to check yet). That's
//   stricter than a person pasting a link, on purpose: nobody on the board
//   asked for this item, and the key alone says what the repository calls it.
//
// Replies go where everyone who can read the item reads them, so they never
// name a board that isn't public unless the commenter named it themselves
// (see src/shared/commands.ts). Each repository posts at most `REPLY_BUDGET`
// replies an hour, so nobody can make the app spam a thread; past that, the
// reactions still say how it went.

/** Tries before giving up on a command (the forge being down, say). */
const MAX_ATTEMPTS = 4;
/** Waits between tries. */
const RETRY_MS = [5_000, 30_000, 120_000];
/** Replies a repository's commands may post per hour. */
const REPLY_BUDGET = 30;
const HOUR_MS = 60 * 60_000;
/** Commands are remembered this long, so a comment never runs twice. */
const RETENTION_MS = 30 * 24 * HOUR_MS;
/** Boards named in a reply when a name could be several. */
const MAX_SUGGESTIONS = 5;

export interface CommandsHost {
	env: Env;
	sql: SqlStorage;
	/** The repository the commands are in. */
	identity(): RepoIdentity | null;
	logger(): Logger;
}

interface CommandRow extends Record<string, SqlStorageValue> {
	comment: string;
	command: string;
	status: string;
	attempts: number;
	due_at: number | null;
	first_at: number | null;
	eyes: string | null;
	outcome: string | null;
	board: string | null;
	replied_at: number | null;
	received_at: number;
}

/** What a command came to, and the board it was about, if any. */
interface Decision {
	outcome: CommandOutcome;
	board: string | null;
}

class RetryLater extends Error {}

export class CommentCommands {
	/** Waits between tries; tests shorten them. */
	retryMs: number[] = RETRY_MS;

	constructor(private readonly host: CommandsHost) {
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS comment_commands (
				comment TEXT PRIMARY KEY,
				command TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				due_at INTEGER,
				first_at INTEGER,
				eyes TEXT,
				outcome TEXT,
				board TEXT,
				replied_at INTEGER,
				received_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS comment_commands_due ON comment_commands (status, due_at);
		`);
	}

	/**
	 * A command arrived: queue it to run at once, unless this comment has
	 * been seen before (a redelivery, or an edit of a comment that was
	 * already a command).
	 */
	receive(command: CommentCommand): "queued" | "duplicate" {
		const now = Date.now();
		const logger = this.host.logger().with({ comment: command.comment.id });
		this.host.sql.exec("DELETE FROM comment_commands WHERE received_at < ?", now - RETENTION_MS);
		const known = this.host.sql
			.exec("SELECT 1 FROM comment_commands WHERE comment = ?", command.comment.id)
			.toArray().length;
		if (known) {
			logger.info("command.duplicate", { item: command.item.key, edited: command.edited });
			return "duplicate";
		}
		this.host.sql.exec(
			`INSERT INTO comment_commands (comment, command, status, due_at, received_at)
			VALUES (?, ?, 'pending', ?, ?)`,
			command.comment.id,
			JSON.stringify(command),
			now,
			now,
		);
		logger.info("command.received", {
			item: command.item.key,
			command: command.command.kind,
			by: command.author.login,
			edited: command.edited,
		});
		return "queued";
	}

	/** When the next command is due, if any are waiting. */
	nextDue(): number | null {
		return (
			this.host.sql
				.exec<{ due: number | null }>(
					"SELECT MIN(due_at) AS due FROM comment_commands WHERE status = 'pending'",
				)
				.toArray()[0]?.due ?? null
		);
	}

	/** Run every command that's due, in the order they arrived. */
	async runDue(): Promise<void> {
		const due = this.host.sql
			.exec<CommandRow>(
				"SELECT * FROM comment_commands WHERE status = 'pending' AND due_at <= ? ORDER BY received_at",
				Date.now(),
			)
			.toArray();
		for (const row of due) await this.run(row);
	}

	/** Commands as stored, for tests and debugging. */
	list(): { comment: string; status: string; attempts: number; outcome: string | null }[] {
		return this.host.sql
			.exec<CommandRow>("SELECT * FROM comment_commands ORDER BY received_at")
			.toArray()
			.map((row) => ({
				comment: row.comment,
				status: row.status,
				attempts: row.attempts,
				outcome: row.outcome ? (JSON.parse(row.outcome) as CommandOutcome).kind : null,
			}));
	}

	private async run(row: CommandRow): Promise<void> {
		const command = JSON.parse(row.command) as CommentCommand;
		const identity = this.host.identity();
		const logger = this.host.logger().with({ comment: row.comment, item: command.item.key });
		if (!identity) return this.finish(row.comment, "failed");
		const adapter = forge(identity.forge);
		const now = Date.now();
		const attempts = row.attempts + 1;
		const firstAt = row.first_at ?? now;
		this.update(row.comment, { attempts, first_at: firstAt, due_at: null });

		let eyes = row.eyes;
		try {
			// Looking: it may take a moment.
			if (!eyes && adapter.react) {
				eyes = await adapter.react(identity, row.comment, "eyes", this.host.env).catch((error) => {
					logger.warn("command.react.failed", { reaction: "eyes", error });
					return null;
				});
				if (eyes) this.update(row.comment, { eyes });
			}

			// Decided once: a retry only finishes answering.
			let decision: Decision;
			if (row.outcome) {
				decision = { outcome: JSON.parse(row.outcome) as CommandOutcome, board: row.board };
			} else {
				decision = await this.decide(command, identity);
				this.update(row.comment, {
					outcome: JSON.stringify(decision.outcome),
					board: decision.board,
				});
			}

			if (row.replied_at === null && adapter.reply) {
				if (this.repliesInLastHour() >= REPLY_BUDGET) {
					logger.warn("command.limited", { budget: REPLY_BUDGET });
				} else {
					const reply = await adapter.reply(
						identity,
						command.item.ref,
						commandReply(decision.outcome),
						this.host.env,
						attempts > 1 ? { retryOf: firstAt } : {},
					);
					if (!reply.ok && reply.retryable) throw new RetryLater(reply.error);
					if (!reply.ok) logger.warn("command.reply.failed", { error: reply.error });
					this.update(row.comment, { replied_at: Date.now() });
				}
			}

			await this.settle(identity, row.comment, eyes, succeeded(decision.outcome), logger);
			this.finish(row.comment, "done");
			logger.info("command.done", {
				command: command.command.kind,
				outcome: decision.outcome.kind,
				board: decision.board,
				by: command.author.login,
				attempts,
			});
		} catch (error) {
			if (attempts >= MAX_ATTEMPTS) {
				this.finish(row.comment, "failed");
				logger.error("command.failed", { attempts, error });
				// If it never got as far as an answer, say it didn't work (once).
				const decided = this.host.sql
					.exec(
						"SELECT 1 FROM comment_commands WHERE comment = ? AND outcome IS NOT NULL",
						row.comment,
					)
					.toArray().length;
				if (!decided && row.replied_at === null) {
					await adapter
						.reply?.(identity, command.item.ref, commandReply({ kind: "failed" }), this.host.env)
						.catch(() => undefined);
				}
				await this.settle(identity, row.comment, eyes, false, logger);
				return;
			}
			const waits = this.retryMs;
			const retryAt = Date.now() + (waits[attempts - 1] ?? waits.at(-1) ?? 60_000);
			this.update(row.comment, { due_at: retryAt });
			logger.warn("command.retry", { attempts, retryAt, error });
		}
	}

	/** Swap 👀 for how it went. Reactions are a courtesy: failing them fails nothing. */
	private async settle(
		identity: RepoIdentity,
		comment: string,
		eyes: string | null,
		ok: boolean,
		logger: Logger,
	): Promise<void> {
		const adapter = forge(identity.forge);
		const env = this.host.env;
		const reaction = ok ? "rocket" : "confused";
		await adapter.react?.(identity, comment, reaction, env).catch((error: unknown) => {
			logger.warn("command.react.failed", { reaction, error });
		});
		if (eyes) {
			await adapter.unreact?.(identity, comment, eyes, env).catch((error: unknown) => {
				logger.warn("command.react.failed", { reaction: "eyes", removing: true, error });
			});
		}
	}

	/** What a command comes to: checking who asked, finding the board, and placing the card. */
	private async decide(command: CommentCommand, identity: RepoIdentity): Promise<Decision> {
		const env = this.host.env;
		const { item } = command;
		if (command.command.kind === "help") {
			return {
				outcome: { kind: "help", name: command.command.name, item: item.kind },
				board: null,
			};
		}
		const asked = command.command;

		const user = await instance(env).knownUser(command.author.id);
		if (!user)
			return { outcome: { kind: "unknown_user", signIn: `${command.origin}/` }, board: null };
		if (!user.allowed) return { outcome: { kind: "not_allowed" }, board: null };

		const all = await directory(env).commandBoards(command.author.id, true);
		const editable = all.filter((board) => canEdit(board.role));
		const tries = asked.section
			? [
					{ query: asked.board, section: asked.section },
					{ query: asked.whole, section: undefined },
				]
			: [{ query: asked.board, section: undefined }];

		let found: { board: CommandBoard; query: string; section: string | undefined } | null = null;
		for (const attempt of tries) {
			const match = matchBoard(attempt.query, editable);
			if (match.kind === "found") {
				found = { board: match.value, query: attempt.query, section: attempt.section };
				break;
			}
			if (match.kind === "ambiguous") {
				const links = match.values.slice(0, MAX_SUGGESTIONS).map((b) => this.link(b, command));
				return { outcome: { kind: "ambiguous", query: attempt.query, boards: links }, board: null };
			}
		}
		if (!found) {
			// Boards they can open but not edit, or that are archived.
			for (const attempt of tries) {
				const match = matchBoard(attempt.query, all);
				if (match.kind === "none") continue;
				const board = match.kind === "found" ? match.value : null;
				return {
					outcome: board?.archived
						? { kind: "archived", query: attempt.query }
						: { kind: "no_permission", query: attempt.query },
					board: board?.id ?? null,
				};
			}
			return { outcome: { kind: "not_found", query: asked.board }, board: null };
		}

		const { board, query, section } = found;
		const privacy = await this.privacyProblem(identity, board);
		if (privacy) {
			return { outcome: { kind: "private_repo", query, reason: privacy }, board: board.id };
		}

		const stub = await getServerByName<Env, Board>(boards(env), board.id);
		const result = await stub.addFromCommand({
			key: item.key,
			...(section ? { section } : {}),
			provenance: { via: "comment", source: command.comment.url, by: command.author.login },
			by: { id: command.author.id, login: command.author.login },
		});
		const link = this.link(board, command);
		const outcome: CommandOutcome =
			result.status === "added"
				? {
						kind: "added",
						board: link,
						item: item.kind,
						section: result.section?.title ?? null,
						full: result.full,
					}
				: result.status === "already"
					? { kind: "already", board: link, item: item.kind }
					: result.status === "no_room"
						? { kind: "no_room", board: link, query }
						: {
								kind: result.status,
								board: link,
								query,
								section: section ?? "",
								sections: result.sections,
							};
		return { outcome, board: board.id };
	}

	/**
	 * Why this repository's items can't go on a board, if they can't: a
	 * repository that isn't known to be public needs a private board whose
	 * members can all read it, checked with each one's own token.
	 */
	private async privacyProblem(
		identity: RepoIdentity,
		board: CommandBoard,
	): Promise<"visibility" | "members" | "pending" | null> {
		const adapter = forge(identity.forge);
		if (identity.private === false || !adapter.canRead) return null;
		if (board.visibility !== "private") return "visibility";
		if (board.pending > 0) return "pending";
		const readable = await Promise.all(
			board.members.map(async (member) => {
				const token = await userToken(this.host.env, member).catch(() => null);
				if (!token) return false;
				return adapter.canRead!(identity, token, this.host.env).catch(() => false);
			}),
		);
		return readable.every(Boolean) ? null : "members";
	}

	private link(board: CommandBoard, command: CommentCommand): BoardLink {
		return {
			title: board.title,
			url: `${command.origin}${boardPath(board)}`,
			public: board.visibility === "public",
		};
	}

	private repliesInLastHour(): number {
		return (
			this.host.sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM comment_commands WHERE replied_at > ?",
					Date.now() - HOUR_MS,
				)
				.toArray()[0]?.n ?? 0
		);
	}

	private finish(comment: string, status: "done" | "failed"): void {
		this.update(comment, { status, due_at: null });
	}

	private update(
		comment: string,
		fields: Partial<Record<keyof CommandRow, SqlStorageValue>>,
	): void {
		const entries = Object.entries(fields);
		if (entries.length === 0) return;
		this.host.sql.exec(
			`UPDATE comment_commands SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE comment = ?`,
			...entries.map(([, value]) => value ?? null),
			comment,
		);
	}
}
