import { type ReactNode, useMemo, useState } from "react";
import * as Y from "yjs";
import { type DotVote, placeDot, readVotes, startVote, tallyVote } from "../../shared/dotvotes.ts";
import {
	EMOTES,
	type StampCount,
	type Timer,
	stampCounts,
	stampsMap,
	toggleStamp,
} from "../../shared/facilitation.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import type { SilentSession } from "../../shared/silent.ts";
import { addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { EmoteWheel, HighFiveBurst } from "../facilitation/Emotes.tsx";
import { StampRow, VoteDots } from "../facilitation/Marks.tsx";
import { SilentBadgeView } from "../facilitation/Silent.tsx";
import { SpotlightIndicator, type SpotlightState } from "../facilitation/Spotlight.tsx";
import { TimerView } from "../facilitation/Timer.tsx";
import { StartVoteForm, TallyView, VoteBar } from "../facilitation/Votes.tsx";
import { StickyView } from "../StickyNode.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { JO, KAI, PRIYA, TOM, VOTE_CARDS } from "./facilitationScenarios.ts";
import "../facilitation/facilitation.css";
import "./facilitationGallery.css";

// Every state of facilitation (#50), silent mode (#49) and dot voting (#48):
// the timer counting, in its last seconds, paused and done; spotlight from
// each side; stamps and dots on shapes; the emote wheel and a high-five;
// stickies face down, yours, and turning over; and votes from starting one
// to the results. `/play/facilitation`.

const NOW = Date.parse("2026-10-10T15:00:00Z");
const ME = { name: "Ana Costa", color: "#3b4cca", login: "ana" };
const noop = () => {};

function timer(over: Partial<Timer>): Timer {
	return {
		id: "t",
		state: "running",
		duration: 5 * 60_000,
		endsAt: NOW + 222_000,
		startedAt: NOW - 78_000,
		by: PRIYA,
		...over,
	};
}

const TIMERS: { label: string; state: string; timer: Timer; canControl?: boolean }[] = [
	{ label: "Counting down", state: "running", timer: timer({}) },
	{ label: "The last ten seconds", state: "final", timer: timer({ endsAt: NOW + 7_000 }) },
	{
		label: "Paused",
		state: "paused",
		timer: timer({ state: "paused", endsAt: undefined, remaining: 95_000 }),
	},
	{ label: "Time’s up", state: "done", timer: timer({ endsAt: NOW - 2_000 }) },
	{ label: "View only", state: "running", timer: timer({}), canControl: false },
];

function Figure({ label, state, children }: { label: string; state: string; children: ReactNode }) {
	return (
		<figure data-state={state}>
			<div className="facilitation-gallery-stage">{children}</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

const presence = (user: { name: string; color: string }) => ({
	clientId: 7,
	user,
	cursor: null,
	chat: null,
	view: null,
	status: "active" as const,
	following: null,
});

const SPOTLIGHTS: { label: string; state: string; spotlight: SpotlightState; withYou?: number }[] =
	[
		{
			label: "You’re spotlighting",
			state: "mine",
			withYou: 4,
			spotlight: {
				spotlight: { clientId: 1, user: ME, since: NOW },
				mine: true,
				leader: undefined,
				along: false,
				brokeOut: false,
				rejoin: noop,
			},
		},
		{
			label: "Brought along by Priya",
			state: "along",
			spotlight: {
				spotlight: { clientId: 7, user: PRIYA, since: NOW },
				mine: false,
				leader: presence(PRIYA),
				along: true,
				brokeOut: false,
				rejoin: noop,
			},
		},
		{
			label: "Broken out",
			state: "away",
			spotlight: {
				spotlight: { clientId: 7, user: PRIYA, since: NOW },
				mine: false,
				leader: presence(PRIYA),
				along: false,
				brokeOut: true,
				rejoin: noop,
			},
		},
	];

function stamps(
	...cast: [{ name: string; color: string; login?: string }, string][]
): StampCount[] {
	const doc = new Y.Doc();
	for (const [who, emoji] of cast)
		toggleStamp(doc, "s", emoji as never, who, "2026-10-10T10:00:00Z");
	return stampCounts(stampsMap(doc), ME).get("s") ?? [];
}

/** A small board with a vote on it, ballots cast, for dots, bars and results. */
function useVoteBoard() {
	return useMemo(() => {
		for (const card of VOTE_CARDS) cardStore.set(card);
		const doc = new Y.Doc();
		const section = addSection(doc, { x: 0, y: 0, w: 900, h: 500 }, { title: "Next quarter" });
		const cards = VOTE_CARDS.map((card, i) => addCard(doc, card.key, { x: 20 + i * 280, y: 40 }));
		const sticky = (text: string, x: number) => {
			const id = crypto.randomUUID();
			addShape(doc, id, {
				type: "sticky",
				text,
				color: "yellow",
				x,
				y: 260,
				z: nextZ(doc),
				parent: section,
				author: PRIYA,
			});
			return id;
		};
		const s1 = sticky("Fewer options, better defaults", 20);
		const s2 = sticky("A provider playground", 220);
		const vote = (over: Parameters<typeof startVote>[1]) => startVote(doc, over);
		const open = vote({
			scope: section,
			by: PRIYA,
			dots: 5,
			reactions: true,
			at: new Date(NOW - 3_600_000).toISOString(),
		});
		const [c1 = "", c2 = ""] = cards;
		for (const [who, id, n] of [
			[PRIYA, c1, 2],
			[KAI, c1, 1],
			[TOM, c1, 3],
			[JO, c2, 2],
			[ME, c1, 1],
			[ME, s1, 2],
			[KAI, s2, 2],
			[PRIYA, s2, 1],
		] as const) {
			for (let i = 0; i < n; i++) placeDot(doc, open, who, id);
		}
		const hidden = vote({
			scope: section,
			by: KAI,
			dots: 3,
			hidden: true,
			endsAt: new Date(NOW + 5 * 3_600_000).toISOString(),
		});
		placeDot(doc, hidden, ME, s1);
		placeDot(doc, hidden, PRIYA, c1);
		placeDot(doc, hidden, KAI, c2);
		const closed = vote({ scope: null, by: KAI, dots: 3, reactions: true });
		placeDot(doc, closed, PRIYA, c1);
		placeDot(doc, closed, ME, c2);
		const map = doc.getMap("dotVotes").get(closed);
		if (map instanceof Y.Map) {
			map.set("closedAt", new Date(NOW - 86_400_000).toISOString());
			map.set("closedBy", { name: KAI.name, color: KAI.color });
		}
		const empty = vote({
			scope: section,
			by: PRIYA,
			dots: 3,
			endsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
		});
		const votes = readVotes(doc);
		const get = (id: string) => votes.find((v) => v.id === id) as DotVote;
		return {
			doc,
			c1,
			s1,
			open: get(open),
			hidden: get(hidden),
			closed: get(closed),
			empty: get(empty),
		};
	}, []);
}

const SESSION: SilentSession = { id: "s", by: PRIYA, at: "2026-10-10T14:50:00Z" };

export default function FacilitationGallery() {
	const [round, setRound] = useState(0);
	const board = useVoteBoard();
	const tally = (vote: DotVote) => tallyVote(vote, board.doc, (ref) => cardStore.get(ref));
	return (
		<div className="gallery facilitation-gallery">
			<header className="gallery-head">
				<h1>Facilitation</h1>
				<p>
					Running a session: a timer everyone shares, spotlight, stamps and emotes, silent
					brainstorming that stays secret until the reveal, and dot votes that can stay open for
					days.
				</p>
				<div className="gallery-actions">
					<button type="button" onClick={() => setRound((r) => r + 1)}>
						Replay
					</button>
					<ThemeToggle labelled />
					<a className="play-link" href="/play?scenario=retro">
						Run a retro →
					</a>
					<a className="play-link" href="/play?scenario=silent">
						Silent mode →
					</a>
					<a className="play-link" href="/play?scenario=vote">
						Dot voting →
					</a>
				</div>
			</header>

			<section>
				<h2>The timer</h2>
				<div className="gallery-grid facilitation-gallery-wide">
					{TIMERS.map((c) => (
						<Figure key={`${c.label}${round}`} label={c.label} state={c.state}>
							<TimerView
								timer={c.timer}
								now={NOW}
								canControl={c.canControl ?? true}
								onAction={noop}
							/>
						</Figure>
					))}
				</div>
			</section>

			<section>
				<h2>Spotlight</h2>
				<div className="gallery-grid facilitation-gallery-wide">
					{SPOTLIGHTS.map((c) => (
						<Figure key={`${c.label}${round}`} label={c.label} state={c.state}>
							<div className="facilitation-gallery-canvas">
								<SpotlightIndicator
									state={c.spotlight}
									withYou={c.withYou ?? 0}
									onBreakOut={noop}
								/>
							</div>
						</Figure>
					))}
				</div>
			</section>

			<section>
				<h2>Stamps and dots</h2>
				<div className="gallery-grid facilitation-gallery-shapes">
					<Figure label="Stamps from a few people" state="stamps">
						<ShapeWithMarks stamps={stamps([PRIYA, "👍"], [KAI, "👍"], [TOM, "❤️"], [JO, "🎉"])} />
					</Figure>
					<Figure label="Yours among them" state="stamps-mine">
						<ShapeWithMarks stamps={stamps([PRIYA, "✅"], [ME, "✅"], [ME, "🔥"], [KAI, "👀"])} />
					</Figure>
					<Figure label="Dots on a shape" state="dots">
						<ShapeWithMarks vote={board.open} shape={board.c1} />
					</Figure>
					<Figure label="Results hidden: only your dots" state="dots-hidden">
						<ShapeWithMarks vote={board.hidden} shape={board.s1} />
					</Figure>
				</div>
			</section>

			<section>
				<h2>Emotes and high-fives</h2>
				<div className="gallery-grid facilitation-gallery-wide">
					<Figure label="The emote wheel (E)" state="wheel">
						<div className="facilitation-gallery-fixed">
							<EmoteWheel at={{ x: 130, y: 100 }} onPick={noop} />
						</div>
					</Figure>
					<Figure label="A high-five" state="high-five">
						<div className="facilitation-gallery-burst" key={round}>
							<HighFiveBurst
								names={["Priya Shah", "Kai Andersen"]}
								colors={[PRIYA.color, KAI.color]}
							/>
						</div>
					</Figure>
					<Figure label="Emotes on offer" state="emotes">
						<p className="facilitation-gallery-emotes">{EMOTES.join(" ")}</p>
					</Figure>
				</div>
			</section>

			<section>
				<h2>Silent mode</h2>
				<div className="gallery-grid stickies">
					<Figure label="Someone else’s, face down" state="face-down">
						<StickyView text="" color="pink" author={KAI} faceDown tilt={-0.6} />
					</Figure>
					<Figure label="Yours, only you can see it" state="hidden">
						<StickyView
							text="The release checklist lives in someone’s head"
							color="yellow"
							author={ME}
							hidden
						/>
					</Figure>
					<Figure label="Turning over at the reveal" state="flip">
						<StickyView
							key={round}
							text="Flaky tests make me rerun CI three times a day"
							color="pink"
							author={PRIYA}
							flip={{ n: round + 1, delay: 200 }}
						/>
					</Figure>
				</div>
				<div className="gallery-grid facilitation-gallery-wide facilitation-gallery-badges">
					<Figure label="A silent section’s header" state="silent">
						<SilentBadgeView
							session={SESSION}
							canReveal
							onReveal={noop}
							counts={[
								{ name: KAI.name, color: KAI.color, count: 4 },
								{ name: PRIYA.name, color: PRIYA.color, count: 3 },
								{ name: ME.name, color: ME.color, count: 2 },
							]}
						/>
					</Figure>
					<Figure label="Nothing written yet" state="silent-empty">
						<SilentBadgeView session={SESSION} canReveal onReveal={noop} counts={[]} />
					</Figure>
					<Figure label="Someone else reveals" state="silent-participant">
						<SilentBadgeView
							session={SESSION}
							canReveal={false}
							counts={[{ name: TOM.name, color: TOM.color, count: 1 }]}
						/>
					</Figure>
					<Figure label="View only" state="silent-read-only">
						<SilentBadgeView
							session={SESSION}
							canReveal={false}
							viewOnly
							counts={[{ name: TOM.name, color: TOM.color, count: 1 }]}
						/>
					</Figure>
				</div>
			</section>

			<section>
				<h2>Dot voting</h2>
				<div className="gallery-grid facilitation-gallery-wide">
					<Figure label="Starting a vote" state="vote-start">
						<div className="facilitation-gallery-fixed facilitation-gallery-form">
							<StartVoteForm
								doc={board.doc}
								user={ME}
								scope={board.open.scope}
								now={() => NOW}
								onCancel={noop}
								onStart={noop}
								autoFocus={false}
							/>
						</div>
					</Figure>
				</div>
				<div className="facilitation-gallery-bars">
					<Figure label="Open until someone closes it" state="vote-live">
						<VoteBar
							vote={board.open}
							scopeTitle="“Next quarter”"
							user={ME}
							now={NOW}
							readOnly={false}
							voting={false}
							onVoting={noop}
							onClose={noop}
							onResults={noop}
							onDismiss={noop}
						/>
					</Figure>
					<Figure label="Placing dots" state="vote-voting">
						<VoteBar
							vote={board.open}
							scopeTitle="“Next quarter”"
							user={ME}
							now={NOW}
							readOnly={false}
							voting
							onVoting={noop}
							onClose={noop}
							onResults={noop}
							onDismiss={noop}
						/>
					</Figure>
					<Figure label="Closing soon, results hidden" state="vote-soon">
						<VoteBar
							vote={board.hidden}
							scopeTitle="“Next quarter”"
							user={ME}
							now={NOW}
							readOnly={false}
							voting={false}
							onVoting={noop}
							onClose={noop}
							onResults={noop}
							onDismiss={noop}
						/>
					</Figure>
					<Figure label="Open for days, nobody’s voted" state="vote-days">
						<VoteBar
							vote={board.empty}
							scopeTitle="“Next quarter”"
							user={ME}
							now={NOW}
							readOnly={false}
							voting={false}
							onVoting={noop}
							onClose={noop}
							onResults={noop}
							onDismiss={noop}
						/>
					</Figure>
					<Figure label="Closed" state="vote-closed">
						<VoteBar
							vote={board.closed}
							scopeTitle="the whole board"
							user={ME}
							now={NOW}
							readOnly={false}
							voting={false}
							onVoting={noop}
							onClose={noop}
							onResults={noop}
							onDismiss={noop}
						/>
					</Figure>
					<Figure label="View only" state="vote-read-only">
						<VoteBar
							vote={board.open}
							scopeTitle="“Next quarter”"
							user={ME}
							now={NOW}
							readOnly
							voting={false}
							onVoting={noop}
							onClose={noop}
							onResults={noop}
							onDismiss={noop}
						/>
					</Figure>
				</div>
				<div className="gallery-grid facilitation-gallery-panels">
					<Figure label="Results, with 👍 on GitHub" state="tally-open">
						<TallyStage>
							<TallyView
								doc={board.doc}
								vote={board.open}
								rows={tally(board.open)}
								now={NOW}
								user={ME}
								readOnly={false}
								onClose={noop}
								onReveal={noop}
							/>
						</TallyStage>
					</Figure>
					<Figure label="Results hidden until it closes" state="tally-hidden">
						<TallyStage>
							<TallyView
								doc={board.doc}
								vote={board.hidden}
								rows={tally(board.hidden)}
								now={NOW}
								user={ME}
								readOnly={false}
								onClose={noop}
								onReveal={noop}
							/>
						</TallyStage>
					</Figure>
					<Figure label="Closed" state="tally-closed">
						<TallyStage>
							<TallyView
								doc={board.doc}
								vote={board.closed}
								rows={tally(board.closed)}
								now={NOW}
								user={ME}
								readOnly={false}
								onClose={noop}
								onReveal={noop}
							/>
						</TallyStage>
					</Figure>
					<Figure label="No votes yet, view only" state="tally-empty">
						<TallyStage>
							<TallyView
								doc={board.doc}
								vote={board.empty}
								rows={tally(board.empty)}
								now={NOW}
								user={ME}
								readOnly
								onClose={noop}
								onReveal={noop}
							/>
						</TallyStage>
					</Figure>
				</div>
			</section>
		</div>
	);
}

function TallyStage({ children }: { children: ReactNode }) {
	return <div className="facilitation-gallery-panel">{children}</div>;
}

/** A sticky with stamps along its bottom edge, or dots in its corner. */
function ShapeWithMarks({
	stamps,
	vote,
	shape,
}: {
	stamps?: StampCount[];
	vote?: DotVote;
	shape?: string;
}) {
	return (
		<div className="facilitation-gallery-shape">
			<StickyView text="Docs search finds the wrong page" color="blue" author={TOM} />
			{stamps && (
				<div className="facilitation-gallery-stamps">
					<StampRow counts={stamps} onToggle={noop} />
				</div>
			)}
			{vote && shape && (
				<div className="facilitation-gallery-dots">
					<VoteDots vote={vote} shape={shape} me={ME} />
				</div>
			)}
		</div>
	);
}
