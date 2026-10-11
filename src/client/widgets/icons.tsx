// Icons for widgets, drawn on a 16px grid with round strokes like the rest
// of the board's icons. Colour comes from `currentColor`.

export function Icon({ size = 16, children }: { size?: number; children: React.ReactNode }) {
	return (
		<svg
			className="widget-icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{children}
		</svg>
	);
}

/** A list: three rows with bullets. */
export function ListPaths() {
	return (
		<>
			<circle cx="3.25" cy="4.25" r="1" className="fill" />
			<circle cx="3.25" cy="8" r="1" className="fill" />
			<circle cx="3.25" cy="11.75" r="1" className="fill" />
			<path d="M6.5 4.25h7M6.5 8h7M6.5 11.75h4.5" />
		</>
	);
}

export function ListIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<ListPaths />
		</Icon>
	);
}

/** A widget kind this version doesn't know: a box with a question. */
export function UnknownIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
			<path d="M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11.1v.1" />
		</Icon>
	);
}

export function RefreshIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.75V5h-2.25" />
		</Icon>
	);
}

export function SettingsIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M3 4.5h5.5M11.5 4.5H13M3 11.5h1.5M7.5 11.5H13" />
			<circle cx="10" cy="4.5" r="1.5" />
			<circle cx="6" cy="11.5" r="1.5" />
		</Icon>
	);
}

/** On the board already: a pin. */
export function PinIcon({ size = 12 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M6 2.5h4l-.6 3.4 2.1 2.1v1H4.5V8l2.1-2.1zM8 9v4.5" />
		</Icon>
	);
}

/** Drop to match: a card going into a tray. */
export function DropIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M8 2v6.5M5.25 5.75 8 8.5l2.75-2.75M2.5 9.5v2a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2" />
		</Icon>
	);
}

export function WarnIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M8 2.5 14 13H2zM8 6.75v2.5M8 11.1v.1" />
		</Icon>
	);
}

export function LockIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="3.5" y="7" width="9" height="6.5" rx="1.75" />
			<path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
		</Icon>
	);
}

export function ClockIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<circle cx="8" cy="8" r="5.75" />
			<path d="M8 4.75V8l2.25 1.5" />
		</Icon>
	);
}

export function SearchIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<circle cx="7" cy="7" r="4.25" />
			<path d="m10.25 10.25 3.25 3.25" />
		</Icon>
	);
}

export function CheckIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="m3.5 8.5 3 3 6-7" />
		</Icon>
	);
}

/** Opens on the forge. */
export function ExternalIcon({ size = 12 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v2.75c0 .7-.55 1.25-1.25 1.25h-6.5c-.7 0-1.25-.55-1.25-1.25v-6.5c0-.7.55-1.25 1.25-1.25H6.5" />
		</Icon>
	);
}

/** The review queue: an eye over a branch. */
export function ReviewIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M1.75 8s2.3-4.25 6.25-4.25S14.25 8 14.25 8 11.95 12.25 8 12.25 1.75 8 1.75 8z" />
			<circle cx="8" cy="8" r="1.9" className="fill" />
		</Icon>
	);
}

/** A milestone: a flag. */
export function MilestoneIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M3.75 14V2.25" />
			<path d="M3.75 2.75h8.5L10.5 5.5l1.75 2.75h-8.5" className="soft" />
		</Icon>
	);
}

/** Stale: a crescent moon, gone quiet. */
export function StaleIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M12.75 9.6A5.25 5.25 0 1 1 6.4 3.25a4.1 4.1 0 0 0 6.35 6.35z" />
			<path d="M11 2.25h2.25L11 4.75h2.25" />
		</Icon>
	);
}

/** Close as not planned: a circle, struck through. */
export function NotPlannedIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<circle cx="8" cy="8" r="5.5" />
			<path d="m4.25 11.75 7.5-7.5" />
		</Icon>
	);
}

/** A label: a tag. */
export function TagIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M2.5 3.5v3.6c0 .4.16.78.44 1.06l5 5a1.5 1.5 0 0 0 2.12 0l3.38-3.38a1.5 1.5 0 0 0 0-2.12l-5-5A1.5 1.5 0 0 0 7.38 2.25H3.75c-.69 0-1.25.56-1.25 1.25z" />
			<circle cx="5.5" cy="5.5" r="1" className="fill" />
		</Icon>
	);
}

/** Ping: a speech bubble. */
export function PingIcon({ size = 14 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M3.5 3h9c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H8l-3 2.5V11H3.5C2.67 11 2 10.33 2 9.5v-5C2 3.67 2.67 3 3.5 3z" />
			<path d="M5.5 7h.01M8 7h.01M10.5 7h.01" strokeWidth="2" />
		</Icon>
	);
}

/** Undo a staged change. */
export function UndoIcon({ size = 12 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M5.5 4 2.75 6.75 5.5 9.5" />
			<path d="M3 6.75h6.25a3.75 3.75 0 0 1 0 7.5H7.5" />
		</Icon>
	);
}

/** The step kinds in a drop-to-match preview. */
export function StepIcon({ kind }: { kind: string }) {
	switch (kind) {
		case "add-label":
			return (
				<Icon size={12}>
					<path d="M8 3.5v9M3.5 8h9" />
				</Icon>
			);
		case "remove-label":
		case "unassign":
			return (
				<Icon size={12}>
					<path d="M3.5 8h9" />
				</Icon>
			);
		case "assign":
			return (
				<Icon size={12}>
					<circle cx="8" cy="5.5" r="2.5" />
					<path d="M3.5 13c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5" />
				</Icon>
			);
		case "milestone":
			return (
				<Icon size={12}>
					<path d="M4 13.5V2.5M4 3h7.5L10 5.5 11.5 8H4" />
				</Icon>
			);
		case "close":
			return (
				<Icon size={12}>
					<circle cx="8" cy="8" r="5.5" />
					<path d="m5.75 8 1.6 1.6 2.9-3.2" />
				</Icon>
			);
		default:
			return (
				<Icon size={12}>
					<circle cx="8" cy="8" r="5.5" />
					<circle cx="8" cy="8" r="1.5" className="fill" />
				</Icon>
			);
	}
}

/** A custom widget (#66): code in angle brackets. */
export function CodeIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />
		</Icon>
	);
}

/** Run again: a play triangle. */
export function PlayIcon({ size = 12 }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M5 3.5v9l7-4.5z" />
		</Icon>
	);
}
