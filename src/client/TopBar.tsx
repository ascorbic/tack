import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { BrandMark } from "./BrandMark.tsx";

/**
 * The board's top bar, which never wraps: the brand and the title (which
 * gives way first, with an ellipsis), who's here, the board's tools, then
 * Changes and Share at the end. Below 1360px the tools drop their labels
 * for icons with tooltips; on a narrow window they fold into a "⋯" menu.
 */
export function TopBar({
	title,
	people,
	tools,
	actions,
	home = { href: "/", label: "Tack: all boards" },
}: {
	title: ReactNode;
	people: ReactNode;
	tools: ReactNode;
	actions: ReactNode;
	/** Where the brand goes, and what it's called: the home page with every board. */
	home?: { href: string; label: string };
}) {
	const [open, setOpen] = useState(false);
	const toolsId = useId();
	const root = useRef<HTMLDivElement>(null);
	const more = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!root.current?.contains(target) && !more.current?.contains(target)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Closing the menu is all this Escape does.
			event.preventDefault();
			setOpen(false);
			more.current?.focus();
		};
		// A panel opening from the menu (History, Rules, Comments) takes over from it.
		const onClick = (event: MouseEvent) => {
			const button = (event.target as Element).closest("button");
			if (button?.hasAttribute("aria-pressed")) setOpen(false);
		};
		const tools = root.current;
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		tools?.addEventListener("click", onClick);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
			tools?.removeEventListener("click", onClick);
		};
	}, [open]);

	return (
		<header className="topbar board-bar">
			<a className="brand" href={home.href} aria-label={home.label}>
				<BrandMark />
				<span className="brand-word">tack</span>
			</a>
			<div className="topbar-title">{title}</div>
			<div className="topbar-people">{people}</div>
			<div ref={root} id={toolsId} className="topbar-tools" data-open={open || undefined}>
				{tools}
			</div>
			<button
				ref={more}
				type="button"
				className="topbar-more"
				aria-label="More tools"
				aria-expanded={open}
				aria-controls={toolsId}
				data-tooltip="More"
				onClick={() => setOpen((value) => !value)}
			>
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="3.5" cy="8" r="1.3" />
					<circle cx="8" cy="8" r="1.3" />
					<circle cx="12.5" cy="8" r="1.3" />
				</svg>
			</button>
			<div className="topbar-actions">{actions}</div>
		</header>
	);
}

/**
 * Whether the board's in step with the server: a quiet dot beside the
 * title while it is, and words only when it isn't, including what's
 * waiting: edits made offline are kept on this device and sent on
 * reconnecting.
 */
export function SyncStatus({ synced, waiting = 0 }: { synced: boolean; waiting?: number }) {
	const [everSynced, setEverSynced] = useState(synced);
	if (synced && !everSynced) setEverSynced(true);
	const state = synced
		? "synced"
		: waiting > 0
			? "waiting"
			: everSynced
				? "reconnecting"
				: "connecting";
	const label =
		state === "synced"
			? "Synced"
			: state === "waiting"
				? `Offline · ${waiting} ${waiting === 1 ? "edit" : "edits"} waiting`
				: state === "reconnecting"
					? "Reconnecting…"
					: "Connecting…";
	return (
		<span
			className="status"
			data-synced={synced}
			data-state={state}
			role="status"
			data-tooltip={
				state === "synced"
					? "Saved and in sync"
					: state === "waiting"
						? "Your edits are kept on this device, and will be sent when the connection’s back."
						: undefined
			}
		>
			<span className={synced ? "visually-hidden" : "status-text"}>{label}</span>
		</span>
	);
}
