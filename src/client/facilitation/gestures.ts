// Gestures that usually start from the keyboard by your pointer (E for
// emotes, / for cursor chat), asked for from elsewhere: the Facilitate
// menu's buttons. Whoever draws them listens.

export type Gesture = "emotes" | "chat";

type Listener = (at: { x: number; y: number }) => void;

const listeners: Record<Gesture, Set<Listener>> = { emotes: new Set(), chat: new Set() };

/** Open a gesture at a point on the page (the middle of the board, say). */
export function requestGesture(gesture: Gesture, at: { x: number; y: number }): void {
	for (const listener of listeners[gesture]) listener(at);
}

export function onGesture(gesture: Gesture, listener: Listener): () => void {
	listeners[gesture].add(listener);
	return () => listeners[gesture].delete(listener);
}

/** The middle of the canvas, on the page, for gestures asked for from a menu. */
export function canvasMiddle(): { x: number; y: number } {
	const canvas = document.querySelector(".canvas")?.getBoundingClientRect();
	if (!canvas) return { x: innerWidth / 2, y: innerHeight / 2 };
	return { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 };
}
