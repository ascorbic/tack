// Rate limits for link cards' fetches: what each person and each board may
// ask the instance to read (or fetch, for images) that isn't cached already.
// Counted in the isolate's memory, as the client error reports are: enough
// to stop a runaway client or a board pasted full of addresses, without a
// binding every instance would need.

/** Fresh reads (not cached) each person and each board may ask for. */
export const UNFURL_LIMITS = {
	person: { minute: 20, hour: 200 },
	board: { minute: 60, hour: 600 },
	/** Images fetched (not cached) for one board. */
	images: { minute: 240, hour: 2400 },
} as const;

/** A sliding count of requests per key over the last minute and hour. */
export class Budget {
	private hits = new Map<string, number[]>();

	constructor(
		private limits: { minute: number; hour: number },
		private now: () => number = Date.now,
	) {}

	/** Spend one for `key`: null if allowed, else when it may ask again (ms since the epoch). */
	take(key: string): number | null {
		const now = this.now();
		const kept = (this.hits.get(key) ?? []).filter((at) => now - at < 3_600_000);
		const lastMinute = kept.filter((at) => now - at < 60_000);
		if (lastMinute.length >= this.limits.minute) return (lastMinute[0] ?? now) + 60_000;
		if (kept.length >= this.limits.hour) return (kept[0] ?? now) + 3_600_000;
		kept.push(now);
		this.hits.set(key, kept);
		if (this.hits.size > 5_000) this.prune(now);
		return null;
	}

	private prune(now: number): void {
		for (const [key, hits] of this.hits) {
			if (!hits.some((at) => now - at < 3_600_000)) this.hits.delete(key);
		}
	}
}
