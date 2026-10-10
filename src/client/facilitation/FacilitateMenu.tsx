import { useEffect, useId, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { TIMER_PRESETS_MS, formatClock, timeLeft, timerDone } from "../../shared/facilitation.ts";
import type { Author } from "../../shared/shapes.ts";
import { chimeEnabled, setChimeEnabled } from "./chime.ts";
import { useServerNow, useTimer } from "./hooks.ts";
import { BatonIcon, DotsIcon, HushIcon, StampIcon, StopwatchIcon } from "./icons.tsx";
import { SpotlightIcon, startSpotlight, stopSpotlight } from "./Spotlight.tsx";
import { useSpotlight } from "./store.ts";
import { sendTimer } from "./Timer.tsx";
import { voteUI } from "./Votes.tsx";
import "./facilitation.css";

/**
 * The top bar's Facilitate menu: the timer, spotlight, starting a dot vote,
 * and pointers to silent mode, stamps and emotes. Viewers get the parts that
 * aren't about changing the board.
 */
export function FacilitateMenu({
	doc,
	awareness,
	user,
	readOnly,
}: {
	doc: Y.Doc;
	awareness: Awareness;
	user: Author;
	readOnly: boolean;
}) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const spotlight = useSpotlight();
	const mine = spotlight?.clientId === awareness.clientID;
	const timer = useTimer(doc);
	const now = useServerNow(1000, open && timer !== null);
	const running = timer && !timerDone(timer, now);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="facilitate" ref={root}>
			<button
				type="button"
				className="facilitate-button"
				aria-expanded={open}
				aria-controls={id}
				data-live={Boolean(running || spotlight) || undefined}
				onClick={() => setOpen((o) => !o)}
			>
				<BatonIcon />
				Facilitate
			</button>
			{open && (
				<div className="facilitate-menu" id={id} role="dialog" aria-label="Facilitate">
					<section className="facilitate-row">
						<span className="facilitate-row-icon">
							<StopwatchIcon />
						</span>
						<div className="facilitate-row-body">
							<h3>Timer</h3>
							{running && timer ? (
								<p className="facilitate-note mono">
									{formatClock(timeLeft(timer, now))} left
									{timer.state === "paused" ? " · paused" : ""}
								</p>
							) : (
								<p className="facilitate-note">Everyone sees it count down together</p>
							)}
							{!readOnly && (
								<TimerStarter
									onStart={(ms) => {
										sendTimer(user, { action: "start", ms });
										setOpen(false);
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
								<h3>Spotlight</h3>
								<p className="facilitate-note">Bring everyone to what you’re looking at</p>
								{mine ? (
									<button type="button" onClick={stopSpotlight}>
										Stop spotlighting
									</button>
								) : (
									<button
										type="button"
										className="facilitate-primary"
										disabled={spotlight !== null}
										onClick={() => {
											startSpotlight(awareness, user);
											setOpen(false);
										}}
									>
										{spotlight ? `${spotlight.user.name} is spotlighting` : "Spotlight me"}
									</button>
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
								<p className="facilitate-note">
									On the whole board, or select a section and choose Vote
								</p>
								<button
									type="button"
									onClick={() => {
										voteUI.start(null);
										setOpen(false);
									}}
								>
									Vote on the board…
								</button>
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
									Select a section and choose Silent mode: everyone writes on their own, then you
									reveal them all at once
								</p>
							</div>
						</section>
					)}
					<section className="facilitate-row">
						<span className="facilitate-row-icon">
							<StampIcon />
						</span>
						<div className="facilitate-row-body">
							<h3>Stamps and emotes</h3>
							<p className="facilitate-note">
								<kbd>M</kbd> stamps shapes · <kbd>E</kbd> emotes by your cursor · ✋ to high-five
							</p>
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

function TimerStarter({ onStart }: { onStart: (ms: number) => void }) {
	const [minutes, setMinutes] = useState("");
	return (
		<div className="timer-starter">
			{TIMER_PRESETS_MS.map((ms) => (
				<button key={ms} type="button" className="timer-preset" onClick={() => onStart(ms)}>
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
					if (Number.isFinite(value) && value > 0) onStart(Math.round(value * 60_000));
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
