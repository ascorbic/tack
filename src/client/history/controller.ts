import * as Y from "yjs";
import type { Rect } from "../../shared/geometry.ts";
import { type Actor, type StepMeta, type Timeline, touchesSection } from "../../shared/history.ts";
import { type SizeOf, boxOf } from "../../shared/sections.ts";
import { readShape, shapesMap } from "../../shared/shapes.ts";
import { mirrorDoc } from "./mirror.ts";
import { indexOf } from "./position.ts";
import { Replayer } from "./replay.ts";
import { type Restored, restoreShapes } from "./restore.ts";
import type { HistorySource } from "./source.ts";

// History mode on the board (#47): the timeline, where the replay is, and
// playing it. While it's open the canvas shows `view`, a document of its own
// mirrored from the board at the step being shown (or the live board, at
// "now"), and nothing can be edited. Restoring copies shapes from the step
// being shown into the live board, as your own edit.

export type Speed = 1 | 2 | 4 | 8;
export const SPEEDS: readonly Speed[] = [1, 2, 4, 8];

export interface HistoryState {
	open: boolean;
	status: "idle" | "loading" | "ready" | "error";
	error: string | null;
	timeline: Timeline | null;
	/** The step shown, or null for now (the live board). */
	position: number | null;
	/** True while the board at `position` is still being fetched. */
	seeking: boolean;
	playing: boolean;
	speed: Speed;
	/** Only steps touching this section, if set. */
	section: string | null;
	/** Steps shown: every step, or those touching the section. */
	steps: StepMeta[];
	/** Bumped on every seek, so marks for a step replay even when it's shown again. */
	beat: number;
}

const INITIAL: HistoryState = {
	open: false,
	status: "idle",
	error: null,
	timeline: null,
	position: null,
	seeking: false,
	playing: false,
	speed: 1,
	section: null,
	steps: [],
	beat: 0,
};

/** How long each step shows while playing, at 1×: its real gap, within these bounds. */
const STEP_MIN_MS = 260;
const STEP_MAX_MS = 1100;
/** How often the timeline is read again while history is open. */
const REFRESH_MS = 12_000;

export class HistoryController {
	private state: HistoryState = INITIAL;
	private listeners = new Set<() => void>();
	private replayer: Replayer;
	private viewDoc: Y.Doc | null = null;
	/** The board at the step shown (the replayer's document), or null at now. */
	private shown: Y.Doc | null = null;
	private seekToken = 0;
	private playTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private frame = 0;
	private pendingSeek: { step: number | null } | null = null;
	private readonly onLive = () => {
		if (this.state.open && this.state.position === null) this.scheduleMirror();
	};
	private mirrorFrame = 0;

	/** Called after restoring: select and show what came back. */
	onRestored: ((restored: Restored) => void) | null = null;

	constructor(
		private readonly live: Y.Doc,
		private readonly source: HistorySource,
	) {
		this.replayer = new Replayer(source);
	}

	getSnapshot = (): HistoryState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** The document the canvas shows while history is open. */
	get view(): Y.Doc | null {
		return this.state.open ? this.viewDoc : null;
	}

	/** The board at the step shown (the live board at now). */
	get current(): Y.Doc {
		return this.shown ?? this.live;
	}

	actor(key: string): Actor | undefined {
		return this.state.timeline?.actors[key];
	}

	async open(options: { section?: string | null } = {}): Promise<void> {
		if (this.state.open) {
			if (options.section !== undefined) this.setSection(options.section);
			return;
		}
		this.viewDoc?.destroy();
		this.viewDoc = new Y.Doc();
		mirrorDoc(this.live, this.viewDoc);
		this.shown = null;
		this.live.on("update", this.onLive);
		this.set({
			...INITIAL,
			open: true,
			status: "loading",
			speed: this.state.speed,
			section: options.section ?? null,
		});
		this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
		await this.refresh();
	}

	close(): void {
		if (!this.state.open) return;
		this.pause();
		clearInterval(this.refreshTimer);
		this.live.off("update", this.onLive);
		cancelAnimationFrame(this.frame);
		cancelAnimationFrame(this.mirrorFrame);
		this.seekToken++;
		this.shown = null;
		this.set({ ...this.state, open: false, playing: false, position: null, seeking: false });
	}

	destroy(): void {
		this.close();
		this.replayer.destroy();
		this.viewDoc?.destroy();
		this.viewDoc = null;
	}

	/** Read the timeline again (it grows while people edit). */
	async refresh(): Promise<void> {
		try {
			const timeline = await this.source.timeline();
			if (!this.state.open) return;
			this.replayer.setTimeline(timeline);
			let position = this.state.position;
			// A step that's been merged away: show the step that took it in.
			if (position !== null && !timeline.steps.some((step) => step.id === position)) {
				position = timeline.steps.find((step) => step.id >= position!)?.id ?? null;
			}
			this.set({
				...this.state,
				status: "ready",
				error: null,
				timeline,
				position,
				steps: this.filter(timeline.steps, this.state.section),
			});
		} catch (error) {
			if (!this.state.open) return;
			// Keep showing what we had; only say so if there's nothing.
			if (this.state.timeline) return;
			this.set({
				...this.state,
				status: "error",
				error: error instanceof Error ? error.message : "Couldn’t load the board’s history.",
			});
		}
	}

	/** Show the board after `step`, or now (null). Scrubbing calls this often: only the latest counts. */
	seek(step: number | null): void {
		this.pendingSeek = { step };
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			const next = this.pendingSeek;
			this.pendingSeek = null;
			if (next) void this.seekNow(next.step);
		});
	}

	/** Seek straight away, without waiting for a frame. */
	async seekNow(step: number | null): Promise<void> {
		if (!this.state.open) return;
		const token = ++this.seekToken;
		if (step === null) {
			this.shown = null;
			this.set({ ...this.state, position: null, seeking: false, beat: this.state.beat + 1 });
			this.mirror(this.live);
			return;
		}
		const ready = this.replayer.docAtNow(step);
		if (ready) {
			this.shown = ready;
			this.set({ ...this.state, position: step, seeking: false, beat: this.state.beat + 1 });
			this.mirror(ready);
			this.prefetchAround(step);
			return;
		}
		this.set({ ...this.state, position: step, seeking: true });
		try {
			const doc = await this.replayer.docAt(step);
			if (token !== this.seekToken || !this.state.open) return;
			this.shown = doc;
			this.set({ ...this.state, position: step, seeking: false, beat: this.state.beat + 1 });
			this.mirror(doc);
			this.prefetchAround(step);
		} catch {
			if (token !== this.seekToken) return;
			this.pause();
			this.set({
				...this.state,
				seeking: false,
				error: "Couldn’t load that part of the board’s history.",
			});
		}
	}

	/** Move by `by` steps among those shown; past the last is now. */
	stepBy(by: number): void {
		const steps = this.state.steps;
		if (steps.length === 0) return;
		const index = this.indexOf(this.state.position);
		const next = Math.max(0, Math.min(steps.length, index + by));
		void this.seekNow(next >= steps.length ? null : steps[next]!.id);
	}

	async play(): Promise<void> {
		if (!this.state.open || this.state.steps.length === 0) return;
		this.set({ ...this.state, playing: true });
		// From now, start again from the beginning.
		if (this.state.position === null) await this.seekNow(this.state.steps[0]!.id);
		if (this.state.playing) this.scheduleNext();
	}

	pause(): void {
		clearTimeout(this.playTimer);
		this.playTimer = undefined;
		if (this.state.playing) this.set({ ...this.state, playing: false });
	}

	toggle(): void {
		if (this.state.playing) this.pause();
		else void this.play();
	}

	setSpeed(speed: Speed): void {
		this.set({ ...this.state, speed });
		if (this.state.playing) this.scheduleNext();
	}

	setSection(section: string | null): void {
		const steps = this.filter(this.state.timeline?.steps ?? [], section);
		this.set({ ...this.state, section, steps });
	}

	/** The step before `step` in the whole timeline (not just the steps shown). */
	previous(step: number): StepMeta | null {
		const all = this.state.timeline?.steps ?? [];
		const index = all.findIndex((s) => s.id === step);
		return index > 0 ? (all[index - 1] ?? null) : null;
	}

	/** Bring back shapes from the board as shown. */
	restore(ids: readonly string[], sizeOf?: SizeOf): Restored | null {
		if (!this.shown) return null;
		const restored = restoreShapes(this.shown, this.live, ids, sizeOf);
		if (restored) this.onRestored?.(restored);
		return restored;
	}

	/**
	 * Bring back what a run of steps removed, as it was just before the first
	 * of them (`removed`: the shapes they removed, from `removedBy`).
	 */
	async bringBack(
		first: number,
		removed: readonly string[],
		sizeOf?: SizeOf,
	): Promise<Restored | null> {
		const before = this.previous(first);
		const gone = removed.filter((id) => !shapesMap(this.live).has(id));
		if (!before || gone.length === 0) return null;
		const doc = await this.replayer.docAt(before.id);
		const restored = restoreShapes(doc, this.live, gone, sizeOf);
		// The replayer's document has moved: put the one being shown back.
		if (this.state.position !== null) await this.seekNow(this.state.position);
		if (restored) this.onRestored?.(restored);
		return restored;
	}

	/** A section's area: as it is now, or as it was at the step shown. */
	sectionArea(section: string): Rect | null {
		for (const doc of [this.live, this.shown]) {
			const shape = doc && shapesMap(doc).get(section);
			if (shape) return boxOf(section, readShape(shape));
		}
		return null;
	}

	/** Sections there are to filter by: on the board now, and at the step shown. */
	sections(): { id: string; title: string }[] {
		const out = new Map<string, string>();
		for (const doc of [this.live, this.shown]) {
			if (!doc) continue;
			for (const [id, shape] of shapesMap(doc)) {
				if (shape.get("type") !== "section" || out.has(id)) continue;
				const title = shape.get("title");
				out.set(id, typeof title === "string" && title.trim() ? title.trim() : "Untitled section");
			}
		}
		return [...out].map(([id, title]) => ({ id, title }));
	}

	private filter(steps: StepMeta[], section: string | null): StepMeta[] {
		if (!section) return steps;
		const area = this.sectionArea(section);
		return steps.filter((step) => !step.origin && touchesSection(step, section, area));
	}

	private indexOf(position: number | null): number {
		return indexOf(this.state.steps, position);
	}

	private scheduleNext(): void {
		clearTimeout(this.playTimer);
		const steps = this.state.steps;
		const index = this.indexOf(this.state.position);
		const current = steps[index];
		const next = steps[index + 1];
		const gap = current && next ? next.at - current.until : STEP_MAX_MS;
		const wait = Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, gap)) / this.state.speed;
		this.playTimer = setTimeout(() => {
			if (!this.state.playing) return;
			if (!next) {
				// Caught up: the live board again.
				this.set({ ...this.state, playing: false });
				void this.seekNow(null);
				return;
			}
			void this.seekNow(next.id).then(() => {
				if (this.state.playing) this.scheduleNext();
			});
		}, wait);
		if (next) this.prefetchAround(next.id);
	}

	private prefetchAround(step: number): void {
		const steps = this.state.steps;
		const index = steps.findIndex((s) => s.id === step);
		const ahead = steps[index + 8];
		if (ahead) this.replayer.prefetch(ahead.id);
	}

	private scheduleMirror(): void {
		if (this.mirrorFrame) return;
		this.mirrorFrame = requestAnimationFrame(() => {
			this.mirrorFrame = 0;
			if (this.state.open && this.state.position === null) this.mirror(this.live);
		});
	}

	private mirror(from: Y.Doc): void {
		if (this.viewDoc) mirrorDoc(from, this.viewDoc);
	}

	private set(state: HistoryState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}
