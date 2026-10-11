import type { Operation, OperationKind } from "../../shared/changes.ts";

// Line icons for pending changes, on a 16px grid in `currentColor`.

function Svg({
	size = 16,
	children,
	className,
}: {
	size?: number;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<svg
			className={className ? `icon ${className}` : "icon"}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

const KIND_PATHS: Record<OperationKind, React.ReactNode> = {
	"issue.create": (
		<>
			<circle cx="7.5" cy="8.5" r="5.25" />
			<circle cx="7.5" cy="8.5" r="1.3" className="fill" />
			<path d="M13 1.5v3.5M11.25 3.25h3.5" />
		</>
	),
	"pr.create": (
		<>
			<circle cx="4.5" cy="3.75" r="1.6" />
			<circle cx="4.5" cy="12.25" r="1.6" />
			<circle cx="11.5" cy="12.25" r="1.6" />
			<path d="M4.5 5.35v5.3M11.5 10.65V6.5a2 2 0 0 0-2-2H7.25M8.75 3l-1.5 1.5 1.5 1.5" />
		</>
	),
	"discussion.create": (
		<>
			<path d="M2.25 3.75a1.5 1.5 0 0 1 1.5-1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H5.5L3 10.5V8.6a1.5 1.5 0 0 1-.75-1.3z" />
			<path d="M12.5 6.25h.25a1.25 1.25 0 0 1 1.25 1.25v3a1.25 1.25 0 0 1-.75 1.15v1.6l-2-1.5H8.5a1.25 1.25 0 0 1-1.2-.9" />
		</>
	),
	"item.comment": (
		<path d="M2.5 4a1.75 1.75 0 0 1 1.75-1.75h7.5A1.75 1.75 0 0 1 13.5 4v5a1.75 1.75 0 0 1-1.75 1.75H7.25L4.25 13.5v-2.75A1.75 1.75 0 0 1 2.5 9z" />
	),
	"item.state": (
		<>
			<circle cx="8" cy="8" r="5.75" />
			<path d="M5.6 8.1l1.7 1.7 3.1-3.5" />
		</>
	),
	"item.labels": (
		<>
			<path d="M2.25 3.25v4.1c0 .4.16.78.44 1.06l5.1 5.1a1.25 1.25 0 0 0 1.77 0l4.1-4.1a1.25 1.25 0 0 0 0-1.77l-5.1-5.1a1.5 1.5 0 0 0-1.06-.44h-4.1a1.15 1.15 0 0 0-1.15 1.15z" />
			<circle cx="5.25" cy="5.25" r="1.1" className="fill" />
		</>
	),
	"item.assignees": (
		<>
			<circle cx="8" cy="5.5" r="2.6" />
			<path d="M3 13.75c.5-2.6 2.5-4.1 5-4.1s4.5 1.5 5 4.1" />
		</>
	),
	"item.milestone": (
		<>
			<path d="M8 1.75v12.5" />
			<path d="M3.5 4h7.6l1.9 2-1.9 2H3.5z" />
		</>
	),
	"item.subIssue": (
		<>
			<circle cx="4" cy="3.75" r="1.75" />
			<path d="M4 5.5v5a1.5 1.5 0 0 0 1.5 1.5h3" />
			<circle cx="11.5" cy="12" r="2.25" />
			<path d="M4 8h4.5" />
		</>
	),
	"item.blockedBy": (
		<>
			<circle cx="8" cy="8" r="5.75" />
			<path d="M3.95 12.05l8.1-8.1" />
		</>
	),
};

export function KindIcon({ op, size }: { op: Operation; size?: number }) {
	if (op.kind === "item.state" && op.state === "open") {
		return (
			<Svg size={size}>
				<path d="M13.25 8a5.25 5.25 0 1 1-1.55-3.72" />
				<path d="M12.25 1.75v3h-3" />
				<circle cx="8" cy="8" r="1.3" className="fill" />
			</Svg>
		);
	}
	if (op.kind === "item.state" && op.reason === "not_planned") {
		return (
			<Svg size={size}>
				<circle cx="8" cy="8" r="5.75" />
				<path d="M5.25 10.75l5.5-5.5" />
			</Svg>
		);
	}
	return <Svg size={size}>{KIND_PATHS[op.kind]}</Svg>;
}

/** Changes waiting to go out: a tray with something dropping into it. */
export function OutboxIcon({ size = 16 }: { size?: number }) {
	return (
		<Svg size={size} className="outbox-icon">
			<path d="M2 9.25h3.1l.9 1.75h4l.9-1.75H14" />
			<path d="M2 9.25l1.5-5.1A1.25 1.25 0 0 1 4.7 3.25h6.6a1.25 1.25 0 0 1 1.2.9L14 9.25v3.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
			<path className="outbox-arrow" d="M8 1v5.25M6 4.25l2 2 2-2" />
		</Svg>
	);
}

export function CloseIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M4 4l8 8M12 4l-8 8" />
		</Svg>
	);
}

export function RetryIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M2.75 8a5.25 5.25 0 0 0 9.6 2.95M13.25 8a5.25 5.25 0 0 0-9.6-2.95" />
			<path d="M3.5 2.25v2.9h2.9M12.5 13.75v-2.9H9.6" />
		</Svg>
	);
}

/** A sub-issue moving from one parent to another: a branch that jumps across. */
export function MoveIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<circle cx="3.75" cy="3.5" r="1.6" />
			<circle cx="12.25" cy="3.5" r="1.6" />
			<path d="M3.75 5.1v1.4a2 2 0 0 0 2 2h1" strokeDasharray="1.6 1.6" />
			<path d="M12.25 5.1v4.65a2 2 0 0 1-2 2H7.5" />
			<path d="M9 10l-1.75 1.75L9 13.5" />
		</Svg>
	);
}

export function ExternalIcon({ size = 12 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M6.5 3.25H4a1.25 1.25 0 0 0-1.25 1.25V12A1.25 1.25 0 0 0 4 13.25h7.5A1.25 1.25 0 0 0 12.75 12V9.5" />
			<path d="M9.25 2.75h4v4M13.25 2.75L7.5 8.5" />
		</Svg>
	);
}

export function CheckIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M3.5 8.4l3 3 6-6.6" />
		</Svg>
	);
}

export function BellIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M4 11.25V7.5a4 4 0 0 1 8 0v3.75l1.25 1.25H2.75z" />
			<path d="M6.5 14a1.6 1.6 0 0 0 3 0" />
		</Svg>
	);
}

export function QuietIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M4 11.25V7.5a4 4 0 0 1 6.9-2.75M12 7.25v4l1.25 1.25H5" />
			<path d="M6.5 14a1.6 1.6 0 0 0 3 0M2.25 2.25l11.5 11.5" />
		</Svg>
	);
}

export function HistoryIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M2.75 8a5.25 5.25 0 1 0 1.55-3.72" />
			<path d="M2.25 2.5v2.75H5M8 5v3.25l2.25 1.5" />
		</Svg>
	);
}

export function BotIcon({ size = 16 }: { size?: number }) {
	return (
		<Svg size={size}>
			<rect x="2.75" y="5" width="10.5" height="8" rx="2.25" />
			<path d="M8 5V2.75" />
			<circle cx="8" cy="2.25" r=".75" className="fill" />
			<circle cx="6" cy="9" r="1" className="fill" />
			<circle cx="10" cy="9" r="1" className="fill" />
			<path d="M1.25 8.25v2M14.75 8.25v2" />
		</Svg>
	);
}

export function WarningIcon({ size = 16 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M7.1 2.6a1 1 0 0 1 1.8 0l5.2 9.6a1 1 0 0 1-.9 1.55H2.8a1 1 0 0 1-.9-1.55z" />
			<path d="M8 6.25v3" />
			<circle cx="8" cy="11.25" r=".7" className="fill" />
		</Svg>
	);
}

export function ChevronIcon({ size = 12 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M6 4l4 4-4 4" />
		</Svg>
	);
}

export function FileIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M4 1.75h5l3.25 3.25v8.25a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" />
			<path d="M9 1.75V5h3.25" />
		</Svg>
	);
}

export function BranchIcon({ size = 14 }: { size?: number }) {
	return (
		<Svg size={size}>
			<circle cx="4.5" cy="3.5" r="1.6" />
			<circle cx="4.5" cy="12.5" r="1.6" />
			<circle cx="11.5" cy="5" r="1.6" />
			<path d="M4.5 5.1v5.8M11.5 6.6c0 3-7 2-7 4.3" />
		</Svg>
	);
}

/** The pin, pressed in: Tack's mark for "this landed". */
export function PinIcon({ size = 16 }: { size?: number }) {
	return (
		<Svg size={size}>
			<path d="M6 2.25h4l-.6 3.75 2.35 2.25h-7.5L6.6 6z" />
			<path d="M8 8.25v5.5" />
		</Svg>
	);
}
