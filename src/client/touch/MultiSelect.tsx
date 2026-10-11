/**
 * Selecting several shapes with a finger, on a tablet (#67): how many, that
 * a tap adds one or takes it out, and Done.
 */
export function MultiSelectPill({ count, onDone }: { count: number; onDone: () => void }) {
	return (
		<div className="multi-select" data-chrome role="status">
			<span className="multi-select-count">{count === 1 ? "1 selected" : `${count} selected`}</span>
			<span className="multi-select-hint">Tap to add or take out</span>
			<button type="button" className="multi-select-done" onClick={onDone}>
				Done
			</button>
		</div>
	);
}
