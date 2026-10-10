import type { ReactNode } from "react";

// Line icons for action items, on the same 16px grid as the actions'.

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			className="action-icon"
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

/** The toolbar's action item: a ticked box with a line beside it. */
export const ActionItemPaths = () => (
	<>
		<rect x="1.75" y="3.25" width="6.5" height="6.5" rx="2" />
		<path d="m3.4 6.5 1.3 1.3 2.1-2.4" />
		<path d="M10.5 5h4M10.5 8h3M1.75 12.75h12.5" />
	</>
);

export const ActionItemIcon = () => (
	<Icon>
		<ActionItemPaths />
	</Icon>
);

export const CalendarIcon = () => (
	<Icon>
		<rect x="2" y="3" width="12" height="11" rx="2.5" />
		<path d="M2 6.5h12M5.5 1.75v2.5M10.5 1.75v2.5" />
	</Icon>
);

export const OwnerIcon = () => (
	<Icon>
		<circle cx="8" cy="5.5" r="2.75" />
		<path d="M2.75 14c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4" />
	</Icon>
);

export const LinkIcon = () => (
	<Icon>
		<path d="M6.75 9.25a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.75" />
		<path d="M9.25 6.75a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.75-.75" />
	</Icon>
);

export const CarryIcon = () => (
	<Icon>
		<path d="M2.5 4.5h7.25a3.75 3.75 0 0 1 0 7.5H5.5" />
		<path d="m7.5 9.75-2.25 2.25 2.25 2.25" />
	</Icon>
);

export const ExternalIcon = () => (
	<Icon size={12}>
		<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
	</Icon>
);

export const ChevronLeft = () => (
	<Icon>
		<path d="m10 3.5-4.5 4.5 4.5 4.5" />
	</Icon>
);

export const ChevronRight = () => (
	<Icon>
		<path d="m6 3.5 4.5 4.5-4.5 4.5" />
	</Icon>
);
