import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLinger } from "../useLinger.ts";
import { sheetCloses, sheetOffset } from "./gestures.ts";

/** How long a sheet takes to slide away; keep in step with `.sheet[data-leaving]`. */
const LEAVE_MS = 260;

/**
 * A sheet that rises from the bottom of a phone's screen (#67): what a
 * shape is, its votes and comments, or a new sticky. Drag it down by its
 * grip or header (or flick it) to put it away, or press Escape. The board
 * above it stays the board: it pans, and tapping another shape opens that. It keeps above the on-screen keyboard while you type.
 */
export function BottomSheet({
	open,
	label,
	onClose,
	header,
	children,
	kind,
	initialFocus = "sheet",
}: {
	open: boolean;
	/** Its accessible name. */
	label: string;
	onClose: () => void;
	/** Drawn at the top, beside the close button; dragging it drags the sheet. */
	header?: ReactNode;
	children: ReactNode;
	/** For styles and tests: what it's showing. */
	kind?: string;
	/** Focus the sheet itself on opening, or leave it to something inside (a text box). */
	initialFocus?: "sheet" | "content";
}) {
	// What it showed stays while it slides away.
	const shown = useLinger(open ? true : null, LEAVE_MS);
	const last = useRef({ header, children, label, kind });
	if (open) last.current = { header, children, label, kind };
	const sheet = useRef<HTMLElement>(null);
	// How far it's dragged down (null when it isn't), and the pointer's recent path.
	const [dy, setDy] = useState<number | null>(null);
	const press = useRef<{
		id: number;
		startY: number;
		prevY: number;
		prevAt: number;
		lastY: number;
		lastAt: number;
	} | null>(null);
	const keyboard = useKeyboardInset(shown.value !== null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Escape puts it away; focus goes in on opening and back where it was after.
	useEffect(() => {
		if (!open) return;
		const before = document.activeElement as HTMLElement | null;
		const element = sheet.current;
		if (initialFocus === "sheet") element?.focus({ preventScroll: true });
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onCloseRef.current();
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			if (before?.isConnected && element?.contains(document.activeElement)) {
				before.focus({ preventScroll: true });
			}
		};
	}, [open, initialFocus]);

	if (!shown.value) return null;
	const content = last.current;

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || (event.target as Element).closest("button, a, input, textarea")) {
			return;
		}
		event.currentTarget.setPointerCapture?.(event.pointerId);
		const now = performance.now();
		press.current = {
			id: event.pointerId,
			startY: event.clientY,
			prevY: event.clientY,
			prevAt: now,
			lastY: event.clientY,
			lastAt: now,
		};
		setDy(0);
	};
	const onPointerMove = (event: React.PointerEvent) => {
		const p = press.current;
		if (!p || p.id !== event.pointerId) return;
		const now = performance.now();
		// Velocity over the last few frames, not the whole drag.
		if (now - p.lastAt > 12) {
			p.prevY = p.lastY;
			p.prevAt = p.lastAt;
		}
		p.lastY = event.clientY;
		p.lastAt = now;
		setDy(event.clientY - p.startY);
	};
	const onPointerUp = (event: React.PointerEvent) => {
		const p = press.current;
		if (!p || p.id !== event.pointerId) return;
		press.current = null;
		const distance = event.clientY - p.startY;
		const velocity = (event.clientY - p.prevY) / Math.max(1, performance.now() - p.prevAt);
		setDy(null);
		if (sheetCloses(distance, velocity, sheet.current?.offsetHeight ?? 400)) onClose();
	};
	const dragging = dy !== null;

	return (
		<div className="phone-sheet-layer" data-chrome data-leaving={shown.leaving || undefined}>
			<section
				ref={sheet}
				className="phone-sheet"
				role="dialog"
				aria-label={content.label}
				data-kind={content.kind}
				data-dragging={dragging || undefined}
				data-leaving={shown.leaving || undefined}
				tabIndex={-1}
				style={
					{
						"--sheet-drag": `${dy === null ? 0 : sheetOffset(dy)}px`,
						"--keyboard": `${keyboard}px`,
					} as React.CSSProperties
				}
			>
				<div
					className="phone-sheet-top"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={() => {
						press.current = null;
						setDy(null);
					}}
				>
					<span className="phone-sheet-grip" aria-hidden="true" />
					<div className="phone-sheet-header">
						<div className="phone-sheet-heading">{content.header}</div>
						<button
							type="button"
							className="phone-sheet-close"
							aria-label="Close"
							onClick={onClose}
						>
							<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
								<path d="M3 3l8 8M11 3l-8 8" />
							</svg>
						</button>
					</div>
				</div>
				<div className="phone-sheet-body">{content.children}</div>
			</section>
		</div>
	);
}

/**
 * How much of the bottom of the window the on-screen keyboard covers, so a
 * sheet with a text box in it stays above it (Safari doesn't resize the
 * layout for the keyboard).
 */
function useKeyboardInset(active: boolean): number {
	const [inset, setInset] = useState(0);
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!active || !viewport) return;
		// Some browsers count their own bars as outside the visual viewport:
		// the smallest gap seen is what's there without a keyboard.
		const gap = () => window.innerHeight - viewport.height - viewport.offsetTop;
		let base = gap();
		const update = () => {
			const now = gap();
			base = Math.min(base, now);
			setInset(Math.max(0, Math.round(now - base)));
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
		};
	}, [active]);
	return inset;
}
