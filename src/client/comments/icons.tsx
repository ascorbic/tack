import type { ReactNode } from "react";

// Line icons for comments, notifications and "since you were here", on the
// same 16px grid as the rest of the chrome. Stroke colour follows the text.

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			className="comment-icon"
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

/** A speech bubble with its tail at the bottom left, like a comment pin. */
export const BubbleIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M2.5 13.5V8a5.5 5.5 0 1 1 5.5 5.5Z" />
	</Icon>
);

export const BellIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3Z" />
		<path d="M6.6 14a1.5 1.5 0 0 0 2.8 0" />
	</Icon>
);

export const CheckIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="m3.5 8.5 3 3 6-7" />
	</Icon>
);

/** Resolve: a tick in a circle. */
export const ResolveIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="8" cy="8" r="5.75" />
		<path d="m5.6 8.2 1.7 1.7 3.2-3.6" />
	</Icon>
);

export const ReopenIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 8a5 5 0 1 0 1.5-3.6" />
		<path d="M3 2.5v2.8h2.8" />
	</Icon>
);

export const CloseIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size}>
		<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
	</Icon>
);

export const EditIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M10.5 3 13 5.5 6 12.5H3.5V10Z" />
	</Icon>
);

export const TrashIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
	</Icon>
);

export const SendIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" />
	</Icon>
);

export const AtIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="8" cy="8" r="2.4" />
		<path d="M10.4 8v1a1.8 1.8 0 0 0 3.6 0V8a6 6 0 1 0-2.4 4.8" />
	</Icon>
);

/** Since you were here: a clock with a little sparkle. */
export const SinceIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M13.4 8.9A5.5 5.5 0 1 1 7.1 2.6" />
		<path d="M8 5v3.2l2 1.3" />
		<path d="M12 1.8v2.8M10.6 3.2h2.8" />
	</Icon>
);

export const ChevronIcon = ({ size, dir = "right" }: { size?: number; dir?: "left" | "right" }) => (
	<Icon size={size}>
		<path d={dir === "right" ? "m6.5 4 4 4-4 4" : "m9.5 4-4 4 4 4"} />
	</Icon>
);

export const EyeIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
		<circle cx="8" cy="8" r="1.9" />
	</Icon>
);

export const PushIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M8 10.5V2.5M5 5.5l3-3 3 3" />
		<path d="M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
	</Icon>
);

export const PencilLineIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9.8 3.2 12.8 6.2 6 13H3v-3Z" />
		<path d="M9 13.5h4.5" />
	</Icon>
);
