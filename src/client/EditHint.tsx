/**
 * "Press ↵ to edit", under a selected sticky or text block when a key that
 * isn't a shortcut is typed on it (see useEditing): typing on a selected
 * shape never writes into it, so this says what does.
 */
export function EditHint({ show }: { show: boolean }) {
	if (!show) return null;
	return (
		<div className="edit-hint" role="status">
			Press <kbd>↵</kbd> to edit
		</div>
	);
}
