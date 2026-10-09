// Icons for decisions, drawn on the same 20px (or 16px) grid as the
// toolbar's, with currentColor strokes.

/** A gavel: the decision tool and the kicker on every decision. */
export function GavelPaths() {
	return (
		<>
			<path d="M10.3 2.9l5.3 5.3M7.2 6l5.3 5.3" />
			<path d="M9.4 4.3l3.8 3.8-2.9 2.9-3.8-3.8z" />
			<path d="M9.2 9.6L3.6 15.2" />
			<path d="M10 17.2h7" />
		</>
	);
}

export function GavelIcon({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 20 20"
			aria-hidden="true"
			className="decision-icon"
		>
			<GavelPaths />
		</svg>
	);
}

export function AgreeIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="decision-icon">
			<path d="M3.5 8.5l3 3 6-7" />
		</svg>
	);
}

export function DisagreeIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="decision-icon">
			<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
		</svg>
	);
}

/** A document with a folded corner: an ADR. */
export function RecordIcon({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
			className="decision-icon"
		>
			<path d="M4 1.75h5.25L12.5 5v9.25H4z" />
			<path d="M9 1.75V5.25h3.5M6.25 8.25h4M6.25 10.75h4" />
		</svg>
	);
}

/** Two speech bubbles: a Discussion. */
export function DiscussionIcon({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
			className="decision-icon"
		>
			<path d="M2 3.25h8v5.5H5.5L3 10.75v-2H2z" />
			<path d="M10 6.25h4v5.5h-1v2l-2.5-2H6.5v-1.5" />
		</svg>
	);
}

export function MoreIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="decision-icon">
			<circle cx="3.5" cy="8" r="1.25" className="fill" />
			<circle cx="8" cy="8" r="1.25" className="fill" />
			<circle cx="12.5" cy="8" r="1.25" className="fill" />
		</svg>
	);
}

export function ArrowIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="decision-icon">
			<path d="M3 8h9.5M9 4.5L12.5 8 9 11.5" />
		</svg>
	);
}
