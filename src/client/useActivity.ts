import { useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import { IDLE_AFTER_MS, type Status, activityStatus } from "./activity.ts";

const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

/** How often to check whether the idle threshold has passed. */
const CHECK_MS = 10_000;

/**
 * This person's status: active, idle after a while without input, or away
 * while the tab is hidden. Waking up is immediate; going idle is noticed
 * within a few seconds.
 */
export function useActivityStatus(idleAfter = IDLE_AFTER_MS): Status {
	const [status, setStatus] = useState<Status>(() => (document.hidden ? "away" : "active"));
	const current = useRef(status);
	current.current = status;

	useEffect(() => {
		let lastActive = performance.now();
		const update = () => {
			setStatus(
				activityStatus({ hidden: document.hidden, lastActive, now: performance.now(), idleAfter }),
			);
		};
		const onActivity = () => {
			lastActive = performance.now();
			if (current.current !== "active") update();
		};
		for (const type of ACTIVITY_EVENTS) {
			window.addEventListener(type, onActivity, { capture: true, passive: true });
		}
		document.addEventListener("visibilitychange", update);
		const timer = setInterval(update, CHECK_MS);
		return () => {
			for (const type of ACTIVITY_EVENTS) {
				window.removeEventListener(type, onActivity, { capture: true });
			}
			document.removeEventListener("visibilitychange", update);
			clearInterval(timer);
		};
	}, [idleAfter]);

	return status;
}

/** Publish this person's status to everyone else on the board. */
export function usePublishStatus(awareness: Awareness): void {
	const status = useActivityStatus();
	useEffect(() => {
		awareness.setLocalStateField("status", status);
	}, [awareness, status]);
}
