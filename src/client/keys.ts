/**
 * Whether a key event is going into something the user is typing in, so
 * board shortcuts (tools, cursor chat) should leave it alone.
 */
/**
 * Whether a key or clipboard event belongs to a text field or an open dialog
 * (like the shortcut sheet) rather than the board itself.
 */
export function isOffBoardTarget(target: EventTarget | null): boolean {
	return (
		isEditableTarget(target) ||
		(target instanceof Element && target.closest("[role='dialog'], dialog") !== null)
	);
}

/**
 * Whether a key event is on a shape the keyboard has moved to without
 * selecting it (#61, navigation.ts): its keys move between shapes and
 * select it, so they're not the selection's (nudging, editing, renaming).
 * A shape that just has focus left over from a click (the selection has
 * since moved on, to a duplicate, say) doesn't count.
 */
export function isOnUnselectedShape(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.classList.contains("react-flow__node") &&
		!target.classList.contains("selected") &&
		target.hasAttribute(KEYBOARD_FOCUS)
	);
}

/** Marks the shape the keyboard moved to, until focus leaves it. */
export const KEYBOARD_FOCUS = "data-keyboard-focus";

export function markKeyboardFocus(el: HTMLElement): void {
	el.setAttribute(KEYBOARD_FOCUS, "");
	el.addEventListener("focusout", () => el.removeAttribute(KEYBOARD_FOCUS), { once: true });
}

export function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
			null
	);
}
