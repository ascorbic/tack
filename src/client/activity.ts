// Whether someone is here right now. Each person works out their own status
// and publishes it, because only their browser knows when they last moved
// or whether the tab is hidden.

export type Status = "active" | "idle" | "away";

/** No pointer or keyboard activity for this long means idle. */
export const IDLE_AFTER_MS = 3 * 60_000;

export function activityStatus({
	hidden,
	lastActive,
	now,
	idleAfter = IDLE_AFTER_MS,
}: {
	/** The tab is in the background. */
	hidden: boolean;
	/** When the person last moved, clicked, scrolled or typed. */
	lastActive: number;
	now: number;
	idleAfter?: number;
}): Status {
	if (hidden) return "away";
	return now - lastActive >= idleAfter ? "idle" : "active";
}

/** How the people bar describes a status, if at all. */
export function statusLabel(status: Status | undefined): string | null {
	if (status === "idle") return "Idle";
	if (status === "away") return "Away";
	return null;
}
