import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type Timer,
	type TimerAction,
	formatClock,
	timeLeft,
	timerDone,
	timerExpired,
} from "../../shared/facilitation.ts";
import type { Author } from "../../shared/shapes.ts";
import type { ToastStore } from "../Toasts.tsx";
import { chime } from "./chime.ts";
import { useServerNow, useTimer } from "./hooks.ts";
import { facilitation, useFacilitator, useTimerChange } from "./store.ts";

/** The last stretch, when the clock turns warm and ticks. */
const FINAL_MS = 10_000;

export function sendTimer(by: Author, command: TimerAction): void {
	facilitation.send({ type: "timer", by: { name: by.name, color: by.color }, ...command });
}

/** Whether you may pause, add to or stop the timer (see facilitator.ts). */
export function useMayControlTimer(timer: Timer | null, readOnly: boolean): boolean {
	useFacilitator();
	return !readOnly && timer !== null && facilitation.mayControl(timer.starter);
}

const CHANGES: Partial<Record<TimerAction["action"], string>> = {
	pause: "paused the timer",
	resume: "started the timer again",
	stop: "stopped the timer",
};

/** "Kai stopped the timer": a toast when someone else pauses, restarts or stops it. */
export function useTimerToasts(toasts: ToastStore): void {
	const change = useTimerChange();
	const shown = useRef<number | null>(null);
	useEffect(() => {
		if (!change || change.at === shown.current) return;
		shown.current = change.at;
		const words = CHANGES[change.action];
		if (words) toasts.show({ message: `${change.by.name} ${words}` });
	}, [change, toasts]);
}

/**
 * The shared timer, at the top of the canvas for everyone. It counts down
 * against the server's clock, so it reaches zero for everyone together;
 * whoever started it (and the board's owner) can pause, add a minute or
 * stop it. At zero it rings once (for people who were watching it run)
 * and glows, then after a while settles into a small chip.
 */
export function TimerPill({
	doc,
	user,
	readOnly,
}: {
	doc: Y.Doc;
	user: Author;
	readOnly: boolean;
}) {
	const timer = useTimer(doc);
	const now = useServerNow(250, timer !== null);
	// Ring only for runs this person saw running, so arriving late to a
	// finished timer doesn't chime.
	const watched = useRef<string | null>(null);
	const rung = useRef<string | null>(null);
	const done = timer ? timerDone(timer, now) : false;
	useEffect(() => {
		if (!timer) return;
		if (!done) watched.current = timer.id;
		else if (watched.current === timer.id && rung.current !== timer.id) {
			rung.current = timer.id;
			chime();
		}
	}, [timer, done]);

	const canControl = useMayControlTimer(timer, readOnly);
	if (!timer || timerExpired(timer, now)) return null;
	return (
		<TimerView
			timer={timer}
			now={now}
			canControl={canControl}
			onAction={(command) => sendTimer(user, command)}
		/>
	);
}

/** How long "Time's up" glows before settling into a small chip. */
export const TIMER_GLOW_MS = 20_000;

export function TimerView({
	timer,
	now,
	canControl,
	onAction,
}: {
	timer: Timer;
	now: number;
	canControl: boolean;
	onAction: (command: TimerAction) => void;
}) {
	const left = timeLeft(timer, now);
	const done = timerDone(timer, now);
	// Time's up glows for a while, then settles so it doesn't crowd the board.
	const settled = done && now - (timer.endsAt ?? now) > TIMER_GLOW_MS;
	const state = settled
		? "settled"
		: done
			? "done"
			: timer.state === "paused"
				? "paused"
				: left <= FINAL_MS
					? "final"
					: "running";
	const progress = timer.duration > 0 ? Math.min(1, Math.max(0, left / timer.duration)) : 0;
	const seconds = Math.ceil(left / 1000);
	// The digits tick (a little pop) every second of the last stretch.
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (state === "final") setTick((n) => n + 1);
	}, [seconds, state]);
	const R = 9;
	const C = 2 * Math.PI * R;
	return (
		<div
			className="timer"
			data-state={state}
			role="timer"
			aria-live={done ? "assertive" : "off"}
			aria-label={
				done
					? "Time's up"
					: `${formatClock(left)} left${timer.state === "paused" ? ", paused" : ""}`
			}
			style={{ "--timer-by": timer.by.color || "var(--accent)" } as React.CSSProperties}
		>
			{done && !settled && <span key={timer.id} className="timer-ripple" aria-hidden="true" />}
			<svg className="timer-ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
				<circle className="timer-ring-track" cx="12" cy="12" r={R} />
				<circle
					className="timer-ring-fill"
					cx="12"
					cy="12"
					r={R}
					strokeDasharray={C}
					strokeDashoffset={C * (1 - progress)}
				/>
				{done && (
					<path className="timer-bell" d="M8.5 14.5h7l-1-1.5v-2.5a2.5 2.5 0 0 0-5 0V13zM11 16h2" />
				)}
			</svg>
			<span
				className="timer-digits mono"
				key={state === "final" ? tick : undefined}
				aria-hidden="true"
			>
				{done ? "Time’s up" : formatClock(left)}
			</span>
			{timer.state === "paused" && !done && <span className="timer-note">Paused</span>}
			{timer.label && !settled && <span className="timer-label">{timer.label}</span>}
			{!settled && (
				<span className="timer-by" title={`Started by ${timer.by.name}`}>
					{timer.by.name}
				</span>
			)}
			{canControl && (
				<span className="timer-controls">
					{!done &&
						(timer.state === "paused" ? (
							<TimerButton label="Resume" onClick={() => onAction({ action: "resume" })}>
								<path d="M6 4.5v7l6-3.5z" />
							</TimerButton>
						) : (
							<TimerButton label="Pause" onClick={() => onAction({ action: "pause" })}>
								<path d="M5.5 4.5v7M10.5 4.5v7" />
							</TimerButton>
						))}
					<TimerButton label="Add a minute" onClick={() => onAction({ action: "add", ms: 60_000 })}>
						<text x="8" y="11.2" textAnchor="middle" className="timer-plus">
							+1
						</text>
					</TimerButton>
					<TimerButton label="Stop the timer" onClick={() => onAction({ action: "stop" })}>
						<path d="M5 5l6 6M11 5l-6 6" />
					</TimerButton>
				</span>
			)}
		</div>
	);
}

function TimerButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="timer-button"
			aria-label={label}
			data-tooltip={label}
			onClick={onClick}
		>
			<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
				{children}
			</svg>
		</button>
	);
}
