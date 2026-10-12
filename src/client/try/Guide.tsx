import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import { scaledDuration } from "../motion.ts";
import { LINKS } from "./Chrome.tsx";
import {
	type GuideMemo,
	STEPS,
	type StepId,
	shapeNode,
	stickyNode,
	watchDots,
	watchHistory,
	watchLanded,
	watchStack,
	watchStaged,
} from "./guide.ts";
import { readPref } from "./persist.ts";
import type { TryScenario } from "./scenarios.ts";

// The demo's first run (#75): gentle coach marks, one step at a time, each
// pointing at what to use (a ring round it, and for the first, a dashed path
// from one sticky to the other) and done by doing it. A step done says so
// for a moment, then the next one comes. Skip a step or the whole tour at
// any time; the tour can be started again from the demo note.

export interface GuideState {
	/** The step showing: 0–4, or 5 for the last word. */
	step: number;
	status: "on" | "skipped" | "done";
}

export function startingGuide(): GuideState {
	const saved = readPref<GuideState>("guide");
	if (
		saved &&
		typeof saved.step === "number" &&
		saved.step >= 0 &&
		saved.step <= STEPS.length &&
		(saved.status === "on" || saved.status === "skipped" || saved.status === "done")
	) {
		return saved;
	}
	return { step: 0, status: "on" };
}

const CHEER_MS = 1500;

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

function rectOf(element: Element | null): Rect | null {
	if (!element) return null;
	const box = element.getBoundingClientRect();
	if (box.width === 0 && box.height === 0) return null;
	if (box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth)
		return null;
	return { x: box.left, y: box.top, w: box.width, h: box.height };
}

const same = (a: readonly (Rect | null)[], b: readonly (Rect | null)[]) =>
	a.length === b.length &&
	a.every((r, i) => {
		const s = b[i];
		if (!r || !s) return r === s;
		return (
			Math.abs(r.x - s.x) < 0.5 &&
			Math.abs(r.y - s.y) < 0.5 &&
			Math.abs(r.w - s.w) < 0.5 &&
			Math.abs(r.h - s.h) < 0.5
		);
	});

/** The demo's own menus and popovers (Chrome.tsx), which the guide steps back for. */
const DEMO_POPOVERS = ".try-popover, .try-picker-menu";

/**
 * Where what the step points at is on screen, followed frame by frame (the
 * board pans and zooms), and whether one of the demo's own popovers is open.
 */
function useTargets(
	find: () => (Element | null)[],
	key: string,
): { rects: (Rect | null)[]; covered: boolean } {
	const [rects, setRects] = useState<(Rect | null)[]>([]);
	const [covered, setCovered] = useState(false);
	const findRef = useRef(find);
	findRef.current = find;
	useEffect(() => {
		let frame = 0;
		let last: (Rect | null)[] = [];
		const tick = () => {
			const next = findRef.current().map(rectOf);
			if (!same(next, last)) {
				last = next;
				setRects(next);
			}
			setCovered(document.querySelector(DEMO_POPOVERS) !== null);
			frame = requestAnimationFrame(tick);
		};
		tick();
		return () => cancelAnimationFrame(frame);
	}, [key]);
	return { rects, covered };
}

/** The first of these that's on screen. */
function visible(...elements: (Element | null | undefined)[]): Element | null {
	return elements.find((element) => element && rectOf(element)) ?? null;
}

interface StepCopy {
	title: string;
	body: ReactNode;
}

function copyFor(step: StepId, scenario: TryScenario): StepCopy {
	switch (step) {
		case "stack":
			return {
				title: "Stack two stickies",
				body: (
					<>
						Drag <q>{scenario.stack.from}</q> onto <q>{scenario.stack.onto}</q> and hold it there a
						moment. ✨ A stand-in AI names the stack from what they say.
					</>
				),
			};
		case "issues":
			return {
				title: "Turn the stack into issues",
				body: (
					<>
						Select the stack, then <b>Parent issue</b> in the bar under it: an issue for the stack,
						with its stickies as sub-issues. They’re only staged, so nothing’s sent yet.
					</>
				),
			};
		case "push":
			return {
				title: "Push, and watch them land",
				body: (
					<>
						Open <b>Changes</b>, look over what’s staged, and push it to the demo forge, a pretend
						GitHub in your browser. The issues land on the board as live cards.
					</>
				),
			};
		case "vote":
			return {
				title: "Dot-vote on what’s next",
				body: (
					<>
						There’s a vote open. Press <b>Place dots</b>, then click the cards and stickies you’d
						pick. Everyone gets three dots.
					</>
				),
			};
		case "history":
			return {
				title: "Go back in time",
				body: (
					<>
						Open <b>History</b>: everything you just did is there, step by step. Scrub through it,
						play it back, or bring back something that’s gone.
					</>
				),
			};
	}
}

/** What each step points at, best first. */
function targetsFor(step: StepId, scenario: TryScenario, memo: GuideMemo): (Element | null)[] {
	switch (step) {
		case "stack":
			return [stickyNode(scenario.stack.from), stickyNode(scenario.stack.onto)];
		case "issues": {
			const button = document.querySelector(
				'.selection-actions button[aria-label^="Make a parent issue"]',
			);
			const stack = shapeNode(memo.stack) ?? document.querySelector(".react-flow__node-stack");
			const stage = document.querySelector(".action-popover .action-primary");
			return [visible(stage, button, stack)];
		}
		case "push": {
			const sheet = document.querySelector(".push-sheet .push-button.primary");
			const panel = document.querySelector(".changes-panel .changes-review-button");
			return [visible(sheet, panel, document.querySelector(".changes-button"))];
		}
		case "vote":
			return [document.querySelector(".vote-bar[data-open='true'] .vote-bar-place")];
		case "history":
			return [
				visible(document.querySelector(".history-button"), document.querySelector(".topbar-more")),
			];
	}
}

function watch(
	step: StepId,
	doc: Y.Doc,
	memo: GuideMemo,
	done: (note?: string) => void,
): () => void {
	switch (step) {
		case "stack":
			return watchStack(doc, memo, done);
		case "issues":
			return watchStaged(doc, done);
		case "push":
			return watchLanded(doc, done);
		case "vote":
			return watchDots(doc, done);
		case "history":
			return watchHistory(done);
	}
}

export function Guide({
	doc,
	scenario,
	state,
	onState,
}: {
	doc: Y.Doc;
	scenario: TryScenario;
	state: GuideState;
	onState: (state: GuideState) => void;
}) {
	const memo = useRef<GuideMemo>({});
	const [cheer, setCheer] = useState<{ step: number; note?: string } | null>(null);
	const on = state.status === "on";
	const step = STEPS[state.step];
	const stateRef = useRef(state);
	stateRef.current = state;

	// Watch for the step being done; say so, then move on.
	useEffect(() => {
		if (!on || !step) return;
		let finished = false;
		let timer = 0;
		const stop = watch(step, doc, memo.current, (note) => {
			if (finished) return;
			finished = true;
			setCheer({ step: state.step, note });
			timer = window.setTimeout(() => {
				setCheer(null);
				const now = stateRef.current;
				if (now.status === "on" && now.step === state.step) {
					onState({ step: state.step + 1, status: "on" });
				}
			}, scaledDuration(CHEER_MS));
		});
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, [on, step, state.step, doc, onState]);

	if (!on) return null;
	if (!step) {
		return createPortal(
			<Finale onClose={() => onState({ step: STEPS.length, status: "done" })} />,
			document.body,
		);
	}
	return createPortal(
		<CoachMark
			key={step}
			step={step}
			index={state.step}
			scenario={scenario}
			memo={memo.current}
			cheer={cheer?.step === state.step ? (cheer.note ?? "Done") : null}
			onSkipStep={() => onState({ step: state.step + 1, status: "on" })}
			onSkipTour={() => onState({ step: state.step, status: "skipped" })}
		/>,
		document.body,
	);
}

const CARD_W = 320;
const GAP = 14;
const MARGIN = 12;

/** Where the card goes: beside what it points at, else above the tool dock. */
function place(
	target: Rect | null,
	card: { w: number; h: number },
): { left: number; top: number; arrow: number | null; side: "above" | "below" | null } {
	const vw = innerWidth;
	const vh = innerHeight;
	if (!target) {
		return { left: (vw - card.w) / 2, top: vh - card.h - 110, arrow: null, side: null };
	}
	const centre = target.x + target.w / 2;
	const left = Math.min(Math.max(MARGIN, centre - card.w / 2), vw - card.w - MARGIN);
	const below = target.y + target.h + GAP;
	const above = target.y - GAP - card.h;
	// Below, if it fits clear of the dock at the bottom; otherwise above.
	const side = below + card.h <= vh - 96 || above < 64 ? "below" : "above";
	let top = side === "below" ? Math.min(below, vh - card.h - MARGIN) : above;
	// Clear of the vote bars hanging under the top bar, which you may need
	// while the card's showing (to finish voting, say).
	if (side === "below") {
		for (const bar of document.querySelectorAll(".vote-bar")) {
			const b = bar.getBoundingClientRect();
			const holdsTarget =
				b.left <= centre && centre <= b.right && b.top <= target.y && target.y <= b.bottom;
			const overlaps =
				b.left < left + card.w && left < b.right && b.top < top + card.h && top < b.bottom;
			if (!holdsTarget && overlaps) top = Math.max(top, b.bottom + GAP);
		}
	}
	const arrow = Math.min(Math.max(18, centre - left), card.w - 18);
	return { left, top, arrow, side };
}

function CoachMark({
	step,
	index,
	scenario,
	memo,
	cheer,
	onSkipStep,
	onSkipTour,
}: {
	step: StepId;
	index: number;
	scenario: TryScenario;
	memo: GuideMemo;
	cheer: string | null;
	onSkipStep: () => void;
	onSkipTour: () => void;
}) {
	const { rects, covered } = useTargets(() => targetsFor(step, scenario, memo), step);
	const card = useRef<HTMLElement>(null);
	const [size, setSize] = useState({ w: CARD_W, h: 180 });
	const narrow = useNarrow();
	useLayoutEffect(() => {
		const element = card.current;
		if (!element) return;
		const observer = new ResizeObserver(() =>
			setSize({ w: element.offsetWidth, h: element.offsetHeight }),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const anchor = rects[0] ?? null;
	const spot = narrow ? null : place(anchor, size);
	const copy = copyFor(step, scenario);
	const titleId = `try-guide-${step}`;

	return (
		// Stepping back while one of the demo's own popovers is open.
		<div className="try-guide" data-covered={covered || undefined}>
			{rects.map(
				(rect, i) =>
					rect && (
						<span
							// The rings are where the step points: a pair for the first.
							key={i}
							className="try-ring"
							data-second={i > 0 || undefined}
							aria-hidden="true"
							style={{
								left: rect.x - 6,
								top: rect.y - 6,
								width: rect.w + 12,
								height: rect.h + 12,
							}}
						/>
					),
			)}
			{step === "stack" && rects[0] && rects[1] && !cheer && (
				<DragPath from={rects[0]} to={rects[1]} />
			)}
			<section
				ref={card}
				className="try-coach"
				data-cheer={cheer ? true : undefined}
				data-side={spot?.side ?? undefined}
				data-docked={spot === null || undefined}
				// Docked along the bottom of a phone, the board opens above it (fitting.ts).
				data-fit-clear={spot === null ? "bottom" : undefined}
				aria-labelledby={titleId}
				aria-live="polite"
				data-chrome
				style={
					spot
						? ({
								left: spot.left,
								top: spot.top,
								"--arrow": spot.arrow === null ? undefined : `${spot.arrow}px`,
							} as React.CSSProperties)
						: undefined
				}
			>
				<header className="try-coach-head">
					<span className="try-coach-count">
						Step {index + 1} of {STEPS.length}
					</span>
					<span className="try-coach-dots" aria-hidden="true">
						{STEPS.map((id, i) => (
							<span
								key={id}
								data-done={i < index || (i === index && cheer !== null) || undefined}
								data-now={i === index || undefined}
							/>
						))}
					</span>
				</header>
				{cheer ? (
					<div className="try-coach-cheer">
						<span className="try-coach-check" aria-hidden="true">
							<svg width="18" height="18" viewBox="0 0 18 18">
								<path
									d="M4 9.5 7.5 13 14 5.5"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.2"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</span>
						<h2 id={titleId} className="try-coach-title">
							{cheer}
						</h2>
					</div>
				) : (
					<>
						<h2 id={titleId} className="try-coach-title">
							{index === 0 && <span className="try-coach-welcome">Welcome to Tack. </span>}
							{copy.title}
						</h2>
						<p className="try-coach-body">{copy.body}</p>
						<footer className="try-coach-foot">
							<button type="button" className="try-coach-quiet" onClick={onSkipTour}>
								Skip tour
							</button>
							<button type="button" className="try-coach-next" onClick={onSkipStep}>
								{index === STEPS.length - 1 ? "Finish" : "Skip this step"}
							</button>
						</footer>
					</>
				)}
			</section>
		</div>
	);
}

/** A dashed path from the sticky to drag to the one to drop it on. */
function DragPath({ from, to }: { from: Rect; to: Rect }) {
	const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
	const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
	// Bowed upwards, so it reads as a lift and a drop.
	const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.35);
	const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift };
	return (
		<svg className="try-path" aria-hidden="true">
			<path d={`M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`} />
			<circle cx={b.x} cy={b.y} r="5" />
		</svg>
	);
}

function useNarrow(): boolean {
	const query = "(max-width: 640px)";
	const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
	useEffect(() => {
		const list = matchMedia(query);
		const onChange = () => setNarrow(list.matches);
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, []);
	return narrow;
}

/** The last word: what you did, and where to go next. */
function Finale({ onClose }: { onClose: () => void }) {
	const close = useRef<HTMLButtonElement>(null);
	return (
		<section className="try-coach try-finale" aria-labelledby="try-finale-title" data-chrome>
			<span className="try-finale-burst" aria-hidden="true">
				{Array.from({ length: 10 }, (_, i) => (
					<span key={i} style={{ "--i": i } as React.CSSProperties} />
				))}
			</span>
			<h2 id="try-finale-title" className="try-coach-title">
				That’s Tack.
			</h2>
			<p className="try-coach-body">
				You stacked, staged, pushed, voted and went back in time, without leaving your browser. On
				your own Tack the cards are your real issues and pull requests, and pushes land on GitHub.
			</p>
			<div className="try-finale-actions">
				<a className="try-finale-primary" href={LINKS.selfHost}>
					Run your own
				</a>
				<a className="try-finale-secondary" href={LINKS.tour}>
					Take the tour
				</a>
				<button ref={close} type="button" className="try-coach-quiet" onClick={onClose}>
					Keep playing
				</button>
			</div>
		</section>
	);
}
