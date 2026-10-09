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

export function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
			null
	);
}
