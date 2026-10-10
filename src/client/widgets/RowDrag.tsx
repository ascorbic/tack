import { useReactFlow } from "@xyflow/react";
import {
	type PointerEvent as ReactPointerEvent,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { NOMINAL_SIZE } from "../../shared/sections.ts";
import { addShape, nextZ, transactLocal } from "../../shared/shapes.ts";
import { placeInSections } from "../../shared/structure.ts";
import { CardView } from "../CardView.tsx";
import { scaledDuration } from "../motion.ts";

// Dragging a row out of a list (#38): the row lifts off as the card it'll
// become, follows the pointer at the board's zoom, and lands as a copy (the
// list keeps the row), recording that it came from this list. Dropped back
// on the list, or off the board, it flies home instead.

/** Below this many screen pixels, a press is a click, not a drag. */
const SLOP = 5;
const CARD = NOMINAL_SIZE.card ?? { w: 252, h: 124 };

type Over = "board" | "home" | "away";

interface Ghost {
	card: Card;
	zoom: number;
	over: Over;
	/** Flying back to the row, then gone. */
	returning: { x: number; y: number } | null;
}

/** The one ghost there can be, so only it re-renders as it moves. */
class GhostStore {
	ghost: Ghost | null = null;
	element: HTMLElement | null = null;
	/** Where the ghost's top-left corner is, in screen pixels. */
	translate = "0px 0px";
	private listeners = new Set<() => void>();
	set(ghost: Ghost | null): void {
		this.ghost = ghost;
		for (const listener of this.listeners) listener();
	}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	get = () => this.ghost;
}

const ghosts = new GhostStore();

/** Where the pointer is: over the board, over the list it came from, or off the board. */
function overAt(x: number, y: number, widget: string): Over {
	const target = document.elementFromPoint(x, y);
	if (!target?.closest(".react-flow")) return "away";
	if (target.closest(".react-flow__panel, .toolbar-dock, .play-panel")) return "away";
	if (target.closest(`.react-flow__node[data-id="${CSS.escape(widget)}"]`)) return "home";
	return "board";
}

/**
 * Pointer handling for dragging rows out of a list. Returns the row's
 * pointer-down handler, and which row (by key) is lifted right now.
 */
export function useRowDrag({
	widget,
	doc,
	enabled,
	onPlaced,
	seedCard,
}: {
	widget: string;
	doc: Y.Doc | null;
	enabled: boolean;
	/** A card was made: its shape's id. */
	onPlaced: (id: string) => void;
	seedCard: (card: Card) => void;
}) {
	const flow = useReactFlow();
	const [lifted, setLifted] = useState<string | null>(null);
	const latest = useRef({ onPlaced, seedCard });
	latest.current = { onPlaced, seedCard };

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>, card: Card) => {
		if (!enabled || !doc || event.button !== 0 || !event.isPrimary) return;
		// Rows aren't the list's handle: the list stays put while a row comes out.
		event.stopPropagation();
		const row = event.currentTarget;
		const from = row.getBoundingClientRect();
		const start = { x: event.clientX, y: event.clientY };
		const zoom = flow.getZoom();
		// Hold the card where the row was held, within the card.
		const grab = {
			x: Math.min(event.clientX - from.left, CARD.w * zoom - 12),
			y: Math.min(event.clientY - from.top, 28 * zoom),
		};
		let dragging = false;
		let at = start;

		const place = (x: number, y: number) => {
			ghosts.translate = `${x - grab.x}px ${y - grab.y}px`;
			if (ghosts.element) ghosts.element.style.translate = ghosts.translate;
		};
		const onMove = (move: PointerEvent) => {
			at = { x: move.clientX, y: move.clientY };
			if (!dragging) {
				if (Math.hypot(at.x - start.x, at.y - start.y) < SLOP) return;
				dragging = true;
				setLifted(card.key);
				ghosts.set({ card, zoom, over: "home", returning: null });
				document.body.dataset.rowDrag = "true";
			}
			place(at.x, at.y);
			const over = overAt(at.x, at.y, widget);
			if (ghosts.ghost && ghosts.ghost.over !== over) ghosts.set({ ...ghosts.ghost, over });
		};
		const finish = (commit: boolean) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("keydown", onKey, true);
			delete document.body.dataset.rowDrag;
			if (!dragging) return;
			// Don't let the press that ended the drag count as a click on the row.
			window.addEventListener("click", swallow, { capture: true, once: true });
			setTimeout(() => window.removeEventListener("click", swallow, true), 0);
			const over = overAt(at.x, at.y, widget);
			if (commit && over === "board") {
				const position = flow.screenToFlowPosition({ x: at.x - grab.x, y: at.y - grab.y });
				latest.current.seedCard(card);
				const id = crypto.randomUUID();
				transactLocal(doc, () => {
					addShape(doc, id, {
						type: "card",
						ref: card.key,
						x: Math.round(position.x),
						y: Math.round(position.y),
						z: nextZ(doc),
						provenance: { via: "list", source: widget },
					});
					placeInSections(doc, [id]);
				});
				ghosts.set(null);
				setLifted(null);
				latest.current.onPlaced(id);
				return;
			}
			// Fly home, to where the row is now.
			const home = row.isConnected ? row.getBoundingClientRect() : from;
			if (ghosts.ghost) {
				ghosts.set({ ...ghosts.ghost, returning: { x: home.left, y: home.top } });
				ghosts.translate = `${home.left}px ${home.top}px`;
				if (ghosts.element) ghosts.element.style.translate = ghosts.translate;
			}
			setTimeout(() => {
				ghosts.set(null);
				setLifted(null);
			}, scaledDuration(320));
		};
		const onUp = () => finish(true);
		const onCancel = () => finish(false);
		const onKey = (key: KeyboardEvent) => {
			if (key.key !== "Escape") return;
			key.stopPropagation();
			finish(false);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("keydown", onKey, true);
	};

	return { onPointerDown, lifted };
}

function swallow(event: Event) {
	event.stopPropagation();
	event.preventDefault();
}

/** The card a dragged row will become, following the pointer. Render once per board. */
export function RowGhost() {
	const ghost = useSyncExternalStore(ghosts.subscribe, ghosts.get);
	if (!ghost) return null;
	return createPortal(
		<div
			ref={(el) => {
				ghosts.element = el;
				if (el) el.style.translate = ghosts.translate;
			}}
			className="widget-ghost"
			data-over={ghost.over}
			data-returning={ghost.returning ? true : undefined}
			aria-hidden="true"
			style={{ "--ghost-zoom": ghost.zoom } as React.CSSProperties}
		>
			<div className="widget-ghost-card">
				<CardView card={ghost.card} cardKey={ghost.card.key} />
			</div>
			<span className="widget-ghost-hint">
				{ghost.over === "board"
					? "Drop to add a card"
					: ghost.over === "home"
						? "Drag onto the board"
						: "Drop on the board"}
			</span>
		</div>,
		document.body,
	);
}
