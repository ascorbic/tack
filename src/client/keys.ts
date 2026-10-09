/**
 * Whether a key event is going into something the user is typing in, so
 * board shortcuts (tools, cursor chat) should leave it alone.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
			null
	);
}
