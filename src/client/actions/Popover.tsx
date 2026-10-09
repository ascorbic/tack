import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isApplePlatform } from "../shortcuts.ts";
import "./actions.css";

// A small panel that opens from the action bar (or a connector's toolbar)
// and stays attached to it as the board moves. It's a dialog, so board
// shortcuts leave its keys alone (see keys.ts); Escape and clicking away
// close it. It opens below its bar, or above when there's no room.

const MARGIN = 12;
const DOCK = 84;
const HEADER = 56;

/** The keys that stage from a panel with a list or text in it. */
export const SUBMIT_HINT = isApplePlatform() ? "⌘↵" : "Ctrl ↵";

export function Popover({
	label,
	onClose,
	children,
	className,
	wide = false,
	prefer = "below",
}: {
	label: string;
	onClose: () => void;
	children: ReactNode;
	className?: string;
	wide?: boolean;
	/** Which side of the bar to open on, room allowing. */
	prefer?: "below" | "above";
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [side, setSide] = useState<"below" | "above">(prefer);
	const [nudge, setNudge] = useState(0);
	const close = useRef(onClose);
	close.current = onClose;

	// Room below? Otherwise above. And keep it on screen sideways.
	useLayoutEffect(() => {
		const el = ref.current;
		const bar = el?.parentElement;
		if (!el || !bar) return;
		const box = el.getBoundingClientRect();
		const anchor = bar.getBoundingClientRect();
		// Leave room for the tool dock along the bottom of the canvas.
		const below = window.innerHeight - DOCK - anchor.bottom;
		const above = anchor.top - HEADER;
		const fits = (room: number) => room >= box.height + MARGIN;
		if (prefer === "below" && !fits(below) && above > below) setSide("above");
		if (prefer === "above" && !fits(above) && below > above) setSide("below");
		if (box.left < MARGIN) setNudge(MARGIN - box.left);
		else if (box.right > window.innerWidth - MARGIN)
			setNudge(window.innerWidth - MARGIN - box.right);
	}, []);

	useEffect(() => {
		const el = ref.current;
		const focusable =
			el?.querySelector<HTMLElement>("[data-autofocus]") ??
			el?.querySelector<HTMLElement>("input, button");
		focusable?.focus({ preventScroll: true });
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			// Clicks on the bar that opened it toggle it there instead.
			if (target && (el?.contains(target) || el?.parentElement?.contains(target))) return;
			close.current();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={label}
			className={`action-popover nodrag nopan nowheel${className ? ` ${className}` : ""}`}
			data-side={side}
			data-wide={wide || undefined}
			style={{ "--nudge": `${nudge}px` } as React.CSSProperties}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					event.preventDefault();
					close.current();
				}
			}}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			{children}
		</div>
	);
}

/** The popover's header: what it does, and a quiet line of context. */
export function PopoverHead({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
	return (
		<header className="action-popover-head">
			<h3>{title}</h3>
			{detail && <p>{detail}</p>}
		</header>
	);
}

/** A status line in a popover: a note, a warning, or an error. */
export function Notice({
	tone = "note",
	icon,
	children,
}: {
	tone?: "note" | "warn" | "error";
	icon?: ReactNode;
	children: ReactNode;
}) {
	return (
		<p className="action-notice" data-tone={tone} role={tone === "error" ? "alert" : undefined}>
			{icon}
			<span>{children}</span>
		</p>
	);
}
