// Cursor chat: press "/" and type, and your words float by your cursor for
// everyone else, like FigJam's. Messages are ephemeral, carried in
// awareness and never written to the document.

export interface Chat {
	text: string;
	/** Still being typed: shown with a caret. */
	typing: boolean;
}

/** Long enough for a sentence; cursor chat isn't for essays. */
export const CHAT_MAX_LENGTH = 100;

/** How long a sent message stays before it fades. */
export const CHAT_LINGER_MS = 4000;

/** How long an open chat waits for more typing before it closes. */
export const CHAT_IDLE_MS = 9000;

/** How long the fade out takes, before motion scaling. */
export const CHAT_FADE_MS = 320;

interface KeyLike {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}

/**
 * Whether a key press opens cursor chat. `editing` is whether it was typed
 * into a text field or an editing sticky, where "/" is just a character.
 */
export function opensChat(event: KeyLike, editing: boolean): boolean {
	return event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !editing;
}

/** Tidy a message for sending: one line, and not too long. */
export function cleanChat(text: string): string {
	return text.replace(/\s+/g, " ").slice(0, CHAT_MAX_LENGTH);
}
