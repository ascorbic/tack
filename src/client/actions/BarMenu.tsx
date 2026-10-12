import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { BarAnchorContext } from "./Popover.tsx";

// A small menu that opens from a button in a bar: a section's colour, a
// list's sort, and what didn't fit in the bar ("…"). It hangs from its
// button on the side its bar's panels open (`BarAnchorContext`: away from
// the edge of the view the bar is at), lined up with the button and kept on
// screen. Inside the bar, it's above every shape and follows the board with
// it. Arrow keys move through it, Escape goes back to its button, and a
// click anywhere else closes it.

const MENU_ITEM = "[role^='menuitem']:not([aria-disabled='true'])";

export interface MenuButtonProps {
	/** The menu's name. */
	label: string;
	/** The button's own attributes and what's in it. */
	button: {
		className: string;
		"aria-label"?: string;
		"data-tooltip"?: string;
		children: ReactNode;
	};
	/** What's in the menu; `close` puts it away (focus back on the button from the keyboard). */
	children: (close: (refocus?: boolean) => void) => ReactNode;
	/** A class for the menu, for its own layout. */
	menuClassName?: string;
	/** Whether the button is one of its bar's roving stops (ActionBar.tsx). */
	barItem?: boolean;
	/** The button, for whoever wants to come back to it (a panel opened from the menu). */
	buttonRef?: RefObject<HTMLButtonElement | null>;
}

export function MenuButton({
	label,
	button,
	children,
	menuClassName,
	barItem = true,
	buttonRef,
}: MenuButtonProps) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const ownTrigger = useRef<HTMLButtonElement>(null);
	const trigger = buttonRef ?? ownTrigger;
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const bar = useContext(BarAnchorContext);
	const side = bar?.side ?? "below";

	const close = (refocus = false) => {
		setOpen(false);
		if (refocus) trigger.current?.focus();
	};

	// Away from the edge of the screen: flipped up or down, and lined up with
	// the button's other end, when it would go off it.
	useLayoutEffect(() => {
		const el = menu.current;
		if (!open || !el) return;
		el.dataset.side = side;
		el.dataset.align = "start";
		const rect = el.getBoundingClientRect();
		const margin = 8;
		if (rect.right > window.innerWidth - margin) el.dataset.align = "end";
		if (side === "below" && rect.bottom > window.innerHeight - margin) el.dataset.side = "above";
		if (side === "above" && rect.top < margin) el.dataset.side = "below";
	}, [open, side]);

	useEffect(() => {
		if (!open) return;
		const items = [...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])];
		const checked = items.find((item) => item.getAttribute("aria-checked") === "true");
		(checked ?? items[0])?.focus({ preventScroll: true });
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => window.removeEventListener("pointerdown", onDown, true);
	}, [open]);

	const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const items = [...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = (to: number) => {
			event.preventDefault();
			event.stopPropagation();
			items[(to + items.length) % items.length]?.focus();
		};
		switch (event.key) {
			case "ArrowDown":
			case "ArrowRight":
				return move(at + 1);
			case "ArrowUp":
			case "ArrowLeft":
				return move(at - 1);
			case "Home":
				return move(0);
			case "End":
				return move(items.length - 1);
			case "Escape":
				event.preventDefault();
				event.stopPropagation();
				return close(true);
			case "Tab":
				event.preventDefault();
				event.stopPropagation();
				return close(true);
			case "Enter":
			case " ":
				// The item's own: not the board's shortcut for the selection.
				event.stopPropagation();
		}
	};

	return (
		<span className="bar-menu-anchor" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={button.className}
				aria-label={button["aria-label"]}
				data-tooltip={button["data-tooltip"]}
				data-bar-item={barItem || undefined}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onPointerDown={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					event.stopPropagation();
					setOpen(true);
				}}
				onClick={(event) => {
					event.stopPropagation();
					setOpen((was) => !was);
				}}
			>
				{button.children}
			</button>
			{open && (
				<div
					ref={menu}
					id={id}
					role="menu"
					aria-label={label}
					className={`bar-menu nodrag nopan nowheel${menuClassName ? ` ${menuClassName}` : ""}`}
					data-side={side}
					onKeyDown={onMenuKey}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
				>
					{children(close)}
				</div>
			)}
		</span>
	);
}
