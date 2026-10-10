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
import { chime } from "./chime.ts";
import { useServerNow, useTimer } from "./hooks.ts";
import { facilitation } from "./store.ts";

/** The last stretch, when the clock turns warm and ticks. */
const FINAL_MS = 10_000;

export function sendTimer(by: Author, command: TimerAction): void {
	facilitation.send({ type: "timer", by: { name: by.name, color: by.color }, ...command });
}

/**
 * The shared timer, at the top of the canvas for everyone. It counts down
 * against the server's clock, so it reaches zero for everyone together;
 * editors can pause, add a minute or stop it. At zero it rings once (for
 * people who were watching it run) and glows.
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

	if (!timer || timerExpired(timer, now)) return null;
	return (
		<TimerView
			timer={timer}
			now={now}
			canControl={!readOnly}
			onAction={(command) => sendTimer(user, command)}
		/>
	);
}

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
	const state = done
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
			{done && <span key={timer.id} className="timer-ripple" aria-hidden="true" />}
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
			<span className="timer-by" title={`Started by ${timer.by.name}`}>
				{timer.by.name}
			</span>
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
