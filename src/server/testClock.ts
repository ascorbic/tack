// A clock integration tests can move forward, to run something that takes
// days (an async retro across time zones, a milestone over weeks) in
// seconds, with every timestamp, visit and window the server keeps going by
// the moved clock. Only with `TACK_TEST_CLOCK=1`, which only the test
// harness sets (never declared in `cloudflare.config.ts`): without it,
// nothing here is ever installed and time is the runtime's own.
//
// Moving it replaces the isolate's `Date` with one running `offset` ahead,
// so `Date.now()` and `new Date()` everywhere agree. Alarms are the one
// thing the runtime keeps in its own clock: `realTime` turns a moved time
// back into the runtime's before it's set, so an alarm a second away still
// fires in a second.

const RealDate = Date;
let offset = 0;

class MovedDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) super(RealDate.now() + offset);
		else super(...(args as [string | number | Date]));
	}

	static override now(): number {
		return RealDate.now() + offset;
	}
}

/** Whether tests may move this Worker's clock. */
export function testClockEnabled(env: unknown): boolean {
	return (env as { TACK_TEST_CLOCK?: string }).TACK_TEST_CLOCK === "1";
}

/** Move the clock to `offsetMs` ahead of the runtime's (never back before it). */
export function setTestClock(offsetMs: number): void {
	offset = Math.max(0, Math.round(offsetMs));
	if (globalThis.Date !== MovedDate) globalThis.Date = MovedDate as DateConstructor;
}

/** A time in the (possibly moved) clock, in the runtime's own: for alarms. */
export function realTime(at: number): number {
	return at - offset;
}
