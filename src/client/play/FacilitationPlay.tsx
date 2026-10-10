import { useState } from "react";
import { readShape, shapesMap } from "../../shared/shapes.ts";
import { parseSession } from "../../shared/silent.ts";
import { facilitation } from "../facilitation/store.ts";
import {
	type SimulatedFacilitator,
	closeOpenVotes,
	emote,
	highFive,
	stampAround,
	startBoardVote,
	voteAround,
} from "./facilitation.ts";
import type { RemotePerson } from "./simulator.ts";

const IDEAS = [
	"Pair on reviews on Fridays",
	"A bot that labels new issues",
	"Rotate who writes release notes",
	"Office hours, once a month",
	"Fix the flaky Windows job first",
	"A good-first-issue sweep",
];

function pick<T>(list: readonly T[]): T | undefined {
	return list[Math.floor(Math.random() * list.length)];
}

/** The playground's facilitation controls: people timing, spotlighting, emoting, writing silently and voting. */
export function FacilitationPlay({
	facilitator,
	someone,
	others,
	pointer,
}: {
	facilitator: SimulatedFacilitator;
	someone: () => RemotePerson;
	/** At least `n` people here, joining if need be. */
	others: (n: number) => RemotePerson[];
	/** Where your pointer is on the board, for high-fives. */
	pointer: () => { x: number; y: number };
}) {
	const [note, setNote] = useState<string | null>(null);
	const doc = facilitator.sim.doc;
	const sections = () =>
		[...shapesMap(doc).entries()]
			.filter(([, shape]) => shape.get("type") === "section")
			.map(([id, shape]) => ({ id, shape: readShape(shape) }));
	const silentSection = () => sections().find(({ shape }) => parseSession(shape.silent));

	const actions = {
		timer: (ms: number) => facilitator.timer(someone(), { action: "start", ms }),
		pause: () => {
			const person = someone();
			if (!facilitator.timer(person, { action: "pause" })) {
				facilitator.timer(person, { action: "resume" });
			}
		},
		spotlight: () => void facilitator.spotlightBy(someone()),
		emote: () => {
			for (const person of others(2)) void emote(person);
		},
		highFiveMe: () => {
			void highFive(someone(), pointer());
			setNote("They’re holding a hand out by your cursor: press E then 8 (✋) to meet it.");
		},
		highFiveEachOther: () => {
			const [a, b] = others(2);
			if (!a || !b) return;
			const spot = { x: 300 + Math.random() * 400, y: 200 + Math.random() * 200 };
			void highFive(a, spot);
			void highFive(b, { x: spot.x + 12, y: spot.y + 6 });
		},
		stamps: () => {
			for (const person of others(2)) void stampAround(person, doc);
		},
		silent: () => {
			const target = sections().find(({ shape }) => !shape.silent);
			if (!target) return setNote("Every section is silent already.");
			const ok = facilitator.startSilent(someone(), target.id);
			setNote(
				ok
					? `“${target.shape.title ?? "Section"}” is in silent mode.`
					: "Couldn’t start silent mode.",
			);
		},
		writeSilently: async () => {
			const section = silentSection();
			if (!section) return setNote("Put a section in silent mode first.");
			const box = section.shape;
			await Promise.all(
				others(3).map(async (person, n) => {
					for (let i = 0; i < 2; i++) {
						await person.addSticky(
							{
								x: box.x + 110 + ((n * 2 + i) % 4) * 190 + Math.random() * 20,
								y: box.y + 140 + Math.floor((n * 2 + i) / 4) * 190 + 220,
							},
							pick(IDEAS) ?? "",
						);
					}
				}),
			);
		},
		reveal: () => {
			const section = silentSection();
			if (!section) return setNote("Nothing’s in silent mode.");
			facilitator.revealBy(null, section.id);
		},
		vote: (days: number | null, hidden = false) => {
			const person = someone();
			const scope = sections()[0]?.id ?? null;
			person.doc.transact(() =>
				startBoardVote(person, scope, {
					...(days
						? { endsAt: new Date(facilitator.now() + days * 86_400_000).toISOString() }
						: {}),
					hidden,
				}),
			);
		},
		voteAround: () => {
			for (const person of others(3)) void voteAround(person, facilitator.now());
		},
		closeVotes: () => {
			const person = someone();
			person.doc.transact(() => closeOpenVotes(person, facilitator.now()));
		},
		advance: (ms: number) => {
			facilitator.advance(ms);
			setNote(`The clock is ${Math.round(facilitator.skew / 60_000)} min ahead.`);
		},
	};

	return (
		<div className="play-section">
			<h2 className="play-label">Facilitation</h2>
			<div className="play-buttons">
				<button type="button" onClick={() => actions.timer(10_000)}>
					10s timer
				</button>
				<button type="button" onClick={() => actions.timer(5 * 60_000)}>
					5 min timer
				</button>
				<button type="button" onClick={actions.pause}>
					Pause / resume
				</button>
				<button type="button" onClick={actions.spotlight}>
					Someone spotlights
				</button>
				<button type="button" onClick={() => facilitator.stopSpotlight()}>
					Stop their spotlight
				</button>
				<button type="button" onClick={actions.emote}>
					People emote
				</button>
				<button type="button" onClick={actions.highFiveMe}>
					High-five me
				</button>
				<button type="button" onClick={actions.highFiveEachOther}>
					Two high-five
				</button>
				<button type="button" onClick={actions.stamps}>
					People stamp
				</button>
			</div>
			<h2 className="play-label play-label-spaced">Silent mode</h2>
			<div className="play-buttons">
				<button type="button" onClick={actions.silent}>
					Make a section silent
				</button>
				<button type="button" onClick={() => void actions.writeSilently()}>
					People write silently
				</button>
				<button type="button" onClick={actions.reveal}>
					Reveal
				</button>
			</div>
			<h2 className="play-label play-label-spaced">Dot voting</h2>
			<div className="play-buttons">
				<button type="button" onClick={() => actions.vote(null)}>
					Live vote
				</button>
				<button type="button" onClick={() => actions.vote(2)}>
					Vote for 2 days
				</button>
				<button type="button" onClick={() => actions.vote(1, true)}>
					Hidden vote, a day
				</button>
				<button type="button" onClick={actions.voteAround}>
					People vote
				</button>
				<button type="button" onClick={actions.closeVotes}>
					Close votes
				</button>
			</div>
			<h2 className="play-label play-label-spaced">Time passing</h2>
			<div className="play-buttons">
				<button type="button" onClick={() => actions.advance(60_000)}>
					+1 minute
				</button>
				<button type="button" onClick={() => actions.advance(3_600_000)}>
					+1 hour
				</button>
				<button type="button" onClick={() => actions.advance(86_400_000)}>
					+1 day
				</button>
			</div>
			<p className="play-hint">
				{note ??
					`M stamps, E emotes. Clock offset ${Math.round(facilitation.clockOffset / 1000)}s.`}
			</p>
		</div>
	);
}
