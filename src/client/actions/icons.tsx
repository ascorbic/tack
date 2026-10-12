import type { ReactNode } from "react";

// Line icons for the selection actions, drawn on a 16px grid to match the
// rest of the chrome. Stroke colour follows the text.

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

export const IssueIcon = () => (
	<Icon>
		<circle cx="8" cy="8" r="6" />
		<circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
	</Icon>
);

/** A frame drawn in snug around what's in it. */
export const FitIcon = () => (
	<Icon>
		<path d="M1.75 5V2.75a1 1 0 0 1 1-1H5M11 1.75h2.25a1 1 0 0 1 1 1V5M14.25 11v2.25a1 1 0 0 1-1 1H11M5 14.25H2.75a1 1 0 0 1-1-1V11" />
		<rect x="5.25" y="5.25" width="5.5" height="5.5" rx="1" />
	</Icon>
);

export const ParentIcon = () => (
	<Icon>
		<circle cx="4.5" cy="4" r="2" />
		<path d="M4.5 6v6.5a1 1 0 0 0 1 1H9M4.5 8.5H9" />
		<circle cx="11" cy="8.5" r="1.6" />
		<circle cx="11" cy="13.5" r="1.6" />
	</Icon>
);

export const LabelIcon = () => (
	<Icon>
		<path d="M2.5 3.5v4.1a1 1 0 0 0 .3.7l5.4 5.4a1 1 0 0 0 1.4 0l3.9-3.9a1 1 0 0 0 0-1.4L8.1 3a1 1 0 0 0-.7-.3H3.3a.8.8 0 0 0-.8.8z" />
		<circle cx="5.5" cy="5.6" r="1" fill="currentColor" stroke="none" />
	</Icon>
);

export const MilestoneIcon = () => (
	<Icon>
		<path d="M8 1.8v12.4M8 3.2h4.6l1.6 1.9-1.6 1.9H8M8 8.5H3.6L2 10.1l1.6 1.6H8" />
	</Icon>
);

export const PersonIcon = () => (
	<Icon>
		<circle cx="8" cy="5.3" r="2.6" />
		<path d="M2.8 13.6c.7-2.4 2.7-3.8 5.2-3.8s4.5 1.4 5.2 3.8" />
	</Icon>
);

export const CloseIssueIcon = () => (
	<Icon>
		<circle cx="8" cy="8" r="6" />
		<path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
	</Icon>
);

export const NotPlannedIcon = () => (
	<Icon>
		<circle cx="8" cy="8" r="6" />
		<path d="M3.9 12.1l8.2-8.2" />
	</Icon>
);

export const DuplicateIcon = () => (
	<Icon>
		<rect x="5" y="5" width="8.5" height="8.5" rx="1.8" />
		<path d="M11 3.4A1.8 1.8 0 0 0 9.3 2.5H4.3a1.8 1.8 0 0 0-1.8 1.8v5a1.8 1.8 0 0 0 .9 1.6" />
	</Icon>
);

export const ReopenIcon = () => (
	<Icon>
		<path d="M13.4 6.2A5.8 5.8 0 1 0 13.6 9.4" />
		<path d="M13.8 2.8v3.6h-3.6" />
	</Icon>
);

/** A comment (a speech bubble) with a link in it: a backlink to the board. */
export const BacklinkIcon = () => (
	<Icon>
		<path d="M3.2 2.8h9.6c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H7.6L4.6 13.6v-2.2H3.2c-.7 0-1.2-.5-1.2-1.2V4c0-.7.5-1.2 1.2-1.2z" />
		<path d="M7.6 6.2l.5-.5a1.3 1.3 0 0 1 1.8 1.8l-.5.5" />
		<path d="M8.4 8l-.5.5a1.3 1.3 0 0 1-1.8-1.8l.5-.5" />
		<path d="M7.3 7.9l1.4-1.4" />
	</Icon>
);

export const BlockedIcon = () => (
	<Icon>
		<circle cx="8" cy="8" r="6" />
		<path d="M5 8h6" />
	</Icon>
);

export const SwapIcon = () => (
	<Icon>
		<path d="M5 2.5v11M2.5 5 5 2.5 7.5 5M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5" />
	</Icon>
);

export const LockIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<rect x="3" y="7" width="10" height="7" rx="1.6" />
		<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
	</Icon>
);

export const RepoIcon = () => (
	<Icon>
		<path d="M3.5 12.5V3.2a1.2 1.2 0 0 1 1.2-1.2h8v9.2H4.8a1.3 1.3 0 0 0-1.3 1.3 1.3 1.3 0 0 0 1.3 1.3h7.9" />
	</Icon>
);

export const SearchIcon = () => (
	<Icon>
		<circle cx="7" cy="7" r="4.2" />
		<path d="M10.2 10.2l3.3 3.3" />
	</Icon>
);

export const CheckIcon = () => (
	<Icon>
		<path d="M3.5 8.4l2.9 2.9 6.1-6.6" />
	</Icon>
);

export const ArrowDownIcon = () => (
	<Icon>
		<path d="M8 2.5v11M3.8 9.4 8 13.5l4.2-4.1" />
	</Icon>
);

export const PullIcon = () => (
	<Icon>
		<circle cx="4.5" cy="3.5" r="1.6" />
		<circle cx="4.5" cy="12.5" r="1.6" />
		<circle cx="11.5" cy="12.5" r="1.6" />
		<path d="M4.5 5.1v5.8M11.5 10.9V6.4a2 2 0 0 0-2-2H7.4M8.8 2.8 7.2 4.4 8.8 6" />
	</Icon>
);

/** A card with its neighbours around it: Expand related. */
export const RelatedIcon = () => (
	<Icon>
		<rect x="5.5" y="5.75" width="5" height="4.5" rx="1.2" />
		<circle cx="8" cy="2" r="1.2" />
		<circle cx="2" cy="8" r="1.2" />
		<circle cx="14" cy="8" r="1.2" />
		<circle cx="5" cy="14" r="1.2" />
		<circle cx="11" cy="14" r="1.2" />
		<path d="M8 3.2v2.5M3.2 8h2.3M10.5 8h2.3M6.8 10.3 5.6 12.9M9.2 10.3l1.2 2.6" />
	</Icon>
);
