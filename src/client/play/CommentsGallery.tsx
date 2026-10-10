import { ReactFlowProvider } from "@xyflow/react";
import { type ReactNode, useMemo, useState } from "react";
import * as Y from "yjs";
import {
	type CommentAuthor,
	type CommentThread,
	type CommentsYou,
	type Notification,
	mentionedLogins,
} from "../../shared/comments.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import type { Digest } from "../../shared/since.ts";
import { cardStore } from "../cardStore.ts";
import { CommentPin } from "../comments/CommentLayer.tsx";
import { CommentsButton, CommentsPanel } from "../comments/CommentsPanel.tsx";
import { NotificationStore, NotificationsButton } from "../comments/Notifications.tsx";
import { peopleSource } from "../comments/people.ts";
import { CommentStore, NO_ONE } from "../comments/store.ts";
import { ThreadView } from "../comments/Thread.tsx";
import { Composer } from "../comments/Composer.tsx";
import { HighlightRing } from "../since/Highlights.tsx";
import { SinceButton, SincePanel } from "../since/SincePanel.tsx";
import { SinceStore } from "../since/store.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { PLANNING_CARDS } from "./fixtures.ts";
import { PLAY_PEOPLE } from "./comments.ts";
import "../comments/comments.css";
import "../since/since.css";
import "./commentsGallery.css";

// Every state of comments (#51) and "since you were here" (#46): pins,
// threads (yours, resolved, sending, deleted, being edited, mentioning
// someone, and what viewers, guests and archived boards get), the comments
// panel, notifications, the digest and the highlights on the canvas.
// `/play/comments`.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const [PRIYA, KAI, TOM, JO] = PLAY_PEOPLE as [
	CommentAuthor,
	CommentAuthor,
	CommentAuthor,
	CommentAuthor,
];
const ME: CommentAuthor = { id: 100, login: "you", name: "You", avatarUrl: "" };
const noop = () => {};

// The people to mention, before anything asks for them (this page only exists in development).
peopleSource.reset(async () =>
	[...PLAY_PEOPLE, ME].map((person) => ({ ...person, role: "editor" as const })),
);
peopleSource.self = ME.login;

let seq = 0;
function thread(
	messages: [CommentAuthor, string, number, Partial<CommentThread["messages"][number]>?][],
	options: { resolved?: CommentAuthor; anchor?: CommentThread["anchor"] } = {},
): CommentThread {
	const id = `g${++seq}xxxxx`;
	const list = messages.map(([author, body, ago, extra], i) => {
		const mentions = mentionedLogins(body).filter((login) =>
			[...PLAY_PEOPLE, ME].some((p) => p.login === login),
		);
		return {
			id: `${id}-${i}`,
			author,
			body,
			at: NOW - ago,
			...(mentions.length > 0 ? { mentions } : {}),
			...extra,
		};
	});
	return {
		id,
		anchor: options.anchor ?? { x: 0, y: 0 },
		createdAt: list[0]?.at ?? NOW,
		updatedAt: list.at(-1)?.at ?? NOW,
		resolved: options.resolved ? { by: options.resolved, at: NOW - HOUR } : null,
		messages: list,
	};
}

const YOU: CommentsYou = {
	id: ME.id,
	canComment: true,
	canTriage: true,
	canModerate: true,
	since: NOW - 30 * DAY,
	reads: {},
};
const VIEWER: CommentsYou = { ...YOU, canTriage: false, canModerate: false };
const GUEST: CommentsYou = { ...NO_ONE, reason: "signed_out" };
const ARCHIVED: CommentsYou = { ...YOU, canComment: false, reason: "archived" };

const CONVERSATION = thread([
	[PRIYA, "Is this still blocked on the CI matrix change?", 2 * DAY],
	[KAI, "#418 is ready for review, so not for long.", DAY],
	[PRIYA, "Great. @you can you review it?", 3 * HOUR],
]);
const RESOLVED = thread(
	[
		[TOM, "Who set this up? It was lovely.", 3 * DAY],
		[JO, "Jo did!", 3 * DAY - HOUR],
	],
	{ resolved: TOM },
);
const SENDING = thread([
	[JO, "Let’s vote on these on Thursday’s call.", 5 * HOUR],
	[ME, "Works for me, I’ll set up the board", 0, { pending: true } as never],
]);
const DELETED = thread([
	[KAI, "Room here for next quarter’s ideas?", 40 * HOUR],
	[TOM, "", 30 * HOUR, { deleted: true }],
	[ME, "Yes, let’s keep the right half for it.", 20 * HOUR],
]);
const MINE = thread([[ME, "We said this last retro too. Let’s make it an action.", 26 * HOUR]]);
const SINGLE = thread([[KAI, "Should this be two issues?", 20 * 60_000]]);
const LONG = thread([
	[
		JO,
		"Long thought: the provider docs are generated from the source, but nobody reads the source comments. If we moved the examples into the docs site and linked back, we'd fix half of the questions we get every week. @priya @kai thoughts?",
		4 * HOUR,
	],
]);

interface ThreadCase {
	label: string;
	state: string;
	thread: CommentThread;
	you: CommentsYou;
	unreadSince?: number;
	editing?: string;
}

const THREADS: ThreadCase[] = [
	{
		label: "A conversation, new to you since yesterday",
		state: "unread",
		thread: CONVERSATION,
		you: YOU,
		unreadSince: NOW - DAY + HOUR,
	},
	{ label: "Resolved", state: "resolved", thread: RESOLVED, you: YOU },
	{ label: "Your reply, sending", state: "sending", thread: SENDING, you: YOU },
	{ label: "A deleted reply", state: "deleted", thread: DELETED, you: YOU },
	{
		label: "Editing your comment",
		state: "editing",
		thread: MINE,
		you: YOU,
		editing: `${MINE.id}-0`,
	},
	{ label: "Mentioning two people", state: "mentions", thread: LONG, you: YOU },
	{
		label: "A viewer: can reply, but not resolve others’",
		state: "viewer",
		thread: SINGLE,
		you: VIEWER,
	},
	{ label: "Signed out: can read, not reply", state: "signed-out", thread: SINGLE, you: GUEST },
	{ label: "Archived board", state: "archived", thread: CONVERSATION, you: ARCHIVED },
];

function Figure({ label, state, children }: { label: string; state: string; children: ReactNode }) {
	return (
		<figure data-state={state}>
			<div className="comment-gallery-stage">{children}</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

function PinCase({
	label,
	state,
	thread: t,
	unread = false,
	open = false,
	preview = false,
	arrived = false,
}: {
	label: string;
	state: string;
	thread: CommentThread;
	unread?: boolean;
	open?: boolean;
	preview?: boolean;
	arrived?: boolean;
}) {
	return (
		<Figure label={label} state={state}>
			<div className="comment-gallery-pin">
				<CommentPin
					thread={t}
					at={{ x: 0, y: 0 }}
					unread={unread}
					open={open}
					arrived={arrived}
					movable={false}
					onOpen={noop}
					onMove={noop}
					preview={preview}
					still
				/>
			</div>
		</Figure>
	);
}

/** A board for the panel and digest to talk about. */
function useGalleryDoc() {
	return useMemo(() => {
		const doc = new Y.Doc();
		for (const card of PLANNING_CARDS) cardStore.set(card);
		addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "To improve", id: "section" });
		addShape(doc, "sticky", {
			type: "sticky",
			text: "Provider docs are still hard to find",
			color: "pink",
			x: 20,
			y: 40,
			z: nextZ(doc),
		});
		addShape(doc, "card", {
			type: "card",
			ref: PLANNING_CARDS[0]?.key,
			x: 300,
			y: 40,
			z: nextZ(doc),
		});
		addShape(doc, "card2", {
			type: "card",
			ref: PLANNING_CARDS[1]?.key,
			x: 300,
			y: 240,
			z: nextZ(doc),
		});
		return doc;
	}, []);
}

function panelStore(
	threads: CommentThread[],
	options: { ready?: boolean; filter?: "open" | "resolved" | "mentions"; unread?: string[] } = {},
) {
	const store = new CommentStore();
	store.user = { name: ME.name ?? "You", login: ME.login };
	if (options.ready !== false) {
		const reads: Record<string, number> = {};
		for (const t of threads) if (!options.unread?.includes(t.id)) reads[t.id] = NOW;
		store.apply({ type: "comments", threads, you: { ...YOU, reads }, first: true });
	}
	store.setUI({ panel: true, filter: options.filter ?? "open" });
	return store;
}

const ON_CARD = { ...CONVERSATION, anchor: { x: 330, y: 60, shape: "card", dx: 30, dy: 20 } };
const ON_SECTION = { ...SENDING, anchor: { x: 100, y: 10, shape: "section", dx: 100, dy: 10 } };
const ON_STICKY = { ...MINE, anchor: { x: 60, y: 60, shape: "sticky", dx: 40, dy: 20 } };
const ON_BOARD = { ...SINGLE, anchor: { x: 900, y: 300 } };
const PANEL_THREADS = [ON_CARD, ON_SECTION, ON_STICKY, ON_BOARD, LONG, RESOLVED];

function notificationStore(notifications: Notification[]) {
	const list = { notifications, unread: notifications.filter((n) => !n.read).length };
	return new NotificationStore({ list: async () => list, read: async () => list });
}

const NOTIFICATIONS: Notification[] = [
	{
		id: "n1",
		kind: "mention",
		board: { id: "b1", slug: "retro", title: "5.0 retro" },
		thread: CONVERSATION.id,
		by: PRIYA,
		excerpt: "Great. @you can you review it?",
		at: NOW - 3 * HOUR,
		read: false,
	},
	{
		id: "n2",
		kind: "reply",
		board: { id: "here", slug: "here", title: "This board" },
		thread: MINE.id,
		by: JO,
		excerpt: "+1, I’ll write it up as an issue.",
		at: NOW - 20 * HOUR,
		read: false,
	},
	{
		id: "n3",
		kind: "mention",
		board: { id: "b2", slug: "roadmap", title: "Roadmap: now, next, later" },
		thread: "x",
		by: KAI,
		excerpt: "@you does this fit in Next?",
		at: NOW - 3 * DAY,
		read: true,
	},
];

const BY = {
	priya: { kind: "person" as const, id: 101, login: "priya", name: "Priya Shah" },
	kai: { kind: "person" as const, id: 102, login: "kai", name: "Kai Andersen" },
};

function digest(overrides: Partial<Digest> = {}): Digest {
	return {
		since: NOW - 3 * DAY,
		at: NOW,
		more: 0,
		edits: [
			{ shape: "sticky", kind: "changed", type: "sticky", at: NOW - 20 * HOUR, by: BY.priya },
			{ shape: "new1", kind: "added", type: "sticky", at: NOW - 30 * HOUR, by: BY.priya },
			{ shape: "new2", kind: "added", type: "sticky", at: NOW - 30 * HOUR, by: BY.priya },
			{ shape: "card2", kind: "moved", type: "card", at: NOW - 2 * DAY, by: BY.kai },
			{ shape: "gone", kind: "removed", type: "text", at: NOW - 2 * DAY, by: BY.kai },
			{ shape: "rule", kind: "added", type: "card", at: NOW - 6 * HOUR, by: { kind: "rule" } },
		],
		cards: [
			{ key: PLANNING_CARDS[0]?.key ?? "", kind: "closed", at: NOW - 5 * HOUR },
			{ key: PLANNING_CARDS[0]?.key ?? "", kind: "comments", at: NOW - 4 * HOUR, count: 3 },
			{ key: PLANNING_CARDS[1]?.key ?? "", kind: "ci_failing", at: NOW - 2 * HOUR },
		],
		pushes: [
			{
				pushId: "p1",
				at: NOW - DAY,
				by: { login: "kai", name: "Kai Andersen" },
				applied: 3,
				failed: 1,
				summaries: ["Create issue “Ship the provider docs page”", "Add docs to #440", "Close #398"],
			},
		],
		...overrides,
	};
}

function sinceStore(value: Digest) {
	const store = new SinceStore();
	store.board = `gallery:${Math.random()}`;
	store.apply({ type: "since", digest: value });
	store.setPanel(true);
	return store;
}

function SinceFigure({
	doc,
	value,
	comments,
}: {
	doc: Y.Doc;
	value: Digest;
	comments: CommentStore;
}) {
	const store = useMemo(() => sinceStore(value), [value]);
	return (
		<div className="comment-gallery-panel">
			<SincePanel
				doc={doc}
				login={ME.login}
				youId={ME.id}
				onJump={noop}
				onOpenThread={noop}
				store={store}
				commentsStore={comments}
			/>
		</div>
	);
}

const RINGS = [
	{ kind: "new" as const, label: "New", by: "Priya" },
	{ kind: "changed" as const, label: "Changed", by: "Kai" },
	{ kind: "moved" as const, label: "Moved", by: "Jo" },
	{ kind: "closed" as const, label: "Closed" },
];

function makeStores() {
	return {
		list: panelStore(PANEL_THREADS, { unread: [ON_CARD.id, LONG.id] }),
		mentions: panelStore(PANEL_THREADS, { filter: "mentions" }),
		resolved: panelStore(PANEL_THREADS, { filter: "resolved" }),
		empty: panelStore([]),
		loading: panelStore([], { ready: false }),
		digestComments: panelStore([
			thread([[KAI, "@you the retry PR is up, but CI is red. Can you take a look?", 5 * HOUR]]),
			thread([
				[ME, "Is the docs page still on for this week?", 4 * DAY],
				[PRIYA, "Yes, Friday.", 10 * HOUR],
			]),
		]),
		noComments: panelStore([]),
		since: sinceStore(digest()),
		inbox: notificationStore(NOTIFICATIONS),
		emptyInbox: notificationStore([]),
	};
}

export default function CommentsGallery() {
	const [round, setRound] = useState(0);
	// Everything starts again on Replay.
	return <GalleryBody key={round} onReplay={() => setRound((r) => r + 1)} />;
}

function GalleryBody({ onReplay }: { onReplay: () => void }) {
	const doc = useGalleryDoc();
	const [stores] = useState(makeStores);
	const { inbox, emptyInbox } = stores;

	return (
		<ReactFlowProvider>
			<div className="gallery comment-gallery">
				<header className="gallery-head">
					<h1>Comments and catching up</h1>
					<p>
						Threads on anything, with mentions, and what changed since you were last here. Every
						state, for people who can edit, view, or only look.
					</p>
					<div className="gallery-actions">
						<button type="button" onClick={onReplay}>
							Replay
						</button>
						<ThemeToggle labelled />
						<a className="play-link" href="/play?scenario=comments">
							← Try comments
						</a>
						<a className="play-link" href="/play?scenario=since">
							Come back after three days →
						</a>
					</div>
				</header>

				<section>
					<h2>Pins</h2>
					<div className="gallery-grid comment-gallery-pins">
						<PinCase label="A comment" state="read" thread={SINGLE} />
						<PinCase label="Unread" state="unread" thread={SINGLE} unread />
						<PinCase label="A conversation" state="replies" thread={CONVERSATION} />
						<PinCase label="Open" state="open" thread={CONVERSATION} open />
						<PinCase label="Resolved (when shown)" state="resolved" thread={RESOLVED} />
						<PinCase label="Just arrived" state="arrived" thread={SINGLE} arrived unread />
						<PinCase
							label="Hovered: a preview"
							state="preview"
							thread={CONVERSATION}
							preview
							unread
						/>
					</div>
				</section>

				<section>
					<h2>Threads</h2>
					<div className="gallery-grid comment-gallery-threads">
						{THREADS.map((c) => (
							<Figure key={c.label} label={c.label} state={c.state}>
								<div className="comment-popover comment-gallery-popover">
									<ThreadView
										thread={c.thread}
										you={c.you}
										login={ME.login}
										canTriage={c.you.canTriage || c.thread.messages[0]?.author.id === ME.id}
										unreadSince={c.unreadSince}
										initialEditing={c.editing}
										autoFocus={false}
										actions={{ reply: noop, edit: noop, delete: noop, resolve: noop, close: noop }}
									/>
								</div>
							</Figure>
						))}
						<Figure label="A new comment, mentioning someone" state="composing">
							<div className="comment-popover comment-gallery-popover comment-gallery-composing">
								<div className="comment-thread comment-draft">
									<Composer
										placeholder="Add a comment"
										initial="Can you look at this @k"
										autoFocus={false}
										onSubmit={noop}
									/>
								</div>
							</div>
						</Figure>
					</div>
				</section>

				<section>
					<h2>The comments panel</h2>
					<div className="gallery-grid comment-gallery-panels">
						<Figure label="Open threads, two unread" state="panel-open">
							<div className="comment-gallery-panel">
								<CommentsPanel doc={doc} login={ME.login} onJump={noop} store={stores.list} />
							</div>
						</Figure>
						<Figure label="Mentions of you" state="panel-mentions">
							<div className="comment-gallery-panel">
								<CommentsPanel doc={doc} login={ME.login} onJump={noop} store={stores.mentions} />
							</div>
						</Figure>
						<Figure label="Resolved" state="panel-resolved">
							<div className="comment-gallery-panel">
								<CommentsPanel doc={doc} login={ME.login} onJump={noop} store={stores.resolved} />
							</div>
						</Figure>
						<Figure label="No comments yet" state="panel-empty">
							<div className="comment-gallery-panel">
								<CommentsPanel doc={doc} login={ME.login} onJump={noop} store={stores.empty} />
							</div>
						</Figure>
						<Figure label="Loading" state="panel-loading">
							<div className="comment-gallery-panel">
								<CommentsPanel doc={doc} login={ME.login} onJump={noop} store={stores.loading} />
							</div>
						</Figure>
					</div>
				</section>

				<section>
					<h2>The top bar</h2>
					<div className="comment-gallery-topbar topbar">
						<Figure label="Comments, two unread" state="button-unread">
							<CommentsButton store={stores.list} />
						</Figure>
						<Figure label="Comments, all read" state="button-read">
							<CommentsButton store={stores.mentions} />
						</Figure>
						<Figure label="What’s new since you were here" state="since-button">
							<SinceButton
								doc={doc}
								store={stores.since}
								commentsStore={stores.digestComments}
								login={ME.login}
								youId={ME.id}
							/>
						</Figure>
						<Figure label="Notifications, open" state="notifications">
							<div className="comment-gallery-notifications">
								<NotificationsButton boardId="here" store={inbox} initiallyOpen />
							</div>
						</Figure>
						<Figure label="All caught up" state="notifications-empty">
							<div className="comment-gallery-notifications">
								<NotificationsButton store={emptyInbox} initiallyOpen />
							</div>
						</Figure>
					</div>
				</section>

				<section>
					<h2>Since you were here</h2>
					<div className="gallery-grid comment-gallery-panels">
						<Figure label="Three days away: edits, GitHub, a push, comments" state="digest">
							<SinceFigure doc={doc} value={digest()} comments={stores.digestComments} />
						</Figure>
						<Figure label="Only comments" state="digest-comments">
							<SinceFigure
								doc={doc}
								value={digest({ edits: [], cards: [], pushes: [], since: NOW - 14 * HOUR })}
								comments={stores.digestComments}
							/>
						</Figure>
						<Figure label="All quiet" state="digest-quiet">
							<SinceFigure
								doc={doc}
								value={digest({ edits: [], cards: [], pushes: [], since: NOW - 9 * DAY })}
								comments={stores.noComments}
							/>
						</Figure>
						<Figure label="A long absence: more than it lists" state="digest-more">
							<SinceFigure
								doc={doc}
								value={digest({ more: 1240, since: NOW - 40 * DAY })}
								comments={stores.noComments}
							/>
						</Figure>
					</div>
				</section>

				<section>
					<h2>On the canvas</h2>
					<div className="gallery-grid comment-gallery-rings">
						{RINGS.map((ring) => (
							<Figure key={ring.kind} label={ring.label} state={`ring-${ring.kind}`}>
								<div className="comment-gallery-ring since-layer">
									<span className="comment-gallery-shape" />
									<HighlightRing
										highlight={{ shape: ring.kind, kind: ring.kind, at: NOW, by: ring.by }}
										box={{ x: 0, y: 0, w: 176, h: 120 }}
										index={0}
										fading={false}
									/>
								</div>
							</Figure>
						))}
						<Figure label="Seen: fading away" state="ring-fading">
							<div className="comment-gallery-ring since-layer">
								<span className="comment-gallery-shape" />
								<HighlightRing
									highlight={{ shape: "f", kind: "new", at: NOW, by: "Priya" }}
									box={{ x: 0, y: 0, w: 176, h: 120 }}
									index={0}
									fading
								/>
							</div>
						</Figure>
					</div>
				</section>
			</div>
		</ReactFlowProvider>
	);
}
