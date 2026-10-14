import * as Y from "yjs";
import { voterKey } from "./decisions.ts";
import type { Author } from "./shapes.ts";

// Facilitation (#50): the shared timer, spotlight, stamps, emotes and
// high-fives.
//
// - The timer lives in the document (`facilitation` map, key `timer`), so
//   late joiners see it, but only the board's server writes it, in its own
//   clock (`applyTimer` with `Date.now()` on the server). Clients estimate
//   the server's clock (`clock` messages) and count down against that, so
//   everyone's timer reaches zero together whatever their own clock says.
// - Spotlight is ephemeral and server-held: who's spotlighting, tied to their
//   connection, so it ends when they leave. Editors only.
// - Stamps are in the document, in their own root map (`stamps`), one key per
//   person, shape and stamp, so people's stamps never conflict and a stamp
//   doesn't depend on a nested map someone else may be creating at the same
//   moment. Deleting a shape leaves its stamps behind, unread, so undoing the
//   delete brings them back.
// - Emotes and high-fives are pure awareness: nothing is stored.

/** The transaction origin for the server's facilitation writes (never undoable). */
export const FACILITATION_ORIGIN = "facilitation";

/** A run of the shared timer. Times are the server's, in epoch milliseconds. */
export interface Timer {
	/** Each start is a new run, so clients chime once per run. */
	id: string;
	state: "running" | "paused";
	/** The run's whole length so far, including time added. */
	duration: number;
	/** While running: when it reaches zero. */
	endsAt?: number;
	/** While paused: how much was left. */
	remaining?: number;
	startedAt: number;
	by: Author;
	/** Who started it, as the server knows them (see facilitator.ts): they run it. */
	starter?: string;
	/** What it's timing: "Silent brainstorm". */
	label?: string;
}

export type TimerAction =
	| { action: "start"; ms: number; label?: string }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "add"; ms: number }
	| { action: "stop" };

/** The shortest and longest timers, and how much time one can grow by at once. */
export const TIMER_MIN_MS = 5_000;
export const TIMER_MAX_MS = 4 * 60 * 60_000;
export const TIMER_PRESETS_MS = [60_000, 3 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];
/** How long a finished timer stays up, saying time's up, before it tidies itself away. */
export const TIMER_LINGER_MS = 2 * 60_000;

export function facilitationMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap("facilitation");
}

export function readTimer(doc: Y.Doc): Timer | null {
	return parseTimer(facilitationMap(doc).get("timer"));
}

export function parseTimer(value: unknown): Timer | null {
	if (typeof value !== "object" || value === null) return null;
	const timer = value as Partial<Timer>;
	if (typeof timer.id !== "string" || typeof timer.duration !== "number") return null;
	if (timer.state === "running" && typeof timer.endsAt === "number") return timer as Timer;
	if (timer.state === "paused" && typeof timer.remaining === "number") return timer as Timer;
	return null;
}

/** Milliseconds left at `now` (server time): never negative. */
export function timeLeft(timer: Timer, now: number): number {
	if (timer.state === "paused") return Math.max(0, timer.remaining ?? 0);
	return Math.max(0, (timer.endsAt ?? now) - now);
}

/** Whether the run has reached zero. */
export function timerDone(timer: Timer, now: number): boolean {
	return timer.state === "running" && timeLeft(timer, now) === 0;
}

/** Whether a finished timer has been up long enough to put away. */
export function timerExpired(timer: Timer, now: number): boolean {
	return timerDone(timer, now) && now - (timer.endsAt ?? now) > TIMER_LINGER_MS;
}

const clampMs = (ms: unknown) =>
	typeof ms === "number" && Number.isFinite(ms)
		? Math.min(TIMER_MAX_MS, Math.max(TIMER_MIN_MS, Math.round(ms)))
		: null;

/**
 * Apply a timer command at `now`. The server calls this with its own clock;
 * the playground's pretend server with the browser's. Returns whether
 * anything changed.
 */
export function applyTimer(
	doc: Y.Doc,
	command: TimerAction,
	now: number,
	by: Author,
	origin: unknown = FACILITATION_ORIGIN,
	starter?: string,
): boolean {
	const map = facilitationMap(doc);
	const current = readTimer(doc);
	let next: Timer | null | undefined;
	switch (command.action) {
		case "start": {
			const ms = clampMs(command.ms);
			if (ms === null) return false;
			const label = typeof command.label === "string" ? command.label.trim().slice(0, 60) : "";
			next = {
				id: crypto.randomUUID(),
				state: "running",
				duration: ms,
				endsAt: now + ms,
				startedAt: now,
				by: { name: by.name, color: by.color },
				...(starter ? { starter } : {}),
				...(label ? { label } : {}),
			};
			break;
		}
		case "pause":
			if (!current || current.state !== "running" || timerDone(current, now)) return false;
			next = {
				...withoutTimes(current),
				state: "paused",
				remaining: timeLeft(current, now),
			};
			break;
		case "resume":
			if (!current || current.state !== "paused") return false;
			next = { ...withoutTimes(current), state: "running", endsAt: now + timeLeft(current, now) };
			break;
		case "add": {
			const ms = clampMs(command.ms);
			if (!current || ms === null) return false;
			// Adding to a finished timer starts it counting again from zero.
			const left = timeLeft(current, now);
			const added = Math.min(ms, TIMER_MAX_MS - left);
			if (added <= 0) return false;
			const duration = (timerDone(current, now) ? 0 : current.duration) + added;
			next =
				current.state === "paused"
					? { ...withoutTimes(current), duration, remaining: left + added }
					: {
							...withoutTimes(current),
							duration: Math.max(duration, left + added),
							endsAt: now + left + added,
						};
			break;
		}
		case "stop":
			if (!current) return false;
			next = null;
			break;
		default:
			return false;
	}
	doc.transact(() => {
		if (next) map.set("timer", next);
		else map.delete("timer");
	}, origin);
	return true;
}

function withoutTimes(timer: Timer): Omit<Timer, "endsAt" | "remaining"> {
	const { endsAt: _endsAt, remaining: _remaining, ...rest } = timer;
	return rest;
}

/** "4:05", or "1:02:05" past an hour. */
export function formatClock(ms: number): string {
	const total = Math.ceil(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

// --- Spotlight ------------------------------------------------------------------

/** Someone bringing everyone to their view. */
export interface Spotlight {
	/** Their awareness client id, to follow their view. */
	clientId: number;
	user: Author;
	/** Server time it started. */
	since: number;
}

// --- Messages -------------------------------------------------------------------

/** Facilitation requests from clients, on the board's custom-message channel. */
export type FacilitationRequest =
	| { type: "clock"; t: number }
	| ({ type: "timer"; by: Author } & TimerAction)
	/**
	 * Spotlight yourself (`on`), taking over from whoever's spotlighting if
	 * you may, or stop yours. With `end`, end whoever's it is, if you may.
	 */
	| { type: "spotlight"; on: boolean; clientId?: number; user?: Author; end?: boolean };

/** Why the server turned a facilitation request down. */
export type FacilitationRefusal = "not_editor" | "not_facilitator" | "invalid";

/** Facilitation messages from the board's server. */
export type FacilitationMessage =
	/** The answer to a `clock` ping: `t` is the client's, `now` the server's. */
	| { type: "clock"; t: number; now: number }
	| { type: "spotlight"; spotlight: Spotlight | null }
	/** Who you are to facilitation (see facilitator.ts): on connecting, and when it changes. */
	| { type: "facilitation-you"; author: string; editor: boolean; owner: boolean }
	/** The author keys of everyone on the board, whenever someone comes or goes. */
	| { type: "facilitation-present"; authors: string[] }
	/** Someone changed the timer: who, for "Kai stopped the timer". */
	| { type: "timer-changed"; action: TimerAction["action"]; by: Author; author: string }
	/** A request this connection isn't allowed to make. */
	| { type: "facilitation-refused"; request: string; reason: FacilitationRefusal };

/**
 * The server's clock as seen from here: the offset from the ping with the
 * shortest round trip, which bounds the error best (as NTP does).
 */
export function clockOffset(
	samples: readonly { sent: number; received: number; server: number }[],
): number {
	let best: { rtt: number; offset: number } | null = null;
	for (const { sent, received, server } of samples) {
		const rtt = received - sent;
		if (rtt < 0) continue;
		const offset = server - (sent + rtt / 2);
		if (!best || rtt < best.rtt) best = { rtt, offset };
	}
	return best?.offset ?? 0;
}

// --- Stamps ---------------------------------------------------------------------

/** The stamps on offer, in order. */
export const STAMPS = ["👍", "❤️", "✅", "➕", "🎉", "🔥", "👀", "❓"] as const;
export type StampEmoji = (typeof STAMPS)[number];

export interface Stamp {
	shape: string;
	emoji: StampEmoji;
	name: string;
	color: string;
	login?: string;
	/** When they stamped it, ISO 8601. */
	at: string;
}

export interface Stamper {
	name: string;
	color: string;
	login?: string;
}

export function stampsMap(doc: Y.Doc): Y.Map<Stamp> {
	return doc.getMap("stamps");
}

/** The key for one person's stamp of one kind on one shape. */
export function stampKey(shape: string, emoji: string, stamper: Stamper): string {
	return `${shape}\n${emoji}\n${voterKey(stamper)}`;
}

export function isStamp(value: unknown): value is Stamp {
	if (typeof value !== "object" || value === null) return false;
	const stamp = value as Partial<Stamp>;
	return (
		typeof stamp.shape === "string" &&
		typeof stamp.name === "string" &&
		(STAMPS as readonly string[]).includes(stamp.emoji as string)
	);
}

/**
 * Stamp a shape, or take your stamp off if it's there. Returns whether it's
 * stamped now. Call inside `transactLocal` so it can be undone.
 */
export function toggleStamp(
	doc: Y.Doc,
	shape: string,
	emoji: StampEmoji,
	stamper: Stamper,
	at = new Date().toISOString(),
): boolean {
	const stamps = stampsMap(doc);
	const key = stampKey(shape, emoji, stamper);
	if (stamps.has(key)) {
		stamps.delete(key);
		return false;
	}
	stamps.set(key, {
		shape,
		emoji,
		name: stamper.name,
		color: stamper.color,
		...(stamper.login ? { login: stamper.login } : {}),
		at,
	});
	return true;
}

/** Someone who stamped a shape, for naming them (see reactions.ts). */
export interface StampPerson {
	name: string;
	color: string;
	login?: string;
	/** It's you: named "You", first. */
	you?: boolean;
	/** When they stamped it, ISO 8601. */
	at: string;
}

/** One kind of stamp on a shape: how many, who, and whether you're among them. */
export interface StampCount {
	emoji: StampEmoji;
	count: number;
	/** Who, you first, then in the order they stamped it. */
	people: StampPerson[];
	mine: boolean;
	/** The latest of them, ISO 8601, to tell a new stamp from an old one. */
	latest: string;
}

/** Stamps by shape, counted, in the order of `STAMPS`. */
export function stampCounts(
	stamps: Iterable<[string, unknown]>,
	me: Stamper | null,
): Map<string, StampCount[]> {
	const mine = me ? voterKey(me) : null;
	const byShape = new Map<string, Map<StampEmoji, StampCount>>();
	for (const [key, value] of stamps) {
		if (!isStamp(value)) continue;
		let counts = byShape.get(value.shape);
		if (!counts) byShape.set(value.shape, (counts = new Map()));
		let count = counts.get(value.emoji);
		if (!count) {
			counts.set(
				value.emoji,
				(count = { emoji: value.emoji, count: 0, people: [], mine: false, latest: "" }),
			);
		}
		count.count++;
		const you = mine !== null && key.endsWith(`\n${mine}`);
		count.people.push({
			name: value.name,
			color: value.color,
			...(value.login ? { login: value.login } : {}),
			...(you ? { you } : {}),
			at: typeof value.at === "string" ? value.at : "",
		});
		if (you) count.mine = true;
		if (value.at > count.latest) count.latest = value.at;
	}
	const out = new Map<string, StampCount[]>();
	for (const [shape, counts] of byShape) {
		for (const count of counts.values()) {
			count.people.sort(
				(a, b) => Number(b.you ?? false) - Number(a.you ?? false) || a.at.localeCompare(b.at),
			);
		}
		out.set(
			shape,
			[...counts.values()].sort((a, b) => STAMPS.indexOf(a.emoji) - STAMPS.indexOf(b.emoji)),
		);
	}
	return out;
}

/** Remove stamps of shapes that no longer exist. For tidying, never needed for reading. */
export function staleStamps(doc: Y.Doc, shapes: { has(id: string): boolean }): string[] {
	const stale: string[] = [];
	for (const [key, value] of stampsMap(doc)) {
		if (!isStamp(value) || !shapes.has(value.shape)) stale.push(key);
	}
	return stale;
}

// --- Emotes and high-fives --------------------------------------------------------

/** Emotes float up from your cursor; ✋ is a high-five, held out to meet someone's. */
export const EMOTES = ["👍", "❤️", "😂", "🎉", "👏", "🔥", "🤔", "✋"] as const;
export type EmoteEmoji = (typeof EMOTES)[number];
export const HIGH_FIVE: EmoteEmoji = "✋";

/** One emote, in awareness: `n` counts up so repeats of the same emoji each float. */
export interface Emote {
	n: number;
	emoji: EmoteEmoji;
	/** Where it starts, in board coordinates. */
	x: number;
	y: number;
}

/** A hand held out for a high-five, in awareness, until it meets one or times out. */
export interface HighFive {
	/** When it was held out, by the holder's clock: pairs a meeting once. */
	at: number;
}

/** How long a hand stays up waiting for a high-five. */
export const HIGH_FIVE_MS = 6_000;
/** How close two raised hands must come, in screen pixels at the viewer's zoom. */
export const HIGH_FIVE_REACH = 56;

/**
 * Pairs of people whose raised hands meet: both held out, cursors within
 * `reach` board units. Each pair once, in a stable order, so everyone
 * watching sees the same high-fives.
 */
export function highFives(
	hands: readonly { id: number; at: number; x: number; y: number }[],
	reach: number,
): [number, number][] {
	const sorted = [...hands].sort((a, b) => a.id - b.id);
	const pairs: [number, number][] = [];
	const used = new Set<number>();
	for (let i = 0; i < sorted.length; i++) {
		const a = sorted[i]!;
		if (used.has(a.id)) continue;
		for (let j = i + 1; j < sorted.length; j++) {
			const b = sorted[j]!;
			if (used.has(b.id)) continue;
			if (Math.hypot(a.x - b.x, a.y - b.y) <= reach) {
				pairs.push([a.id, b.id]);
				used.add(a.id);
				used.add(b.id);
				break;
			}
		}
	}
	return pairs;
}
