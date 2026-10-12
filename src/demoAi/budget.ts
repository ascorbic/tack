import { DurableObject } from "cloudflare:workers";

// The demo AI's daily budget (src/demoAi/handler.ts): one `DemoBudget`
// object for the whole site, counting requests per UTC day, in all and per
// visitor (by a hash of their IP address that changes every day, never the
// address itself). Requests to one object are handled one at a time, so the
// count is exact: past the limit, the demo says it's busy and the page uses
// its stand-in until tomorrow. Days before yesterday are forgotten.

export interface DailyLimits {
	/** Requests a day, from everyone. */
	total: number;
	/** Requests a day from one visitor. */
	visitor: number;
}

export type Spent =
	| { ok: true; used: number }
	| { ok: false; reason: "busy" | "visitor"; used: number };

/** Today in UTC, `YYYY-MM-DD`. */
export function dayOf(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** The start of the next UTC day, ms since the epoch: when a spent budget comes back. */
export function nextDay(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export class DemoBudget extends DurableObject<unknown> {
	private readonly sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS spent (day TEXT NOT NULL, who TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (day, who))",
		);
	}

	/** Spend one of today's requests for `who` (`""` is everyone's), or say why not. */
	spend(day: string, who: string, limits: DailyLimits): Spent {
		const used = (key: string) =>
			this.sql
				.exec<{ used: number }>("SELECT used FROM spent WHERE day = ? AND who = ?", day, key)
				.toArray()[0]?.used ?? 0;
		const total = used("");
		if (total >= limits.total) return { ok: false, reason: "busy", used: total };
		const theirs = used(who);
		if (theirs >= limits.visitor) return { ok: false, reason: "visitor", used: total };
		for (const key of ["", who]) {
			this.sql.exec(
				"INSERT INTO spent (day, who, used) VALUES (?, ?, 1) ON CONFLICT (day, who) DO UPDATE SET used = used + 1",
				day,
				key,
			);
		}
		// Yesterday is kept, for looking at; anything older goes.
		const yesterday = dayOf(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
		this.sql.exec("DELETE FROM spent WHERE day < ?", yesterday);
		return { ok: true, used: total + 1 };
	}
}
