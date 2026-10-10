// Icons for widgets, drawn on a 16px grid with round strokes like the rest
// of the board's icons. Colour comes from `currentColor`.

function Icon({ size = 16, children }: { size?: number; children: React.ReactNode }) {
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
