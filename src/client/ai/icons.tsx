import type { ReactNode } from "react";

// AI's icons (#64), on the selection actions' 16px grid: a four-pointed
// spark, alone or beside what it makes. Stroke colour follows the text.

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			className="action-icon ai-icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

/** A spark: four curved points. */
export const SPARK =
	"M8 1.8c.4 2.9 1.4 3.9 4.3 4.3-2.9.4-3.9 1.4-4.3 4.3-.4-2.9-1.4-3.9-4.3-4.3 2.9-.4 3.9-1.4 4.3-4.3z";

export function SparkIcon({ size = 16 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d={SPARK} transform="translate(0 1.9)" />
			<path d="M12.6 1.6v2.2M11.5 2.7h2.2" strokeWidth="1.2" />
		</Icon>
	);
}

/** Lines of text with a spark: summarise. */
export function SummariseIcon() {
	return (
		<Icon>
			<path d="M2 4h6M2 7.5h5M2 11h8M2 14.5h5.5" />
			<path d="M12 4.2c.2 1.6.8 2.2 2.4 2.4-1.6.2-2.2.8-2.4 2.4-.2-1.6-.8-2.2-2.4-2.4 1.6-.2 2.2-.8 2.4-2.4z" />
		</Icon>
	);
}

/** A gavel's head with a spark: draft a decision. */
export function DraftDecisionIcon() {
	return (
		<Icon>
			<path d="M7.3 3.4l4.3 4.3M4.8 5.9l4.3 4.3" />
			<path d="M6.6 4.6l3.1 3.1-2.3 2.3-3.1-3.1z" />
			<path d="M6.5 8.9 2 13.4" />
			<path d="M12.9 1.4c.2 1.3.6 1.7 1.9 1.9-1.3.2-1.7.6-1.9 1.9-.2-1.3-.6-1.7-1.9-1.9 1.3-.2 1.7-.6 1.9-1.9z" />
			<path d="M9 14.5h5" />
		</Icon>
	);
}
