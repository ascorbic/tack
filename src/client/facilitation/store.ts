import { useSyncExternalStore } from "react";
import {
	type FacilitationMessage,
	type FacilitationRefusal,
	type FacilitationRequest,
	type Spotlight,
	type TimerAction,
	clockOffset,
} from "../../shared/facilitation.ts";
import { type FacilitationYou, mayControl, mayDelete } from "../../shared/facilitator.ts";
import type { Author } from "../../shared/shapes.ts";
import type { SilentMessage, SilentRefusal, SilentRequest } from "../../shared/silent.ts";

// Facilitation's client side (#50, #49): what the board's server says about
// the clock, spotlight and your own hidden stickies, kept outside the
// document. The live board wires `channel` to its connection; the
// playground swaps in its pretend server (play/facilitation.ts).
//
// Silent stickies' text lives here, never in the document: what you type is
// sent to the server (`silent-text`, throttled), which keeps it for you
// alone, and sends it back when you reconnect or to your other tabs.

export type FacilitationOutgoing = FacilitationRequest | SilentRequest;
export type FacilitationIncoming = FacilitationMessage | SilentMessage;

export interface FacilitationChannel {
	send(request: FacilitationOutgoing): void;
}

/** How often to check the clock again while connected. */
const CLOCK_EVERY_MS = 60_000;
/** Keep this many clock samples, using the best. */
const CLOCK_SAMPLES = 6;
/** Typing in a silent sticky is sent at most this often. */
const TEXT_THROTTLE_MS = 250;
const SECRET_KEY = "tack:silent-secret";

export interface Refusal {
	request: string;
	reason: SilentRefusal | FacilitationRefusal;
	shape?: string;
	at: number;
}

/** Someone else changed the timer, for a toast. */
export interface TimerChange {
	action: TimerAction["action"];
	by: Author;
	at: number;
}

/** Who you are to facilitation, and who's here, as the server says (see facilitator.ts). */
export interface Facilitator {
	you: FacilitationYou | null;
	present: ReadonlySet<string>;
}

class FacilitationStore {
	channel: FacilitationChannel = { send: () => {} };

	private samples: { sent: number; received: number; server: number }[] = [];
	private offset = 0;
	private clockTimer: ReturnType<typeof setInterval> | undefined;

	private spotlightState: Spotlight | null = null;
	private facilitator: Facilitator = { you: null, present: new Set() };
	private timerChange: TimerChange | null = null;

	/** Your own silent stickies' text, by shape. */
	private texts = new Map<string, string>();
	private textsSnapshot: ReadonlyMap<string, string> = new Map();
	/** Silent stickies you made here, before the server has confirmed them. */
	private made = new Set<string>();
	private pending = new Map<string, ReturnType<typeof setTimeout>>();
	private refusal: Refusal | null = null;

	private listeners = new Set<() => void>();

	/** The connection is (re)established: say hello, and check the clock. */
	connected(): void {
		this.channel.send({ type: "silent-hello", secret: guestSecret() });
		this.pingClock();
		clearInterval(this.clockTimer);
		this.clockTimer = setInterval(() => this.pingClock(), CLOCK_EVERY_MS);
		// Anything typed while disconnected goes again.
		for (const id of this.made) {
			const text = this.texts.get(id);
			if (text !== undefined) this.channel.send({ type: "silent-text", shape: id, text });
		}
	}

	disconnected(): void {
		clearInterval(this.clockTimer);
		this.clockTimer = undefined;
	}

	/** Forget what we knew of the clock (the playground winds it forward). */
	resetClock(): void {
		this.samples = [];
	}

	pingClock(): void {
		// A few pings at once give a good sample even on a jittery network.
		for (let i = 0; i < 3; i++) {
			setTimeout(() => this.channel.send({ type: "clock", t: Date.now() }), i * 150);
		}
	}

	apply(message: FacilitationIncoming): void {
		switch (message.type) {
			case "clock": {
				this.samples = [
					...this.samples,
					{ sent: message.t, received: Date.now(), server: message.now },
				].slice(-CLOCK_SAMPLES);
				this.offset = clockOffset(this.samples);
				this.emit();
				return;
			}
			case "spotlight":
				this.spotlightState = message.spotlight;
				this.emit();
				return;
			case "facilitation-you": {
				const { type: _type, ...you } = message;
				this.facilitator = { ...this.facilitator, you };
				this.emit();
				return;
			}
			case "facilitation-present":
				this.facilitator = { ...this.facilitator, present: new Set(message.authors) };
				this.emit();
				return;
			case "timer-changed":
				// Only what someone else did is news.
				if (message.author === this.facilitator.you?.author) return;
				this.timerChange = { action: message.action, by: message.by, at: Date.now() };
				this.emit();
				return;
			case "silent-texts": {
				if (message.replace) {
					// Keep what's still being typed here.
					for (const id of this.texts.keys()) {
						if (!(id in message.texts) && !this.made.has(id)) this.texts.delete(id);
					}
				}
				for (const [id, text] of Object.entries(message.texts)) {
					if (!this.pending.has(id)) this.texts.set(id, text);
					this.made.delete(id);
				}
				this.textsSnapshot = new Map(this.texts);
				this.emit();
				return;
			}
			case "silent-refused":
			case "facilitation-refused":
				this.refusal = {
					request: message.request,
					reason: message.reason,
					...("shape" in message && message.shape ? { shape: message.shape } : {}),
					at: Date.now(),
				};
				this.emit();
				return;
		}
	}

	/** The server's clock, as best we know it (epoch ms). */
	serverNow = (): number => Date.now() + this.offset;

	get clockOffset(): number {
		return this.offset;
	}

	get spotlight(): Spotlight | null {
		return this.spotlightState;
	}

	get lastRefusal(): Refusal | null {
		return this.refusal;
	}

	get you(): Facilitator {
		return this.facilitator;
	}

	get lastTimerChange(): TimerChange | null {
		return this.timerChange;
	}

	/** Whether you may control what `starter` started (see `mayControl`). */
	mayControl(starter: string | null | undefined): boolean {
		return mayControl(this.facilitator.you, starter, this.facilitator.present);
	}

	/** Whether you may delete what `starter` started (see `mayDelete`). */
	mayDelete(starter: string | null | undefined): boolean {
		return mayDelete(this.facilitator.you, starter);
	}

	send(request: FacilitationOutgoing): void {
		this.channel.send(request);
	}

	// --- Silent stickies ---------------------------------------------------------

	/** Whether a silent sticky is yours: the server says so, or you just made it here. */
	isMine(id: string): boolean {
		return this.texts.has(id) || this.made.has(id);
	}

	textOf(id: string): string | undefined {
		return this.texts.get(id);
	}

	get silentTexts(): ReadonlyMap<string, string> {
		return this.textsSnapshot;
	}

	/**
	 * A silent sticky you just made: yours at once, and claimed on the server
	 * straight after the sticky itself reaches it (it may be inside a bigger
	 * transaction, which ends first).
	 */
	claim(id: string, text = ""): void {
		this.made.add(id);
		this.texts.set(id, text);
		this.textsSnapshot = new Map(this.texts);
		this.emit();
		queueMicrotask(() =>
			this.channel.send({ type: "silent-text", shape: id, text: this.texts.get(id) ?? text }),
		);
	}

	/** Type into one of your silent stickies. Shown at once, sent shortly. */
	setText(id: string, text: string): void {
		this.texts.set(id, text);
		this.textsSnapshot = new Map(this.texts);
		this.emit();
		if (this.pending.has(id)) return;
		this.pending.set(
			id,
			setTimeout(() => {
				this.pending.delete(id);
				this.channel.send({ type: "silent-text", shape: id, text: this.texts.get(id) ?? "" });
			}, TEXT_THROTTLE_MS),
		);
	}

	/** Send anything still waiting for the throttle, e.g. when editing stops. */
	flush(id: string): void {
		const timer = this.pending.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.pending.delete(id);
		this.channel.send({ type: "silent-text", shape: id, text: this.texts.get(id) ?? "" });
	}

	/** Forget everything, for the playground and gallery switching boards. */
	reset(): void {
		for (const timer of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
		this.texts.clear();
		this.made.clear();
		this.textsSnapshot = new Map();
		this.spotlightState = null;
		this.facilitator = { you: null, present: new Set() };
		this.timerChange = null;
		this.refusal = null;
		this.samples = [];
		this.offset = 0;
		this.emit();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const facilitation = new FacilitationStore();

/**
 * A guest's secret for silent mode, kept in this browser, so their hidden
 * text finds them again after a reload. Signed-in people don't need it (the
 * server knows them), but sending it does no harm.
 */
function guestSecret(): string | undefined {
	try {
		let secret = localStorage.getItem(SECRET_KEY);
		if (!secret) {
			secret = crypto.randomUUID() + crypto.randomUUID();
			localStorage.setItem(SECRET_KEY, secret);
		}
		return secret;
	} catch {
		return undefined;
	}
}

export function useSpotlight(): Spotlight | null {
	return useSyncExternalStore(facilitation.subscribe, () => facilitation.spotlight);
}

export function useSilentTexts(): ReadonlyMap<string, string> {
	return useSyncExternalStore(facilitation.subscribe, () => facilitation.silentTexts);
}

export function useRefusal(): Refusal | null {
	return useSyncExternalStore(facilitation.subscribe, () => facilitation.lastRefusal);
}

/** Who you are to facilitation and who's here: re-renders when either changes. */
export function useFacilitator(): Facilitator {
	return useSyncExternalStore(facilitation.subscribe, () => facilitation.you);
}

export function useTimerChange(): TimerChange | null {
	return useSyncExternalStore(facilitation.subscribe, () => facilitation.lastTimerChange);
}

export function useClockOffset(): number {
	return useSyncExternalStore(facilitation.subscribe, () => facilitation.clockOffset);
}
