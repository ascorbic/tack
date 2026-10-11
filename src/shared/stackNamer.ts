import type * as Y from "yjs";
import type { ProposedStack } from "./stackEdits.ts";
import { GROUP_LIMIT, type GroupNote, groupNotes, readGroups, readName } from "./stackNaming.ts";
import {
	cleanText,
	nameState,
	namingTexts,
	stackHash,
	stackMembers,
	readSuggestion,
	wantsSuggestion,
} from "./stacks.ts";
import { readShape, shapesMap } from "./shapes.ts";
import type { ShapeProps } from "./shapes.ts";

// Naming stacks (#73), written once for the board's Durable Object and the
// playground, as silent mode's hub is. It watches the document, and when a
// stack's visible text changes (and nobody's named it), asks for a name a
// moment later and writes it as the stack's `suggested` name, which never
// touches a name a person gave it (`title`). It also answers "Group these":
// stacks proposed for a selection of stickies, for the person who asked to
// preview before anything's written.
//
// What it sends is only ever text that's in the document: a face-down
// sticky's text is never there before the reveal, and `namingTexts` leaves
// face-down stickies out regardless. Names are cached by a hash of the text
// they came from, so the same stickies never cost a second request. Requests
// are rate limited per board, one at a time, and a request that failed
// isn't tried again for the same text for a while.

/** The transaction origin for suggested names: the server's, never undoable. */
export const STACK_ORIGIN = "stack-name";

/** How long after a stack's text changes before naming it: typing settles first. */
export const NAME_DEBOUNCE_MS = 1500;
/** Requests per board: at most this many a minute, and an hour. "Group these" counts as `GROUP_COST`. */
export const AI_BUDGET = { perMinute: 20, perHour: 240 } as const;
export const GROUP_COST = 4;
/** A failed name isn't asked for again, for the same text, for this long. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** The most a request may take. */
export const AI_TIMEOUT_MS = 20_000;

/** Where names and groupings come from: Workers AI on the server, a fake in the playground and tests. */
export interface StackAi {
	/** A name for a stack from its notes: the model's answer, read with `readName`. */
	name(texts: readonly string[]): Promise<unknown>;
	/** Stacks for some notes, referred to by their short ids: the answer, read with `readGroups`. */
	group(notes: readonly GroupNote[]): Promise<unknown>;
}

/** Names already made, by `stackHash` of the text they were made from. */
export interface NameCache {
	get(hash: string): string | null | undefined;
	set(hash: string, name: string): void;
}

export class MemoryNameCache implements NameCache {
	private names = new Map<string, string>();
	get(hash: string): string | undefined {
		return this.names.get(hash);
	}
	set(hash: string, name: string): void {
		this.names.set(hash, name);
		if (this.names.size > 500) this.names.delete(this.names.keys().next().value as string);
	}
}

type Level = "info" | "warn" | "error";

export interface NamerOptions {
	doc: Y.Doc;
	/** Whether naming is on, and with what: null when it's off (the instance's setting). */
	ai: () => StackAi | null | Promise<StackAi | null>;
	cache?: NameCache;
	log?: (level: Level, event: string, context: Record<string, unknown>) => void;
	now?: () => number;
	debounceMs?: number;
	/** Timers, swappable for tests. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

/** A rolling count of requests, per minute and per hour. */
export class AiBudget {
	private spent: { at: number; cost: number }[] = [];
	constructor(private readonly limits: { perMinute: number; perHour: number } = AI_BUDGET) {}

	/** Spend `cost` if there's room, now. */
	take(now: number, cost = 1): boolean {
		this.spent = this.spent.filter((entry) => now - entry.at < 3_600_000);
		const minute = this.spent
			.filter((entry) => now - entry.at < 60_000)
			.reduce((sum, entry) => sum + entry.cost, 0);
		const hour = this.spent.reduce((sum, entry) => sum + entry.cost, 0);
		if (minute + cost > this.limits.perMinute || hour + cost > this.limits.perHour) return false;
		this.spent.push({ at: now, cost });
		return true;
	}

	/** When there'll next be room for `cost`. */
	nextAt(now: number, cost = 1): number {
		const inMinute = this.spent.filter((entry) => now - entry.at < 60_000);
		const used = inMinute.reduce((sum, entry) => sum + entry.cost, 0);
		if (used + cost <= this.limits.perMinute) {
			const oldest = this.spent[0];
			return oldest ? oldest.at + 3_600_000 : now;
		}
		return (inMinute[0]?.at ?? now) + 60_000;
	}
}

/** On the board's connection: asking for stacks for a selection (editors only). */
export interface StackGroupRequest {
	type: "stack-group";
	/** The client's own id for the request, sent back with the answer. */
	request: string;
	ids: string[];
}

export type StackRequest = StackGroupRequest;

/** On the board's connection, to one client: whether suggestions are on, and answers. */
export type StackMessage =
	| { type: "stacks-ai"; enabled: boolean }
	| { type: "stack-groups"; request: string; stacks: ProposedStack[] }
	| {
			type: "stack-group-failed";
			request: string;
			reason: "off" | "too_few" | "limited" | "failed" | "not_editor";
	  };

export function isStackRequest(value: unknown): value is StackRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<StackGroupRequest>;
	return (
		request.type === "stack-group" &&
		typeof request.request === "string" &&
		request.request.length <= 64 &&
		Array.isArray(request.ids) &&
		request.ids.length <= 500 &&
		request.ids.every((id) => typeof id === "string" && id.length <= 128)
	);
}

export type GroupOutcome =
	| { ok: true; stacks: ProposedStack[]; ms: number }
	| { ok: false; reason: "off" | "too_few" | "limited" | "failed" };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export class StackNamer {
	readonly budget = new AiBudget();
	private readonly cache: NameCache;
	private readonly now: () => number;
	private readonly log: NonNullable<NamerOptions["log"]>;
	private readonly setTimer: NonNullable<NamerOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<NamerOptions["clearTimer"]>;
	private timer: unknown = null;
	private running: Promise<void> | null = null;
	private again = false;
	/** Hashes whose request failed, and when. */
	private failed = new Map<string, number>();
	private observer:
		| ((events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void)
		| null = null;

	constructor(private readonly options: NamerOptions) {
		this.cache = options.cache ?? new MemoryNameCache();
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer =
			options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	/** Watch the document, naming stacks as their text changes. */
	start(): void {
		const shapes = shapesMap(this.options.doc);
		this.observer = (events, transaction) => {
			if (transaction.origin === STACK_ORIGIN) return;
			const relevant = events.some(
				(event) =>
					event.target === shapes ||
					[...event.changes.keys.keys()].some(
						(key) =>
							key === "stack" ||
							key === "text" ||
							key === "silent" ||
							key === "title" ||
							key === "type",
					),
			);
			if (relevant) this.schedule();
		};
		shapes.observeDeep(this.observer);
		this.schedule();
	}

	stop(): void {
		if (this.observer) shapesMap(this.options.doc).unobserveDeep(this.observer);
		this.observer = null;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
	}

	/** Name what needs naming, a moment from now. */
	schedule(ms = this.options.debounceMs ?? NAME_DEBOUNCE_MS): void {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = this.setTimer(() => {
			this.timer = null;
			void this.scan();
		}, ms);
	}

	/** Name every stack that wants a (new) name now. Resolves when they're done. */
	scan(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					await this.nameAll();
				} while (this.again);
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	/** What each stack would be named from now, for the stacks that want a name. */
	private wanted(): { stack: string; texts: string[]; hash: string }[] {
		const doc = this.options.doc;
		const shapes = new Map<string, ShapeProps>();
		for (const [id, shape] of shapesMap(doc)) shapes.set(id, readShape(shape));
		const members = stackMembers(shapes);
		const out: { stack: string; texts: string[]; hash: string }[] = [];
		for (const [id, shape] of shapes) {
			if (shape.type !== "stack") continue;
			const texts = namingTexts(shapes, members.get(id) ?? []);
			const hash = texts.length > 0 ? stackHash(texts) : null;
			if (hash === null) {
				// Nothing left to read (the words went): the old suggestion no longer fits.
				if (nameState(shape) === "suggested") this.write(id, null);
				continue;
			}
			if (wantsSuggestion(shape, hash)) out.push({ stack: id, texts, hash });
		}
		return out;
	}

	private async nameAll(): Promise<void> {
		const wanted = this.wanted();
		if (wanted.length === 0) return;
		let ai: StackAi | null = null;
		for (const { stack, texts, hash } of wanted) {
			const cached = this.cache.get(hash);
			if (cached) {
				this.write(stack, { title: cached, hash });
				this.log("info", "stack.named", { stack, stickies: texts.length, cached: true });
				continue;
			}
			const failedAt = this.failed.get(hash);
			if (failedAt !== undefined && this.now() - failedAt < RETRY_AFTER_MS) continue;
			ai ??= await this.options.ai();
			if (!ai) return;
			if (!this.budget.take(this.now())) {
				this.log("warn", "stack.name.limited", { stack, waiting: wanted.length });
				this.schedule(Math.max(1000, this.budget.nextAt(this.now()) - this.now()));
				return;
			}
			const started = this.now();
			let name: string | null = null;
			try {
				name = readName(await withTimeout(ai.name(texts), AI_TIMEOUT_MS));
			} catch (error) {
				this.failed.set(hash, this.now());
				this.log("warn", "stack.name.failed", { stack, stickies: texts.length, error });
				continue;
			}
			if (!name) {
				this.failed.set(hash, this.now());
				this.log("warn", "stack.name.failed", {
					stack,
					stickies: texts.length,
					reason: "unusable",
				});
				continue;
			}
			this.cache.set(hash, name);
			// Still wanted, for the same text? People may have named it, or moved on.
			const still = this.wanted().find((entry) => entry.stack === stack);
			if (still?.hash !== hash) {
				this.log("info", "stack.name.stale", { stack });
				this.again = true;
				continue;
			}
			this.write(stack, { title: name, hash });
			this.log("info", "stack.named", {
				stack,
				stickies: texts.length,
				cached: false,
				ms: this.now() - started,
			});
		}
	}

	private write(stack: string, suggestion: { title: string; hash: string } | null): void {
		const doc = this.options.doc;
		const shape = shapesMap(doc).get(stack);
		if (!shape || shape.get("type") !== "stack") return;
		const current = readSuggestion(shape.get("suggested"));
		if (suggestion && current?.title === suggestion.title && current.hash === suggestion.hash)
			return;
		doc.transact(() => {
			if (suggestion) shape.set("suggested", suggestion);
			else if (shape.has("suggested")) shape.delete("suggested");
		}, STACK_ORIGIN);
	}

	/**
	 * "Group these": stacks proposed for these stickies, by what they say.
	 * Only stickies with visible text take part (never a face-down one).
	 */
	async group(ids: readonly string[]): Promise<GroupOutcome> {
		const doc = this.options.doc;
		const shapes = shapesMap(doc);
		const items: { id: string; text: string }[] = [];
		for (const id of new Set(ids)) {
			const raw = shapes.get(id);
			if (!raw) continue;
			const shape = readShape(raw);
			if (shape.type !== "sticky" || shape.silent !== undefined) continue;
			const text = cleanText(typeof shape.text === "string" ? shape.text : "");
			if (text) items.push({ id, text });
			if (items.length >= GROUP_LIMIT) break;
		}
		if (items.length < 3) return { ok: false, reason: "too_few" };
		const ai = await this.options.ai();
		if (!ai) return { ok: false, reason: "off" };
		if (!this.budget.take(this.now(), GROUP_COST)) {
			this.log("warn", "stack.group.limited", { stickies: items.length });
			return { ok: false, reason: "limited" };
		}
		const { notes, shapeOf } = groupNotes(items);
		const started = this.now();
		try {
			const stacks = readGroups(await withTimeout(ai.group(notes), AI_TIMEOUT_MS), shapeOf);
			const ms = this.now() - started;
			if (stacks.length === 0) {
				this.log("warn", "stack.group.failed", { stickies: notes.length, reason: "unusable", ms });
				return { ok: false, reason: "failed" };
			}
			this.log("info", "stack.grouped", {
				stickies: notes.length,
				stacks: stacks.length,
				grouped: stacks.reduce((sum, stack) => sum + stack.ids.length, 0),
				ms,
			});
			return { ok: true, stacks, ms };
		} catch (error) {
			this.log("warn", "stack.group.failed", { stickies: notes.length, error });
			return { ok: false, reason: "failed" };
		}
	}
}
