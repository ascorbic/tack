import { ReactFlowProvider } from "@xyflow/react";
import { type ReactNode, useMemo, useState } from "react";
import * as Y from "yjs";
import type { CommentAuthor, CommentThread, CommentsYou } from "../../shared/comments.ts";
import { addDecision, castVote } from "../../shared/decisions.ts";
import { type DotVote, placeDot, readVotes, startVote } from "../../shared/dotvotes.ts";
import { toggleStamp } from "../../shared/facilitation.ts";
import { type ShapeProps, addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import type { ShapeNode, StickyColor } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { peopleSource } from "../comments/people.ts";
import { CommentStore } from "../comments/store.ts";
import type { User } from "../presence.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { ToastStore } from "../Toasts.tsx";
import { BottomSheet } from "../touch/BottomSheet.tsx";
import { MultiSelectPill } from "../touch/MultiSelect.tsx";
import { PhoneDock } from "../touch/PhoneBoard.tsx";
import { QuickSticky } from "../touch/QuickSticky.tsx";
import { ShapeHeading, ShapeSheet, ThreadSheet } from "../touch/ShapeSheet.tsx";
import { PLAY_PEOPLE } from "./comments.ts";
import { KAI, PRIYA, TOM } from "./facilitationScenarios.ts";
import { PLANNING_CARDS } from "./fixtures.ts";
import "../comments/comments.css";
import "../facilitation/facilitation.css";
import "../touch/touch.css";
import "./mobileGallery.css";

// Every state of the board on a phone and a tablet (#67): what a tapped
// shape's sheet shows (a sticky in a dot vote, a card, a decision to vote
// on, one face down in silent mode, comments, a thread, view only), writing
// a sticky, the dock with its +, and selecting several with a finger.
// `/play/mobile`; try it on a board with `/play` in a phone's viewport.

const ME: User = { name: "Jo Rivera", color: "#5b5fc7", login: "jo" };
const ME_AUTHOR: CommentAuthor = { id: 100, login: "jo", name: "Jo Rivera", avatarUrl: "" };
const [P_PRIYA, P_KAI] = PLAY_PEOPLE as [CommentAuthor, CommentAuthor];
const NOW = Date.now();
const HOUR = 3_600_000;
const noop = () => {};

peopleSource.reset(async () =>
	[...PLAY_PEOPLE, ME_AUTHOR].map((person) => ({ ...person, role: "editor" as const })),
);

/** A board with one of everything a sheet can show, and an open vote across it. */
function seed(): { doc: Y.Doc; ids: Record<string, string>; vote: DotVote } {
	const doc = new Y.Doc();
	const ids: Record<string, string> = {};
	const put = (name: string, shape: Omit<ShapeProps, "z">) => {
		const id = `g-${name}`;
		addShape(doc, id, { ...shape, z: nextZ(doc) } as ShapeProps);
		ids[name] = id;
	};
	put("sticky", {
		type: "sticky",
		text: "Fewer options, better defaults",
		color: "pink",
		author: PRIYA,
		x: 0,
		y: 0,
	});
	put("hand", {
		type: "sticky",
		text: "Docs search that finds things",
		color: "green",
		font: "hand",
		author: KAI,
		x: 200,
		y: 0,
	});
	put("faceDown", {
		type: "sticky",
		text: "",
		color: "blue",
		silent: "s1",
		author: TOM,
		x: 400,
		y: 0,
	});
	put("card", { type: "card", ref: PLANNING_CARDS[0]?.key ?? "", x: 0, y: 300 });
	put("action", {
		type: "action",
		text: "Write the migration guide",
		owner: { login: "kai", name: "Kai Andersen" },
		due: "2026-10-20",
		x: 0,
		y: 600,
	});
	ids.decision = "g-decision";
	addDecision(doc, ids.decision, {
		x: 400,
		y: 300,
		author: PRIYA,
		title: "Require Node 20 in imagekit 5.0",
		text: "Node 18 is end-of-life in April. Keeping it costs a CI runner per job.",
	});
	castVote(doc, ids.decision, PRIYA, "agree");
	castVote(doc, ids.decision, KAI, "agree");
	castVote(doc, ids.decision, TOM, "disagree");
	castVote(doc, ids.decision, ME, "agree");
	const voteId = startVote(doc, { scope: null, dots: 3, title: "What next quarter?", by: KAI });
	placeDot(doc, voteId, PRIYA, ids.sticky as string);
	placeDot(doc, voteId, KAI, ids.sticky as string);
	placeDot(doc, voteId, ME, ids.sticky as string);
	toggleStamp(doc, ids.sticky as string, "👍", PRIYA);
	toggleStamp(doc, ids.sticky as string, "👍", ME);
	toggleStamp(doc, ids.sticky as string, "🔥", KAI);
	const vote = readVotes(doc).find((v) => v.id === voteId) as DotVote;
	return { doc, ids, vote };
}

function nodeOf(doc: Y.Doc, id: string): ShapeNode {
	const shape = readShape(shapesMap(doc).get(id) as Y.Map<unknown>);
	return {
		id,
		type: shape.type,
		position: { x: shape.x, y: shape.y },
		data: { id, shape },
	} as ShapeNode;
}

function thread(id: string, shape: string, messages: [CommentAuthor, string, number][]) {
	return {
		id,
		anchor: { x: 20, y: 20, shape, dx: 20, dy: 20 },
		createdAt: NOW - (messages[0]?.[2] ?? 0),
		updatedAt: NOW - (messages.at(-1)?.[2] ?? 0),
		resolved: null,
		messages: messages.map(([author, body, ago], i) => ({
			id: `${id}-${i}`,
			author,
			body,
			at: NOW - ago,
		})),
	} satisfies CommentThread;
}

const YOU: CommentsYou = {
	id: ME_AUTHOR.id,
	canComment: true,
	canTriage: true,
	canModerate: false,
	since: NOW - 30 * 24 * HOUR,
	reads: {},
};

function storeWith(threads: CommentThread[], you: CommentsYou = YOU): CommentStore {
	const store = new CommentStore();
	store.user = { name: ME.name, login: ME.login };
	store.apply({ type: "comments", threads, you, first: true });
	return store;
}

/** A phone's screen, with the board behind the sheet. */
function Phone({
	label,
	state,
	children,
	height = 640,
}: {
	label: string;
	state: string;
	children: ReactNode;
	height?: number;
}) {
	return (
		<figure data-state={state}>
			<div className="mobile-gallery-phone" style={{ height }}>
				<div className="mobile-gallery-board" aria-hidden="true" />
				{children}
			</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

export default function MobileGallery() {
	const [round, setRound] = useState(0);
	useMemo(() => {
		for (const card of PLANNING_CARDS) cardStore.set(card);
	}, []);
	const { doc, ids, vote } = useMemo(seed, []);
	const toasts = useMemo(() => new ToastStore(), []);
	const shapes = useMemo(
		() =>
			new Map(
				Object.values(ids).map((id) => {
					const shape = readShape(shapesMap(doc).get(id) as Y.Map<unknown>);
					return [id, { type: shape.type, parent: shape.parent }] as const;
				}),
			),
		[doc, ids],
	);
	const stores = useMemo(() => {
		const sticky = ids.hand as string;
		const conversation = thread("t-conversation", sticky, [
			[P_PRIYA, "Is this still blocked on the search index?", 26 * HOUR],
			[P_KAI, "Not for long: the index lands this week.", 3 * HOUR],
			[ME_AUTHOR, "Great, I’ll pick up the UI.", HOUR],
		]);
		const another = thread("t-another", sticky, [
			[P_KAI, "Could this be two issues?", 20 * 60_000],
		]);
		return {
			none: storeWith([]),
			threads: storeWith([conversation, another], { ...YOU, reads: { [conversation.id]: NOW } }),
			viewer: storeWith([], { ...YOU, canComment: false, reason: "signed_out" }),
			conversation,
		};
	}, [ids]);
	const [color, setColor] = useState<StickyColor>("yellow");

	const sheet = (
		name: string,
		options: { readOnly?: boolean; store?: CommentStore; votes?: DotVote[] } = {},
	) => {
		const node = nodeOf(doc, ids[name] as string);
		return (
			<BottomSheet
				open
				label="Shape"
				kind="shape"
				header={<ShapeHeading node={node} />}
				onClose={noop}
				initialFocus="content"
			>
				<ShapeSheet
					doc={doc}
					node={node}
					user={ME}
					readOnly={options.readOnly ?? false}
					toasts={toasts}
					votes={options.votes ?? []}
					shapes={shapes}
					box={{ x: node.position.x, y: node.position.y, w: 176, h: 176 }}
					onOpenThread={noop}
					store={options.store ?? stores.none}
				/>
			</BottomSheet>
		);
	};

	return (
		<ReactFlowProvider>
			<div className="gallery mobile-gallery" key={round}>
				<header className="gallery-head">
					<h1>Phones and tablets</h1>
					<p>
						On a phone, tap a shape to see it big, vote on it and talk about it; the + writes
						stickies. On a tablet, a finger or a pencil edits.
					</p>
					<div className="gallery-actions">
						<button type="button" onClick={() => setRound((r) => r + 1)}>
							Replay
						</button>
						<ThemeToggle labelled />
						<a className="play-link" href="/play?scenario=vote">
							Try it on a board (in a phone’s viewport) →
						</a>
					</div>
				</header>

				<section>
					<h2>A tapped shape, on a phone</h2>
					<div className="mobile-gallery-grid">
						<Phone label="A sticky in a dot vote, with stamps" state="sticky-vote">
							{sheet("sticky", { votes: [vote] })}
						</Phone>
						<Phone label="A card" state="card">
							{sheet("card")}
						</Phone>
						<Phone label="A decision: your vote, and everyone’s" state="decision">
							{sheet("decision")}
						</Phone>
						<Phone label="Face down in silent mode" state="face-down">
							{sheet("faceDown")}
						</Phone>
						<Phone label="With comments" state="comments">
							{sheet("hand", { store: stores.threads })}
						</Phone>
						<Phone label="An action item" state="action">
							{sheet("action")}
						</Phone>
						<Phone label="View only, signed out" state="view-only">
							{sheet("sticky", { readOnly: true, store: stores.viewer })}
						</Phone>
					</div>
				</section>

				<section>
					<h2>A thread</h2>
					<div className="mobile-gallery-grid">
						<Phone label="Opened from its pin, or the Comments panel" state="thread">
							<BottomSheet
								open
								label="Comment"
								kind="thread"
								header={
									<span className="phone-sheet-title">
										<span className="phone-sheet-kind">Comment</span>
									</span>
								}
								onClose={noop}
								initialFocus="content"
							>
								<ThreadSheet
									thread={stores.conversation}
									login={ME.login}
									toasts={toasts}
									doc={doc}
									store={stores.threads}
								/>
							</BottomSheet>
						</Phone>
					</div>
				</section>

				<section>
					<h2>Adding stickies</h2>
					<div className="mobile-gallery-grid">
						<Phone label="The dock: see everything, and the +" state="dock" height={220}>
							<PhoneDock
								sheet={null}
								readOnly={false}
								writing={false}
								color={color}
								onFit={noop}
								onAdd={noop}
							/>
						</Phone>
						<Phone label="View only: no +" state="dock-view-only" height={220}>
							<PhoneDock
								sheet={null}
								readOnly
								writing={false}
								color={color}
								onFit={noop}
								onAdd={noop}
							/>
						</Phone>
						<Phone label="Writing one, in the colour picked" state="new-sticky">
							<BottomSheet
								open
								label="New sticky"
								kind="sticky"
								header={
									<span className="phone-sheet-title">
										<span className="phone-sheet-kind">New sticky</span>
									</span>
								}
								onClose={noop}
								initialFocus="content"
							>
								<QuickSticky color={color} onColor={setColor} onAdd={noop} autoFocus={false} />
							</BottomSheet>
						</Phone>
					</div>
				</section>

				<section>
					<h2>On a tablet</h2>
					<div className="mobile-gallery-grid">
						<Phone label="Selecting several: a long-press, then taps" state="multi" height={160}>
							<MultiSelectPill count={3} onDone={noop} />
						</Phone>
						<Phone label="A long-press took" state="press" height={160}>
							<span className="press-ring mobile-gallery-ring" aria-hidden="true" />
						</Phone>
					</div>
				</section>
			</div>
		</ReactFlowProvider>
	);
}
