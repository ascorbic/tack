import { type CSSProperties, useContext, useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { type VoteChoice, castVote, statusOf, tally } from "../../shared/decisions.ts";
import { type DotVote, ballotOf, dotsLeft, voteFor } from "../../shared/dotvotes.ts";
import { STAMPS, type StampEmoji } from "../../shared/facilitation.ts";
import { type CommentThread, anchorAt, isVisible, starter } from "../../shared/comments.ts";
import { voterKey } from "../../shared/decisions.ts";
import { excerpt } from "../../shared/comments.ts";
import type { ShapeNode } from "../board.ts";
import { CardView, StateIcon, cardTone } from "../CardView.tsx";
import { useCard } from "../cardStore.ts";
import { relativeTime } from "../boards/api.ts";
import { Composer } from "../comments/Composer.tsx";
import { threadPlace } from "../comments/CommentsPanel.tsx";
import { type CommentStore, commentStore, useComments } from "../comments/store.ts";
import { ThreadView, authorUser, cantComment, useNow } from "../comments/Thread.tsx";
import { dotShape, stampShape, VoteDots } from "../facilitation/Marks.tsx";
import { useStampCounts } from "../facilitation/hooks.ts";
import { facilitation, useSilentTexts } from "../facilitation/store.ts";
import { Avatar } from "../People.tsx";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { silentOf } from "../../shared/silent.ts";
import { countMembers, stackName } from "../../shared/stacks.ts";
import { isMissing, kindName } from "../../shared/cards.ts";
import { linkText, readPreview } from "../../shared/linkPreview.ts";
import { ServicesContext } from "../actions/services.ts";
import { LinkView } from "../links/LinkView.tsx";

// What a phone shows when you tap a shape (#67): the shape itself, big
// enough to read; its votes (a dot vote around it, or a decision's own);
// stamps; and its comments, to read, reply to or add to. Writing the
// document (dots, stamps, a decision's votes) is for editors, as on any
// screen; comments for anyone signed in.

const TYPE_NAMES: Record<string, string> = {
	sticky: "Sticky",
	text: "Text",
	card: "Card",
	section: "Section",
	decision: "Decision",
	widget: "Widget",
	action: "Action item",
	stack: "Stack",
};

export interface ShapeSheetProps {
	doc: Y.Doc;
	node: ShapeNode;
	user: User;
	readOnly: boolean;
	toasts: ToastStore;
	/** Every open dot vote, and the shapes they might cover. */
	votes: readonly DotVote[];
	shapes: ReadonlyMap<string, { type: ShapeNode["data"]["shape"]["type"]; parent?: string | null }>;
	/** The shape's drawn box, for where a new comment's pin goes. */
	box: { x: number; y: number; w: number; h: number };
	/** Open a thread in the sheet. */
	onOpenThread: (id: string) => void;
	store?: CommentStore;
}

/** The sheet's heading for a shape: what it is, and who made it or where it's from. */
export function ShapeHeading({ node }: { node: ShapeNode }) {
	const shape = node.data.shape;
	const card = useCard(shape.type === "card" ? (shape.ref ?? "") : "");
	let kind = TYPE_NAMES[shape.type] ?? "Shape";
	let detail: string | null = null;
	if (shape.type === "card" && card && !("missing" in card)) {
		// The card says which, just below.
		kind = kindName(card.kind);
	} else if (shape.type === "sticky" || shape.type === "decision") {
		detail = shape.author?.name ?? null;
	} else if (shape.type === "section") {
		detail = shape.title?.trim() || "Untitled";
	} else if (shape.type === "stack") {
		detail = stackName(shape);
	}
	return (
		<span className="phone-sheet-title">
			<span className="phone-sheet-kind">{kind}</span>
			{detail && <span className="phone-sheet-detail">{detail}</span>}
		</span>
	);
}

export function ShapeSheet({
	doc,
	node,
	user,
	readOnly,
	toasts,
	votes,
	shapes,
	box,
	onOpenThread,
	store = commentStore,
}: ShapeSheetProps) {
	const shape = node.data.shape;
	const id = node.id;
	return (
		<div className="shape-sheet" data-type={shape.type}>
			<ShapeFace doc={doc} node={node} user={user} readOnly={readOnly} />
			{!readOnly && (
				<DotVoteRow doc={doc} id={id} user={user} votes={votes} shapes={shapes} toasts={toasts} />
			)}
			{!readOnly && shape.type !== "section" && <Stamps doc={doc} id={id} user={user} />}
			<Comments id={id} box={box} store={store} onOpenThread={onOpenThread} />
		</div>
	);
}

/** The shape, as big as the sheet allows. */
function ShapeFace({
	doc,
	node,
	user,
	readOnly,
}: {
	doc: Y.Doc;
	node: ShapeNode;
	user: User;
	readOnly: boolean;
}) {
	const shape = node.data.shape;
	const card = useCard(shape.type === "card" ? (shape.ref ?? "") : "");
	const texts = useSilentTexts();
	const links = useContext(ServicesContext)?.links;
	switch (shape.type) {
		case "card":
			return (
				<div className="phone-sheet-card">
					<CardView card={card} cardKey={shape.ref ?? ""} selected />
				</div>
			);
		case "sticky": {
			const session = silentOf(shape);
			const mine = session !== null && texts.has(node.id);
			const faceDown = session !== null && !mine;
			const text = (mine ? texts.get(node.id) : shape.text) ?? "";
			return (
				<div
					className="phone-sheet-sticky"
					data-color={shape.color ?? "yellow"}
					data-font={shape.font}
					data-face-down={faceDown || undefined}
				>
					{faceDown ? (
						<p className="phone-sheet-sticky-hidden">Face down until it’s revealed</p>
					) : (
						<p className="phone-sheet-sticky-text">{text || <em>Empty</em>}</p>
					)}
					{shape.author?.name && (
						<span className="phone-sheet-sticky-author">
							<span
								className="phone-sheet-sticky-dot"
								style={{ background: shape.author.color }}
								aria-hidden="true"
							/>
							{shape.author.name}
						</span>
					)}
				</div>
			);
		}
		case "decision":
			return <DecisionFace doc={doc} node={node} user={user} readOnly={readOnly} />;
		case "action":
			return (
				<div className="phone-sheet-plain" data-done={shape.done || undefined}>
					<p className="phone-sheet-plain-text">{shape.text || <em>Empty</em>}</p>
					<p className="phone-sheet-meta">
						{[
							shape.done ? "Done" : "To do",
							shape.owner?.login ? `@${shape.owner.login}` : null,
							shape.due ? `due ${shape.due}` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
			);
		case "section":
			return null;
		case "stack":
			return <StackFace node={node} />;
		case "link":
			return (
				<div className="phone-sheet-card">
					<LinkView
						url={shape.url ?? ""}
						preview={readPreview(shape.preview)}
						selected
						imageSrc={links?.imageSrc}
					/>
				</div>
			);
		case "widget": {
			const config = shape.config as { title?: unknown } | undefined;
			const title = typeof config?.title === "string" ? config.title : "";
			return (
				<div className="phone-sheet-plain">
					<p className="phone-sheet-plain-text">{title || "A widget"}</p>
					<p className="phone-sheet-meta">Widgets are easier to read on a bigger screen.</p>
				</div>
			);
		}
		default:
			return (
				<div className="phone-sheet-plain">
					<p className="phone-sheet-plain-text">{shape.text || <em>Empty</em>}</p>
				</div>
			);
	}
}

/** A stack (#73): its stickies and cards, top first, each to read. */
function StackFace({ node }: { node: ShapeNode }) {
	const members = node.data.stack?.members ?? [];
	const texts = useSilentTexts();
	if (members.length === 0) {
		return (
			<div className="phone-sheet-plain">
				<p className="phone-sheet-plain-text">
					<em>An empty stack</em>
				</p>
			</div>
		);
	}
	return (
		<ol
			className="phone-sheet-stack"
			aria-label={countMembers(members.map(({ shape }) => shape.type)).replace(" ", " stacked ")}
		>
			{members.map(({ id, shape }, i) => {
				if (shape.type === "card") {
					return <StackCardItem key={id} cardRef={shape.ref ?? ""} index={i} />;
				}
				if (shape.type === "link") {
					const { title, host } = linkText(shape);
					return (
						<li
							key={id}
							className="phone-sheet-stack-item"
							data-kind="link"
							style={{ "--i": i } as CSSProperties}
						>
							<p className="phone-sheet-sticky-text">{title}</p>
							<span className="phone-sheet-sticky-author">{host}</span>
						</li>
					);
				}
				const session = silentOf(shape);
				const mine = session !== null && texts.has(id);
				const faceDown = session !== null && !mine;
				const text = (mine ? texts.get(id) : shape.text) ?? "";
				return (
					<li
						key={id}
						className="phone-sheet-stack-item"
						data-color={shape.color ?? "yellow"}
						data-font={shape.font}
						style={{ "--i": i } as CSSProperties}
					>
						{faceDown ? "Face down until it’s revealed" : text || <em>Empty</em>}
					</li>
				);
			})}
		</ol>
	);
}

/** A card in a stack's sheet: its state, number and title, or that it's private. */
function StackCardItem({ cardRef, index }: { cardRef: string; index: number }) {
	const card = useCard(cardRef);
	const style = { "--i": index } as CSSProperties;
	if (!card || isMissing(card)) {
		return (
			<li className="phone-sheet-stack-item" data-kind="card" style={style}>
				<em>
					{!card ? "Loading…" : card.reason === "private" ? "Private item" : "Unavailable item"}
				</em>
			</li>
		);
	}
	return (
		<li className="phone-sheet-stack-item" data-kind="card" {...cardTone(card)} style={style}>
			<span className="state-icon" title={kindName(card.kind)}>
				<StateIcon card={card} size={15} />
			</span>
			<span className="phone-sheet-stack-ref">{card.item}</span> {card.title}
		</li>
	);
}

/** A decision: what was decided, and agreeing or disagreeing while it's proposed. */
function DecisionFace({
	doc,
	node,
	user,
	readOnly,
}: {
	doc: Y.Doc;
	node: ShapeNode;
	user: User;
	readOnly: boolean;
}) {
	const shape = node.data.shape;
	const status = statusOf(shape);
	const votes = tally(shape.votes);
	const mine = shape.votes?.[voterKey(user)]?.choice ?? null;
	const vote = (choice: VoteChoice) =>
		castVote(doc, node.id, user, mine === choice ? null : choice);
	return (
		<div className="phone-sheet-decision" data-status={status}>
			<span className="phone-sheet-decision-status">{status}</span>
			<h3 className="phone-sheet-decision-title">{shape.title?.trim() || "Untitled decision"}</h3>
			{shape.text?.trim() && <p className="phone-sheet-decision-text">{shape.text}</p>}
			{status === "proposed" && (
				<div className="phone-sheet-choices" role="group" aria-label="Your vote">
					{(["agree", "disagree"] as const).map((choice) => (
						<button
							key={choice}
							type="button"
							className="phone-sheet-choice"
							data-choice={choice}
							aria-pressed={mine === choice}
							disabled={readOnly}
							onClick={() => vote(choice)}
						>
							<span className="phone-sheet-choice-label">
								{choice === "agree" ? "Agree" : "Disagree"}
							</span>
							<span className="phone-sheet-choice-count">{votes[choice].length}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** Your dots, while a vote covers the shape: put one on, or take one back. */
function DotVoteRow({
	doc,
	id,
	user,
	votes,
	shapes,
	toasts,
}: {
	doc: Y.Doc;
	id: string;
	user: User;
	votes: readonly DotVote[];
	shapes: ShapeSheetProps["shapes"];
	toasts: ToastStore;
}) {
	const vote = voteFor(votes, shapes, id, facilitation.serverNow());
	if (!vote) return null;
	const mineHere = Math.max(0, ballotOf(vote, user)?.dots[id] ?? 0);
	const left = dotsLeft(vote, user);
	const dot = (remove: boolean) => {
		const result = dotShape(doc, votes, shapes, id, user, remove);
		if (result === "none_left") {
			toasts.show({ message: "No dots left: take one back from something else first" });
		}
		if (result === "placed" && navigator.vibrate) navigator.vibrate(8);
	};
	return (
		<section className="phone-sheet-section phone-sheet-vote" aria-label="Dot vote">
			<div className="phone-sheet-vote-head">
				<h3 className="phone-sheet-section-title">{vote.title?.trim() || "Dot vote"}</h3>
				<span className="phone-sheet-vote-left" aria-live="polite">
					{left === 0 ? "No dots left" : `${left} ${left === 1 ? "dot" : "dots"} left`}
				</span>
			</div>
			<div className="phone-sheet-vote-row">
				<VoteDots vote={vote} shape={id} me={user} />
				<span className="phone-sheet-vote-buttons">
					<button
						type="button"
						className="phone-sheet-round"
						aria-label="Take a dot back"
						disabled={mineHere === 0}
						onClick={() => dot(true)}
					>
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3.5 8h9" />
						</svg>
					</button>
					<span className="phone-sheet-vote-mine" aria-label={`Your dots here: ${mineHere}`}>
						{mineHere}
					</span>
					<button
						type="button"
						className="phone-sheet-round phone-sheet-round-primary"
						aria-label="Add a dot"
						disabled={left === 0}
						onClick={() => dot(false)}
					>
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3.5 8h9M8 3.5v9" />
						</svg>
					</button>
				</span>
			</div>
		</section>
	);
}

/** Stamps: every one there is, with how many each has, yours pressed. */
function Stamps({ doc, id, user }: { doc: Y.Doc; id: string; user: User }) {
	const counts = useStampCounts(doc, user).get(id) ?? [];
	const byEmoji = new Map(counts.map((count) => [count.emoji, count]));
	const stamp = (emoji: StampEmoji) => stampShape(doc, id, emoji, user);
	return (
		<div className="phone-sheet-stamps" role="group" aria-label="Stamps">
			{STAMPS.map((emoji) => {
				const count = byEmoji.get(emoji);
				return (
					<button
						key={emoji}
						type="button"
						className="phone-sheet-stamp"
						aria-pressed={count?.mine ?? false}
						aria-label={`${emoji}${count ? ` ${count.count}` : ""}`}
						onClick={() => stamp(emoji)}
					>
						<span aria-hidden="true">{emoji}</span>
						{count && <span className="phone-sheet-stamp-count">{count.count}</span>}
					</button>
				);
			})}
		</div>
	);
}

/** The shape's comment threads, newest activity first, and a box to start one. */
function Comments({
	id,
	box,
	store,
	onOpenThread,
}: {
	id: string;
	box: ShapeSheetProps["box"];
	store: CommentStore;
	onOpenThread: (id: string) => void;
}) {
	const { threads, you } = useComments(store);
	const now = useNow();
	const [showResolved, setShowResolved] = useState(false);
	const here = useMemo(
		() =>
			[...threads.values()]
				.filter((thread) => thread.anchor.shape === id && isVisible(thread))
				.sort((a, b) => b.updatedAt - a.updatedAt),
		[threads, id],
	);
	const open = here.filter((thread) => !thread.resolved);
	const resolved = here.filter((thread) => thread.resolved);
	return (
		<section className="phone-sheet-section phone-sheet-comments" aria-label="Comments">
			<h3 className="phone-sheet-section-title">
				Comments
				{open.length > 0 && <span className="phone-sheet-count">{open.length}</span>}
			</h3>
			{here.length === 0 && <p className="phone-sheet-empty">No comments yet.</p>}
			<ul className="phone-sheet-threads">
				{[...open, ...(showResolved ? resolved : [])].map((thread) => (
					<li key={thread.id}>
						<ThreadRow
							thread={thread}
							unread={store.isUnread(thread)}
							now={now}
							onOpen={() => onOpenThread(thread.id)}
						/>
					</li>
				))}
			</ul>
			{resolved.length > 0 && !showResolved && (
				<button type="button" className="phone-sheet-link" onClick={() => setShowResolved(true)}>
					{resolved.length === 1 ? "1 resolved" : `${resolved.length} resolved`}
				</button>
			)}
			{you.canComment ? (
				<div className="phone-sheet-composer">
					<Composer
						placeholder="Add a comment"
						autoFocus={false}
						compact
						onSubmit={(body) => {
							// Its pin goes in the shape's top-right corner.
							const point = { x: box.x + Math.max(16, box.w - 20), y: box.y + 20 };
							store.start(anchorAt(point, { id, box }), body);
						}}
					/>
				</div>
			) : (
				<p className="phone-sheet-empty">{cantComment(you)}</p>
			)}
		</section>
	);
}

/** A thread in a list: who started it, what they said, how many replies. */
function ThreadRow({
	thread,
	unread,
	now,
	onOpen,
}: {
	thread: CommentThread;
	unread: boolean;
	now: number;
	onOpen: () => void;
}) {
	const first = starter(thread);
	const messages = thread.messages.filter((message) => !message.deleted);
	const replies = messages.length - 1;
	const body = messages[0]?.body ?? "";
	return (
		<button
			type="button"
			className="phone-sheet-thread"
			data-unread={unread || undefined}
			data-resolved={!!thread.resolved || undefined}
			onClick={onOpen}
		>
			{first && <Avatar user={authorUser(first)} />}
			<span className="phone-sheet-thread-main">
				<span className="phone-sheet-thread-head">
					<span className="phone-sheet-thread-name">
						{first?.name || first?.login || "Someone"}
					</span>
					<span className="phone-sheet-thread-time">{relativeTime(thread.updatedAt, now)}</span>
				</span>
				<span className="phone-sheet-thread-body">{excerpt(body, 120)}</span>
				{replies > 0 && (
					<span className="phone-sheet-thread-replies">
						{replies === 1 ? "1 reply" : `${replies} replies`}
					</span>
				)}
			</span>
			{unread && <span className="phone-sheet-unread" aria-label="Unread" />}
		</button>
	);
}

/** One thread, open in the sheet: read, reply, resolve. */
export function ThreadSheet({
	thread,
	login,
	toasts,
	doc,
	store = commentStore,
}: {
	thread: CommentThread;
	login?: string;
	toasts: ToastStore;
	doc: Y.Doc;
	store?: CommentStore;
}) {
	const { you } = useComments(store);
	// Messages that arrive while it's open are read as they arrive.
	useEffect(() => {
		store.markRead(thread.id);
	}, [store, thread]);
	return (
		<div className="phone-sheet-thread-view comment-ui">
			<ThreadView
				thread={thread}
				you={you}
				login={login}
				canTriage={store.canTriage(thread)}
				autoFocus={false}
				place={threadPlace(doc, thread)}
				actions={{
					reply: (body) => store.reply(thread.id, body),
					edit: (message, body) => store.edit(thread.id, message, body),
					delete: (message) => {
						const last = store.delete(thread.id, message);
						toasts.show({
							message: last ? "Deleted the comment" : "Deleted your reply",
							action: { label: "Undo", run: () => store.restore(thread.id, message) },
						});
					},
					resolve: (resolved) => {
						store.resolve(thread.id, resolved);
						if (resolved) {
							store.setUI({ open: null });
							toasts.show({
								message: "Resolved",
								action: { label: "Undo", run: () => store.resolve(thread.id, false) },
							});
						}
					},
					close: () => store.setUI({ open: null }),
				}}
			/>
		</div>
	);
}
