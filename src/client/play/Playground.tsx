import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { Card, PullDetails } from "../../shared/cards.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { Board } from "../Board.tsx";
import { cardStore } from "../cardStore.ts";
import type { Status } from "../activity.ts";
import { localUser } from "../presence.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import {
	checkFailed,
	checksPassed,
	ciProgressed,
	ciStarted,
	conflictToggled,
	type Person,
	reviewed,
} from "./ci.ts";
import {
	installFakeRepoApi,
	mergeRecords,
	proposedDecisions,
	pushWriteBacks,
} from "./decisions.ts";
import { fixture, LABELS } from "./fixtures.ts";
import { type PenMode, PenProbe, scribble } from "./PenProbe.tsx";
import { SCENARIOS } from "./scenarios.ts";
import { type RemotePerson, SimulatedBoard } from "./simulator.ts";

type Motion = "normal" | "slow" | "reduced";

const STICKY_LINES = [
	"what if we did this in 5.1 instead?",
	"+1, this bites me weekly",
	"needs an RFC first",
	"I can take this one",
];

const CHAT_LINES = [
	"over here!",
	"ooh, I like this one",
	"should we group these?",
	"wait, is #412 still blocked?",
	"brb, coffee",
	"let's vote in 5 minutes",
];

const BRAINSTORM_LINES = [
	"Better errors",
	"Benchmarks in CI",
	"A logo?",
	"Fewer options, better defaults",
	"Show the generated URL in devtools",
	"Write down why we chose each default, so the next person doesn't have to guess",
	"Video walkthrough",
	"Hmm",
];

const NEXT_STATUS: Record<Status, Status> = { active: "idle", idle: "away", away: "active" };

const PEOPLE: Person[] = ["priya", "kai", "tom", "jo"];
const pickPerson = (): Person => PEOPLE[Math.floor(Math.random() * PEOPLE.length)] ?? "kai";

function pick<T>(list: T[]): T | undefined {
	return list[Math.floor(Math.random() * list.length)];
}

function shuffle<T>(list: T[]): T[] {
	return list
		.map((item) => ({ item, key: Math.random() }))
		.sort((a, b) => a.key - b.key)
		.map(({ item }) => item);
}

export default function Playground() {
	const [scenario, setScenario] = useState(
		() => new URLSearchParams(location.search).get("scenario") ?? "planning",
	);
	const sim = useMemo(() => {
		const board = new SimulatedBoard();
		(SCENARIOS[scenario] ?? SCENARIOS.planning)?.seed(board.doc);
		return board;
	}, [scenario]);
	useEffect(() => () => sim.destroy(), [sim]);
	// For poking at from the console, e.g. to measure things.
	useEffect(() => {
		Object.assign(window, { tackPlayground: sim });
	}, [sim]);
	// Decisions' write-backs ask a fake repository instead of the server.
	useEffect(() => installFakeRepoApi(), []);

	const [user] = useState(localUser);
	const [people, setPeople] = useState<RemotePerson[]>([]);
	const [motion, setMotion] = useState<Motion>("normal");
	const [autoplay, setAutoplay] = useState(false);
	const [structureNote, setStructureNote] = useState<string | null>(null);
	const [pen, setPen] = useState<PenMode>("off");
	const [penStats, setPenStats] = useState<string | null>(null);
	useEffect(() => setPen("off"), [sim]);

	useEffect(() => setPeople([]), [sim]);

	useEffect(() => {
		document.documentElement.dataset.motion = motion;
		return () => {
			delete document.documentElement.dataset.motion;
		};
	}, [motion]);

	const chooseScenario = (name: string) => {
		const url = new URL(location.href);
		url.searchParams.set("scenario", name);
		history.replaceState(null, "", url);
		setScenario(name);
	};

	const someone = (): RemotePerson => {
		const existing = pick(sim.people);
		if (existing) return existing;
		const person = sim.join();
		setPeople([...sim.people]);
		return person;
	};

	const randomCard = (filter: (card: Card) => boolean = () => true): string | undefined =>
		pick(
			sim.cardKeys().filter((key) => {
				const card = cardStore.get(key);
				return card && !("missing" in card) && filter(card);
			}),
		);

	/** Pretend a CI or review webhook changed a random open pull request. */
	const updatePull = (
		change: (pull: PullDetails) => PullDetails,
		filter: (pull: PullDetails) => boolean = () => true,
	) => {
		const key = randomCard(
			(card) =>
				card.kind === "pull" &&
				card.state !== "merged" &&
				card.pull?.detail === "full" &&
				filter(card.pull),
		);
		if (key) sim.updateCard(key, (card) => (card.pull ? { pull: change(card.pull) } : {}));
	};

	const actions = {
		join: () => {
			const person = sim.join();
			setPeople([...sim.people]);
			void person.wander(3);
		},
		leave: () => {
			const person = sim.people.at(-1);
			if (person) sim.leave(person);
			setPeople([...sim.people]);
		},
		wander: () => void someone().wander(3),
		drag: () => {
			const id = pick(sim.shapeIds());
			const from = id ? sim.shapePosition(id) : null;
			if (id && from) {
				void someone().drag(id, {
					x: from.x + (Math.random() - 0.5) * 500,
					y: from.y + (Math.random() - 0.3) * 300,
				});
			}
		},
		type: () => {
			const id = pick(sim.shapeIds("sticky"));
			if (id) void someone().type(id, pick(STICKY_LINES) ?? "");
		},
		addCard: () => {
			const card = fixture({
				title: "Freshly pasted: support signed URLs",
				labels: [LABELS.enhancement],
			});
			cardStore.set(card);
			void someone().addCard(card.key, {
				x: 200 + Math.random() * 600,
				y: 100 + Math.random() * 400,
			});
		},
		say: () => void someone().say(pick(CHAT_LINES) ?? ""),
		lookAround: () => void someone().lookAround(),
		status: () => {
			const person = someone();
			person.setStatus(NEXT_STATUS[person.status]);
			setPeople([...sim.people]);
		},
		followMe: () => {
			const person = someone();
			person.follow(person.following === null ? sim.awareness.clientID : null);
			setPeople([...sim.people]);
		},
		brainstorm: () => {
			while (sim.people.length < 3) sim.join();
			setPeople([...sim.people]);
			// Everyone adds a few stickies at once, each in their own patch
			// below whatever is on the board already.
			const top = Math.max(0, ...sim.shapeIds().map((id) => sim.shapePosition(id)?.y ?? 0)) + 320;
			sim.people.forEach(async (person, n) => {
				for (let i = 0; i < 3; i++) {
					await person.addSticky(
						{ x: 120 + n * 420 + Math.random() * 220, y: top + i * 190 + Math.random() * 30 },
						pick(BRAINSTORM_LINES) ?? "",
						Math.random() < 0.3 ? "hand" : undefined,
					);
				}
			});
		},
		editMine: () => {
			const id = sim.lastLocalShape();
			if (!id) return;
			if (shapesMap(sim.doc).get(id)?.get("type") === "sticky") {
				void someone().type(id, "and I added this");
			} else {
				const from = sim.shapePosition(id);
				if (from) void someone().drag(id, { x: from.x + 160, y: from.y + 60 });
			}
		},
		addSticky: () => {
			void someone().addSticky(
				{ x: 200 + Math.random() * 700, y: 120 + Math.random() * 400 },
				pick(STICKY_LINES) ?? "",
			);
		},
		editTitle: () => {
			const key = randomCard();
			if (key)
				sim.updateCard(key, (card) => ({
					title: `${card.title.replace(/ \(edited\)$/, "")} (edited)`,
				}));
		},
		merge: () => {
			const key = randomCard((card) => card.kind === "pull" && card.state !== "merged");
			if (key) sim.updateCard(key, () => ({ state: "merged" }));
		},
		close: () => {
			const key = randomCard((card) => card.kind === "issue" && card.state === "open");
			if (key) sim.updateCard(key, () => ({ state: "closed", stateReason: "completed" }));
		},
		reopen: () => {
			const key = randomCard((card) => card.state === "closed");
			if (key) sim.updateCard(key, () => ({ state: "open", stateReason: null }));
		},
		label: () => {
			const key = randomCard();
			if (key) {
				sim.updateCard(key, (card) => ({
					labels: card.labels.some((l) => l.name === "needs review")
						? card.labels.filter((l) => l.name !== "needs review")
						: [...card.labels, LABELS.needsReview],
				}));
			}
		},
		installApp: () => {
			// The app is installed on every repo whose cards aren't live: they upgrade in place.
			for (const key of sim.cardKeys()) {
				const card = cardStore.get(key);
				if (card && !("missing" in card) && card.live === false) {
					sim.updateCard(key, () => ({ live: true, writable: true }));
				}
			}
		},
		comments: () => {
			const key = randomCard();
			if (key)
				sim.updateCard(key, (card) => ({
					comments: card.comments + 1 + Math.floor(Math.random() * 3),
				}));
		},
		ciStart: () => updatePull(ciStarted),
		ciProgress: () => updatePull(ciProgressed, (pull) => (pull.checks?.pending ?? 0) > 0),
		ciFail: () => updatePull(checkFailed),
		ciPass: () => updatePull(checksPassed, (pull) => pull.checks?.state !== "passing"),
		approve: () => updatePull((pull) => reviewed(pull, pickPerson(), "approved")),
		requestChanges: () => updatePull((pull) => reviewed(pull, pickPerson(), "changes_requested")),
		conflict: () => updatePull(conflictToggled),
	};

	// Decisions: people voting and deciding, and a stand-in for the push
	// that writes decisions back.
	const [decisionNote, setDecisionNote] = useState<string | null>(null);
	useEffect(() => setDecisionNote(null), [sim]);
	const decisions = {
		vote: () => {
			const id = pick(proposedDecisions(sim.doc));
			if (!id) return setDecisionNote("Nothing proposed to vote on: add a decision (D).");
			void someone().vote(id, Math.random() < 0.7 ? "agree" : "disagree");
		},
		decide: () => {
			const id = pick(proposedDecisions(sim.doc));
			if (!id) return setDecisionNote("Nothing proposed to decide.");
			void someone().vote(id, "decide");
		},
		push: async () => {
			setDecisionNote("Pushing…");
			const count = await pushWriteBacks(sim.doc);
			setDecisionNote(
				count === 0
					? "No write-backs staged: decide something, then Write back."
					: `Pushed ${count} write-back${count === 1 ? "" : "s"}.`,
			);
		},
		merge: () => {
			const count = mergeRecords(sim.doc);
			setDecisionNote(count === 0 ? "No open decision records." : `Merged ${count}.`);
		},
	};

	// Sections and connectors, including the concurrent edits the server's
	// repair pass exists for.
	const shapes = () => [...sim.shapeIds("card"), ...sim.shapeIds("sticky")];
	const structure = {
		connect: () => {
			const [from, to] = shuffle(shapes());
			if (from && to) void someone().connect(from, to);
		},
		resize: () => {
			const id = pick(sim.shapeIds("section"));
			const box = id ? sim.box(id) : undefined;
			if (id && box) {
				void someone().resize(id, {
					w: Math.max(200, box.w + (Math.random() - 0.4) * 300),
					h: Math.max(160, box.h + (Math.random() - 0.4) * 200),
				});
			}
		},
		race: async () => {
			const [from, target] = shuffle(shapes());
			if (!from || !target) return;
			const deleter = someone();
			const connector = sim.people.find((person) => person !== deleter) ?? sim.join();
			setPeople([...sim.people]);
			setStructureNote("One person is offline, connecting to a shape the other is deleting…");
			connector.offline = true;
			const connecting = connector.connect(from, target);
			await deleter.remove(target);
			await connecting;
			const before = sim.repairs;
			connector.reconnect();
			setTimeout(() => {
				setStructureNote(
					sim.repairs > before
						? "Back online: the server detached the connector from the deleted shape."
						: "Back online: nothing needed repairing.",
				);
			}, 600);
		},
	};

	useEffect(() => {
		if (!autoplay) return;
		const all = Object.values(actions).filter(
			(action) =>
				action !== actions.leave &&
				action !== actions.join &&
				action !== actions.brainstorm &&
				action !== actions.followMe,
		);
		const timer = setInterval(() => pick(all)?.(), 1800);
		return () => clearInterval(timer);
	});

	return (
		<ReactFlowProvider key={scenario}>
			<Board
				name={`Playground · ${SCENARIOS[scenario]?.name ?? scenario}`}
				user={user}
				doc={sim.doc}
				awareness={sim.awareness}
				synced
			>
				<PenProbe doc={sim.doc} mode={pen} onStats={setPenStats} />
				<aside className="play-panel" aria-label="Playground controls">
					<div className="play-section">
						<label className="play-label" htmlFor="scenario">
							Scenario
						</label>
						<select id="scenario" value={scenario} onChange={(e) => chooseScenario(e.target.value)}>
							{Object.entries(SCENARIOS).map(([id, s]) => (
								<option key={id} value={id}>
									{s.name}
								</option>
							))}
						</select>
						<p className="play-hint">{SCENARIOS[scenario]?.description}</p>
					</div>

					<div className="play-section">
						<h2 className="play-label">
							People {people.length > 0 && <span>· {people.length}</span>}
						</h2>
						<div className="play-buttons">
							<button type="button" onClick={actions.join}>
								Someone joins
							</button>
							<button type="button" onClick={actions.leave} disabled={people.length === 0}>
								Someone leaves
							</button>
							<button type="button" onClick={actions.wander}>
								Wander
							</button>
							<button type="button" onClick={actions.drag}>
								Drag a shape
							</button>
							<button type="button" onClick={actions.type}>
								Type in a sticky
							</button>
							<button type="button" onClick={actions.addCard}>
								Add a card
							</button>
							<button type="button" onClick={actions.addSticky}>
								Add a sticky
							</button>
							<button type="button" onClick={actions.brainstorm}>
								Brainstorm
							</button>
							<button type="button" onClick={actions.editMine}>
								Edit my last shape
							</button>
						</div>
						<p className="play-hint">
							Make something, have someone edit it, then undo: their work stays.
						</p>
					</div>

					<div className="play-section">
						<h2 className="play-label">Presence</h2>
						<div className="play-buttons">
							<button type="button" onClick={actions.say}>
								Cursor chat
							</button>
							<button type="button" onClick={actions.lookAround}>
								Pan and zoom
							</button>
							<button type="button" onClick={actions.status}>
								Idle → away → back
							</button>
							<button type="button" onClick={actions.followMe}>
								Follow me (toggle)
							</button>
						</div>
						<p className="play-hint">
							Press / for your own cursor chat. Click an avatar to follow someone, then try Pan and
							zoom.
						</p>
					</div>

					<div className="play-section">
						<h2 className="play-label">Sections and connectors</h2>
						<div className="play-buttons">
							<button type="button" onClick={structure.connect}>
								Connect two shapes
							</button>
							<button type="button" onClick={structure.resize}>
								Resize a section
							</button>
							<button type="button" onClick={() => void structure.race()}>
								Delete while connecting
							</button>
						</div>
						{structureNote && <p className="play-hint">{structureNote}</p>}
					</div>

					<div className="play-section">
						<h2 className="play-label">Decisions</h2>
						<div className="play-buttons">
							<button type="button" onClick={decisions.vote}>
								Someone votes
							</button>
							<button type="button" onClick={decisions.decide}>
								Someone decides
							</button>
							<button type="button" onClick={() => void decisions.push()}>
								Push write-backs
							</button>
							<button type="button" onClick={decisions.merge}>
								Merge the ADR
							</button>
						</div>
						<p className="play-hint">
							{decisionNote ?? "Write-backs use a fake repository with two records already."}
						</p>
					</div>

					<div className="play-section">
						<h2 className="play-label">Probe: pen layer</h2>
						<div className="segmented" role="radiogroup" aria-label="Pen">
							{(["off", "pen", "eraser"] as const).map((m) => (
								<label key={m} data-checked={pen === m}>
									<input type="radio" name="pen" checked={pen === m} onChange={() => setPen(m)} />
									{m === "off" ? "Off" : m === "pen" ? "Pen" : "Eraser"}
								</label>
							))}
						</div>
						<div className="play-buttons">
							<button type="button" onClick={() => scribble(sim.doc, 300, { x: 600, y: 400 })}>
								Scribble 300 strokes
							</button>
						</div>
						<p className="play-hint">
							{penStats ?? "Our own SVG layer and hit testing, outside React Flow."}
						</p>
					</div>

					<div className="play-section">
						<h2 className="play-label">Forge events</h2>
						<div className="play-buttons">
							<button type="button" onClick={actions.editTitle}>
								Edit a title
							</button>
							<button type="button" onClick={actions.merge}>
								Merge a PR
							</button>
							<button type="button" onClick={actions.close}>
								Close an issue
							</button>
							<button type="button" onClick={actions.reopen}>
								Reopen
							</button>
							<button type="button" onClick={actions.label}>
								Toggle a label
							</button>
							<button type="button" onClick={actions.comments}>
								New comments
							</button>
							<button type="button" onClick={actions.installApp}>
								App installed
							</button>
						</div>
					</div>

					<div className="play-section">
						<h2 className="play-label">Checks and reviews</h2>
						<div className="play-buttons">
							<button type="button" onClick={actions.ciStart}>
								CI starts
							</button>
							<button type="button" onClick={actions.ciProgress}>
								Checks progress
							</button>
							<button type="button" onClick={actions.ciFail}>
								A check fails
							</button>
							<button type="button" onClick={actions.ciPass}>
								All checks pass
							</button>
							<button type="button" onClick={actions.approve}>
								Approve
							</button>
							<button type="button" onClick={actions.requestChanges}>
								Request changes
							</button>
							<button type="button" onClick={actions.conflict}>
								Toggle conflict
							</button>
						</div>
					</div>

					<div className="play-section">
						<h2 className="play-label">Motion</h2>
						<div className="segmented" role="radiogroup" aria-label="Motion">
							{(["normal", "slow", "reduced"] as const).map((m) => (
								<label key={m} data-checked={motion === m}>
									<input
										type="radio"
										name="motion"
										checked={motion === m}
										onChange={() => setMotion(m)}
									/>
									{m === "slow" ? "Slow ×10" : m === "reduced" ? "Reduced" : "Normal"}
								</label>
							))}
						</div>
						<h2 className="play-label play-label-spaced">Theme</h2>
						<ThemeToggle labelled />
						<label className="play-toggle">
							<input
								type="checkbox"
								checked={autoplay}
								onChange={(e) => setAutoplay(e.target.checked)}
							/>
							Autoplay random events
						</label>
						<a className="play-link" href="/play/cards">
							Gallery →
						</a>
					</div>
				</aside>
			</Board>
		</ReactFlowProvider>
	);
}
