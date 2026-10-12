import { type NodeProps, ReactFlowProvider } from "@xyflow/react";
import { useState } from "react";
import * as Y from "yjs";
import type { Card, MissingCard, PullDetails } from "../../shared/cards.ts";
import type { Connector } from "../../shared/connectors.ts";
import type { Rect } from "../../shared/geometry.ts";
import type { ShapeFont, ShapeProps, TextSize } from "../../shared/shapes.ts";
import type { Status } from "../activity.ts";
import { STICKY_COLORS, type ShapeNode } from "../board.ts";
import { CardView } from "../CardView.tsx";
import type { LinkPreview } from "../../shared/linkPreview.ts";
import { LinkView, type LinkViewProps } from "../links/LinkView.tsx";
import { cannedPreview, playLinks } from "./links.ts";
import { ConnectorSample } from "../connectors.tsx";
import type { Chat } from "../chat.ts";
import { CursorView } from "../Cursors.tsx";
import { DocContext, SectionContext } from "../DocContext.ts";
import { EmptyBoard } from "../EmptyBoard.tsx";
import { FollowIndicator } from "../Follow.tsx";
import { People } from "../People.tsx";
import type { RemotePresence, User } from "../presence.ts";
import { SectionNode } from "../sections.tsx";
import { ShapeToolbarView } from "../ShapeToolbar.tsx";
import { StickyView } from "../StickyNode.tsx";
import { TextView } from "../TextNode.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import {
	checkFailed,
	checksPassed,
	ciProgressed,
	ciStarted,
	conflictToggled,
	reviewed,
} from "./ci.ts";
import { DecisionGallery } from "./DecisionGallery.tsx";
import { StackGallery } from "./StackGallery.tsx";
import { ImageGallery } from "./images.tsx";
import {
	ACCESS_GALLERY,
	DISCUSSION_GALLERY,
	FORGE_GALLERY,
	GALLERY_CARDS,
	LABELS,
	PULL_GALLERY,
} from "./fixtures.ts";
import { PROVENANCE_GALLERY } from "./related.ts";

const MISSING: { label: string; card: MissingCard }[] = [
	{
		label: "No access",
		card: { key: "fake.tack/acme/private#12", missing: true, reason: "forbidden" },
	},
	{
		label: "Not found",
		card: { key: "fake.tack/acme/unpic#9999", missing: true, reason: "not_found" },
	},
	{
		label: "Unsupported forge",
		card: { key: "fake.tack/acme/other!3", missing: true, reason: "unsupported" },
	},
	{
		label: "Forge unreachable",
		card: { key: "fake.tack/acme/unpic#77", missing: true, reason: "error" },
	},
];

/** What viewers who can't read a repository get, and repositories nobody can read yet. */
const PRIVATE: { label: string; card: MissingCard }[] = [
	{
		label: "Private reference (you can’t see the repo)",
		card: { key: "github.com/acme/roadmap#12", missing: true, reason: "private" },
	},
	{
		label: "Private repo without the app",
		card: {
			key: "github.com/acme/vault#7",
			missing: true,
			reason: "not_found",
			installed: false,
		},
	},
];

/** Other forges' items nobody may see on a board (#65): Tack only shows what's public there. */
const FORGE_HIDDEN: { label: string; card: MissingCard }[] = [
	{
		label: "GitLab: a confidential issue",
		card: { key: "gitlab.com/ascorbic/cirrus#4600", missing: true, reason: "forbidden" },
	},
	{
		label: "Codeberg: a private repository",
		card: { key: "codeberg.org/acme/vault#3", missing: true, reason: "private" },
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

/** A pull request's life, one step per click: CI runs, fails, gets fixed. */
const CI_STEPS: { label: string; step: (pull: PullDetails) => PullDetails }[] = [
	{ label: "New push", step: ciStarted },
	{ label: "Checks progress", step: ciProgressed },
	{ label: "A check fails", step: checkFailed },
	{ label: "Changes requested", step: (pull) => reviewed(pull, "priya", "changes_requested") },
	{ label: "Fixed, all green", step: checksPassed },
	{ label: "Approved", step: (pull) => reviewed(pull, "priya", "approved") },
	{ label: "Conflict", step: conflictToggled },
	{ label: "Conflict resolved", step: conflictToggled },
];

function stepPull(card: Card, round: number): Card {
	const { pull } = card;
	// Without the app there's no CI to simulate.
	if (!pull || pull.detail === "basic") return card;
	const step = CI_STEPS[round % CI_STEPS.length];
	return step ? { ...card, pull: step.step(pull), updatedAt: new Date().toISOString() } : card;
}

const SECTIONS: {
	label: string;
	title: string;
	color: string;
	count: number;
	selected?: boolean;
	dropTarget?: boolean;
}[] = [
	{ label: "Untitled", title: "", color: "grey", count: 0 },
	{ label: "Green", title: "Now", color: "green", count: 4 },
	{ label: "Blue, drop target", title: "Next", color: "blue", count: 7, dropTarget: true },
	{ label: "Purple, selected", title: "Later", color: "purple", count: 12, selected: true },
	{ label: "Red", title: "Blocked", color: "red", count: 2 },
	{ label: "Orange", title: "Needs a decision", color: "orange", count: 3 },
	{
		label: "Yellow, long title",
		title: "Things we said we’d do last quarter",
		color: "yellow",
		count: 9,
	},
];

/** Render a section node outside the canvas. */
function SectionSample({
	id,
	title,
	color,
	count,
	selected,
}: {
	id: string;
	title: string;
	color: string;
	count: number;
	selected?: boolean;
}) {
	const shape: ShapeProps = { type: "section", x: 0, y: 0, z: "a0", w: 252, h: 150, title, color };
	const props = { id, data: { id, shape, count }, selected } as NodeProps<ShapeNode>;
	return (
		<div className="gallery-section">
			<SectionNode {...props} />
		</div>
	);
}

const A: Rect = { x: 6, y: 40, w: 70, h: 50 };
const B: Rect = { x: 176, y: 40, w: 70, h: 50 };
const BELOW: Rect = { x: 176, y: 90, w: 70, h: 40 };

const CONNECTOR: Connector = {
	from: { x: 0, y: 0, shape: "a" },
	to: { x: 0, y: 0, shape: "b" },
	route: "curved",
	arrow: "end",
	dash: false,
	color: "ink",
	label: "",
};

const CONNECTORS: {
	label: string;
	connector: Partial<Connector>;
	boxes: [string, Rect][];
	selected?: boolean;
}[] = [
	{
		label: "Curved",
		connector: {},
		boxes: [
			["a", A],
			["b", B],
		],
	},
	{
		label: "Curved, pinned to sides",
		connector: {
			from: { x: 0, y: 0, shape: "a", anchor: { x: 1, y: 0.5 } },
			to: { x: 0, y: 0, shape: "b", anchor: { x: 0.5, y: 0 } },
		},
		boxes: [
			["a", { ...A, y: 10 }],
			["b", BELOW],
		],
	},
	{
		label: "Elbow",
		connector: { route: "elbow", to: { x: 0, y: 0, shape: "b", anchor: { x: 0.5, y: 0 } } },
		boxes: [
			["a", { ...A, y: 10 }],
			["b", BELOW],
		],
	},
	{
		label: "Straight, dashed, both ends",
		connector: { route: "straight", dash: true, arrow: "both", color: "blue" },
		boxes: [
			["a", A],
			["b", B],
		],
	},
	{
		label: "Labelled",
		connector: { label: "blocks", color: "red" },
		boxes: [
			["a", A],
			["b", B],
		],
	},
	{
		label: "Loose end",
		connector: { to: { x: 230, y: 20 }, color: "green", arrow: "none" },
		boxes: [["a", A]],
	},
	{
		label: "Selected",
		connector: { color: "purple" },
		boxes: [
			["a", A],
			["b", B],
		],
		selected: true,
	},
	{
		label: "Free arrow",
		connector: { from: { x: 20, y: 110 }, to: { x: 230, y: 30 }, color: "orange", label: "look" },
		boxes: [],
	},
];

/** Every link card state: read (`preview` absent: the canned page), and every other. */
const LINK_GALLERY: ({
	label: string;
	url: string;
	preview?: LinkPreview | null;
} & Partial<Pick<LinkViewProps, "loading" | "selected" | "compact">>)[] = [
	{ label: "With an image", url: "https://unpic.pics/" },
	{ label: "Dark image", url: "https://emdashcms.com/" },
	{ label: "Only an icon", url: "https://tack.social/docs/boards/link-cards" },
	{ label: "Only a title", url: "https://tack.social/changelog.txt" },
	{ label: "Selected", url: "https://github.com/ascorbic/cirrus", selected: true },
	{ label: "Loading", url: "https://tack.social/docs/self-hosting", preview: null, loading: true },
	{ label: "Not read yet", url: "https://emdashcms.com/blog/launch", preview: null },
	{ label: "Couldn’t be read", url: "https://docs.emdashcms.invalid/guide" },
	{ label: "Won’t be read", url: "http://192.168.1.20/admin" },
	{ label: "Compact", url: "https://tack.social/", compact: true },
	{ label: "Compact, no image", url: "https://tack.social/changelog.txt", compact: true },
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
	const [pulls, setPulls] = useState(() => PULL_GALLERY.map((entry) => entry.card));
	const [ciRound, setCiRound] = useState(0);
	const [access, setAccess] = useState(() => ACCESS_GALLERY.map((entry) => entry.card));
	const installed = access.every((card) => card.live !== false);

	/** Install the app on the upstream repository (or remove it again). */
	const toggleApp = () => {
		setAccess((current) =>
			current.map((card, i) => {
				const original = ACCESS_GALLERY[i]?.card;
				if (original?.live !== false) return card;
				return installed ? original : { ...card, live: true, writable: true };
			}),
		);
	};

	const stepCi = () => {
		setPulls((current) => current.map((card) => stepPull(card, ciRound)));
		setCiRound((r) => r + 1);
	};
	const [doc] = useState(() => new Y.Doc());
	const [drops, setDrops] = useState(0);

	const replay = () => {
		setCards((current) => current.map((card) => mutate(card, round)));
		setRound((r) => r + 1);
		setDrops((n) => n + 1);
	};
	const reset = () => {
		setCards(GALLERY_CARDS.map((entry) => entry.card));
		setRound(0);
		setPulls(PULL_GALLERY.map((entry) => entry.card));
		setCiRound(0);
		setAccess(ACCESS_GALLERY.map((entry) => entry.card));
	};

	return (
		<div className="gallery" data-motion={motion ? "slow" : undefined}>
			<header className="gallery-head">
				<h1>Gallery</h1>
				<p>
					Every card, sticky, decision, text and presence state. Use “Simulate an update” to replay
					the live-update animations, and the CI button to walk pull requests through a run.
				</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={replay}>
						Simulate an update
					</button>
					<button type="button" onClick={stepCi}>
						CI: {CI_STEPS[ciRound % CI_STEPS.length]?.label}
					</button>
					<button type="button" onClick={toggleApp}>
						{installed ? "Remove the app" : "Install the app"}
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
						<Sections cards={cards} pulls={pulls} access={access} doc={doc} drops={drops} />
					</div>
					<div className="gallery-pane" data-theme="dark">
						<Sections cards={cards} pulls={pulls} access={access} doc={doc} drops={drops} />
					</div>
				</div>
			) : (
				<Sections cards={cards} pulls={pulls} access={access} doc={doc} drops={drops} />
			)}
		</div>
	);
}

function Sections({
	cards,
	pulls,
	access,
	doc,
	drops,
}: {
	cards: Card[];
	pulls: Card[];
	/** Cards from repositories with and without the app (#9). */
	access: Card[];
	/** A scratch document, so selected sections show their colour controls. */
	doc: Y.Doc;
	/** How many times something has dropped into the sample sections. */
	drops: number;
}) {
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
				<h2>Pull requests: checks and reviews</h2>
				<div className="gallery-grid">
					{pulls.map((card, i) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{PULL_GALLERY[i]?.label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Discussions</h2>
				<p className="gallery-note">
					GitHub Discussions: a speech bubble, the category’s emoji and name, upvotes, and an
					Answered badge once an answer’s chosen.
				</p>
				<div className="gallery-grid">
					{DISCUSSION_GALLERY.map(({ label, card }) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
					<figure>
						<CardView
							card={{
								key: "github.com/acme/roadmap#61",
								missing: true,
								reason: "forbidden",
								permission: "discussions",
							}}
							cardKey="github.com/acme/roadmap#61"
						/>
						<figcaption>The app needs the Discussions permission</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Repository access</h2>
				<div className="gallery-grid">
					{access.map((card, i) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{ACCESS_GALLERY[i]?.label}</figcaption>
						</figure>
					))}
					{PRIVATE.map(({ label, card }) => (
						<figure key={label}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Other forges</h2>
				<div className="gallery-grid">
					{FORGE_GALLERY.map(({ label, card }) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
					{FORGE_HIDDEN.map(({ label, card }) => (
						<figure key={label}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Compact (zoomed out)</h2>
				<div className="gallery-grid">
					{[
						...cards.slice(0, 4),
						...pulls.slice(0, 3),
						...DISCUSSION_GALLERY.slice(0, 2).map((entry) => entry.card),
					].map((card) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} compact />
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Provenance</h2>
				<p className="gallery-note">
					What brought a card, when nobody placed it on the board by hand: point at the glyph to
					read it (a comment’s links to the comment). A card that no longer matches its inbox or
					rule says so, and offers to keep or remove it.
				</p>
				<div className="gallery-grid">
					{PROVENANCE_GALLERY.map(({ label, card, origin, unmatched }) => (
						<figure key={label}>
							<CardView card={card} cardKey={card.key} origin={origin} unmatched={unmatched} />
							<figcaption>{label}</figcaption>
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
						<CardView card={undefined} cardKey="fake.tack/acme/unpic#999" />
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
				<h2>Link cards</h2>
				<p className="gallery-note">
					Any other web address, as its page’s preview: the image (or the site’s icon on its own
					tint), the site, title, description and host. Images come through the instance, and one
					that can’t be shown falls back to the tint, never a broken image.
				</p>
				<div className="gallery-grid">
					{LINK_GALLERY.map(({ label, url, preview, ...props }) => (
						<figure key={label}>
							<LinkView
								url={url}
								preview={preview === undefined ? cannedPreview(url) : preview}
								imageSrc={playLinks.imageSrc}
								{...props}
							/>
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Sections</h2>
				<p className="gallery-note">
					“Simulate an update” drops something into each, replaying the landing glow.
				</p>
				<ReactFlowProvider>
					<DocContext value={doc}>
						<SectionContext
							value={{
								dropTargets: new Set(SECTIONS.filter((s) => s.dropTarget).map((s) => s.label)),
								holding: null,
								selectionSize: 1,
								setResize: () => {},
								snapResize: (_id, rect) => rect,
								sizeOf: () => undefined,
							}}
						>
							<div className="gallery-grid sections">
								{SECTIONS.map((section) => (
									<figure key={section.label}>
										<SectionSample
											id={section.label}
											title={section.title}
											color={section.color}
											count={section.count + drops}
											selected={section.selected}
										/>
										<figcaption>{section.label}</figcaption>
									</figure>
								))}
							</div>
						</SectionContext>
					</DocContext>
				</ReactFlowProvider>
			</section>

			<section>
				<h2>Connectors</h2>
				<div className="gallery-grid">
					{CONNECTORS.map(({ label, connector, boxes, selected }) => (
						<figure key={label}>
							<ConnectorSample
								connector={{ ...CONNECTOR, ...connector }}
								boxes={new Map(boxes)}
								width={252}
								height={130}
								selected={selected}
							/>
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

			<StackGallery />

			<ImageGallery />

			<DecisionGallery />

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
