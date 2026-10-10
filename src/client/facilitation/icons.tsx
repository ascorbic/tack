import type { ReactNode } from "react";

// Line icons for facilitation, on the chrome's 16px grid. Stroke colour
// follows the text.

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			className="facilitate-icon"
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

/** Facilitation: a conductor's baton with a sparkle. */
export const BatonIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 13 9.5 6.5" />
		<circle cx="3.2" cy="12.8" r="1.2" />
		<path d="M11.5 1.8v2.4M10.3 3h2.4M13.4 6.4v1.8M12.5 7.3h1.8M8.2 2.6v1.2M7.6 3.2h1.2" />
	</Icon>
);

/** The timer: a stopwatch. */
export const StopwatchIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="8" cy="9" r="5" />
		<path d="M8 9V6.5M6.5 1.8h3M12 4.6l.9-.9" />
	</Icon>
);

/** Silent mode: a finger to the lips. */
export const HushIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 9.2c1.6 1.8 3.3 2.6 5 2.6s3.4-.8 5-2.6" />
		<path d="M5.4 9.6c.9.5 1.7.7 2.6.7s1.7-.2 2.6-.7" />
		<path d="M8 2.2v6.4" />
	</Icon>
);

/** Turning stickies over. */
export const FlipIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<rect x="2.5" y="4.5" width="6" height="8" rx="1" />
		<path d="M10.5 4.5h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2" strokeDasharray="1.6 1.6" />
		<path d="M6 2.2c2.4-.8 4.8-.3 6.6 1.6M12.6 1.8v2h-2" />
	</Icon>
);

/** Dot voting: three dots in a ballot. */
export const DotsIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="4.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
		<circle cx="8" cy="5" r="1.6" fill="currentColor" stroke="none" />
		<circle cx="11.5" cy="9" r="1.6" fill="currentColor" stroke="none" />
		<path d="M2 12.8h12" />
	</Icon>
);

/** Results: bars of different lengths. */
export const TallyIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 3.5h10M3 8h6.5M3 12.5h3.5" />
	</Icon>
);

/** A stamp. */
export const StampIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M6.3 8.5V6.6a2.5 2.5 0 1 1 3.4 0v1.9" />
		<path d="M3 8.5h10v2.5H3zM4.5 13.5h7" />
	</Icon>
);

export const CloseIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M4 4l8 8M12 4l-8 8" />
	</Icon>
);
