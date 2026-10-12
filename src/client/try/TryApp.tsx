import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { Board } from "../Board.tsx";
import { cardStore } from "../cardStore.ts";
import { commentStore } from "../comments/store.ts";
import { type User, localUser } from "../presence.ts";
import { PLAY_YOU_ID, SimulatedComments } from "../play/comments.ts";
import { playAi } from "../play/ai.ts";
import { installFakeRepoApi } from "../play/decisions.ts";
import { SimulatedFacilitator } from "../play/facilitation.ts";
import { SimulatedHistory } from "../play/history.ts";
import { SimulatedPush, numberAfter } from "../play/push.ts";
import { type RemotePerson, SimulatedBoard } from "../play/simulator.ts";
import { SimulatedStacks } from "../play/stacks.ts";
import { SimulatedWidgets } from "../play/widgets.ts";
import { playServices } from "../play/writes.ts";
import { demoImages } from "./images.ts";
import { widgetStore } from "../widgets/store.ts";
import { AiHint } from "./AiHint.tsx";
import { DemoAi, demoAiEndpoint, wantsRealAi } from "./ai.ts";
import { HintStore } from "./hints.ts";
import { DemoNote, ResetButton, ScenarioPicker, TryActions } from "./Chrome.tsx";
import { Guide, type GuideState, startingGuide } from "./Guide.tsx";
import { type Restored, forget, readPref, restore, save, writePref } from "./persist.ts";
import { KAI, PRIYA, TRY_SCENARIOS, type TryScenarioId, isScenario } from "./scenarios.ts";

// The public demo's page (#75): one of three boards, each running entirely
// in this browser on the playground's simulations (people, the board's
// server for stacks, votes and history, a pretend forge to push to), kept
// in localStorage so a refresh doesn't lose it, with a guide for a first run
// and no developer controls. Only what you ask the AI to read leaves the
// browser, for the real model (ai.ts), with the stand-in as its fallback.

/** Where changes made by the demo itself come from: never undone, never yours. */
const RESTORED = "try-restored";
const SAVE_MS = 400;

/**
 * The real AI, for stacks' names, Auto-stack, summaries, decisions and
 * widgets, where this page asks it (`wantsRealAi`), with a quiet word when
 * the stand-in answers instead. One for the page, so a rate limit or a busy
 * day holds across boards.
 */
const hints = new HintStore();
const realAi = wantsRealAi()
	? new DemoAi({ endpoint: demoAiEndpoint(), onFallback: hints.show })
	: null;

function firstScenario(): TryScenarioId {
	const asked = new URLSearchParams(location.search).get("scenario");
	if (isScenario(asked)) return asked;
	const last = readPref<string>("scenario");
	return isScenario(last) ? last : "planning";
}

/** You, here: a remembered guest name, with a login so pushes and votes say who. */
function you(): User {
	const guest = localUser();
	const login =
		guest.name
			.toLowerCase()
			.replace(/[^a-z]+/g, "-")
			.replace(/^-|-$/g, "") || "you";
	return { ...guest, login };
}

/** The highest number of anything on the board, so new issues number after it. */
function highestNumber(cards: readonly Card[]): number {
	return Math.max(0, ...cards.map((card) => Number(card.item.slice(1)) || 0));
}

/**
 * The cards a board shows, in the card store before it renders, and what
 * this browser kept of it. Done when a board is chosen rather than while
 * rendering one, since the board on screen until then is watching the store.
 */
function prepare(scenario: TryScenarioId): Restored | null {
	for (const card of TRY_SCENARIOS[scenario].cards) cardStore.set(card);
	const kept = restore(scenario);
	if (kept) {
		for (const card of kept.cards) cardStore.set(card);
		numberAfter(highestNumber(kept.cards));
	}
	return kept;
}

interface Showing {
	scenario: TryScenarioId;
	/** Bumped by Reset: a new board, from scratch. */
	generation: number;
	kept: Restored | null;
}

export function TryApp() {
	const [showing, setShowing] = useState<Showing>(() => {
		const scenario = firstScenario();
		return { scenario, generation: 0, kept: prepare(scenario) };
	});
	const showingRef = useRef(showing);
	showingRef.current = showing;
	const [guide, setGuide] = useState<GuideState>(startingGuide);
	useEffect(() => writePref("guide", guide), [guide]);

	const choose = useCallback((next: TryScenarioId) => {
		const url = new URL(location.href);
		url.searchParams.set("scenario", next);
		history.replaceState(null, "", url);
		writePref("scenario", next);
		setShowing({ scenario: next, generation: showingRef.current.generation, kept: prepare(next) });
	}, []);

	const reset = useCallback(() => {
		const { scenario, generation } = showingRef.current;
		setShowing({ scenario, generation: generation + 1, kept: prepare(scenario) });
	}, []);

	const { scenario, generation, kept } = showing;
	return (
		<ReactFlowProvider key={`${scenario}:${generation}`}>
			<TryBoard
				scenario={scenario}
				kept={kept}
				onScenario={choose}
				onReset={reset}
				guide={guide}
				onGuide={setGuide}
			/>
		</ReactFlowProvider>
	);
}

/** Everything the board runs on, made once per board. */
interface World {
	sim: SimulatedBoard;
	history: SimulatedHistory;
	push: SimulatedPush;
	facilitator: SimulatedFacilitator;
	stacks: SimulatedStacks;
	widgets: SimulatedWidgets;
	comments: SimulatedComments;
	restored: boolean;
}

function makeWorld(scenario: TryScenarioId, kept: Restored | null, user: () => User): World {
	const sim = new SimulatedBoard();
	if (kept) Y.applyUpdate(sim.doc, kept.update, RESTORED);
	else TRY_SCENARIOS[scenario].seed(sim.doc);
	const history = new SimulatedHistory(sim, user, kept?.history ?? undefined);
	const push = new SimulatedPush(sim.doc, () => {
		const { login, name } = user();
		return { login: login ?? "you", name };
	});
	const me = user();
	const comments = new SimulatedComments(
		sim.doc,
		{ id: PLAY_YOU_ID, login: me.login ?? "you", name: me.name, avatarUrl: "" },
		commentStore,
		undefined,
		undefined,
		`try:${scenario}`,
	);
	return {
		sim,
		history,
		push,
		facilitator: new SimulatedFacilitator(sim),
		stacks: new SimulatedStacks(sim.doc, realAi),
		widgets: new SimulatedWidgets(sim.doc),
		comments,
		restored: kept !== null,
	};
}

function TryBoard({
	scenario,
	kept,
	onScenario,
	onReset,
	guide,
	onGuide,
}: {
	scenario: TryScenarioId;
	/** What this browser kept of the board, if anything. */
	kept: Restored | null;
	onScenario: (scenario: TryScenarioId) => void;
	onReset: () => void;
	guide: GuideState;
	onGuide: (state: GuideState) => void;
}) {
	const definition = TRY_SCENARIOS[scenario];
	const [user] = useState(you);
	const userRef = useRef(user);
	const [world] = useState(() => makeWorld(scenario, kept, () => userRef.current));
	const [services] = useState(() => ({
		...playServices(),
		// Pictures stay in this browser, beside the board it keeps.
		images: demoImages(),
		boardId: `try:${scenario}`,
		boardUrl: () => location.href,
		boardTitle: () => definition.name,
	}));
	const { sim, history, push, facilitator, stacks, widgets, comments } = world;

	// The board's pretend server, as the playground runs it.
	useEffect(() => {
		const uninstalls = [
			facilitator.install(),
			stacks.install(),
			installFakeRepoApi(),
			comments.connect(),
		];
		widgetStore.connect(widgets);
		comments.setAccess({ signedIn: true, role: "owner" });
		// AI (#64) over this board and its widgets: the real model, where
		// there is one, else the stand-in, in the browser.
		playAi.mode = "live";
		playAi.remote = realAi;
		playAi.doc = sim.doc;
		playAi.widgets = widgets;
		playAi.login = userRef.current.login ?? null;
		return () => {
			for (const uninstall of uninstalls) uninstall();
			if (playAi.doc === sim.doc) {
				playAi.doc = null;
				playAi.remote = null;
			}
			if (playAi.widgets === widgets) playAi.widgets = null;
			widgetStore.connect(null);
			widgets.destroy();
			history.destroy();
			sim.destroy();
		};
	}, [sim, history, facilitator, stacks, widgets, comments]);

	// Kept in this browser: saved a moment after each change, and on leaving.
	const forgotten = useRef(false);
	useEffect(() => {
		let timer = 0;
		const now = () => {
			clearTimeout(timer);
			if (forgotten.current) return;
			history.log.flush();
			save(scenario, sim.doc, history.store);
		};
		const soon = () => {
			clearTimeout(timer);
			timer = window.setTimeout(now, SAVE_MS);
		};
		sim.doc.on("update", soon);
		const unsubscribe = cardStore.subscribeAll(soon);
		window.addEventListener("pagehide", now);
		return () => {
			sim.doc.off("update", soon);
			unsubscribe();
			window.removeEventListener("pagehide", now);
			now();
		};
	}, [scenario, sim, history]);

	const reset = useCallback(() => {
		forgotten.current = true;
		forget(scenario);
		// Files no kept board needs any more go too.
		void demoImages().sweep();
		onReset();
	}, [scenario, onReset]);

	useTeammates(sim, facilitator, world.restored);

	return (
		<Board
			name={`Try Tack · ${definition.name}`}
			title={
				<>
					<ScenarioPicker scenario={scenario} onChoose={onScenario} />
					<DemoNote
						onTour={() => onGuide({ step: 0, status: "on" })}
						touring={guide.status === "on"}
					/>
				</>
			}
			user={user}
			doc={sim.doc}
			awareness={sim.awareness}
			synced
			services={services}
			push={push}
			historySource={history}
			fitOnLoad
			rememberView={`try:${scenario}`}
			home={{ href: "/", label: "Tack: home" }}
			actions={
				<TryActions>
					<ResetButton scenario={definition.name} onReset={reset} />
				</TryActions>
			}
		>
			<Guide doc={sim.doc} scenario={definition} state={guide} onState={onGuide} />
			{realAi && <AiHint store={hints} />}
		</Board>
	);
}

/**
 * Two teammates on the board with you, as on a real one: they look around
 * now and then, and say hello the first time.
 */
function useTeammates(sim: SimulatedBoard, facilitator: SimulatedFacilitator, restored: boolean) {
	useEffect(() => {
		const people: RemotePerson[] = [sim.join(PRIYA), sim.join(KAI)];
		facilitator.announce();
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const timers: number[] = [];
		const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
		if (!restored) later(3500, () => void people[0]?.say("👋 hi! have a play, it's all yours"));
		if (!reduced) {
			const wander = () => {
				const person = people[Math.floor(Math.random() * people.length)];
				void person?.wander(2);
				later(9000 + Math.random() * 7000, wander);
			};
			later(1500, wander);
		}
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [sim, facilitator, restored]);
}
