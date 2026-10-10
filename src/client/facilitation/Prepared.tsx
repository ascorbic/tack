import type * as Y from "yjs";
import { startVote } from "../../shared/dotvotes.ts";
import {
	type PreparedStep,
	describeStep,
	markStarted,
	nextStep,
	readPrepared,
} from "../../shared/prepared.ts";
import type { Author } from "../../shared/shapes.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { relativeTime } from "../boards/api.ts";
import { clock } from "../clock.ts";
import { useDocValue } from "../decisions/useDocValue.ts";
import { transactLocal } from "../undo.ts";
import { DotsIcon, HushIcon, StopwatchIcon } from "./icons.tsx";
import { startSilent } from "./Silent.tsx";
import { sendTimer } from "./Timer.tsx";

// Facilitation a template prepared (#53): the Facilitate menu lists each
// step, the next one first in line, and starting one does what the menu
// would by hand, then brings everyone's attention to its section.

/** The board's prepared steps, re-read as the document changes. */
export function usePrepared(doc: Y.Doc): PreparedStep[] {
	return useDocValue(doc, readPrepared, "prepared") ?? [];
}

/** Start a prepared step: its timer, silent mode or dot vote, and remember it started. */
export function startStep(doc: Y.Doc, step: PreparedStep, by: Author): void {
	const minutes = "minutes" in step ? step.minutes : undefined;
	switch (step.kind) {
		case "silent":
			startSilent(step.section, by);
			break;
		case "vote":
			transactLocal(doc, () =>
				startVote(doc, {
					scope: step.scope,
					dots: step.dots,
					hidden: step.hidden,
					reactions: step.reactions ?? false,
					...(step.title ? { title: step.title } : {}),
					by,
				}),
			);
			break;
		case "timer":
			break;
	}
	if (minutes) sendTimer(by, { action: "start", ms: Math.round(minutes * 60_000) });
	transactLocal(doc, () => markStarted(doc, step.id, by, new Date(clock.now()).toISOString()));
}

function sectionTitle(doc: Y.Doc, id: string): string {
	const title = shapesMap(doc).get(id)?.get("title");
	return typeof title === "string" ? title : "";
}

/** The section a step is about, to bring into view as it starts. */
export function stepSection(step: PreparedStep): string | null {
	return step.kind === "silent" ? step.section : step.kind === "vote" ? step.scope : null;
}

const ICONS = { timer: StopwatchIcon, silent: HushIcon, vote: DotsIcon };

const KIND: Record<PreparedStep["kind"], string> = {
	timer: "Timer",
	silent: "Silent writing",
	vote: "Dot vote",
};

/** The Facilitate menu's "Ready to start": a run sheet, in order. */
export function PreparedSteps({
	doc,
	steps,
	user,
	readOnly,
	onStarted,
}: {
	doc: Y.Doc;
	steps: PreparedStep[];
	user: Author;
	readOnly: boolean;
	onStarted: (step: PreparedStep) => void;
}) {
	const next = nextStep(steps);
	return (
		<section className="prepared" aria-label="Ready to start">
			<header className="prepared-head">
				<h3>Ready to start</h3>
				<span className="prepared-progress">
					{steps.filter((step) => step.startedAt).length} of {steps.length}
				</span>
			</header>
			<ol className="prepared-steps">
				{steps.map((step, i) => {
					const Icon = ICONS[step.kind];
					const started = Boolean(step.startedAt);
					const isNext = step.id === next?.id;
					const minutes = "minutes" in step && step.minutes ? `${step.minutes} min` : null;
					return (
						<li
							key={step.id}
							className="prepared-step"
							data-started={started || undefined}
							data-next={isNext || undefined}
							style={{ "--i": i } as React.CSSProperties}
						>
							<span className="prepared-step-icon" aria-hidden="true">
								{started ? (
									<svg width="14" height="14" viewBox="0 0 16 16">
										<path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
									</svg>
								) : (
									<Icon />
								)}
							</span>
							<span className="prepared-step-body">
								<span className="prepared-step-label">
									{describeStep(step, (id) => sectionTitle(doc, id))}
								</span>
								<span className="prepared-step-meta">
									{started && step.startedAt
										? `Started ${relativeTime(Date.parse(step.startedAt), clock.now())}${step.startedBy ? ` by ${step.startedBy.name}` : ""}`
										: [KIND[step.kind], minutes].filter(Boolean).join(" · ")}
								</span>
							</span>
							{!readOnly && (
								<button
									type="button"
									className={isNext ? "facilitate-primary" : undefined}
									aria-label={`${started ? "Start again" : "Start"}: ${describeStep(step, (id) => sectionTitle(doc, id))}`}
									onClick={() => {
										startStep(doc, step, user);
										onStarted(step);
									}}
								>
									{started ? "Again" : "Start"}
								</button>
							)}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
