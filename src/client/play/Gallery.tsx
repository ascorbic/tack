import { useState } from "react";
import type { Card, MissingCard } from "../../shared/cards.ts";
import type { ShapeFont, TextSize } from "../../shared/shapes.ts";
import type { Status } from "../activity.ts";
import { STICKY_COLORS } from "../board.ts";
import { CardView } from "../CardView.tsx";
import type { Chat } from "../chat.ts";
import { CursorView } from "../Cursors.tsx";
import { EmptyBoard } from "../EmptyBoard.tsx";
import { FollowIndicator } from "../Follow.tsx";
import { People } from "../People.tsx";
import type { RemotePresence, User } from "../presence.ts";
import { ShapeToolbarView } from "../ShapeToolbar.tsx";
import { StickyView } from "../StickyNode.tsx";
import { TextView } from "../TextNode.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { GALLERY_CARDS, LABELS } from "./fixtures.ts";

const MISSING: { label: string; card: MissingCard }[] = [
	{
		label: "No access",
		card: { key: "fake.tack/acme/private#12", missing: true, reason: "forbidden" },
	},
	{
		label: "Not found",
		card: { key: "fake.tack/acme/imagekit#9999", missing: true, reason: "not_found" },
	},
	{
		label: "Unsupported forge",
		card: { key: "fake.tack/acme/other!3", missing: true, reason: "unsupported" },
	},
	{
		label: "Forge unreachable",
		card: { key: "fake.tack/acme/imagekit#77", missing: true, reason: "error" },
	},
];

const PRIYA = { name: "Priya Shah", color: "#b4467a" };
const KAI = { name: "Kai Andersen", color: "#1f7a6b" };
const TOM = { name: "Tom Okafor", color: "#a35a12" };
const JO = { name: "Jo Rivera", color: "#5b5fc7" };

/** Sticky text from a word to more than fits, to show shrink-to-fit. */
const LENGTHS: { label: string; text: string }[] = [
	{ label: "One word", text: "Docs" },
	{ label: "A phrase", text: "Codemods for 5.0" },
	{ label: "A sentence", text: "Provider docs are hard to find, I end up reading source" },
	{
		label: "Two sentences",
		text: "Every adapter has slightly different props. I keep a cheat sheet open in another tab.",
	},
	{ label: "A long word", text: "Internationalisation" },
	{
		label: "More than fits",
		text: "Every framework adapter has slightly different props and I can never remember which ones are supported where, so I keep a cheat sheet open in another tab, and when that goes stale I end up reading the source of each adapter, which is fine for me but not for someone trying unpic for the first time on a deadline.",
	},
];

function person(clientId: number, user: User, extra: Partial<RemotePresence> = {}): RemotePresence {
	return {
		clientId,
		user,
		cursor: null,
		chat: null,
		view: null,
		status: "active",
		following: null,
		...extra,
	};
}

const CURSORS: { label: string; user: User; chat: Chat | null; status?: Status }[] = [
	{ label: "Cursor", user: PRIYA, chat: null },
	{ label: "Chat opened", user: KAI, chat: { text: "", typing: true } },
	{ label: "Typing", user: TOM, chat: { text: "should we group the", typing: true } },
	{ label: "Said", user: JO, chat: { text: "ooh, I like this one", typing: false } },
	{
		label: "A long message",
		user: PRIYA,
		chat: {
			text: "wait, is #412 still blocked on the CI matrix change or can we merge?",
			typing: false,
		},
	},
	{ label: "Idle", user: KAI, chat: null, status: "idle" },
	{ label: "Away (tab hidden)", user: TOM, chat: null, status: "away" },
];

/** Apply a plausible webhook-style change, to replay update animations. */
function mutate(card: Card, round: number): Card {
	const changes: Partial<Card>[] = [
		{ comments: card.comments + 2 },
		{ title: `${card.title} (edited)` },
		{ labels: [...card.labels, LABELS.needsReview] },
		card.kind === "pull" ? { state: "merged" } : { state: "closed", stateReason: "completed" },
	];
	return { ...card, ...changes[round % changes.length] };
}

type Layout = "page" | "both";

export default function Gallery() {
	const [cards, setCards] = useState(() => GALLERY_CARDS.map((entry) => entry.card));
	const [round, setRound] = useState(0);
	const [motion, setMotion] = useState(false);
	const [layout, setLayout] = useState<Layout>("page");

	const replay = () => {
		setCards((current) => current.map((card) => mutate(card, round)));
		setRound((r) => r + 1);
	};
	const reset = () => {
		setCards(GALLERY_CARDS.map((entry) => entry.card));
		setRound(0);
	};

	return (
		<div className="gallery" data-motion={motion ? "slow" : undefined}>
			<header className="gallery-head">
				<h1>Gallery</h1>
				<p>
					Every card, sticky, text and presence state. Use “Simulate an update” to replay the
					live-update animations.
				</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={replay}>
						Simulate an update
					</button>
					<button type="button" onClick={reset}>
						Reset
					</button>
					<ThemeToggle labelled />
					<label className="play-toggle">
						<input
							type="checkbox"
							checked={layout === "both"}
							onChange={(e) => setLayout(e.target.checked ? "both" : "page")}
						/>
						Both themes side by side
					</label>
					<label className="play-toggle">
						<input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
						Slow motion
					</label>
					<a className="play-link" href="/play">
						← Playground
					</a>
				</div>
			</header>

			{layout === "both" ? (
				<div className="gallery-split">
					<div className="gallery-pane" data-theme="light">
						<Sections cards={cards} />
					</div>
					<div className="gallery-pane" data-theme="dark">
						<Sections cards={cards} />
					</div>
				</div>
			) : (
				<Sections cards={cards} />
			)}
		</div>
	);
}

function Sections({ cards }: { cards: Card[] }) {
	return (
		<>
			<section>
				<h2>Cards</h2>
				<div className="gallery-grid">
					{cards.map((card, i) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{GALLERY_CARDS[i]?.label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Compact (zoomed out)</h2>
				<div className="gallery-grid">
					{cards.slice(0, 4).map((card) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} compact />
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Selected, loading and unavailable</h2>
				<div className="gallery-grid">
					<figure>
						<CardView card={cards[0]} cardKey="selected" selected />
						<figcaption>Selected</figcaption>
					</figure>
					<figure>
						<CardView card={undefined} cardKey="fake.tack/acme/imagekit#999" />
						<figcaption>Loading</figcaption>
					</figure>
					{MISSING.map(({ label, card }) => (
						<figure key={card.reason}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Stickies</h2>
				<div className="gallery-grid stickies">
					{STICKY_COLORS.map((color, i) => (
						<figure key={color}>
							<StickyView
								text="Provider docs are hard to find"
								color={color}
								author={PRIYA}
								tilt={(i - 2) * 0.7}
							/>
							<figcaption>{color[0]?.toUpperCase() + color.slice(1)}</figcaption>
						</figure>
					))}
				</div>
			</section>

			{(["sans", "hand"] as const).map((font) => (
				<section key={font}>
					<h2>Shrink to fit{font === "hand" ? ", handwriting" : ""}</h2>
					<div className="gallery-grid stickies">
						{LENGTHS.map(({ label, text }, i) => (
							<figure key={label}>
								<StickyView
									text={text}
									font={font}
									color={STICKY_COLORS[i % STICKY_COLORS.length] ?? "yellow"}
									author={[PRIYA, KAI, TOM, JO][i % 4]}
								/>
								<figcaption>{label}</figcaption>
							</figure>
						))}
					</div>
				</section>
			))}

			<section>
				<h2>Sticky states</h2>
				<div className="gallery-grid stickies">
					<figure className="gallery-with-toolbar">
						<ShapeToolbarView color="pink" size={null} font="sans" />
						<StickyView text="Credit contributors" color="pink" author={KAI} selected />
						<figcaption>Selected, with its toolbar</figcaption>
					</figure>
					<figure>
						<StickyView text="Ship 5.0 beta" color="green" author={TOM} selected editing />
						<figcaption>Editing</figcaption>
					</figure>
					<figure>
						<StickyView text="" color="yellow" author={JO} selected />
						<figcaption>New, empty</figcaption>
					</figure>
					<figure>
						<StickyView text="No author on this one" color="blue" />
						<figcaption>No author</figcaption>
					</figure>
					<figure>
						<StickyView
							text="Long names get cut short"
							color="purple"
							author={{ name: "Maximilian Alexander Featherstonehaugh", color: "#2a7ab0" }}
						/>
						<figcaption>A long author name</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Text</h2>
				<div className="gallery-text">
					{(["sans", "hand"] as ShapeFont[]).map((font) =>
						(["xl", "l", "m", "s"] as TextSize[]).map((size) => (
							<figure key={`${font}-${size}`}>
								<TextView
									text={size === "s" ? "Small text for notes and captions" : "unpic 5.0"}
									size={size}
									font={font}
								/>
								<figcaption>
									{size.toUpperCase()}
									{font === "hand" ? ", handwriting" : ""}
								</figcaption>
							</figure>
						)),
					)}
					<figure className="gallery-with-toolbar">
						<ShapeToolbarView color={null} size="l" font="sans" />
						<TextView text="What hurts" size="l" selected />
						<figcaption>Selected, with its toolbar</figcaption>
					</figure>
					<figure>
						<TextView text={"Ten minutes, no talking.\nThen we vote."} size="m" selected editing />
						<figcaption>Editing, two lines</figcaption>
					</figure>
					<figure>
						<TextView text="" size="m" selected editing />
						<figcaption>New, empty</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Presence</h2>
				<div className="gallery-cursors">
					{CURSORS.map(({ label, user, chat, status }) => (
						<figure key={label}>
							<div className="gallery-cursor">
								<CursorView user={user} chat={chat} status={status} />
							</div>
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
				<div className="gallery-people">
					<figure>
						<People
							user={JO}
							selfId={0}
							people={[
								person(1, PRIYA, { following: 0 }),
								person(2, KAI),
								person(3, TOM, { status: "idle" }),
								person(4, { name: "Ana Lima", color: "#7444c4" }, { status: "away" }),
							]}
							following={2}
							onFollow={() => {}}
						/>
						<figcaption>
							You, Priya (following you), Kai (followed), Tom (idle) and Ana (away)
						</figcaption>
					</figure>
					<figure>
						<People
							user={JO}
							selfId={0}
							people={[PRIYA, KAI, TOM, JO, PRIYA, KAI, TOM].map((user, i) => person(i + 1, user))}
							following={null}
							onFollow={() => {}}
						/>
						<figcaption>A crowd</figcaption>
					</figure>
				</div>
				<figure className="gallery-frame">
					<FollowIndicator person={person(2, KAI)} onStop={() => {}} />
					<figcaption>Following someone</figcaption>
				</figure>
			</section>

			<section>
				<h2>Empty board</h2>
				<figure className="gallery-frame gallery-empty">
					<EmptyBoard empty onTool={() => {}} />
				</figure>
			</section>
		</>
	);
}
