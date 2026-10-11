import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import type { Rect } from "../../shared/geometry.ts";
import { type StepGroup, type StepMeta, groupSteps, removedBy } from "../../shared/history.ts";
import type { SizeOf } from "../../shared/sections.ts";
import type { HistoryController, HistoryState } from "./controller.ts";
import {
	ActorStack,
	CloseIcon,
	FlagIcon,
	HistoryIcon,
	InfoIcon,
	RestoreIcon,
	SectionIcon,
	actorNames,
	dayLabel,
	startOfDay,
	stepTime,
	whatHappened,
} from "./parts.tsx";
import { motionScale } from "../motion.ts";
import { useShapeIds } from "./useHistory.ts";

// The history panel: what happened, newest first, grouped into entries by
// who and when, under day headings. Click an entry to see the board as it
// was then; entries that removed something offer to bring it back. Its scope
// can be the whole board or one section, which also filters the scrubber.

export function HistoryPanel({
	controller,
	state,
	live,
	readOnly,
	sizeOf,
	onClose,
	onFocus,
}: {
	controller: HistoryController;
	state: HistoryState;
	/** The live board, to know what's still on it. */
	live: Y.Doc;
	/** View only: history can be read, but nothing brought back. */
	readOnly: boolean;
	sizeOf?: SizeOf;
	onClose: () => void;
	/** Show part of the board (where an entry's changes were). */
	onFocus: (bounds: Rect) => void;
}) {
	const actors = state.timeline?.actors ?? {};
	const groups = useMemo(() => groupSteps(state.steps).reverse(), [state.steps]);
	const liveIds = useShapeIds(live);
	const sections = useMemo(
		() => (state.open ? controller.sections() : []),
		// Sections come and go with the board, and with the step shown.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
		[controller, state.open, state.position, liveIds],
	);
	const section = sections.find((s) => s.id === state.section) ?? null;
	const origin = state.timeline?.steps[0];
	const [restoring, setRestoring] = useState<number | null>(null);
	// The entry being shown stays in view as playback moves through them.
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const current = list.current?.querySelector('[aria-current="step"]');
		current?.scrollIntoView({
			block: "nearest",
			behavior: motionScale() < 0.01 ? "auto" : "smooth",
		});
	}, [state.position, state.section]);

	const choose = (group: StepGroup) => {
		controller.pause();
		const last = group.steps.at(-1)!;
		void controller.seekNow(last.id);
		const bounds = group.merged.bounds;
		if (bounds) onFocus({ x: bounds[0], y: bounds[1], w: bounds[2], h: bounds[3] });
	};

	const bringBack = async (group: StepGroup) => {
		setRestoring(group.merged.id);
		try {
			await controller.bringBack(group.steps[0]!.id, removedBy(group.merged), sizeOf);
		} finally {
			setRestoring(null);
		}
	};

	let lastDay: number | null = null;
	return (
		<aside className="history-panel nowheel" aria-label="History" data-chrome>
			<header className="history-head">
				<span className="history-head-icon" aria-hidden="true">
					<HistoryIcon size={18} />
				</span>
				<div>
					<h2>History</h2>
					<p>
						{readOnly
							? "Scrub back through the board, and see who changed what."
							: "Scrub back through the board. Select something from the past to bring it back."}
					</p>
				</div>
				<button
					type="button"
					className="history-close"
					aria-label="Close history"
					data-tooltip="Close (Esc)"
					onClick={onClose}
				>
					<CloseIcon />
				</button>
			</header>

			<div className="history-scope">
				<div
					className="segmented history-scope-switch"
					role="radiogroup"
					aria-label="Show history for"
				>
					<label data-checked={!section}>
						<input
							type="radio"
							name="history-scope"
							checked={!section}
							onChange={() => controller.setSection(null)}
						/>
						Whole board
					</label>
					<label data-checked={Boolean(section)} data-disabled={sections.length === 0 || undefined}>
						<input
							type="radio"
							name="history-scope"
							checked={Boolean(section)}
							disabled={sections.length === 0}
							onChange={() => {
								const first = sections[0];
								if (first) {
									controller.setSection(first.id);
									const area = controller.sectionArea(first.id);
									if (area) onFocus(area);
								}
							}}
						/>
						A section
					</label>
				</div>
				{section && (
					<label className="history-section-pick">
						<SectionIcon />
						<span className="visually-hidden">Section</span>
						<select
							value={section.id}
							onChange={(event) => {
								controller.setSection(event.target.value);
								const area = controller.sectionArea(event.target.value);
								if (area) onFocus(area);
							}}
						>
							{sections.map((s) => (
								<option key={s.id} value={s.id}>
									{s.title}
								</option>
							))}
						</select>
					</label>
				)}
			</div>

			<div ref={list} className="history-list" role="list" aria-busy={state.status === "loading"}>
				<button
					type="button"
					role="listitem"
					className="history-entry history-entry-now"
					aria-current={state.position === null ? "step" : undefined}
					onClick={() => {
						controller.pause();
						void controller.seekNow(null);
					}}
				>
					<span className="history-live-dot" aria-hidden="true" />
					<span className="history-entry-text">
						<strong>Now</strong> <span className="history-muted">· the live board</span>
					</span>
				</button>

				{state.status === "loading" && <ListSkeleton />}
				{state.status === "error" && (
					<div role="listitem">
						<p className="history-message" role="alert">
							{state.error}{" "}
							<button
								type="button"
								className="history-link"
								onClick={() => void controller.refresh()}
							>
								Try again
							</button>
						</p>
					</div>
				)}
				{state.status === "ready" && groups.length === 0 && (
					<p className="history-message" role="listitem">
						{section
							? `Nothing’s happened in “${section.title}” yet.`
							: "Nothing’s changed since history began. Edits show up here as people make them."}
					</p>
				)}

				{groups.map((group) => {
					const last = group.steps.at(-1)!;
					const first = group.steps[0]!;
					const day = startOfDay(last.until);
					const heading = day !== lastDay ? dayLabel(last.until, state.timeline?.now) : null;
					lastDay = day;
					const current =
						state.position !== null && group.steps.some((step) => step.id === state.position);
					if (last.origin) {
						return (
							<div key={last.id} role="listitem" className="history-group">
								{heading && <h3 className="history-day-head">{heading}</h3>}
								<button
									type="button"
									className="history-entry history-entry-origin"
									aria-current={current ? "step" : undefined}
									onClick={() => choose(group)}
								>
									<span className="history-origin-icon" aria-hidden="true">
										<FlagIcon />
									</span>
									<span className="history-entry-text">
										<strong>History starts here</strong>
										<span className="history-muted">
											{last.actors.length > 0
												? "Older history was let go, to keep the board light"
												: "The board as it was"}
										</span>
									</span>
									<time className="history-entry-time">{stepTime(last)}</time>
								</button>
							</div>
						);
					}
					const gone = removedBy(group.merged).filter((id) => !liveIds.has(id));
					return (
						<div key={last.id} role="listitem" className="history-group">
							{heading && <h3 className="history-day-head">{heading}</h3>}
							<div className="history-entry-row" data-current={current || undefined}>
								<button
									type="button"
									className="history-entry"
									aria-current={current ? "step" : undefined}
									onClick={() => choose(group)}
								>
									<ActorStack keys={group.merged.actors} actors={actors} />
									<span className="history-entry-text">
										<span>
											<strong>{actorNames(group.merged.actors, actors)}</strong>{" "}
											{whatHappened(group.merged, actors)}
										</span>
										{group.merged.span > 0 && (
											<span
												className="history-muted history-summarised"
												title="Older history is kept in coarser steps"
											>
												Summarised
											</span>
										)}
									</span>
									<time
										className="history-entry-time"
										dateTime={new Date(last.until).toISOString()}
									>
										{stepTime(group.steps.length > 1 ? spanOf(first, last) : last)}
									</time>
								</button>
								{!readOnly && gone.length > 0 && (
									<button
										type="button"
										className="history-bring-back"
										disabled={restoring !== null}
										data-busy={restoring === group.merged.id || undefined}
										onClick={() => void bringBack(group)}
									>
										<RestoreIcon />
										{gone.length === 1 ? "Bring back" : `Bring back ${gone.length}`}
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>

			<footer className="history-foot">
				<InfoIcon />
				<span>
					Cards show their GitHub details as they are now.
					{origin && !origin.actors.length && state.timeline && (
						<> History began {began(origin.at, state.timeline.now)}.</>
					)}
				</span>
			</footer>
		</aside>
	);
}

/** "today", "yesterday", "on Tue 6 Oct". */
function began(at: number, now: number): string {
	const day = dayLabel(at, now);
	return day === "Today" || day === "Yesterday" ? day.toLowerCase() : `on ${day}`;
}

/** A group's steps as one span, for its time. */
function spanOf(first: StepMeta, last: StepMeta): Pick<StepMeta, "at" | "until" | "span"> {
	return { at: first.at, until: last.until, span: Math.max(1, last.span) };
}

function ListSkeleton() {
	return (
		<div className="history-skeleton" aria-hidden="true">
			{[0, 1, 2, 3].map((i) => (
				<span key={i} style={{ "--i": i } as React.CSSProperties} />
			))}
		</div>
	);
}
