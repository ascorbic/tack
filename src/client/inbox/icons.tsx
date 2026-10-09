import type { ReactNode } from "react";

// Line icons for inbox frames and rules, on the same 16px grid as the rest
// of the chrome. Stroke colour follows the text.

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			className="auto-icon"
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

/** An inbox tray. */
export const TrayIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M2.5 9.5 4.2 3.6a1 1 0 0 1 1-.6h5.6a1 1 0 0 1 1 .6l1.7 5.9" />
		<path d="M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3h-3.2a2.3 2.3 0 0 1-4.6 0Z" />
	</Icon>
);

/** Automation: a rule. */
export const BoltIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 1.8 3.6 9h4l-1 5.2L12.4 7h-4Z" />
	</Icon>
);

export const RefreshIcon = () => (
	<Icon>
		<path d="M13 8a5 5 0 1 1-1.5-3.6" />
		<path d="M13 2.5v2.8h-2.8" />
	</Icon>
);

export const CloseIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size}>
		<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
	</Icon>
);

export const EditIcon = () => (
	<Icon>
		<path d="M10.5 3 13 5.5 6 12.5H3.5V10Z" />
	</Icon>
);

export const CheckIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="m3.5 8.5 3 3 6-7" />
	</Icon>
);

export const ChevronIcon = () => (
	<Icon>
		<path d="m6 4 4 4-4 4" />
	</Icon>
);

export const TrashIcon = () => (
	<Icon>
		<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3" />
	</Icon>
);

export const PlusIcon = () => (
	<Icon>
		<path d="M8 3v10M3 8h10" />
	</Icon>
);

export const UndoDismissIcon = () => (
	<Icon>
		<path d="M5 6.5H10a3 3 0 0 1 0 6H7" />
		<path d="M7 4 4.5 6.5 7 9" />
	</Icon>
);

/** A pull request beside an issue: the "place beside" rule. */
export const BesideIcon = () => (
	<Icon>
		<rect x="1.8" y="4" width="5.4" height="8" rx="1.2" />
		<rect x="8.8" y="4" width="5.4" height="8" rx="1.2" strokeDasharray="2 1.6" />
	</Icon>
);

/** Into a section: the "add to section" rule. */
export const IntoSectionIcon = () => (
	<Icon>
		<rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
		<rect x="4.5" y="6.5" width="4.5" height="4" rx="1" />
		<path d="M11.5 1v3M10 2.5h3" />
	</Icon>
);
