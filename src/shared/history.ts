import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { Rect } from "./geometry.ts";
import { boxOf } from "./sections.ts";
import { type ShapeProps, readShape, shapesMap } from "./shapes.ts";

// Board history (M4, #47): the board's document kept over time, compact and
// bounded, with who changed what.
//
// The design, like a video codec: keyframes and deltas.
//
// - A **step** is a run of one person's edits (or the server's: a push, a
//   rule, a reveal), flushed with the board's save (every 2–10 s): their
//   updates merged into one Yjs update, and a summary of which shapes it
//   added, edited or removed, where they were, and who did it. Steps are
//   kept in order; each step's update applies on top of the state after the
//   step before it.
// - A **keyframe** is the whole document as it was after some step
//   (`Y.encodeStateAsUpdate`, which is garbage-collected and compact). The
//   first step kept, the **origin**, always has one: it's where history
//   starts. Seeking to a step loads the keyframe at or before it and applies
//   the steps after it, so keyframes are written whenever the deltas since
//   the last one add up to more than the document itself (and at least
//   `keyframeMin`): a seek never applies more than about one document's
//   worth of updates, and keyframes never take more room than the deltas.
// - **Thinning**: recent history is dense; older history is merged into
//   coarser steps: as recorded for the last hour, then 5-minute steps for a
//   day, hourly for a week, daily for three months, weekly after that.
//   Merging replays the steps' updates on the state before them inside one
//   transaction and keeps the update that transaction emits, so content
//   that was added and deleted within the merged span is garbage-collected
//   away (a sticky retyped a hundred times keeps only its last text),
//   rather than `Y.mergeUpdates`, which keeps every deleted string. A
//   merged step keeps every person who took part and the union of what
//   they changed.
// - **Budget**: when updates and keyframes together pass `budget` bytes,
//   the oldest history goes: a later step becomes the origin, with a
//   keyframe of its own, and everything before it is dropped.
//
// Nothing here ever holds more than the document did. Silent mode's hidden
// text is never in the document until the reveal (silent.ts), so it's never
// in history either; summaries name shapes by id and type, never their text.
// Card data isn't in the document, so replays show cards as they are now.
//
// `HistoryLog` is written once, over a `HistoryStore`: the board's Durable
// Object keeps it in SQLite (src/server/history.ts), the playground and the
// tests in memory.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** How dense history is at each age: steps older than `age` are merged into `span`-long steps. */
export const HISTORY_TIERS: readonly { age: number; span: number }[] = [
	{ age: HOUR, span: 5 * MINUTE },
	{ age: DAY, span: HOUR },
	{ age: WEEK, span: DAY },
	{ age: 90 * DAY, span: WEEK },
];

export interface HistoryLimits {
	/** Bytes of updates and keyframes kept, at most (roughly: trimming leaves a quarter spare). */
	budget: number;
	/** Keyframes are at least this many bytes of updates apart. */
	keyframeMin: number;
	/** A step being recorded is flushed once it's this old, even without a save. */
	maxStepMs: number;
	/** How often to thin history out. */
	compactEvery: number;
	/** Changes listed per step; the rest are counted in `more`. */
	maxChanges: number;
}

export const HISTORY_LIMITS: HistoryLimits = {
	budget: 8 * 1024 * 1024,
	keyframeMin: 64 * 1024,
	maxStepMs: 10_000,
	compactEvery: 10 * MINUTE,
	maxChanges: 120,
};

/** Who made a step: a person, by a stable key, or the board's server doing something. */
export interface Actor {
	/** `u:{github id}` for people signed in, `g:{…}` for guests, `sys:{kind}` for the server. */
	key: string;
	name: string;
	color: string;
	login?: string;
	avatarUrl?: string;
	/** The server, on its own account: pushes, rules, silent mode's reveal, the timer, repairs. */
	system?: SystemKind;
}

export type SystemKind =
	| "push"
	| "rule"
	| "reveal"
	| "timer"
	| "repair"
	| "inbox"
	| "naming"
	| "server";

export type ChangeOp = "add" | "edit" | "remove";

/** What a step did to one shape. */
export interface ShapeChange {
	id: string;
	op: ChangeOp;
	type?: string;
	/** For edits: the properties that changed. */
	keys?: string[];
	/** Where the shape was (for removals, just before), with nominal sizes: [x, y, w, h]. */
	box?: [number, number, number, number];
	/** The section it was in. */
	parent?: string | null;
	/** Who, as keys into the step's `actors`, when more than one person made the step. */
	by?: string[];
}

export interface StepMeta {
	id: number;
	/** When its first and last edits were made (ms since the epoch). */
	at: number;
	until: number;
	/** Who made it, in order of their first edit. */
	actors: string[];
	changes: ShapeChange[];
	/** Changes left out of `changes`. */
	more?: number;
	/** Root maps other than shapes it touched: `changes`, `dotVotes`, `stamps`… */
	other?: string[];
	/** Everything its changes touched: [x, y, w, h]. */
	bounds?: [number, number, number, number];
	/** How long a span it's been merged into (0: as recorded). */
	span: number;
	/** Where history starts: its keyframe is the board as it was then. */
	origin?: boolean;
	/**
	 * The document was rebuilt here (compacted, src/shared/compaction.ts):
	 * its keyframe starts a new document, so nothing replays across it and
	 * it's never merged into its neighbours.
	 */
	rebase?: boolean;
	/** Its update's size. */
	bytes: number;
}

/** What the history panel reads: every step, who made them, and how much room it takes. */
export interface Timeline {
	steps: StepMeta[];
	actors: Record<string, Actor>;
	/** Bytes kept (updates and keyframes), and the most there may be. */
	bytes: number;
	budget: number;
	/** Bumped whenever earlier steps change (merged or dropped), so clients drop what they cached. */
	generation: number;
	/** The server's time when this was read. */
	now: number;
}

/**
 * What a seek needs: the keyframe at or before a step, and every step's
 * update from there to the next keyframe (inclusive), so playback can carry
 * on into the next segment without reloading.
 */
export interface Segment {
	generation: number;
	base: { step: number; state: Uint8Array };
	steps: { id: number; update: Uint8Array | null }[];
}

// --- Storage ------------------------------------------------------------------

export interface HistoryStore {
	/** Every step's metadata, oldest first. */
	steps(): StepMeta[];
	/** A step's update (null for an origin, or a step that changed nothing). */
	update(id: number): Uint8Array | null;
	/** Add a step after every other; returns its id. */
	addStep(meta: Omit<StepMeta, "id">, update: Uint8Array | null): number;
	/** Rewrite a step, keeping its id. */
	putStep(meta: StepMeta, update: Uint8Array | null): void;
	removeSteps(ids: readonly number[]): void;
	/** Steps with keyframes, oldest first, and their sizes. */
	keyframes(): { step: number; bytes: number }[];
	keyframe(step: number): Uint8Array | null;
	putKeyframe(step: number, state: Uint8Array): void;
	removeKeyframes(steps: readonly number[]): void;
	actors(): Actor[];
	putActor(actor: Actor): void;
	meta(key: string): string | null;
	putMeta(key: string, value: string): void;
	/** Run writes together. */
	transact(fn: () => void): void;
}

/** A `HistoryStore` in memory, for the playground and unit tests. */
export class MemoryHistoryStore implements HistoryStore {
	private rows = new Map<number, { meta: StepMeta; update: Uint8Array | null }>();
	private frames = new Map<number, Uint8Array>();
	private people = new Map<string, Actor>();
	private values = new Map<string, string>();
	private nextId = 1;

	steps(): StepMeta[] {
		return [...this.rows.values()].map((row) => row.meta).sort((a, b) => a.id - b.id);
	}
	update(id: number): Uint8Array | null {
		return this.rows.get(id)?.update ?? null;
	}
	addStep(meta: Omit<StepMeta, "id">, update: Uint8Array | null): number {
		const id = this.nextId++;
		this.rows.set(id, { meta: { ...meta, id }, update });
		return id;
	}
	putStep(meta: StepMeta, update: Uint8Array | null): void {
		this.rows.set(meta.id, { meta, update });
	}
	removeSteps(ids: readonly number[]): void {
		for (const id of ids) this.rows.delete(id);
	}
	keyframes(): { step: number; bytes: number }[] {
		return [...this.frames]
			.map(([step, state]) => ({ step, bytes: state.byteLength }))
			.sort((a, b) => a.step - b.step);
	}
	keyframe(step: number): Uint8Array | null {
		return this.frames.get(step) ?? null;
	}
	putKeyframe(step: number, state: Uint8Array): void {
		this.frames.set(step, state);
	}
	removeKeyframes(steps: readonly number[]): void {
		for (const step of steps) this.frames.delete(step);
	}
	actors(): Actor[] {
		return [...this.people.values()];
	}
	putActor(actor: Actor): void {
		this.people.set(actor.key, actor);
	}
	meta(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	putMeta(key: string, value: string): void {
		this.values.set(key, value);
	}
	transact(fn: () => void): void {
		fn();
	}

	/** Everything it holds, as plain data, e.g. to keep in the browser (the public demo, #75). */
	dump(): HistoryDump {
		return {
			steps: [...this.rows.values()].map(({ meta, update }) => ({
				meta,
				update: update && toBase64(update),
			})),
			frames: [...this.frames].map(([step, state]) => ({ step, state: toBase64(state) })),
			actors: [...this.people.values()],
			meta: Object.fromEntries(this.values),
		};
	}

	/** A store holding what `dump` gave. */
	static from(dump: HistoryDump): MemoryHistoryStore {
		const store = new MemoryHistoryStore();
		for (const { meta, update } of dump.steps) {
			store.rows.set(meta.id, { meta, update: update === null ? null : fromBase64(update) });
			store.nextId = Math.max(store.nextId, meta.id + 1);
		}
		for (const { step, state } of dump.frames) store.frames.set(step, fromBase64(state));
		for (const actor of dump.actors) store.people.set(actor.key, actor);
		for (const [key, value] of Object.entries(dump.meta)) store.values.set(key, value);
		return store;
	}
}

/** A `MemoryHistoryStore` as plain data, its updates and keyframes in base64. */
export interface HistoryDump {
	steps: { meta: StepMeta; update: string | null }[];
	frames: { step: number; state: string }[];
	actors: Actor[];
	meta: Record<string, string>;
}

// --- Recording ----------------------------------------------------------------

/** Who made a transaction, by its origin. `actor` is remembered for showing their name. */
export interface Attribution {
	key: string;
	actor?: Actor;
}

export interface HistoryLogOptions {
	doc: Y.Doc;
	store: HistoryStore;
	/** Who a transaction's origin is. */
	attribute(origin: unknown): Attribution;
	now?: () => number;
	limits?: Partial<HistoryLimits>;
	log?: (level: "info" | "warn" | "error", event: string, context: Record<string, unknown>) => void;
	/**
	 * Which build of the document this is (src/shared/compaction.ts): a
	 * rebuilt document can't take updates recorded on the old one, so when
	 * it changes, history starts a new stretch with a keyframe (a `rebase`).
	 */
	epoch?: string;
}

interface Pending {
	at: number;
	until: number;
	updates: Uint8Array[];
	changes: Map<string, ShapeChange>;
	other: Set<string>;
}

type Box = [number, number, number, number];

/** What compaction did. */
export interface CompactResult {
	merged: number;
	steps: number;
	keyframes: number;
	trimmed: number;
	bytes: number;
}

export class HistoryLog {
	readonly limits: HistoryLimits;
	private readonly doc: Y.Doc;
	private readonly store: HistoryStore;
	private readonly now: () => number;
	private pending = new Map<string, Pending>();
	/** The last known box, type and section of every shape, for describing removals. */
	private shapes = new Map<string, { type?: string; box?: Box; parent?: string | null }>();
	private known = new Map<string, string>();
	private bytesSinceKeyframe = 0;
	private lastKeyframeBytes = 0;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onUpdate = (
		update: Uint8Array,
		origin: unknown,
		_doc: Y.Doc,
		tr: Y.Transaction,
	) => this.record(update, origin, tr);

	constructor(private readonly options: HistoryLogOptions) {
		this.doc = options.doc;
		this.store = options.store;
		this.now = options.now ?? Date.now;
		this.limits = { ...HISTORY_LIMITS, ...options.limits };
	}

	/**
	 * Start recording. A store without history begins with the document as it
	 * is now (the origin). One whose last recorded state is behind the
	 * document (edits saved without being recorded) catches up in one step.
	 */
	start(): void {
		for (const [id, shape] of shapesMap(this.doc)) this.remember(id, shape);
		for (const actor of this.store.actors()) this.known.set(actor.key, actorFingerprint(actor));
		const steps = this.store.steps();
		const frames = this.store.keyframes();
		const epoch = this.options.epoch ?? "";
		if (steps.length === 0) {
			const state = Y.encodeStateAsUpdate(this.doc);
			const at = this.now();
			this.store.transact(() => {
				const id = this.store.addStep(
					{ at, until: at, actors: [], changes: [], span: 0, origin: true, bytes: 0 },
					null,
				);
				this.store.putKeyframe(id, state);
				this.store.putMeta("sv", toBase64(Y.encodeStateVector(this.doc)));
				if (epoch) this.store.putMeta("epoch", epoch);
			});
			this.lastKeyframeBytes = state.byteLength;
		} else if ((this.store.meta("epoch") ?? "") !== epoch) {
			this.rebase(epoch);
		} else {
			const last = frames.at(-1);
			this.lastKeyframeBytes = last?.bytes ?? 0;
			this.bytesSinceKeyframe = steps
				.filter((step) => !last || step.id > last.step)
				.reduce((n, step) => n + step.bytes, 0);
			this.catchUp();
		}
		this.doc.on("update", this.onUpdate);
	}

	stop(): void {
		this.doc.off("update", this.onUpdate);
		clearTimeout(this.flushTimer);
	}

	/** Whether anything is waiting to be written. */
	get dirty(): boolean {
		return this.pending.size > 0;
	}

	/**
	 * The document was rebuilt (compacted) since history last saw it: a step
	 * with a keyframe of the new document, which replays start from. Edits
	 * saved but not recorded before the rebuild are in it, unattributed.
	 */
	private rebase(epoch: string): void {
		const state = Y.encodeStateAsUpdate(this.doc);
		const at = this.now();
		this.store.transact(() => {
			const id = this.store.addStep(
				{ at, until: at, actors: ["sys:server"], changes: [], span: 0, rebase: true, bytes: 0 },
				null,
			);
			this.store.putKeyframe(id, state);
			this.store.putMeta("sv", toBase64(Y.encodeStateVector(this.doc)));
			this.store.putMeta("epoch", epoch);
			// Clients drop what they'd cached of the old document.
			this.store.putMeta("generation", String(this.generation() + 1));
		});
		this.rememberActor({ key: "sys:server", name: "Tack", color: "", system: "server" });
		this.lastKeyframeBytes = state.byteLength;
		this.bytesSinceKeyframe = 0;
		this.options.log?.("info", "history.rebased", { bytes: state.byteLength });
	}

	private catchUp(): void {
		const saved = this.store.meta("sv");
		if (!saved) return;
		const sv = fromBase64(saved);
		const recorded = Y.decodeStateVector(sv);
		const current = Y.decodeStateVector(Y.encodeStateVector(this.doc));
		// History can only be ahead if the board's last save was lost; then there's nothing to add.
		if (![...current].some(([client, clock]) => clock > (recorded.get(client) ?? 0))) return;
		const missing = Y.encodeStateAsUpdate(this.doc, sv);
		const at = this.now();
		this.store.addStep(
			{
				at,
				until: at,
				actors: ["sys:server"],
				changes: [],
				span: 0,
				bytes: missing.byteLength,
			},
			missing,
		);
		this.rememberActor({ key: "sys:server", name: "Tack", color: "", system: "server" });
		this.store.putMeta("sv", toBase64(Y.encodeStateVector(this.doc)));
		this.bytesSinceKeyframe += missing.byteLength;
		this.options.log?.("info", "history.caught_up", { bytes: missing.byteLength });
	}

	private record(update: Uint8Array, origin: unknown, tr: Y.Transaction): void {
		const { key, actor } = this.options.attribute(origin);
		if (actor) this.rememberActor(actor);
		const at = this.now();
		let pending = this.pending.get(key);
		if (!pending) {
			pending = { at, until: at, updates: [], changes: new Map(), other: new Set() };
			this.pending.set(key, pending);
		}
		pending.until = at;
		pending.updates.push(update);
		this.describe(tr, pending);
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = undefined;
				try {
					this.flush();
				} catch (error) {
					this.options.log?.("error", "history.failed", { error });
				}
			}, this.limits.maxStepMs);
		}
	}

	private rememberActor(actor: Actor): void {
		const fingerprint = actorFingerprint(actor);
		if (this.known.get(actor.key) === fingerprint) return;
		this.known.set(actor.key, fingerprint);
		this.store.putActor(actor);
	}

	/** Note what a transaction did to shapes (and which other maps it touched). */
	private describe(tr: Y.Transaction, pending: Pending): void {
		const shapes = shapesMap(this.doc);
		const shapesType = shapes as unknown as Y.AbstractType<unknown>;
		for (const [type, keys] of tr.changed) {
			if (type === shapesType) {
				for (const id of keys) {
					if (id === null) continue;
					const shape = shapes.get(id);
					const op: ChangeOp = !shape ? "remove" : createdIn(tr, shape) ? "add" : "edit";
					note(pending.changes, id, op, op === "edit" ? ["*"] : [], this.shapes.get(id));
					if (shape) this.remember(id, shape);
					else this.shapes.delete(id);
				}
				continue;
			}
			// A shape's own properties, or something nested in one (a decision's votes).
			let child: Y.AbstractType<unknown> = type as Y.AbstractType<unknown>;
			let key: string | null = null;
			while (child._item && child._item.parent !== shapesType) {
				key = child._item.parentSub;
				child = child._item.parent as Y.AbstractType<unknown>;
			}
			if (child._item?.parent === shapesType) {
				const id = child._item.parentSub;
				if (id === null) continue;
				const shape = shapes.get(id);
				if (!shape || (shape as unknown) !== child) continue;
				const changed =
					child === type ? [...keys].filter((k): k is string => k !== null) : key ? [key] : [];
				note(pending.changes, id, "edit", changed, this.shapes.get(id));
				this.remember(id, shape);
				continue;
			}
			const root = rootName(this.doc, child);
			if (root && root !== "shapes") pending.other.add(root);
		}
		for (const id of pending.changes.keys()) {
			const change = pending.changes.get(id);
			const known = this.shapes.get(id);
			if (change && known && change.op !== "remove") {
				change.type = known.type;
				change.box = known.box;
				change.parent = known.parent;
			}
		}
	}

	private remember(id: string, shape: Y.Map<unknown>): void {
		const props = readShape(shape);
		this.shapes.set(id, { type: props.type, box: boxFor(id, props), parent: props.parent ?? null });
	}

	/**
	 * Write what's been recorded as steps (one per person, in the order they
	 * started), with a keyframe if one's due, and thin history out when it's
	 * time. Call it whenever the board saves.
	 */
	flush(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.pending.size === 0) return;
		const runs = [...this.pending].sort((a, b) => a[1].at - b[1].at);
		this.pending.clear();
		let written = 0;
		this.store.transact(() => {
			let last = 0;
			for (const [key, run] of runs) {
				const update = run.updates.length === 1 ? run.updates[0]! : Y.mergeUpdates(run.updates);
				const changes = [...run.changes.values()];
				const shown = changes.slice(0, this.limits.maxChanges);
				const meta: Omit<StepMeta, "id"> = {
					at: run.at,
					until: run.until,
					actors: [key],
					changes: shown,
					span: 0,
					bytes: update.byteLength,
				};
				if (changes.length > shown.length) meta.more = changes.length - shown.length;
				if (run.other.size > 0) meta.other = [...run.other].sort();
				const bounds = unionBoxes(changes);
				if (bounds) meta.bounds = bounds;
				last = this.store.addStep(meta, update);
				written += update.byteLength;
			}
			this.bytesSinceKeyframe += written;
			if (this.bytesSinceKeyframe >= Math.max(this.limits.keyframeMin, this.lastKeyframeBytes)) {
				const state = Y.encodeStateAsUpdate(this.doc);
				this.store.putKeyframe(last, state);
				this.lastKeyframeBytes = state.byteLength;
				this.bytesSinceKeyframe = 0;
			}
			this.store.putMeta("sv", toBase64(Y.encodeStateVector(this.doc)));
		});
		const compactedAt = Number(this.store.meta("compactedAt") ?? 0);
		if (this.now() - compactedAt >= this.limits.compactEvery) this.compact();
	}

	// --- Reading ---------------------------------------------------------------

	generation(): number {
		return Number(this.store.meta("generation") ?? 0);
	}

	timeline(): Timeline {
		const steps = this.store.steps();
		const actors: Record<string, Actor> = {};
		for (const actor of this.store.actors()) actors[actor.key] = actor;
		return {
			steps,
			actors,
			bytes: this.bytes(steps),
			budget: this.limits.budget,
			generation: this.generation(),
			now: this.now(),
		};
	}

	/** The segment holding `step`: from the keyframe at or before it to the next one. */
	segment(step: number): Segment | null {
		const frames = this.store.keyframes();
		const base = frames.filter((frame) => frame.step <= step).at(-1) ?? frames[0];
		if (!base) return null;
		const next = frames.find((frame) => frame.step > base.step);
		const state = this.store.keyframe(base.step);
		if (!state) return null;
		const steps = this.store
			.steps()
			.filter((meta) => meta.id > base.step && (!next || meta.id <= next.step))
			.map((meta) => ({ id: meta.id, update: this.store.update(meta.id) }));
		return { generation: this.generation(), base: { step: base.step, state }, steps };
	}

	/** The document as it was after `step` (or as early as history goes). */
	docAt(step: number): Y.Doc {
		const frames = this.store.keyframes();
		const base = frames.filter((frame) => frame.step <= step).at(-1) ?? frames[0];
		const doc = new Y.Doc();
		if (!base) return doc;
		const state = this.store.keyframe(base.step);
		if (state) Y.applyUpdate(doc, state);
		for (const meta of this.store.steps()) {
			if (meta.id <= base.step || meta.id > step) continue;
			const update = this.store.update(meta.id);
			if (update) Y.applyUpdate(doc, update);
		}
		return doc;
	}

	private bytes(steps = this.store.steps()): number {
		return (
			steps.reduce((n, step) => n + step.bytes, 0) +
			this.store.keyframes().reduce((n, frame) => n + frame.bytes, 0)
		);
	}

	// --- Thinning ----------------------------------------------------------------

	/**
	 * Merge older steps into coarser ones, drop keyframes that are no longer
	 * needed, and trim the oldest history if it's over budget.
	 */
	compact(now = this.now()): CompactResult {
		const result: CompactResult = { merged: 0, steps: 0, keyframes: 0, trimmed: 0, bytes: 0 };
		this.store.transact(() => {
			result.merged = this.mergeOld(now);
			result.keyframes = this.thinKeyframes();
			result.trimmed = this.trim();
			this.store.putMeta("compactedAt", String(now));
		});
		const steps = this.store.steps();
		result.steps = steps.length;
		result.bytes = this.bytes(steps);
		if (result.merged + result.keyframes + result.trimmed > 0) {
			this.store.putMeta("generation", String(this.generation() + 1));
			this.options.log?.("info", "history.compacted", { ...result });
		}
		// Keyframe bookkeeping for the next flush.
		const last = this.store.keyframes().at(-1);
		this.lastKeyframeBytes = last?.bytes ?? 0;
		this.bytesSinceKeyframe = steps
			.filter((step) => !last || step.id > last.step)
			.reduce((n, step) => n + step.bytes, 0);
		return result;
	}

	private mergeOld(now: number): number {
		const steps = this.store.steps();
		const groups = planMerges(steps, now);
		if (groups.length === 0) return 0;
		const first = groups[0]![0]!;
		let doc = this.docAt(steps[first - 1]!.id);
		const keyframes = new Set(this.store.keyframes().map((frame) => frame.step));
		let merged = 0;
		let g = 0;
		for (let i = first; i < steps.length && g < groups.length; i++) {
			const group = groups[g]!;
			if (group[0] !== i) {
				// A rebuilt document starts again from its own keyframe.
				if (steps[i]!.rebase) {
					doc = this.docAt(steps[i]!.id);
					continue;
				}
				const update = this.store.update(steps[i]!.id);
				if (update) Y.applyUpdate(doc, update);
				continue;
			}
			const metas = group.map((j) => steps[j]!);
			let captured: Uint8Array | null = null;
			const capture = (update: Uint8Array) => {
				captured = update;
			};
			doc.on("update", capture);
			doc.transact(() => {
				for (const meta of metas) {
					const update = this.store.update(meta.id);
					if (update) Y.applyUpdate(doc, update);
				}
			});
			doc.off("update", capture);
			i = group.at(-1)!;
			g++;
			// Updates still waiting on others would be lost from the merged
			// update: leave those steps as they are.
			if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) continue;
			const last = metas.at(-1)!;
			const update = captured as Uint8Array | null;
			const meta = mergeMetas(metas, spanFor(now - last.until), this.limits.maxChanges);
			meta.bytes = update?.byteLength ?? 0;
			this.store.putStep(meta, update);
			const gone = metas.slice(0, -1).map((m) => m.id);
			this.store.removeSteps(gone);
			this.store.removeKeyframes(gone.filter((id) => keyframes.has(id)));
			merged += gone.length;
		}
		return merged;
	}

	/** Keep only the keyframes that save a seek more than a document's worth of updates. */
	private thinKeyframes(): number {
		const frames = this.store.keyframes();
		if (frames.length <= 1) return 0;
		const steps = this.store.steps();
		const origin = steps[0]?.id;
		const byStep = new Map(frames.map((frame) => [frame.step, frame.bytes]));
		const drop: number[] = [];
		let since = 0;
		let lastKept = 0;
		for (const step of steps) {
			if (step.id !== origin) since += step.bytes;
			const bytes = byStep.get(step.id);
			if (bytes === undefined) continue;
			// A rebuild's keyframe is the only way into what came after it.
			if (step.id === origin || step.rebase) {
				lastKept = bytes;
				since = 0;
				continue;
			}
			if (since >= Math.max(this.limits.keyframeMin, lastKept)) {
				lastKept = bytes;
				since = 0;
			} else {
				drop.push(step.id);
			}
		}
		// Keyframes for steps that no longer exist.
		const ids = new Set(steps.map((step) => step.id));
		for (const frame of frames) if (!ids.has(frame.step)) drop.push(frame.step);
		this.store.removeKeyframes(drop);
		return drop.length;
	}

	/** Over budget: start history later, dropping the oldest steps. */
	private trim(): number {
		const steps = this.store.steps();
		const frames = this.store.keyframes();
		const frameBytes = new Map(frames.map((frame) => [frame.step, frame.bytes]));
		const total =
			steps.reduce((n, step) => n + step.bytes, 0) +
			frames.reduce((n, frame) => n + frame.bytes, 0);
		if (total <= this.limits.budget || steps.length < 2) return 0;
		const target = this.limits.budget * 0.75;
		// A new origin's keyframe will be about the size of the latest.
		const keyframe = frames.at(-1)?.bytes ?? 0;
		// What's kept after each step: its successors' updates and keyframes.
		const after = Array.from({ length: steps.length + 1 }, () => 0);
		for (let i = steps.length - 1; i >= 0; i--) {
			after[i] = after[i + 1]! + steps[i]!.bytes + (frameBytes.get(steps[i]!.id) ?? 0);
		}
		// The new origin: the earliest step after which everything fits.
		let j = 1;
		while (j < steps.length - 1 && after[j + 1]! + keyframe > target) j++;
		const origin = steps[j]!;
		const state = Y.encodeStateAsUpdate(this.docAt(origin.id));
		const gone = steps.filter((step) => step.id < origin.id).map((step) => step.id);
		this.store.putKeyframe(origin.id, state);
		this.store.putStep({ ...origin, origin: true, bytes: 0 }, null);
		this.store.removeSteps(gone);
		this.store.removeKeyframes(gone.filter((id) => frameBytes.has(id)));
		this.options.log?.("info", "history.trimmed", { steps: gone.length, from: origin.at });
		return gone.length;
	}
}

/** The span steps of this age are merged into (0: kept as recorded). */
export function spanFor(age: number): number {
	let span = 0;
	for (const tier of HISTORY_TIERS) if (age >= tier.age) span = tier.span;
	return span;
}

/**
 * Which steps to merge: runs of neighbouring steps that fall in the same
 * span-long bucket for their age, at least one of them finer than that.
 * Never the origin. Returns runs of indexes into `steps`.
 */
export function planMerges(steps: readonly StepMeta[], now: number): number[][] {
	const groups: number[][] = [];
	let run: number[] = [];
	let runKey = "";
	const close = () => {
		if (run.length >= 2) groups.push(run);
		run = [];
		runKey = "";
	};
	steps.forEach((step, i) => {
		const span = step.origin || step.rebase ? 0 : spanFor(now - step.until);
		if (span === 0) return close();
		const key = `${span}:${Math.floor(step.at / span)}`;
		if (key !== runKey) {
			close();
			runKey = key;
		}
		run.push(i);
	});
	close();
	// A run whose steps are all as coarse as their age asks has nothing to gain.
	return groups.filter((group) =>
		group.some((i) => steps[i]!.span < spanFor(now - steps[i]!.until)),
	);
}

/** One step from several neighbouring ones: everyone who took part, and everything they changed. */
export function mergeMetas(metas: readonly StepMeta[], span: number, maxChanges: number): StepMeta {
	const last = metas.at(-1)!;
	const actors: string[] = [];
	const changes = new Map<string, ShapeChange>();
	const other = new Set<string>();
	let more = 0;
	for (const meta of metas) {
		for (const actor of meta.actors) if (!actors.includes(actor)) actors.push(actor);
		for (const name of meta.other ?? []) other.add(name);
		more += meta.more ?? 0;
		for (const change of meta.changes) {
			const by = change.by ?? meta.actors;
			const merged = note(changes, change.id, change.op, change.keys ?? [], change, by);
			if (merged) {
				if (change.type) merged.type = change.type;
				if (change.box) merged.box = change.box;
				if (change.parent !== undefined) merged.parent = change.parent;
			}
		}
	}
	const all = [...changes.values()];
	if (actors.length <= 1) for (const change of all) delete change.by;
	const shown = all.slice(0, maxChanges);
	const meta: StepMeta = {
		id: last.id,
		at: Math.min(...metas.map((m) => m.at)),
		until: Math.max(...metas.map((m) => m.until)),
		actors,
		changes: shown,
		span: Math.max(span, ...metas.map((m) => m.span)),
		bytes: 0,
	};
	more += all.length - shown.length;
	if (more > 0) meta.more = more;
	if (other.size > 0) meta.other = [...other].sort();
	const bounds = unionBoxes([
		...all,
		...metas.flatMap((m) => (m.bounds ? [{ box: m.bounds } as ShapeChange] : [])),
	]);
	if (bounds) meta.bounds = bounds;
	return meta;
}

/** Fold one change to a shape into what's known of its changes so far. */
function note(
	changes: Map<string, ShapeChange>,
	id: string,
	op: ChangeOp,
	keys: readonly string[],
	known?: { type?: string; box?: Box; parent?: string | null },
	by?: readonly string[],
): ShapeChange | undefined {
	const existing = changes.get(id);
	if (!existing) {
		const change: ShapeChange = { id, op };
		if (known?.type) change.type = known.type;
		if (known?.box) change.box = known.box;
		if (known?.parent !== undefined) change.parent = known.parent;
		if (op === "edit" && keys.length > 0) change.keys = [...new Set(keys)];
		if (by && by.length > 0) change.by = [...by];
		changes.set(id, change);
		return change;
	}
	if (by) existing.by = [...new Set([...(existing.by ?? []), ...by])];
	if (existing.op === "add" && op === "remove") {
		// Made and removed within the step: as if it never was.
		changes.delete(id);
		return undefined;
	}
	if (existing.op === "remove" && op === "add") {
		existing.op = "edit";
		existing.keys = ["*"];
	} else if (op === "remove") {
		existing.op = "remove";
		delete existing.keys;
	} else if (existing.op === "edit" && op === "edit") {
		existing.keys = [...new Set([...(existing.keys ?? []), ...keys])];
	}
	return existing;
}

function createdIn(tr: Y.Transaction, type: { _item: Y.Item | null }): boolean {
	const item = type._item;
	return item !== null && item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0);
}

function rootName(doc: Y.Doc, type: Y.AbstractType<unknown>): string | null {
	for (const [name, root] of doc.share) if (root === type) return name;
	return null;
}

/** A shape's box, with nominal sizes; a connector's spans its ends. */
function boxFor(id: string, props: ShapeProps): Box | undefined {
	if (props.type === "connector") {
		const ends = [props.from, props.to].filter(
			(end): end is { x: number; y: number } =>
				typeof end?.x === "number" && typeof end?.y === "number",
		);
		if (ends.length === 0) return undefined;
		const xs = ends.map((end) => end.x);
		const ys = ends.map((end) => end.y);
		const x = Math.min(...xs);
		const y = Math.min(...ys);
		return [round(x), round(y), round(Math.max(...xs) - x), round(Math.max(...ys) - y)];
	}
	if (typeof props.x !== "number" || typeof props.y !== "number") return undefined;
	const box = boxOf(id, props);
	return [round(box.x), round(box.y), round(box.w), round(box.h)];
}

const round = (n: number) => Math.round(n);

function unionBoxes(changes: readonly { box?: Box }[]): Box | undefined {
	let out: { x1: number; y1: number; x2: number; y2: number } | null = null;
	for (const { box } of changes) {
		if (!box) continue;
		const [x, y, w, h] = box;
		out = out
			? {
					x1: Math.min(out.x1, x),
					y1: Math.min(out.y1, y),
					x2: Math.max(out.x2, x + w),
					y2: Math.max(out.y2, y + h),
				}
			: { x1: x, y1: y, x2: x + w, y2: y + h };
	}
	return out ? [out.x1, out.y1, out.x2 - out.x1, out.y2 - out.y1] : undefined;
}

function actorFingerprint(actor: Actor): string {
	return JSON.stringify([actor.name, actor.color, actor.login, actor.avatarUrl, actor.system]);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// --- Segments over the wire ------------------------------------------------------

const SEGMENT_VERSION = 1;

/** A segment as bytes, for `GET /api/boards/:id/history/segment`. */
export function encodeSegment(segment: Segment): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, SEGMENT_VERSION);
	encoding.writeVarUint(encoder, segment.generation);
	encoding.writeVarUint(encoder, segment.base.step);
	encoding.writeVarUint8Array(encoder, segment.base.state);
	encoding.writeVarUint(encoder, segment.steps.length);
	for (const step of segment.steps) {
		encoding.writeVarUint(encoder, step.id);
		encoding.writeVarUint8Array(encoder, step.update ?? new Uint8Array());
	}
	return encoding.toUint8Array(encoder);
}

export function decodeSegment(bytes: Uint8Array): Segment {
	const decoder = decoding.createDecoder(bytes);
	const version = decoding.readVarUint(decoder);
	if (version !== SEGMENT_VERSION) throw new Error(`Unknown history segment version ${version}`);
	const generation = decoding.readVarUint(decoder);
	const step = decoding.readVarUint(decoder);
	const state = decoding.readVarUint8Array(decoder);
	const count = decoding.readVarUint(decoder);
	const steps: Segment["steps"] = [];
	for (let i = 0; i < count; i++) {
		const id = decoding.readVarUint(decoder);
		const update = decoding.readVarUint8Array(decoder);
		steps.push({ id, update: update.byteLength > 0 ? update : null });
	}
	return { generation, base: { step, state }, steps };
}

// --- Reading history ---------------------------------------------------------------

/** Whether a step touched a section: the section itself, what's in it, or anything in its area. */
export function touchesSection(step: StepMeta, section: string, area: Rect | null): boolean {
	for (const change of step.changes) {
		if (change.id === section || change.parent === section) return true;
		if (area && change.box && overlaps(change.box, area)) return true;
	}
	// Changes beyond those listed: go by everything the step touched.
	if (step.more && area && step.bounds) return overlaps(step.bounds, area);
	return false;
}

function overlaps([x, y, w, h]: Box, area: Rect): boolean {
	return x < area.x + area.w && x + w > area.x && y < area.y + area.h && y + h > area.y;
}

const NOUNS: Record<string, [string, string]> = {
	card: ["card", "cards"],
	sticky: ["sticky", "stickies"],
	text: ["text", "texts"],
	section: ["section", "sections"],
	connector: ["connector", "connectors"],
	decision: ["decision", "decisions"],
	widget: ["widget", "widgets"],
	action: ["action item", "action items"],
	stack: ["stack", "stacks"],
	link: ["link card", "link cards"],
	image: ["image", "images"],
};

const MOVE_KEYS = new Set(["x", "y", "parent", "z"]);
const SIZE_KEYS = new Set(["w", "h"]);
const TEXT_KEYS = new Set(["text", "title", "label", "alt"]);
const STYLE_KEYS = new Set(["color", "font", "size", "route", "arrow", "dash", "caption"]);
/** An image's file arriving (images.ts). */
const UPLOAD_KEYS = new Set(["image", "upload", "blur"]);

/** What kind of edit a change was, by which properties changed. */
export function editKind(keys: readonly string[] | undefined): string {
	if (!keys || keys.length === 0 || keys.includes("*")) return "changed";
	if (keys.every((key) => UPLOAD_KEYS.has(key))) return "uploaded";
	const kinds = new Set(
		keys.map((key) =>
			MOVE_KEYS.has(key)
				? "moved"
				: SIZE_KEYS.has(key)
					? "resized"
					: TEXT_KEYS.has(key)
						? "edited"
						: STYLE_KEYS.has(key)
							? "restyled"
							: key === "votes"
								? "voted on"
								: key === "from" || key === "to"
									? "reconnected"
									: key === "status"
										? "decided"
										: "changed",
		),
	);
	// Moving into a section changes its parent and position together.
	if (kinds.size === 1) return [...kinds][0]!;
	if (kinds.has("edited")) return "edited";
	if (kinds.has("resized")) return "resized";
	if (kinds.has("moved") && kinds.size === 2 && kinds.has("changed")) return "moved";
	return "changed";
}

const OTHER_WORDS: Record<string, string> = {
	changes: "staged changes",
	dotVotes: "voted",
	stamps: "stamped",
	facilitation: "set the timer",
	rules: "changed rules",
	ruleLog: "",
	// The format's version, moved on by a migration (schema.ts).
	meta: "upgraded the board",
};

const VERB_ORDER = [
	"added",
	"uploaded",
	"removed",
	"edited",
	"moved",
	"resized",
	"restyled",
	"reconnected",
	"decided",
	"voted on",
	"changed",
];

/**
 * A step in words, without who: "added 3 stickies and moved a card". Pass
 * `only` to describe one person's part of a merged step.
 */
export function describeChanges(
	step: Pick<StepMeta, "changes" | "more" | "other">,
	only?: string,
): string {
	const counts = new Map<string, Map<string, number>>();
	for (const change of step.changes) {
		if (only && change.by && !change.by.includes(only)) continue;
		const verb =
			change.op === "add" ? "added" : change.op === "remove" ? "removed" : editKind(change.keys);
		const noun = change.type ?? "shape";
		const byNoun = counts.get(verb) ?? new Map<string, number>();
		byNoun.set(noun, (byNoun.get(noun) ?? 0) + 1);
		counts.set(verb, byNoun);
	}
	const phrases: string[] = [];
	for (const verb of VERB_ORDER) {
		const byNoun = counts.get(verb);
		if (!byNoun) continue;
		const things = [...byNoun]
			.sort((a, b) => b[1] - a[1])
			.map(([noun, n]) => {
				const [one, many] = NOUNS[noun] ?? ["shape", "shapes"];
				return n === 1 ? `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}` : `${n} ${many}`;
			});
		phrases.push(`${verb} ${list(things)}`);
	}
	if (step.more) phrases.push(`${step.more} more change${step.more === 1 ? "" : "s"}`);
	if (phrases.length === 0) {
		const words = (step.other ?? []).map((name) => OTHER_WORDS[name] ?? "").filter(Boolean);
		if (words.length > 0) return list([...new Set(words)]);
		return "made changes";
	}
	return list(phrases);
}

function list(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What the server did on its own, in words that read well after its name. */
const SYSTEM_VERBS: Partial<Record<SystemKind, string>> = {
	reveal: "turned the stickies over",
	timer: "updated the timer",
	repair: "tidied up connectors",
	push: "updated push statuses",
	naming: "suggested names for stacks",
};

/** A step in a sentence, without the name: "added 3 stickies". */
export function whatHappened(step: StepMeta, actors: Record<string, Actor>): string {
	if (step.rebase) return "tidied the board's storage up";
	const system = step.actors.length === 1 ? actors[step.actors[0]!]?.system : undefined;
	// Silent mode's own writes are its start (a section's mark) as well as
	// the reveal: only a step that turned stickies over is the reveal.
	if (system === "reveal" && step.changes.some((change) => change.type === "sticky")) {
		return SYSTEM_VERBS.reveal!;
	}
	const words = describeChanges(step);
	if (words === "made changes" && system && SYSTEM_VERBS[system]) return SYSTEM_VERBS[system]!;
	return words;
}

/** The shapes a step removed, for "Bring back". */
export function removedBy(step: Pick<StepMeta, "changes">): string[] {
	return step.changes.filter((change) => change.op === "remove").map((change) => change.id);
}

/** Steps that read as one entry in a list: the same people, close together. */
export interface StepGroup {
	/** The steps, oldest first. */
	steps: StepMeta[];
	/** All of them as one step (with the last one's id), for describing. */
	merged: StepMeta;
}

/** Root maps a session touches without changing the board: votes, stamps, the timer. */
const SESSION_MAPS = new Set(["dotVotes", "stamps", "facilitation"]);

/** A step that only voted, stamped or set the timer. */
function sessionOnly(step: StepMeta): boolean {
	return (
		step.changes.length === 0 &&
		!step.more &&
		(step.other?.length ?? 0) > 0 &&
		step.other!.every((name) => SESSION_MAPS.has(name))
	);
}

/**
 * Group neighbouring steps by the same people within `gap` of each other.
 * The origin stands alone, and so does every step that removed something:
 * those are what people come looking for, to bring back, and in a group a
 * shape made and removed again would cancel out. Steps that only voted,
 * stamped or set the timer group whoever made them ("Ana, Ben and Kai
 * voted"), so a session doesn't bury the board's edits.
 */
export function groupSteps(steps: readonly StepMeta[], gap = 10 * MINUTE): StepGroup[] {
	const runs: StepMeta[][] = [];
	const removes = (step: StepMeta) => step.changes.some((change) => change.op === "remove");
	for (const step of steps) {
		const run = runs.at(-1);
		const last = run?.at(-1);
		if (
			run &&
			last &&
			!last.origin &&
			!step.origin &&
			!removes(last) &&
			!removes(step) &&
			(step.actors.join() === last.actors.join() || (sessionOnly(step) && sessionOnly(last))) &&
			step.at - last.until <= gap
		) {
			run.push(step);
		} else {
			runs.push([step]);
		}
	}
	return runs.map((run) => ({
		steps: run,
		merged:
			run.length === 1
				? run[0]!
				: mergeMetas(run, Math.max(...run.map((s) => s.span)), Number.POSITIVE_INFINITY),
	}));
}
