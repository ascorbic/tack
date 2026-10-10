import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Actor, StepMeta } from "../../shared/history.ts";
import { relativeTime } from "../boards/api.ts";
import { type HistoryController, type HistoryState, SPEEDS } from "./controller.ts";
import { indexOf } from "./position.ts";
import {
	ActorStack,
	PlayIcon,
	StepIcon,
	actorColor,
	actorNames,
	dayLabel,
	moment,
	startOfDay,
	whatHappened,
} from "./parts.tsx";

// The scrubber, where the tool dock usually is: play and pause, speed,
// stepping, and a track of every step, evenly spaced (history is bursty: a
// time axis would be all gaps), each a tick as tall as it was busy and in
// its author's colour, with days marked. Drag it and the board replays
// under your pointer; the far right is now, the live board.

/** Each column of ticks is this wide, so a long history still reads as a shape. */
const COLUMN_PX = 4;
/** Day labels closer than this to the one before are left out. */
const LABEL_GAP_PX = 64;

interface Column {
	left: number;
	width: number;
	height: number;
	color: string;
	/** The last step in it, by index. */
	last: number;
}

export function HistoryDock({
	controller,
	state,
	onClose,
}: {
	controller: HistoryController;
	state: HistoryState;
	onClose: () => void;
}) {
	const steps = state.steps;
	const actors = state.timeline?.actors ?? {};
	const count = steps.length;
	const index = indexOf(steps, state.position);
	const step = state.position === null ? null : steps[index];
	const now = state.timeline?.now ?? Date.now();

	const track = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(600);
	useLayoutEffect(() => {
		const node = track.current;
		if (!node) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(entry.contentRect.width);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const columns = useMemo(() => columnsOf(steps, actors, width), [steps, actors, width]);
	const days = useMemo(() => daysOf(steps, width, now), [steps, width, now]);

	// Where the pointer is over the track (an index, `count` for now), and whether it's dragging.
	const [hover, setHover] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const at = (clientX: number) => {
		const rect = track.current?.getBoundingClientRect();
		if (!rect || rect.width === 0 || count === 0) return count;
		const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		return Math.round(t * count);
	};
	const seekIndex = (i: number) => controller.seek(i >= count ? null : (steps[i]?.id ?? null));

	const onKeyDown = (event: React.KeyboardEvent) => {
		const moves: Record<string, number> = {
			ArrowLeft: -1,
			ArrowRight: 1,
			PageUp: -10,
			PageDown: 10,
		};
		if (event.key in moves) {
			event.preventDefault();
			event.stopPropagation();
			controller.pause();
			controller.stepBy(moves[event.key]!);
		} else if (event.key === "Home" && count > 0) {
			event.preventDefault();
			controller.pause();
			void controller.seekNow(steps[0]!.id);
		} else if (event.key === "End") {
			event.preventDefault();
			controller.pause();
			void controller.seekNow(null);
		}
	};

	const tip = hover ?? (dragging ? index : null);
	const tipStep = tip !== null && tip < count ? steps[tip] : null;
	const fraction = (i: number) => (count === 0 ? 1 : i / count);
	const speedIndex = SPEEDS.indexOf(state.speed);
	const [speedBump, setSpeedBump] = useState(0);
	useEffect(() => {
		if (speedBump === 0) return;
		const timer = setTimeout(() => setSpeedBump(0), 400);
		return () => clearTimeout(timer);
	}, [speedBump]);

	return (
		<section
			className="history-dock nopan nowheel"
			aria-label="History scrubber"
			data-chrome
			data-playing={state.playing || undefined}
			data-live={state.position === null || undefined}
		>
			<div className="history-dock-controls">
				<div className="history-transport">
					<button
						type="button"
						className="history-round"
						aria-label="Back a step"
						data-tooltip="Back a step (←)"
						disabled={count === 0 || index === 0}
						onClick={() => {
							controller.pause();
							controller.stepBy(-1);
						}}
					>
						<StepIcon direction="back" />
					</button>
					<button
						type="button"
						className="history-play"
						aria-label={state.playing ? "Pause" : "Play"}
						aria-pressed={state.playing}
						data-tooltip={state.playing ? "Pause (Space)" : "Play (Space)"}
						disabled={count === 0}
						onClick={() => controller.toggle()}
					>
						<PlayIcon playing={state.playing} />
					</button>
					<button
						type="button"
						className="history-round"
						aria-label="Forward a step"
						data-tooltip="Forward a step (→)"
						disabled={state.position === null}
						onClick={() => {
							controller.pause();
							controller.stepBy(1);
						}}
					>
						<StepIcon direction="forward" />
					</button>
					<button
						type="button"
						className="history-speed"
						aria-label={`Speed: ${state.speed}×`}
						data-tooltip="Playback speed"
						data-bump={speedBump || undefined}
						onClick={() => {
							controller.setSpeed(SPEEDS[(speedIndex + 1) % SPEEDS.length]!);
							setSpeedBump((n) => n + 1);
						}}
					>
						{state.speed}×
					</button>
				</div>
				<div className="history-when" aria-live="polite">
					{step ? (
						<>
							<span className="history-when-main" key={step.id}>
								{moment(step.until, now)}
							</span>
							<span className="history-when-sub">
								{relativeTime(step.until, now)}
								{state.seeking && <span className="history-seeking" aria-label="Loading" />}
							</span>
						</>
					) : (
						<>
							<span className="history-when-main">
								<span className="history-live-dot" aria-hidden="true" />
								Now
							</span>
							<span className="history-when-sub">
								{count === 0 && state.status === "ready"
									? "Nothing’s changed yet"
									: "The live board"}
							</span>
						</>
					)}
				</div>
				<div className="history-dock-end">
					<button
						type="button"
						className="history-now"
						disabled={state.position === null}
						onClick={() => {
							controller.pause();
							void controller.seekNow(null);
						}}
					>
						Back to now
					</button>
					<button type="button" className="history-done" onClick={onClose}>
						Done
					</button>
				</div>
			</div>

			<div
				ref={track}
				className="history-track"
				role="slider"
				tabIndex={0}
				aria-label="Point in history"
				aria-valuemin={0}
				aria-valuemax={count}
				aria-valuenow={index}
				aria-valuetext={
					step
						? `${moment(step.until, now)}: ${actorNames(step.actors, actors)} ${whatHappened(step, actors)}`
						: "Now"
				}
				data-dragging={dragging || undefined}
				data-loading={state.status === "loading" || undefined}
				onKeyDown={onKeyDown}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					event.currentTarget.setPointerCapture(event.pointerId);
					controller.pause();
					setDragging(true);
					setHover(null);
					seekIndex(at(event.clientX));
				}}
				onPointerMove={(event) => {
					const i = at(event.clientX);
					if (dragging) seekIndex(i);
					else setHover(i);
				}}
				onPointerUp={(event) => {
					event.currentTarget.releasePointerCapture(event.pointerId);
					setDragging(false);
				}}
				onPointerCancel={() => setDragging(false)}
				onPointerLeave={() => setHover(null)}
			>
				<div className="history-days" aria-hidden="true">
					{days.map((day) => (
						<span
							key={day.index}
							className="history-day"
							style={{ left: `${fraction(day.index) * 100}%` }}
							data-labelled={day.label !== null || undefined}
						>
							{day.label}
						</span>
					))}
				</div>
				<div className="history-ticks" aria-hidden="true">
					{columns.map((column) => (
						<span
							key={column.left}
							className="history-tick"
							data-past={column.last <= index || undefined}
							style={
								{
									left: `${column.left}px`,
									width: `${column.width}px`,
									height: `${column.height}px`,
									"--tick": column.color,
								} as React.CSSProperties
							}
						/>
					))}
				</div>
				<span className="history-rail" aria-hidden="true">
					<span className="history-progress" style={{ width: `${fraction(index) * 100}%` }} />
				</span>
				<span className="history-now-mark" aria-hidden="true" />
				{hover !== null && !dragging && (
					<span
						className="history-ghost"
						aria-hidden="true"
						style={{ left: `${fraction(hover) * 100}%` }}
					/>
				)}
				<span
					className="history-playhead"
					aria-hidden="true"
					style={{ left: `${fraction(index) * 100}%` }}
				/>
				{tip !== null && (
					<span
						className="history-tip"
						role="presentation"
						style={{ left: `${fraction(tip) * 100}%` }}
						data-edge={fraction(tip) < 0.12 ? "start" : fraction(tip) > 0.88 ? "end" : undefined}
					>
						{tipStep ? (
							<>
								<span className="history-tip-head">
									<ActorStack keys={tipStep.actors} actors={actors} size={16} />
									<span className="history-tip-when">{moment(tipStep.until, now)}</span>
								</span>
								<span className="history-tip-what">
									{tipStep.origin ? (
										"History starts here"
									) : (
										<>
											<strong>{actorNames(tipStep.actors, actors)}</strong>{" "}
											{whatHappened(tipStep, actors)}
										</>
									)}
								</span>
							</>
						) : (
							<span className="history-tip-head">
								<span className="history-live-dot" aria-hidden="true" />
								<span className="history-tip-when">Now</span>
							</span>
						)}
					</span>
				)}
			</div>
		</section>
	);
}

function columnsOf(
	steps: readonly StepMeta[],
	actors: Record<string, Actor>,
	width: number,
): Column[] {
	const count = steps.length;
	if (count === 0 || width <= 0) return [];
	// Room for a bar per step, or bars for columns of steps when there are many.
	const pitch = width / count;
	const bucket = pitch >= COLUMN_PX ? 0 : COLUMN_PX;
	const bar = bucket ? 3 : Math.round(Math.min(8, Math.max(3, pitch * 0.42)));
	const columns = new Map<number, { size: number; color: string; last: number }>();
	steps.forEach((step, i) => {
		const x = (i / count) * width;
		const key = bucket ? Math.floor(x / bucket) * bucket : Math.round(x);
		const size = step.changes.length + (step.more ?? 0) + (step.other?.length ?? 0) || 1;
		const column = columns.get(key);
		const color = actorColor(actors[step.actors[0] ?? ""]);
		if (!column) columns.set(key, { size, color, last: i });
		else {
			if (size > column.size) column.color = color;
			column.size = Math.max(column.size, size);
			column.last = i;
		}
	});
	return [...columns].map(([x, column]) => ({
		left: Math.round(x - bar / 2),
		width: bar,
		height: Math.round(8 + 20 * Math.min(1, Math.log2(1 + column.size) / 4)),
		color: column.color,
		last: column.last,
	}));
}

function daysOf(steps: readonly StepMeta[], width: number, now: number) {
	const days: { index: number; label: string | null }[] = [];
	let lastLabelAt = Number.NEGATIVE_INFINITY;
	steps.forEach((step, i) => {
		if (i > 0 && startOfDay(step.at) === startOfDay(steps[i - 1]!.at)) return;
		const x = (i / steps.length) * width;
		const label = x - lastLabelAt >= LABEL_GAP_PX ? dayLabel(step.at, now) : null;
		if (label) lastLabelAt = x;
		days.push({ index: i, label });
	});
	return days;
}
