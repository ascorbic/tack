import { useEffect, useId, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import {
	type DotVote,
	closeVote,
	formatRemaining,
	isOpen,
	turnout,
} from "../../shared/dotvotes.ts";
import {
	TIMER_PRESETS_MS,
	type Timer,
	formatClock,
	timeLeft,
	timerDone,
} from "../../shared/facilitation.ts";
import { isFacilitator } from "../../shared/facilitator.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { carriedToast } from "../actions/ActionBar.tsx";
import { useServices } from "../actions/services.ts";
import { CarryPanel, openActionItems } from "../actionItems/CarryPanel.tsx";
import { CarryIcon } from "../actionItems/icons.tsx";
import { isEditableTarget, isOffBoardTarget } from "../keys.ts";
import type { ToastStore } from "../Toasts.tsx";
import { transactLocal } from "../undo.ts";
import { PreparedSteps, stepSection, usePrepared } from "./Prepared.tsx";
import { chimeEnabled, setChimeEnabled } from "./chime.ts";
import { canvasMiddle, requestGesture } from "./gestures.ts";
import { useServerNow, useTimer, useVotes } from "./hooks.ts";
import { BatonIcon, DotsIcon, FlipIcon, HushIcon, StampIcon, StopwatchIcon } from "./icons.tsx";
import { callEveryone } from "./Call.tsx";
import { type PickKind, sectionPicker } from "./SectionPicker.tsx";
import { revealSilent, startSilent, useSilentSessions } from "./Silent.tsx";
import { SpotlightIcon, endSpotlight, startSpotlight, stopSpotlight } from "./Spotlight.tsx";
import { facilitation, useFacilitator, useSpotlight } from "./store.ts";
import { sendTimer, useMayControlTimer } from "./Timer.tsx";
import { useVoteControl, voteUI } from "./Votes.tsx";
import "./facilitation.css";

/** Keys for facilitation, also listed in the shortcut sheet (shortcuts.ts). */
export function facilitationKey(event: KeyboardEvent): "menu" | "timer" | "spotlight" | null {
	if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
	switch (event.code) {
		case "KeyF":
			return "menu";
		case "KeyT":
			return "timer";
		case "KeyS":
			return "spotlight";
		default:
			return null;
	}
}

/**
 * The top bar's Facilitate menu: what's running now (with its controls, so
 * there's one place to run a session from), a template's prepared steps,
 * then a way to start each thing: the timer, spotlight, a dot vote or
 * silent mode on a section, carrying action items over, stamps, emotes and
 * cursor chat. Viewers get the parts that aren't about changing the board.
 * ⇧F opens it, ⇧T opens it at the timer, ⇧S spotlights you (or stops).
 */
export function FacilitateMenu({
	doc,
	awareness,
	user,
	readOnly,
	toasts,
	onReveal,
	selectedSection = null,
	onStamp,
}: {
	doc: Y.Doc;
	awareness: Awareness;
	user: { name: string; color: string; login?: string };
	readOnly: boolean;
	toasts?: ToastStore;
	/** Bring a section into view: the one a prepared step is about. */
	onReveal?: (id: string) => void;
	/** A section selected on its own: what "on a section" starts on, without asking. */
	selectedSection?: string | null;
	/** Pick up the stamp tool. */
	onStamp?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [carrying, setCarrying] = useState(false);
	const services = useServices();
	const steps = usePrepared(doc);
	const ready = steps.some((step) => !step.startedAt);
	const openItems = open && !readOnly ? openActionItems(doc) : [];
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const timerRow = useRef<HTMLElement>(null);
	/** Opened from the keyboard: what to focus in it. */
	const [focusOn, setFocusOn] = useState<"first" | "timer" | null>(null);
	const spotlight = useSpotlight();
	const mine = spotlight?.clientId === awareness.clientID;
	const timer = useTimer(doc);
	const votes = useVotes(doc);
	const silent = useSilentSessions(doc);
	const now = useServerNow(1000, open && (timer !== null || votes.length > 0));
	const running = timer && !timerDone(timer, now);
	const facilitator = useFacilitator();
	const leads = !readOnly && isFacilitator(facilitator.you, doc, now);
	const canTime = useMayControlTimer(timer, readOnly);
	const openVotes = votes.filter((vote) => isOpen(vote, now));
	const live = Boolean(running || spotlight || openVotes.length > 0 || silent.length > 0);

	const close = (refocus = false) => {
		setOpen(false);
		setCarrying(false);
		if (refocus) button.current?.focus();
	};

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				close(true);
			}
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	// ⇧F, ⇧T and ⇧S, from anywhere on the board.
	const latest = useRef({ open, mine, spotlight, readOnly });
	latest.current = { open, mine, spotlight, readOnly };
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const key = facilitationKey(event);
			if (!key || isEditableTarget(event.target)) return;
			// Dialogs keep their keys, except this menu's own.
			if (isOffBoardTarget(event.target) && !root.current?.contains(event.target as Node)) return;
			const state = latest.current;
			event.preventDefault();
			if (key === "menu") {
				setOpen(!state.open);
				setCarrying(false);
				setFocusOn(state.open ? null : "first");
			} else if (key === "timer") {
				setOpen(true);
				setCarrying(false);
				setFocusOn("timer");
			} else if (!state.readOnly) {
				if (state.mine) stopSpotlight();
				else if (!state.spotlight) startSpotlight(awareness, user);
				else setOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [awareness, user]);

	// Opened from the keyboard: focus the first thing in it (or the timer).
	useEffect(() => {
		if (!open || !focusOn) return;
		const frame = requestAnimationFrame(() => {
			const scope =
				focusOn === "timer" ? timerRow.current : root.current?.querySelector(".facilitate-menu");
			scope?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
			setFocusOn(null);
		});
		return () => cancelAnimationFrame(frame);
	}, [open, focusOn]);

	/** Start something on a section: the one selected, or pick one on the board. */
	const onSection = (kind: PickKind) => {
		close();
		if (selectedSection) {
			if (kind === "silent") startSilent(selectedSection, user);
			else voteUI.start(selectedSection);
			return;
		}
		sectionPicker.start(kind);
	};
	const selectedIsSilent =
		selectedSection !== null && silent.some((s) => s.section === selectedSection);

	return (
		<div className="facilitate" ref={root}>
			<button
				ref={button}
				type="button"
				className="facilitate-button"
				aria-expanded={open}
				aria-controls={id}
				aria-keyshortcuts="Shift+F"
				title="Facilitate (⇧F)"
				data-live={live || undefined}
				data-ready={(ready && !readOnly) || undefined}
				onClick={(event) => {
					if (open) return close();
					setOpen(true);
					// Enter or Space (a click with no pointer) moves focus into it.
					if (event.detail === 0) setFocusOn("first");
				}}
			>
				<BatonIcon />
				Facilitate
				{ready && !readOnly && (
					<span className="facilitate-ready" aria-label="Steps ready to start" />
				)}
			</button>
			{open && carrying && services.carryTargets && (
				<div
					className="facilitate-menu facilitate-carry"
					id={id}
					role="dialog"
					aria-label="Carry over"
				>
					<CarryPanel
						items={openItems}
						services={services}
						onCarried={(result) => {
							close();
							if (toasts) carriedToast(toasts, result);
						}}
					/>
				</div>
			)}
			{open && !carrying && (
				<div className="facilitate-menu" id={id} role="dialog" aria-label="Facilitate">
					{live && (
						<RunningNow
							doc={doc}
							timer={running ? timer : null}
							votes={openVotes}
							silent={silent}
							now={now}
							canTime={canTime}
							readOnly={readOnly}
							spotlight={
								spotlight ? { name: spotlight.user.name, mine, canEnd: !mine && leads } : null
							}
							user={user}
							onReveal={(section) => {
								close();
								onReveal?.(section);
							}}
							onDone={() => close()}
						/>
					)}
					{steps.length > 0 && (
						<PreparedSteps
							doc={doc}
							steps={steps}
							user={user}
							readOnly={readOnly}
							onStarted={(step) => {
								close();
								const section = stepSection(step);
								if (section) onReveal?.(section);
							}}
						/>
					)}
					<section className="facilitate-row" ref={timerRow}>
						<span className="facilitate-row-icon">
							<StopwatchIcon />
						</span>
						<div className="facilitate-row-body">
							<h3>
								Timer <kbd className="facilitate-key">⇧T</kbd>
							</h3>
							{running && timer && !canTime ? (
								<p className="facilitate-note">
									{timer.by.name}’s timer is running: they, or the board’s owner, can change it
								</p>
							) : (
								<p className="facilitate-note">
									{running
										? "Start a new one in its place"
										: "Everyone sees it count down together"}
								</p>
							)}
							{!readOnly && (!running || canTime) && (
								<TimerStarter
									onStart={(ms, label) => {
										sendTimer(user, { action: "start", ms, ...(label ? { label } : {}) });
										close();
									}}
								/>
							)}
						</div>
					</section>
					{!readOnly && (
						<section className="facilitate-row">
							<span className="facilitate-row-icon">
								<SpotlightIcon />
							</span>
							<div className="facilitate-row-body">
								<h3>
									Spotlight <kbd className="facilitate-key">⇧S</kbd>
								</h3>
								<p className="facilitate-note">
									{spotlight && !mine
										? `${spotlight.user.name} is spotlighting`
										: "Bring everyone to what you’re looking at, or just call them over"}
								</p>
								{mine ? (
									<button type="button" onClick={stopSpotlight}>
										Stop spotlighting
									</button>
								) : spotlight ? (
									leads && (
										<span className="facilitate-actions">
											<button
												type="button"
												className="facilitate-primary"
												onClick={() => {
													startSpotlight(awareness, user);
													close();
												}}
											>
												Spotlight me instead
											</button>
											<button type="button" onClick={endSpotlight}>
												End theirs
											</button>
										</span>
									)
								) : (
									<span className="facilitate-actions">
										<button
											type="button"
											className="facilitate-primary"
											onClick={() => {
												startSpotlight(awareness, user);
												close();
											}}
										>
											Spotlight me
										</button>
										<button
											type="button"
											title="Everyone gets a note with a way here; nobody is moved"
											onClick={() => {
												callEveryone(awareness);
												close();
												toasts?.show({ message: "Called everyone over to what you’re looking at" });
											}}
										>
											Call everyone over
										</button>
									</span>
								)}
							</div>
						</section>
					)}
					{!readOnly && (
						<section className="facilitate-row">
							<span className="facilitate-row-icon">
								<DotsIcon />
							</span>
							<div className="facilitate-row-body">
								<h3>Dot vote</h3>
								<p className="facilitate-note">Everyone gets a few dots to put on what matters</p>
								<span className="facilitate-actions">
									<button type="button" onClick={() => onSection("vote")}>
										{selectedSection ? "On this section…" : "On a section…"}
									</button>
									<button
										type="button"
										onClick={() => {
											voteUI.start(null);
											close();
										}}
									>
										On the board…
									</button>
								</span>
							</div>
						</section>
					)}
					{!readOnly && (
						<section className="facilitate-row">
							<span className="facilitate-row-icon">
								<HushIcon />
							</span>
							<div className="facilitate-row-body">
								<h3>Silent mode</h3>
								<p className="facilitate-note">
									Everyone writes stickies on their own, face down until you reveal them all at once
								</p>
								<button
									type="button"
									disabled={selectedIsSilent}
									onClick={() => onSection("silent")}
								>
									{selectedSection ? "Start on this section" : "Start on a section…"}
								</button>
							</div>
						</section>
					)}
					{!readOnly && openItems.length > 0 && services.carryTargets && (
						<section className="facilitate-row">
							<span className="facilitate-row-icon">
								<CarryIcon />
							</span>
							<div className="facilitate-row-body">
								<h3>Action items</h3>
								<p className="facilitate-note">
									{openItems.length} still open: carry them over to the next session, with their
									owners and due dates
								</p>
								<button type="button" onClick={() => setCarrying(true)}>
									Carry over…
								</button>
							</div>
						</section>
					)}
					<section className="facilitate-row">
						<span className="facilitate-row-icon">
							<StampIcon />
						</span>
						<div className="facilitate-row-body">
							<h3>{readOnly ? "Emotes and chat" : "Stamps, emotes and chat"}</h3>
							<span className="facilitate-actions">
								{!readOnly && onStamp && (
									<button
										type="button"
										onClick={() => {
											close();
											onStamp();
										}}
									>
										Stamp <kbd>M</kbd>
									</button>
								)}
								<button
									type="button"
									onClick={() => {
										close();
										requestGesture("emotes", canvasMiddle());
									}}
								>
									Emote <kbd>E</kbd>
								</button>
								<button
									type="button"
									onClick={() => {
										close();
										requestGesture("chat", canvasMiddle());
									}}
								>
									Chat at your cursor <kbd>/</kbd>
								</button>
							</span>
						</div>
					</section>
					<label className="facilitate-sound">
						<input
							type="checkbox"
							defaultChecked={chimeEnabled()}
							onChange={(event) => setChimeEnabled(event.target.checked)}
						/>
						Chime when the timer ends
					</label>
				</div>
			)}
		</div>
	);
}

function sectionTitle(doc: Y.Doc, id: string | null): string {
	if (id === null) return "the board";
	const title = shapesMap(doc).get(id)?.get("title");
	return typeof title === "string" && title ? `“${title}”` : "a section";
}

/**
 * Everything running on the board, each with its controls: one place to
 * run a session from.
 */
function RunningNow({
	doc,
	timer,
	votes,
	silent,
	now,
	canTime,
	readOnly,
	spotlight,
	user,
	onReveal,
	onDone,
}: {
	doc: Y.Doc;
	timer: Timer | null;
	votes: DotVote[];
	silent: { section: string; session: string; title: string; total: number; starter?: string }[];
	now: number;
	canTime: boolean;
	readOnly: boolean;
	spotlight: { name: string; mine: boolean; canEnd: boolean } | null;
	user: { name: string; color: string };
	onReveal: (section: string) => void;
	onDone: () => void;
}) {
	const { control } = useVoteControl();
	return (
		<section className="running" aria-label="Running now">
			<h3 className="running-head">
				<span className="running-pulse" aria-hidden="true" />
				Running now
			</h3>
			<ul className="running-items">
				{timer && (
					<li className="running-item">
						<StopwatchIcon size={14} />
						<span className="running-what">
							<span className="mono">{formatClock(timeLeft(timer, now))}</span>
							{timer.label ? ` · ${timer.label}` : " left"}
							{timer.state === "paused" && <span className="running-note"> · paused</span>}
						</span>
						{canTime && (
							<span className="running-actions">
								<button
									type="button"
									onClick={() =>
										sendTimer(user, { action: timer.state === "paused" ? "resume" : "pause" })
									}
								>
									{timer.state === "paused" ? "Resume" : "Pause"}
								</button>
								<button
									type="button"
									onClick={() => sendTimer(user, { action: "add", ms: 60_000 })}
								>
									+1
								</button>
								<button type="button" onClick={() => sendTimer(user, { action: "stop" })}>
									Stop
								</button>
							</span>
						)}
					</li>
				)}
				{spotlight && (
					<li className="running-item">
						<SpotlightIcon size={14} />
						<span className="running-what">
							{spotlight.mine ? "You’re spotlighting" : `${spotlight.name} is spotlighting`}
						</span>
						{(spotlight.mine || spotlight.canEnd) && (
							<span className="running-actions">
								<button type="button" onClick={spotlight.mine ? stopSpotlight : endSpotlight}>
									{spotlight.mine ? "Stop" : "End"}
								</button>
							</span>
						)}
					</li>
				)}
				{votes.map((vote) => {
					const { voters } = turnout(vote);
					return (
						<li key={vote.id} className="running-item">
							<DotsIcon size={14} />
							<span className="running-what">
								Voting on {sectionTitle(doc, vote.scope)}
								<span className="running-note">
									{` · ${voters} voted`}
									{vote.endsAt ? ` · ${formatRemaining(Date.parse(vote.endsAt) - now)} left` : ""}
								</span>
							</span>
							<span className="running-actions">
								{vote.scope && (
									<button type="button" onClick={() => onReveal(vote.scope!)}>
										Go there
									</button>
								)}
								<button
									type="button"
									onClick={() => {
										voteUI.showTally(vote.id);
										onDone();
									}}
								>
									Results
								</button>
								{!readOnly && control(vote) && (
									<button
										type="button"
										onClick={() =>
											transactLocal(doc, () =>
												closeVote(doc, vote.id, user, new Date(now).toISOString()),
											)
										}
									>
										Close
									</button>
								)}
							</span>
						</li>
					);
				})}
				{silent.map((session) => (
					<li key={session.session} className="running-item">
						<HushIcon size={14} />
						<span className="running-what">
							{session.title} is silent
							<span className="running-note">{` · ${session.total} face down`}</span>
						</span>
						<span className="running-actions">
							<button type="button" onClick={() => onReveal(session.section)}>
								Go there
							</button>
							{!readOnly && facilitation.mayControl(session.starter) && (
								<button
									type="button"
									className="running-reveal"
									onClick={() => revealSilent(session.session)}
								>
									{session.total > 0 ? (
										<>
											<FlipIcon size={13} />
											Reveal
										</>
									) : (
										"End"
									)}
								</button>
							)}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function TimerStarter({ onStart }: { onStart: (ms: number, label: string) => void }) {
	const [minutes, setMinutes] = useState("");
	const [label, setLabel] = useState("");
	return (
		<div className="timer-starter">
			<input
				className="timer-label-input"
				aria-label="What it’s for (optional)"
				placeholder="What for? (optional)"
				maxLength={60}
				value={label}
				onChange={(event) => setLabel(event.target.value)}
			/>
			{TIMER_PRESETS_MS.map((ms) => (
				<button
					key={ms}
					type="button"
					className="timer-preset"
					onClick={() => onStart(ms, label.trim())}
				>
					{ms / 60_000}
					<span aria-hidden="true">m</span>
					<span className="visually-hidden"> minutes</span>
				</button>
			))}
			<form
				className="timer-custom"
				onSubmit={(event) => {
					event.preventDefault();
					const value = Number.parseFloat(minutes);
					if (Number.isFinite(value) && value > 0)
						onStart(Math.round(value * 60_000), label.trim());
				}}
			>
				<input
					aria-label="Minutes"
					inputMode="decimal"
					placeholder="min"
					value={minutes}
					onChange={(event) => setMinutes(event.target.value.replace(/[^\d.]/g, ""))}
				/>
				<button type="submit" disabled={!minutes}>
					Start
				</button>
			</form>
		</div>
	);
}
