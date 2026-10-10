import { Icon } from "./icons.tsx";

// Icons for the timeline, release draft and dependency map widgets (#43),
// on the same 16px grid with round strokes as the rest.

/** A timeline: a line with markers above it. */
export function TimelineIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M2 12.5h12M4.5 12.5v-2M8.5 12.5V7M11.5 12.5V9.5" />
			<circle cx="4.5" cy="9" r="1.25" className="fill" />
			<circle cx="8.5" cy="5" r="1.5" />
			<circle cx="11.5" cy="8" r="1.25" className="fill" />
		</Icon>
	);
}

/** A release: a tag. */
export function ReleaseIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M2.5 3.5v4.1c0 .4.2.8.4 1.1l4.9 4.9a1.4 1.4 0 0 0 2 0l3.3-3.3a1.4 1.4 0 0 0 0-2L8.2 3.4a1.6 1.6 0 0 0-1.1-.4H3a.5.5 0 0 0-.5.5z" />
			<circle cx="5.5" cy="6" r="1" className="fill" />
		</Icon>
	);
}

/** Dependencies: three nodes, two leading into one. */
export function DependencyIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="1.75" y="2.5" width="4" height="3" rx="1" />
			<rect x="1.75" y="10.5" width="4" height="3" rx="1" />
			<rect x="10.25" y="6.5" width="4" height="3" rx="1" />
			<path d="M5.75 4c2.5 0 2 4 4.5 4M5.75 12c2.5 0 2-4 4.5-4" />
		</Icon>
	);
}

export function CopyIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
			<path d="M10.5 5.5V4.25c0-.97-.78-1.75-1.75-1.75h-4.5c-.97 0-1.75.78-1.75 1.75v4.5c0 .97.78 1.75 1.75 1.75H5.5" />
		</Icon>
	);
}

/** Markdown: the M and arrow. */
export function MarkdownIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="1.5" y="3.5" width="13" height="9" rx="2" />
			<path d="M4 10.25v-4.5l1.75 2 1.75-2v4.5M10.75 5.75v4.25M9.25 8.75l1.5 1.5 1.5-1.5" />
		</Icon>
	);
}

/** Put on the board: cards spreading out. */
export function SpreadIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<rect x="1.75" y="5.5" width="5" height="5" rx="1.25" />
			<path d="M9.5 3.5h4.75M9.5 8h4.75M9.5 12.5h4.75M6.75 8h1" />
		</Icon>
	);
}

/** Back out to the whole range. */
export function ZoomOutIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<circle cx="7" cy="7" r="4.25" />
			<path d="m10.25 10.25 3.25 3.25M5 7h4" />
		</Icon>
	);
}

/** A cycle: arrows chasing each other. */
export function CycleIcon({ size }: { size?: number }) {
	return (
		<Icon size={size}>
			<path d="M12.5 6.5A4.75 4.75 0 0 0 3.6 5.2M3.5 9.5a4.75 4.75 0 0 0 8.9 1.3M3.25 2.75V5.5H6M12.75 13.25V10.5H10" />
		</Icon>
	);
}
