import { useReactFlow, useStoreApi } from "@xyflow/react";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { type Direction, type Placed, boardOrder, nearestInDirection } from "../shared/a11y.ts";
import { announce } from "./announce.tsx";
import type { ShapeNode } from "./board.ts";
import { cardStore } from "./cardStore.ts";
import { KEYBOARD_FOCUS, isOffBoardTarget, markKeyboardFocus } from "./keys.ts";
import { scaledDuration } from "./motion.ts";
import { safeUrl } from "./changes/inline.ts";

// Moving around the board with the keyboard (#61). Keyboard focus is its
// own thing, apart from the selection: a ring shows where you are, and
// what you do on a shape that's focused but not selected is about getting
// around. Arrow keys go to the nearest shape that way (staying in its
// section first), Tab and Shift-Tab go through every shape in reading
// order (each section then what's in it) and then on out of the board,
// Home and End go to the first and last, Enter or Space selects it, and O
// opens a card's item. Once a shape is selected its keys are the
// selection's, as before: arrows nudge, Enter edits, Tab reaches the action
// bar, Escape deselects and leaves focus where it is. React Flow only draws
// shapes in view, so moving to one that isn't pans to it first.

const ARROWS: Record<string, Direction> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	ArrowDown: "down",
};

const TABBABLE =
	"a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";

interface NavigationOptions {
	nodes: readonly ShapeNode[];
	selected: ReadonlySet<string>;
	setSelected: (ids: Set<string>) => void;
	/** Where shapes are drawn, at what size (rows in lists included). */
	sizeOf: (id: string) => { width: number; height: number } | undefined;
	/** The board's region, which the skip link focuses. */
	canvas: RefObject<HTMLElement | null>;
	/** Called when moving to a shape moves the view, e.g. to stop following someone. */
	onNavigate?: () => void;
}

export function useShapeNavigation(options: NavigationOptions) {
	const latest = useRef(options);
	latest.current = options;
	const flow = useReactFlow();
	const store = useStoreApi();
	/** The shape the keyboard was last on, to come back to. */
	const last = useRef<string | null>(null);

	// Where shapes are and their order, worked out when a key needs them
	// (never per frame, as shapes are dragged), and kept until they change.
	const cache = useRef<{
		nodes: readonly ShapeNode[] | null;
		placed: Placed[];
		order: string[];
	}>({ nodes: null, placed: [], order: [] });
	const placedNow = useCallback(() => {
		const { nodes, sizeOf } = latest.current;
		if (cache.current.nodes !== nodes) {
			const placed = nodes.map((node) => {
				const size = sizeOf(node.id) ?? { width: node.width ?? 0, height: node.height ?? 0 };
				return {
					id: node.id,
					type: node.data.shape.type,
					parent: node.data.shape.parent ?? null,
					x: node.position.x,
					y: node.position.y,
					w: size.width,
					h: size.height,
				};
			});
			cache.current = { nodes, placed, order: boardOrder(placed) };
		}
		return cache.current;
	}, []);

	const element = useCallback(
		(id: string) =>
			store
				.getState()
				.domNode?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`) ??
			null,
		[store],
	);

	/** Move keyboard focus to a shape, bringing it into view first if it isn't. */
	const focusShape = useCallback(
		(id: string) => {
			const shape = placedNow().placed.find((each) => each.id === id);
			if (!shape) return;
			last.current = id;
			// The selection was somewhere else: leave it behind, so keys like
			// Delete never act on shapes you've moved away from.
			const { selected, setSelected } = latest.current;
			if (selected.size > 0 && !selected.has(id)) setSelected(new Set());
			const bounds = latest.current.canvas.current?.getBoundingClientRect();
			const { x, y, zoom } = flow.getViewport();
			const box = {
				left: shape.x * zoom + x,
				top: shape.y * zoom + y,
				right: (shape.x + shape.w) * zoom + x,
				bottom: (shape.y + shape.h) * zoom + y,
			};
			const inView =
				!bounds ||
				(box.left >= 0 && box.top >= 0 && box.right <= bounds.width && box.bottom <= bounds.height);
			const existing = element(id);
			if (existing && inView) {
				focusMarked(existing);
				return;
			}
			latest.current.onNavigate?.();
			// Big shapes (sections) fit as much as they can: their top left in view.
			const tooBig = bounds && (shape.w * zoom > bounds.width || shape.h * zoom > bounds.height);
			const centre = tooBig
				? { x: shape.x + (bounds.width * 0.45) / zoom, y: shape.y + (bounds.height * 0.4) / zoom }
				: { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
			void flow.setCenter(centre.x, centre.y, { zoom, duration: scaledDuration(320) });
			// Drawn once it's in view: focus it when it is.
			let tries = 0;
			const attempt = () => {
				const el = element(id);
				if (el) focusMarked(el);
				else if (tries++ < 60) requestAnimationFrame(attempt);
			};
			requestAnimationFrame(attempt);
		},
		[flow, element],
	);

	/** Into the board: the shape you were last on, or the first in reading order. */
	const enterBoard = useCallback(
		(from: "start" | "end" = "start") => {
			const { order } = placedNow();
			const back = last.current && order.includes(last.current) ? last.current : null;
			const id = back ?? (from === "end" ? order.at(-1) : order[0]);
			if (id) focusShape(id);
			else announce("The board is empty");
		},
		[focusShape],
	);

	/** Out of the board, to whatever comes after it (or before it) for Tab. */
	const leaveBoard = useCallback(
		(forward: boolean) => {
			const viewport = store.getState().domNode?.querySelector(".react-flow__viewport");
			if (!viewport) return;
			const outside = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
				(el) =>
					el.tabIndex >= 0 &&
					!viewport.contains(el) &&
					!el.closest("[hidden], [inert], [aria-hidden='true']") &&
					el.getClientRects().length > 0,
			);
			const next = forward
				? outside.find(
						(el) => viewport.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
					)
				: outside
						.filter(
							(el) =>
								viewport.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING &&
								!el.contains(viewport),
						)
						.at(-1);
			next?.focus();
		},
		[store],
	);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Escape deselects (commands.ts), and React Flow blurs the shape as it
			// does: keep the keyboard where it was.
			if (event.key === "Escape" && event.target instanceof HTMLElement) {
				const node = event.target;
				if (node.classList.contains("react-flow__node")) {
					requestAnimationFrame(() => {
						if (document.activeElement === document.body && node.isConnected) {
							focusMarked(node);
						}
					});
				}
				return;
			}
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (!target || isOffBoardTarget(target)) return;
			const { order, placed } = placedNow();

			// The board itself (from the skip link), or nowhere in particular with
			// nothing selected (after clicking the canvas, say): any way in goes
			// to a shape. History's scrubber has the arrow keys while it's open.
			const nowhere =
				target === document.body &&
				latest.current.selected.size === 0 &&
				!latest.current.canvas.current?.hasAttribute("data-history");
			if (target === latest.current.canvas.current || nowhere) {
				if (event.key in ARROWS || event.key === "Home") {
					event.preventDefault();
					enterBoard();
				} else if (event.key === "End") {
					event.preventDefault();
					enterBoard("end");
				}
				return;
			}

			const node = target.closest<HTMLElement>(".react-flow__node");
			const id = node?.dataset.id;
			const onNode = node === target && id !== undefined;

			// O opens the item behind a card (or a decision's pull request, or
			// an action item's issue): the one in focus, or the one selected.
			const onBoard = target === document.body || !!latest.current.canvas.current?.contains(target);
			if (event.key.toLowerCase() === "o" && !event.shiftKey && onBoard) {
				const { selected } = latest.current;
				const which = onNode ? id : selected.size === 1 ? [...selected][0] : undefined;
				if (!which) return;
				const ref = nodeRef(latest.current.nodes, which);
				if (!ref) return;
				event.preventDefault();
				const card = cardStore.get(ref);
				const url = card && "url" in card ? safeUrl(card.url) : undefined;
				if (url) window.open(url, "_blank", "noopener,noreferrer");
				else announce("That item hasn’t loaded yet");
				return;
			}

			if (!onNode || !id) return;
			const selected = latest.current.selected.has(id);
			// Selected shapes keep their keys, except Tab when there's no action
			// bar to go to (view-only boards): then it goes on through the board.
			const bar = document.querySelector(".selection-actions[role='toolbar']");
			if (selected && !(event.key === "Tab" && !bar)) return;
			// Focus left on a shape by a click, with the selection moved on (to a
			// duplicate, say): its keys are still the selection's.
			if (!selected && !node.hasAttribute(KEYBOARD_FOCUS) && latest.current.selected.size > 0) {
				return;
			}

			const at = order.indexOf(id);
			const direction = ARROWS[event.key];
			if (direction && !event.shiftKey) {
				event.preventDefault();
				const from = placed.find((shape) => shape.id === id);
				const next = from ? nearestInDirection(from, placed, direction) : null;
				if (next) focusShape(next);
				else announce(`Nothing further ${direction}`);
				return;
			}
			switch (event.key) {
				case "Tab": {
					event.preventDefault();
					const next = order[at + (event.shiftKey ? -1 : 1)];
					if (at >= 0 && next) focusShape(next);
					else leaveBoard(!event.shiftKey);
					return;
				}
				case "Home":
				case "End": {
					event.preventDefault();
					const to = event.key === "Home" ? order[0] : order.at(-1);
					if (to) focusShape(to);
					return;
				}
			}
		};

		// Tabbing into the board from outside it (the top bar or the skip
		// link before it, the zoom controls after it) lands on the shape you
		// were last on, or the first (or last) in reading order, rather than
		// whatever happens to come first in the page: a link inside a card,
		// say. Only for a Tab nothing else took (the action bar moves focus
		// itself, and keeps it).
		let tabbing: "forward" | "back" | null = null;
		const onTab = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.defaultPrevented) return;
			const viewport = store.getState().domNode?.querySelector(".react-flow__viewport");
			if (!viewport || (event.target instanceof Node && viewport.contains(event.target))) return;
			tabbing = event.shiftKey ? "back" : "forward";
			requestAnimationFrame(() => {
				tabbing = null;
			});
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (!target) return;
			const node = target.classList.contains("react-flow__node") ? target : null;
			const viewport = store.getState().domNode?.querySelector(".react-flow__viewport");
			const way = tabbing;
			tabbing = null;
			if (way && viewport?.contains(target)) {
				const { order } = placedNow();
				const back = last.current && order.includes(last.current) ? last.current : null;
				const want = back ?? (way === "back" ? order.at(-1) : order[0]);
				if (want && want !== node?.dataset.id) {
					focusShape(want);
					return;
				}
			}
			if (way && node) markKeyboardFocus(node);
			if (node?.dataset.id) last.current = node.dataset.id;
		};

		window.addEventListener("keydown", onKey);
		window.addEventListener("keydown", onTab);
		document.addEventListener("focusin", onFocusIn);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keydown", onTab);
			document.removeEventListener("focusin", onFocusIn);
		};
	}, [enterBoard, focusShape, leaveBoard, store]);

	return { focusShape, enterBoard };
}

/** The item a shape opens: a card's, a decision's pull request, an action item's issue. */
function nodeRef(nodes: readonly ShapeNode[], id: string): string | undefined {
	const shape = nodes.find((node) => node.id === id)?.data.shape;
	if (!shape) return undefined;
	return shape.type === "card" || shape.type === "decision" || shape.type === "action"
		? shape.ref
		: undefined;
}

/** Focus a shape for the keyboard, marked as the keyboard's (see `isOnUnselectedShape`). */
function focusMarked(el: HTMLElement): void {
	el.focus({ preventScroll: true });
	markKeyboardFocus(el);
}
