// How much AI one board may use (#64), kept by its `Board` object in memory:
// a board is one object, so every request for it is counted in one place.
// Losing the count when the object sleeps only ever lets a little more
// through, never less.

export interface AiLimits {
	/** Requests on the board in any minute... */
	perMinute: number;
	/** ...and in any hour. */
	perHour: number;
	/** One person's requests on the board in any minute. */
	personPerMinute: number;
}

export const AI_LIMITS: AiLimits = { perMinute: 12, perHour: 120, personPerMinute: 6 };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class AiBudget {
	private board: number[] = [];
	private people = new Map<string, number[]>();

	constructor(
		public limits: AiLimits = { ...AI_LIMITS },
		private now: () => number = () => Date.now(),
	) {}

	/**
	 * Spend one request for `who` (a user id, or a connection's for people
	 * signed out), or say when one may next be made.
	 */
	spend(who: string): { ok: true } | { ok: false; retryAt: number } {
		const now = this.now();
		this.board = this.board.filter((at) => now - at < HOUR);
		const theirs = (this.people.get(who) ?? []).filter((at) => now - at < MINUTE);
		const lastMinute = this.board.filter((at) => now - at < MINUTE);
		const waits: number[] = [];
		if (lastMinute.length >= this.limits.perMinute) {
			waits.push((lastMinute[lastMinute.length - this.limits.perMinute] ?? now) + MINUTE);
		}
		if (this.board.length >= this.limits.perHour) {
			waits.push((this.board[this.board.length - this.limits.perHour] ?? now) + HOUR);
		}
		if (theirs.length >= this.limits.personPerMinute) {
			waits.push((theirs[theirs.length - this.limits.personPerMinute] ?? now) + MINUTE);
		}
		if (waits.length > 0) {
			this.people.set(who, theirs);
			return { ok: false, retryAt: Math.max(...waits) };
		}
		this.board.push(now);
		theirs.push(now);
		this.people.set(who, theirs);
		// Forget people who've gone quiet.
		if (this.people.size > 200) {
			for (const [key, times] of this.people) {
				if (times.every((at) => now - at >= MINUTE)) this.people.delete(key);
			}
		}
		return { ok: true };
	}
}
