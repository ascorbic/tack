import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type ListSort,
	type ListSortBy,
	type SectionDisplay,
	displayOf,
	setDisplay,
	setSort,
	sortOf,
} from "../../shared/display.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { DocContext } from "../DocContext.ts";
import { transactLocal } from "../undo.ts";

// The switch in a selected section's header between cards, a list and mini
// cards (#72), and a list's sort. Each change is one undo step.

const MODES: { mode: SectionDisplay; label: string }[] = [
	{ mode: "cards", label: "Cards" },
	{ mode: "list", label: "List" },
	{ mode: "mini", label: "Mini cards" },
];

export function ModeIcon({ mode, size = 16 }: { mode: SectionDisplay; size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="mode-icon">
			{mode === "cards" ? (
				<>
					<rect x="1.75" y="2.25" width="7" height="5.5" rx="1.4" />
					<rect x="7.25" y="8.25" width="7" height="5.5" rx="1.4" />
				</>
			) : mode === "list" ? (
				<>
					<circle cx="3" cy="4" r="1" className="fill" />
					<circle cx="3" cy="8" r="1" className="fill" />
					<circle cx="3" cy="12" r="1" className="fill" />
					<path d="M6 4h8M6 8h8M6 12h6" />
				</>
			) : (
				<>
					<rect x="1.75" y="2.75" width="3.5" height="4.25" rx="0.9" />
					<rect x="6.25" y="2.75" width="3.5" height="4.25" rx="0.9" />
					<rect x="10.75" y="2.75" width="3.5" height="4.25" rx="0.9" />
					<rect x="1.75" y="9" width="3.5" height="4.25" rx="0.9" />
					<rect x="6.25" y="9" width="3.5" height="4.25" rx="0.9" />
				</>
			)}
		</svg>
	);
}

const SORTS: { by: ListSortBy | null; label: string; hint: string }[] = [
	{ by: null, label: "By hand", hint: "Drag rows to order them" },
	{ by: "state", label: "State", hint: "Open, draft, merged, closed" },
	{ by: "number", label: "Number", hint: "Oldest first" },
	{ by: "title", label: "Title", hint: "A to Z" },
];

export function sortLabel(sort: ListSort | null): string {
	if (!sort) return "By hand";
	const name = SORTS.find((s) => s.by === sort.by)?.label ?? sort.by;
	return `${name}${sort.desc ? " ↓" : " ↑"}`;
}

/** Cards, list or mini cards, and (for a list or grid) how it's sorted. */
export function DisplaySwitch({ id, shape }: { id: string; shape: ShapeProps }) {
	const doc = useContext(DocContext);
	const mode = displayOf(shape);
	if (!doc) return null;
	return (
		<div className="display-switch nodrag nopan" role="group" aria-label="Show as">
			<div className="display-modes" role="radiogroup" aria-label="Show contents as">
				{MODES.map((option) => (
					<button
						key={option.mode}
						type="button"
						role="radio"
						aria-checked={mode === option.mode}
						aria-label={option.label}
						data-tooltip={option.label}
						className="display-mode"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							if (mode !== option.mode)
								transactLocal(doc, () => setDisplay(doc, [id], option.mode));
						}}
					>
						<ModeIcon mode={option.mode} />
					</button>
				))}
				<span className="display-mode-thumb" data-mode={mode} aria-hidden="true" />
			</div>
			{mode !== "cards" && <SortMenu id={id} sort={sortOf(shape)} />}
		</div>
	);
}

function SortMenu({ id, sort }: { id: string; sort: ListSort | null }) {
	const doc = useContext(DocContext);
	// Where the menu opens, on screen: it's drawn over everything on the
	// board, rather than inside the section (which stacks beneath its rows).
	const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
	const menu = useId();
	const root = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!root.current?.contains(target) && !list.current?.contains(target)) setOpen(null);
		};
		// Panning or zooming moves the button away from the menu.
		const onWheel = () => setOpen(null);
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setOpen(null);
		};
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("wheel", onWheel, { capture: true, passive: true });
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("wheel", onWheel, true);
		};
	}, [open]);
	if (!doc) return null;
	const choose = (by: ListSortBy | null) => {
		transactLocal(doc, () => {
			if (by === null) setSort(doc, id, null);
			else if (sort?.by === by) setSort(doc, id, { by, desc: !sort.desc });
			else setSort(doc, id, { by });
		});
	};
	return (
		<div className="display-sort" ref={root}>
			<button
				type="button"
				className="display-sort-button"
				aria-haspopup="menu"
				aria-expanded={open !== null}
				aria-controls={menu}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					const box = event.currentTarget.getBoundingClientRect();
					setOpen((value) => (value ? null : { left: box.left, top: box.bottom + 6 }));
				}}
			>
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<path d="M3.5 2v8M1.5 8l2 2 2-2M8.5 10V2M6.5 4l2-2 2 2" />
				</svg>
				{sortLabel(sort)}
			</button>
			{open &&
				createPortal(
					<div
						ref={list}
						className="display-sort-menu"
						id={menu}
						role="menu"
						aria-label="Sort"
						data-chrome
						style={{ left: open.left, top: open.top }}
					>
						{SORTS.map((option) => {
							const active = option.by === null ? sort === null : sort?.by === option.by;
							return (
								<button
									key={option.label}
									type="button"
									role="menuitemradio"
									aria-checked={active}
									className="display-sort-option"
									onPointerDown={(event) => event.stopPropagation()}
									onClick={(event) => {
										event.stopPropagation();
										choose(option.by);
										if (option.by === null || !active) setOpen(null);
									}}
								>
									<span className="display-sort-check" aria-hidden="true">
										{active ? "✓" : ""}
									</span>
									<span className="display-sort-name">{option.label}</span>
									<span className="display-sort-hint">
										{active && option.by !== null
											? sort?.desc
												? "Reversed: click to flip"
												: "Click again to reverse"
											: option.hint}
									</span>
								</button>
							);
						})}
					</div>,
					document.body,
				)}
		</div>
	);
}
