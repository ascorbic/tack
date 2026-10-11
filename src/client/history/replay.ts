import * as Y from "yjs";
import type { Segment, Timeline } from "../../shared/history.ts";
import type { HistorySource } from "./source.ts";

// Rebuilding the board at any step, from segments of history (a keyframe
// and the steps after it; see src/shared/history.ts). Segments are fetched
// as needed and kept, so scrubbing back and forth over the same stretch
// costs nothing after the first pass, and playing forwards applies one
// step's update at a time to the same document.

export class Replayer {
	/** Each step's update, from every segment loaded. */
	private updates = new Map<number, Uint8Array | null>();
	/** Keyframes loaded, by step. */
	private bases = new Map<number, Uint8Array>();
	/** What each loaded segment covers: from its keyframe to its last step. */
	private spans: { base: number; last: number }[] = [];
	private loading = new Map<number, Promise<Segment>>();
	private generation = -1;
	/** Every step's id, in order. */
	private ids: number[] = [];
	/** Steps where the document was rebuilt (compacted): nothing replays across them. */
	private rebases: number[] = [];
	/** The document as of the last seek, kept to play forwards from, and the keyframe it grew from. */
	private cursor: { doc: Y.Doc; step: number; base: number } | null = null;

	constructor(private readonly source: HistorySource) {}

	/** Use a newer timeline. If earlier history changed (thinned or trimmed), start afresh. */
	setTimeline(timeline: Timeline): void {
		if (timeline.generation !== this.generation) {
			this.generation = timeline.generation;
			this.updates.clear();
			this.bases.clear();
			this.spans = [];
			this.cursor = null;
		}
		this.ids = timeline.steps.map((step) => step.id);
		this.rebases = timeline.steps.filter((step) => step.rebase).map((step) => step.id);
	}

	/** Whether `step` can be shown without fetching anything. */
	ready(step: number): boolean {
		return this.canWalk(step) || this.spanOf(step) !== null;
	}

	/**
	 * The board as it was after `step`. The document returned is reused by
	 * later seeks: read it before seeking again.
	 */
	async docAt(step: number): Promise<Y.Doc> {
		if (this.canWalk(step)) return this.walk(step);
		if (!this.spanOf(step)) await this.load(step);
		return this.rebuild(step);
	}

	/** The same, if it needs nothing fetched; otherwise null. */
	docAtNow(step: number): Y.Doc | null {
		if (this.canWalk(step)) return this.walk(step);
		return this.spanOf(step) ? this.rebuild(step) : null;
	}

	/** Fetch the segment holding `step` ahead of time (e.g. while playing). */
	prefetch(step: number): void {
		if (!this.ready(step)) void this.load(step).catch(() => {});
	}

	/** The loaded segment holding `step` that starts latest (a rebuild's, where two overlap). */
	private spanOf(step: number) {
		let best: { base: number; last: number } | null = null;
		for (const span of this.spans) {
			if (span.base <= step && step <= span.last && (!best || span.base > best.base)) best = span;
		}
		return best;
	}

	/**
	 * Whether every step from the cursor to `step` has its update here, and
	 * the document wasn't rebuilt on the way (updates after a rebuild only
	 * apply to its own keyframe).
	 */
	private canWalk(step: number): boolean {
		const cursor = this.cursor;
		if (!cursor || step < cursor.step) return false;
		if (this.rebases.some((id) => cursor.base < id && id <= step)) return false;
		for (const id of this.ids) {
			if (id <= cursor.step) continue;
			if (id > step) break;
			if (!this.updates.has(id)) return false;
		}
		return true;
	}

	private walk(step: number): Y.Doc {
		const cursor = this.cursor!;
		for (const id of this.ids) {
			if (id <= cursor.step) continue;
			if (id > step) break;
			const update = this.updates.get(id);
			if (update) Y.applyUpdate(cursor.doc, update);
		}
		cursor.step = step;
		return cursor.doc;
	}

	private rebuild(step: number): Y.Doc {
		const span = this.spanOf(step)!;
		const doc = new Y.Doc();
		const base = this.bases.get(span.base);
		if (base) Y.applyUpdate(doc, base);
		this.cursor?.doc.destroy();
		this.cursor = { doc, step: span.base, base: span.base };
		return this.walk(step);
	}

	private async load(step: number): Promise<Segment> {
		let pending = this.loading.get(step);
		if (!pending) {
			pending = this.source.segment(step).finally(() => this.loading.delete(step));
			this.loading.set(step, pending);
		}
		const segment = await pending;
		if (segment.generation !== this.generation) {
			// History changed under us: drop what's cached for the old one.
			this.generation = segment.generation;
			this.updates.clear();
			this.bases.clear();
			this.spans = [];
			this.cursor = null;
		}
		this.bases.set(segment.base.step, segment.base.state);
		for (const { id, update } of segment.steps) this.updates.set(id, update);
		const last = segment.steps.at(-1)?.id ?? segment.base.step;
		this.spans = this.spans.filter((span) => span.base !== segment.base.step);
		this.spans.push({ base: segment.base.step, last });
		return segment;
	}

	destroy(): void {
		this.cursor?.doc.destroy();
		this.cursor = null;
	}
}
