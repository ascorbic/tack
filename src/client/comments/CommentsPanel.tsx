import { useEffect } from "react";
import type * as Y from "yjs";
import {
	type CommentFilter,
	type CommentThread,
	excerpt,
	filterThreads,
	liveMessages,
	mentions,
	starter,
} from "../../shared/comments.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { shortRef } from "../../shared/rules.ts";
import { stackName } from "../../shared/stacks.ts";
import { type ShapeProps, shapesMap } from "../../shared/shapes.ts";
import { relativeTime } from "../boards/api.ts";
import { cardStore } from "../cardStore.ts";
import { Avatar } from "../People.tsx";
import { BubbleIcon, CloseIcon, EyeIcon } from "./icons.tsx";
import { type CommentStore, commentStore, useCommentUI, useComments } from "./store.ts";
import { CommentBody, authorUser, useNow } from "./Thread.tsx";
import "./comments.css";

// The comments panel (#51), from the top bar's Comments button: every
// thread on the board, open, resolved, or mentioning you, newest activity
// first, with unread ones marked. Click one to go to it on the canvas.

const FILTERS: { id: CommentFilter; label: string }[] = [
	{ id: "open", label: "Open" },
	{ id: "resolved", label: "Resolved" },
	{ id: "mentions", label: "Mentions" },
];

/** Where a thread is, in words: on a card, in a section, on a sticky, or on the board. */
export function threadPlace(doc: Y.Doc | null, thread: CommentThread): string {
	const id = thread.anchor.shape;
	const shape = id && doc ? shapesMap(doc).get(id) : undefined;
	if (!shape) return id ? "where a shape was" : "on the board";
	const type = shape.get("type");
	if (type === "section") {
		const title = (shape.get("title") as string | undefined)?.trim();
		return title ? `in “${title}”` : "in a section";
	}
	if (type === "card") {
		const ref = shape.get("ref") as string | undefined;
		if (!ref) return "on a card";
		const card = cardStore.get(ref);
		const short = shortRef(ref, repoKeyOf(ref));
		return card && !("missing" in card) ? `on ${short} ${excerpt(card.title, 40)}` : `on ${short}`;
	}
	if (type === "sticky") {
		const text = (shape.get("text") as string | undefined)?.trim();
		return text ? `on “${excerpt(text, 32)}”` : "on a sticky";
	}
	if (type === "decision") {
		const title = (shape.get("title") as string | undefined)?.trim();
		return title ? `on “${excerpt(title, 32)}”` : "on a decision";
	}
	if (type === "action") {
		const text = (shape.get("text") as string | undefined)?.trim();
		return text ? `on “${excerpt(text, 32)}”` : "on an action item";
	}
	if (type === "stack") {
		const name = stackName(shape.toJSON() as ShapeProps);
		return name ? `on the “${excerpt(name, 32)}” stack` : "on a stack";
	}
	if (type === "text") return "on some text";
	return "on the board";
}

/** The top bar's button: comments, and how many are unread. */
export function CommentsButton({ store = commentStore }: { store?: CommentStore }) {
	const { threads } = useComments(store);
	const ui = useCommentUI(store);
	const unread = [...threads.values()].filter(
		(thread) => !thread.resolved && store.isUnread(thread),
	).length;
	const open = [...threads.values()].filter((t) => !t.resolved && liveMessages(t).length > 0);
	return (
		<button
			type="button"
			className="comments-button"
			aria-pressed={ui.panel}
			aria-label={`Comments: ${open.length} open${unread > 0 ? `, ${unread} unread` : ""}`}
			data-tooltip={[
				`${open.length} open ${open.length === 1 ? "thread" : "threads"} on this board`,
				unread > 0 ? `${unread} with replies you haven’t read` : null,
			]
				.filter(Boolean)
				.join(" · ")}
			data-shortcut="B to add one"
			data-unread={unread > 0 || undefined}
			onClick={() => store.setUI({ panel: !ui.panel })}
		>
			<span className="comments-button-icon">
				<BubbleIcon size={15} />
				{unread > 0 && <span className="comments-button-dot" key={unread} />}
			</span>
			<span className="topbar-label">Comments</span>
			{open.length > 0 && (
				<span className="comments-button-count" data-unread={unread > 0 || undefined}>
					{unread > 0 ? unread : open.length}
				</span>
			)}
		</button>
	);
}

export function CommentsPanel({
	doc,
	login,
	onJump,
	store = commentStore,
}: {
	doc: Y.Doc | null;
	login?: string;
	/** Go to a thread on the canvas. */
	onJump: (thread: CommentThread) => void;
	store?: CommentStore;
}) {
	const { threads, ready } = useComments(store);
	const ui = useCommentUI(store);
	const now = useNow();

	useEffect(() => {
		if (!ui.panel) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !ui.open) store.setUI({ panel: false });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ui.panel, ui.open, store]);

	if (!ui.panel) return null;
	const counts = Object.fromEntries(
		FILTERS.map(({ id }) => [id, filterThreads(threads.values(), id, login).length]),
	) as Record<CommentFilter, number>;
	const list = filterThreads(threads.values(), ui.filter, login);

	return (
		<aside className="comments-panel comment-ui" aria-label="Comments">
			<header className="comments-head">
				<span className="comments-head-icon">
					<BubbleIcon size={17} />
				</span>
				<div>
					<h2>Comments</h2>
					<p>Press B, then click anything to comment on it.</p>
				</div>
				<button
					type="button"
					className="comment-icon-button"
					aria-label="Close comments"
					onClick={() => store.setUI({ panel: false })}
				>
					<CloseIcon />
				</button>
			</header>
			<div className="comments-filters" role="tablist" aria-label="Show">
				{FILTERS.map((filter) => (
					<button
						key={filter.id}
						type="button"
						role="tab"
						aria-selected={ui.filter === filter.id}
						onClick={() => store.setUI({ filter: filter.id })}
					>
						{filter.label}
						<span className="comments-filter-count">{counts[filter.id]}</span>
					</button>
				))}
			</div>
			<div className="comments-body">
				{!ready ? (
					<ul className="comments-list" aria-busy="true">
						{[0, 1, 2].map((i) => (
							<li key={i} className="comments-skeleton" />
						))}
					</ul>
				) : list.length === 0 ? (
					<EmptyList filter={ui.filter} />
				) : (
					<ul className="comments-list" aria-label={`${ui.filter} comments`}>
						{list.map((thread, i) => {
							const messages = liveMessages(thread);
							const first = messages[0];
							const latest = messages.at(-1);
							const author = starter(thread);
							if (!first || !author) return null;
							const unread = store.isUnread(thread);
							const replies = messages.length - 1;
							return (
								<li
									key={thread.id}
									style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
									data-unread={unread || undefined}
									data-active={ui.open === thread.id || undefined}
								>
									<button
										type="button"
										className="comments-item"
										onClick={() => onJump(thread)}
										aria-label={`Comment by ${author.name || author.login} ${threadPlace(doc, thread)}${unread ? ", unread" : ""}`}
									>
										<Avatar user={authorUser(author)} />
										<span className="comments-item-main">
											<span className="comments-item-meta">
												<strong>{author.name || author.login}</strong>
												<span className="comments-item-place">{threadPlace(doc, thread)}</span>
												<time>{relativeTime(latest?.at ?? first.at, now)}</time>
											</span>
											<CommentBody message={first} login={login} />
											<span className="comments-item-foot">
												{replies > 0 && (
													<span>
														{replies} {replies === 1 ? "reply" : "replies"}
													</span>
												)}
												{mentions(thread, login) && (
													<span className="comments-you">Mentions you</span>
												)}
												{thread.resolved && (
													<span>
														Resolved by {thread.resolved.by.name || thread.resolved.by.login}
													</span>
												)}
											</span>
										</span>
										{unread && <span className="comments-unread" aria-hidden="true" />}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
			<footer className="comments-foot">
				<label className="comments-toggle">
					<input
						type="checkbox"
						checked={ui.showResolved}
						onChange={(event) => store.setUI({ showResolved: event.target.checked })}
					/>
					<EyeIcon size={14} />
					Show resolved on the board
				</label>
			</footer>
		</aside>
	);
}

function EmptyList({ filter }: { filter: CommentFilter }) {
	const copy: Record<CommentFilter, [string, string]> = {
		open: ["No open comments", "Press B, then click a card, a sticky, a section or anywhere."],
		resolved: ["Nothing resolved yet", "Resolved threads move here, out of the way."],
		mentions: ["No mentions", "When someone @mentions you, it shows up here."],
	};
	const [title, hint] = copy[filter];
	return (
		<div className="comments-empty">
			<span className="comments-empty-art" aria-hidden="true">
				<span />
				<span />
			</span>
			<strong>{title}</strong>
			<p>{hint}</p>
		</div>
	);
}
