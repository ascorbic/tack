import { clock } from "../clock.ts";
import { useEffect, useRef, useState } from "react";
import {
	type CommentAuthor,
	type CommentMessage,
	type CommentThread,
	type CommentsYou,
	bodyParts,
} from "../../shared/comments.ts";
import { personColor } from "../auth/me.ts";
import { relativeTime } from "../boards/api.ts";
import { Avatar } from "../People.tsx";
import { Composer } from "./Composer.tsx";
import { CheckIcon, CloseIcon, EditIcon, ReopenIcon, ResolveIcon, TrashIcon } from "./icons.tsx";
import type { PendingMessage } from "./store.ts";

// A comment thread: its messages, a reply box, and resolving. Board-free,
// so the gallery can show every state; the canvas wraps it in a popover by
// its pin (see CommentLayer.tsx).

export interface ThreadActions {
	reply: (body: string) => void;
	edit: (message: string, body: string) => void;
	delete: (message: string) => void;
	resolve: (resolved: boolean) => void;
	close: () => void;
}

export function authorUser(author: CommentAuthor) {
	return {
		name: author.name || author.login,
		color: personColor(author.id),
		avatarUrl: author.avatarUrl,
	};
}

/** A message body, with the mentions the server checked set apart. */
export function CommentBody({ message, login }: { message: CommentMessage; login?: string }) {
	const self = login?.toLowerCase();
	return (
		<p className="comment-body">
			{bodyParts(message.body, message.mentions).map((part, i) =>
				"mention" in part ? (
					<span
						key={i}
						className="comment-mention"
						data-self={part.mention === self || undefined}
						title={`@${part.mention}`}
					>
						{part.text}
					</span>
				) : (
					<span key={i}>{part.text}</span>
				),
			)}
		</p>
	);
}

/** The time now, re-rendering every so often for relative times. */
export function useNow(ms = 30_000): number {
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return clock.now();
}

export function ThreadView({
	thread,
	you,
	login,
	canTriage,
	actions,
	unreadSince,
}: {
	thread: CommentThread;
	you: CommentsYou;
	/** Your login, to set your own mentions apart. */
	login?: string;
	/** Whether you can resolve it: yours, or you can edit the board. */
	canTriage: boolean;
	actions: ThreadActions;
	/** Messages after this were new when the thread opened. */
	unreadSince?: number;
}) {
	const now = useNow();
	const [editing, setEditing] = useState<string | null>(null);
	const list = useRef<HTMLOListElement>(null);
	const count = useRef(thread.messages.length);

	// New messages scroll into view, as a chat would.
	useEffect(() => {
		if (thread.messages.length > count.current) {
			list.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
		count.current = thread.messages.length;
	}, [thread.messages.length]);

	const resolved = thread.resolved;
	const messages = thread.messages as PendingMessage[];
	return (
		<div className="comment-thread" data-resolved={!!resolved || undefined}>
			<header className="comment-thread-head">
				<span className="comment-thread-title">
					{resolved ? "Resolved" : "Comment"}
					{messages.filter((m) => !m.deleted).length > 1 && (
						<span className="comment-thread-count">
							{messages.filter((m) => !m.deleted).length}
						</span>
					)}
				</span>
				{canTriage && (
					<button
						type="button"
						className="comment-icon-button"
						data-action={resolved ? "reopen" : "resolve"}
						aria-label={resolved ? "Reopen" : "Resolve"}
						data-tip={resolved ? "Reopen" : "Resolve"}
						onClick={() => actions.resolve(!resolved)}
					>
						{resolved ? <ReopenIcon /> : <ResolveIcon />}
					</button>
				)}
				<button
					type="button"
					className="comment-icon-button"
					aria-label="Close"
					data-tip="Close"
					onClick={actions.close}
				>
					<CloseIcon />
				</button>
			</header>
			{resolved && (
				<p className="comment-resolved">
					<CheckIcon size={13} />
					Resolved by {resolved.by.name || resolved.by.login}
					<span aria-hidden="true"> · </span>
					{relativeTime(resolved.at, now)}
				</p>
			)}
			<ol className="comment-messages" ref={list}>
				{messages.map((message) => {
					if (message.deleted) {
						return (
							<li key={message.id} className="comment-message" data-deleted>
								<p className="comment-deleted">This comment was deleted</p>
							</li>
						);
					}
					const mine = you.id !== null && message.author.id === you.id;
					const fresh = unreadSince !== undefined && !mine && message.at > unreadSince;
					return (
						<li
							key={message.id}
							className="comment-message"
							data-pending={message.pending || undefined}
							data-fresh={fresh || undefined}
						>
							<Avatar user={authorUser(message.author)} />
							<div className="comment-message-main">
								<div className="comment-message-meta">
									<span className="comment-author">
										{message.author.name || message.author.login}
									</span>
									<time dateTime={new Date(message.at).toISOString()}>
										{message.pending ? "Sending…" : relativeTime(message.at, now)}
									</time>
									{message.editedAt && <span className="comment-edited">edited</span>}
									{mine && !message.pending && editing !== message.id && (
										<span className="comment-message-tools">
											<button
												type="button"
												className="comment-icon-button"
												aria-label="Edit"
												data-tip="Edit"
												onClick={() => setEditing(message.id)}
											>
												<EditIcon size={14} />
											</button>
											<button
												type="button"
												className="comment-icon-button"
												data-danger
												aria-label="Delete"
												data-tip="Delete"
												onClick={() => actions.delete(message.id)}
											>
												<TrashIcon size={14} />
											</button>
										</span>
									)}
									{!mine && you.canModerate && (
										<span className="comment-message-tools">
											<button
												type="button"
												className="comment-icon-button"
												data-danger
												aria-label="Delete"
												data-tip="Delete (you own this board)"
												onClick={() => actions.delete(message.id)}
											>
												<TrashIcon size={14} />
											</button>
										</span>
									)}
								</div>
								{editing === message.id ? (
									<Composer
										placeholder="Edit your comment"
										initial={message.body}
										submitLabel="Save"
										onSubmit={(body) => {
											actions.edit(message.id, body);
											setEditing(null);
										}}
										onCancel={() => setEditing(null)}
									/>
								) : (
									<CommentBody message={message} login={login} />
								)}
							</div>
						</li>
					);
				})}
			</ol>
			{you.canComment ? (
				<div className="comment-reply">
					<Composer
						key={thread.id}
						compact
						placeholder={resolved ? "Reply to reopen" : "Reply"}
						onSubmit={actions.reply}
						onCancel={actions.close}
					/>
				</div>
			) : (
				<p className="comment-cant">{cantComment(you)}</p>
			)}
		</div>
	);
}

export function cantComment(you: CommentsYou): string {
	if (you.reason === "archived") return "This board is archived, so it’s read-only.";
	return "Sign in to reply.";
}
