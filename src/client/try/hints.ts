import type { Fallback } from "./ai.ts";

// When the demo's stand-in AI answered instead of the real one, for the
// quiet word about it (AiHint.tsx). The same reason isn't repeated for a
// couple of minutes, so a run of fallbacks (a rate limit, say) is one hint.

const QUIET_MS = 120_000;

export interface Hint {
	why: Fallback;
	at: number;
}

export class HintStore {
	private current: Hint | null = null;
	private readonly last = new Map<Fallback, number>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly now: () => number = Date.now) {}

	/** The stand-in answered: say so, unless it said the same just now. */
	show = (why: Fallback): void => {
		const now = this.now();
		const before = this.last.get(why);
		if (before !== undefined && now - before < QUIET_MS) return;
		this.last.set(why, now);
		this.current = { why, at: now };
		this.emit();
	};

	hide = (): void => {
		if (!this.current) return;
		this.current = null;
		this.emit();
	};

	getSnapshot = (): Hint | null => this.current;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
