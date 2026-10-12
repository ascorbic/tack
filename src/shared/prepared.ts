import type * as Y from "yjs";
import { DOTS_DEFAULT, DOTS_MAX } from "./dotvotes.ts";
import { TIMER_MAX_MS, TIMER_MIN_MS } from "./facilitation.ts";
import { type Author, LOCAL_ORIGIN, shapesMap } from "./shapes.ts";

// Prepared facilitation (#53): steps a template sets up for whoever runs the
// session, ready to start with one click from the Facilitate menu: a timer,
// silent writing in a section, a dot vote. They're in the document's
// `prepared` map (step id → `PreparedStep`, each replaced whole), so
// everyone sees what's planned and when it was started.
//
// Starting a step does what the Facilitate menu would: silent mode and the
// timer go through the server (which alone starts them), a dot vote is a
// local edit. A step remembers when it was started, so it's shown as done,
// and can be started again (a second round of voting, say).

export type PreparedStep = { id: string; label: string; order: number } & (
	| {
			kind: "timer";
			minutes: number;
	  }
	| {
			kind: "silent";
			/** The section to write in. */
			section: string;
			/** A timer to start with it, if any. */
			minutes?: number;
	  }
	| {
			kind: "vote";
			/** The section to vote on, or null for the whole board. */
			scope: string | null;
			dots: number;
			hidden: boolean;
			reactions?: boolean;
			title?: string;
			minutes?: number;
			/** Open for this many days, then it closes by itself: a vote for people across time zones. */
			days?: number;
	  }
) & {
		/** When someone started it, ISO 8601. */
		startedAt?: string;
		startedBy?: Author;
	};

export type PreparedKind = PreparedStep["kind"];

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A step as a template plans it: not started, and without an id (the map's key is its id). */
export type PreparedPlan = DistributiveOmit<PreparedStep, "id" | "startedAt" | "startedBy">;

/** Longest a step's label may be. */
const LABEL_MAX = 80;

/** The longest a prepared vote stays open, in days, as the Facilitate menu offers. */
export const VOTE_DAYS_MAX = 7;

export function preparedMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap("prepared");
}

function minutesOf(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const ms = Math.round(value * 60_000);
	if (ms < TIMER_MIN_MS) return undefined;
	return Math.min(ms, TIMER_MAX_MS) / 60_000;
}

/** A step as stored, or null if it's malformed. */
export function readStep(id: string, value: unknown): PreparedStep | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const label = typeof raw.label === "string" ? raw.label.slice(0, LABEL_MAX) : "";
	const order = typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : 0;
	const started = {
		...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
		...(isAuthor(raw.startedBy) ? { startedBy: raw.startedBy } : {}),
	};
	const minutes = minutesOf(raw.minutes);
	switch (raw.kind) {
		case "timer":
			return minutes ? { id, label, order, kind: "timer", minutes, ...started } : null;
		case "silent":
			if (typeof raw.section !== "string" || !raw.section) return null;
			return {
				id,
				label,
				order,
				kind: "silent",
				section: raw.section,
				...(minutes ? { minutes } : {}),
				...started,
			};
		case "vote": {
			const dots =
				typeof raw.dots === "number" && Number.isFinite(raw.dots)
					? Math.min(DOTS_MAX, Math.max(1, Math.round(raw.dots)))
					: DOTS_DEFAULT;
			return {
				id,
				label,
				order,
				kind: "vote",
				scope: typeof raw.scope === "string" && raw.scope ? raw.scope : null,
				dots,
				hidden: Boolean(raw.hidden),
				...(raw.reactions ? { reactions: true } : {}),
				...(typeof raw.title === "string" && raw.title ? { title: raw.title.slice(0, 120) } : {}),
				...(minutes ? { minutes } : {}),
				...(daysOf(raw.days) ? { days: daysOf(raw.days) } : {}),
				...started,
			};
		}
		default:
			return null;
	}
}

function daysOf(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(VOTE_DAYS_MAX, Math.max(1, Math.round(value)));
}

/** When a vote started now from a step closes by itself, if it does. */
export function voteEndsAt(step: PreparedStep, now: number): string | undefined {
	return step.kind === "vote" && step.days
		? new Date(now + step.days * 86_400_000).toISOString()
		: undefined;
}

/** How long a step runs, in words: "5 min", "3 days". */
export function stepLength(step: PreparedStep): string | null {
	if (step.kind === "vote" && step.days) return step.days === 1 ? "1 day" : `${step.days} days`;
	return "minutes" in step && step.minutes ? `${step.minutes} min` : null;
}

function isAuthor(value: unknown): value is Author {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Author).name === "string" &&
		typeof (value as Author).color === "string"
	);
}

/**
 * The board's prepared steps, in order. Steps about a section that's gone
 * are left out: there's nothing left to start.
 */
export function readPrepared(doc: Y.Doc): PreparedStep[] {
	const shapes = shapesMap(doc);
	const steps: PreparedStep[] = [];
	for (const [id, value] of preparedMap(doc)) {
		const step = readStep(id, value);
		if (!step) continue;
		const section =
			step.kind === "silent" ? step.section : step.kind === "vote" ? step.scope : null;
		if (section !== null && shapes.get(section)?.get("type") !== "section") continue;
		steps.push(step);
	}
	return steps.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The next step to start: the first that hasn't been. */
export function nextStep(steps: readonly PreparedStep[]): PreparedStep | null {
	return steps.find((step) => !step.startedAt) ?? null;
}

/** Remember that a step was started, as a local edit. */
export function markStarted(
	doc: Y.Doc,
	id: string,
	by: Author,
	at: string = new Date().toISOString(),
	origin: unknown = LOCAL_ORIGIN,
): void {
	const map = preparedMap(doc);
	const step = readStep(id, map.get(id));
	if (!step) return;
	doc.transact(() => {
		map.set(id, { ...step, startedAt: at, startedBy: { name: by.name, color: by.color } });
	}, origin);
}

/** Write steps (a template's), replacing any with the same ids. */
export function writePrepared(doc: Y.Doc, steps: readonly PreparedStep[]): void {
	const map = preparedMap(doc);
	doc.transact(() => {
		for (const step of steps) {
			const { startedAt: _at, startedBy: _by, ...plain } = step;
			map.set(step.id, plain);
		}
	});
}

/** A step in words, for the menu: "Silent writing in “Went well”, 5 min". */
export function describeStep(step: PreparedStep, sectionTitle: (id: string) => string): string {
	if (step.label) return step.label;
	const length = stepLength(step);
	const timer = length ? `, ${length}` : "";
	switch (step.kind) {
		case "timer":
			return `${step.minutes} minute timer`;
		case "silent":
			return `Silent writing in “${sectionTitle(step.section) || "a section"}”${timer}`;
		case "vote":
			return `Dot vote${step.scope ? ` on “${sectionTitle(step.scope) || "a section"}”` : ""}, ${step.dots} dots${timer}`;
	}
}
