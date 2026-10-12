// The live embeds' director (tack.social's landing page): a clock of its
// own, which only runs while the embed's playing, so a loop paused off
// screen picks up exactly where it was. Every wait and every eased movement
// in a loop goes through it. Stopping it (someone took over the board)
// rejects whatever the loop was waiting for with `Stopped`, which unwinds it.
//
// `instant` plays a loop with no time at all: waits are over at once and
// movements land at their end, for reduced motion, which shows where a loop
// ends without playing it. Waiting for the board itself (`until`) still
// takes real time, as the board answers in its own time.

/** Thrown into a loop when the director's stopped. */
export class Stopped extends Error {
	constructor() {
		super("The director stopped");
		this.name = "Stopped";
	}
}

/** Ease in and out, for movement that starts and settles gently. */
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A frame never moves the clock on by more than this: no jumps after a stall. */
const MAX_STEP_MS = 50;

interface Waiter {
	at: number;
	resolve: () => void;
	reject: (error: Error) => void;
}

export class Director {
	/** The loop's time, in ms: moves only while playing. */
	private time = 0;
	private last: number | null = null;
	private frame = 0;
	private playing = false;
	private stopped = false;
	private waiters = new Set<Waiter>();
	private steps = new Set<(time: number) => void>();
	private listeners = new Set<() => void>();

	constructor(readonly instant = false) {}

	get isPlaying(): boolean {
		return this.playing;
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	now(): number {
		return this.time;
	}

	play(): void {
		if (this.stopped || this.playing) return;
		this.playing = true;
		this.last = null;
		this.frame = requestAnimationFrame(this.tick);
		this.changed();
	}

	pause(): void {
		if (!this.playing) return;
		this.playing = false;
		cancelAnimationFrame(this.frame);
		this.changed();
	}

	/** For good: whatever the loop's waiting for fails with `Stopped`. */
	stop(): void {
		if (this.stopped) return;
		this.pause();
		this.stopped = true;
		const error = new Stopped();
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
		this.steps.clear();
		this.changed();
	}

	/** Hear when it plays, pauses or stops. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	private tick = (now: number) => {
		if (!this.playing) return;
		const step = this.last === null ? 16 : Math.min(MAX_STEP_MS, now - this.last);
		this.last = now;
		this.time += step;
		for (const run of this.steps) run(this.time);
		for (const waiter of this.waiters) {
			if (waiter.at <= this.time) {
				this.waiters.delete(waiter);
				waiter.resolve();
			}
		}
		if (this.playing) this.frame = requestAnimationFrame(this.tick);
	};

	/** Throw if stopped: call between steps that don't wait. */
	check(): void {
		if (this.stopped) throw new Stopped();
	}

	/** Something that happens alongside, not waited for: stopping ends it quietly. */
	also(promise: Promise<unknown>): void {
		promise.catch((error: unknown) => {
			if (!(error instanceof Stopped)) console.error(error);
		});
	}

	/** Wait `ms` of the loop's time. */
	wait(ms: number): Promise<void> {
		if (this.stopped) return Promise.reject(new Stopped());
		if (this.instant || ms <= 0) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.waiters.add({ at: this.time + ms, resolve, reject });
		});
	}

	/** Call `step` each frame with eased progress from 0 to 1 over `ms`. */
	async tween(ms: number, step: (t: number) => void, ease = easeInOut): Promise<void> {
		this.check();
		if (this.instant || ms <= 0) {
			step(1);
			return;
		}
		const start = this.time;
		const run = (time: number) => step(ease(Math.min(1, (time - start) / ms)));
		this.steps.add(run);
		try {
			await this.wait(ms);
		} finally {
			this.steps.delete(run);
		}
		step(1);
	}

	/**
	 * Wait until `ready` says so, checking every frame of real time (the board
	 * answers in its own time). Gives up quietly after `timeout` ms.
	 */
	async until<T>(ready: () => T | null | undefined | false, timeout = 6000): Promise<T | null> {
		let start = performance.now();
		for (;;) {
			this.check();
			const value = ready();
			if (value) return value;
			if (performance.now() - start > timeout) return null;
			await new Promise((resolve) => setTimeout(resolve, 40));
			// Paused meanwhile: wait to play again before looking, and don't count it.
			const paused = performance.now();
			while (!this.playing && !this.stopped && !this.instant) {
				await new Promise((resolve) => setTimeout(resolve, 120));
			}
			start += performance.now() - paused;
		}
	}
}
