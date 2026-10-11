import { useEffect, useState, useSyncExternalStore } from "react";

// What a screen reader should hear that isn't anywhere on screen to be read
// (#61): where the keyboard went, a shape moved, other people's changes.
// Toasts already speak for themselves (role=status); this is for the rest.
// One polite and one assertive live region, drawn once by <Announcer />.

type Politeness = "polite" | "assertive";

interface Message {
	text: string;
	politeness: Politeness;
	/** Bumped for every announcement, so saying the same thing twice is heard twice. */
	n: number;
}

class Announcements {
	private current: Message | null = null;
	private listeners = new Set<() => void>();
	private n = 0;

	say(text: string, politeness: Politeness = "polite"): void {
		if (!text) return;
		this.current = { text, politeness, n: ++this.n };
		for (const listener of this.listeners) listener();
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	get = () => this.current;
}

export const announcements = new Announcements();

/** Say something to screen readers, politely unless it can't wait. */
export function announce(text: string, politeness: Politeness = "polite"): void {
	announcements.say(text, politeness);
}

/** How long an announcement stays in its region before it's cleared. */
const CLEAR_MS = 4000;

/**
 * The live regions announcements go into. Text is put in a frame after the
 * region is emptied, so screen readers notice a repeat.
 */
export function Announcer() {
	const message = useSyncExternalStore(announcements.subscribe, announcements.get);
	const [shown, setShown] = useState<{ polite: string; assertive: string }>({
		polite: "",
		assertive: "",
	});
	useEffect(() => {
		if (!message) return;
		setShown((current) => ({ ...current, [message.politeness]: "" }));
		const frame = requestAnimationFrame(() =>
			setShown((current) => ({ ...current, [message.politeness]: message.text })),
		);
		const clear = setTimeout(
			() => setShown((current) => ({ ...current, [message.politeness]: "" })),
			CLEAR_MS,
		);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(clear);
		};
	}, [message]);
	return (
		<div className="visually-hidden" data-announcer>
			<div role="status" aria-live="polite" aria-atomic="true">
				{shown.polite}
			</div>
			<div role="alert" aria-live="assertive" aria-atomic="true">
				{shown.assertive}
			</div>
		</div>
	);
}
