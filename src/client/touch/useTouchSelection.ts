import { useStoreApi } from "@xyflow/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { LONG_PRESS_MS, movedTooFar } from "./gestures.ts";

/**
 * Selecting several shapes with a finger, on a tablet (#67). There's no
 * Shift key, so a long-press on a shape adds it to the selection and starts
 * selecting several: from then on a tap adds a shape or takes it out again,
 * until Done, or tapping the empty board. A pencil draws a selection box
 * (React Flow's, with the select tool), and a finger on the board pans.
 */
export function useTouchSelection({
	canvas,
	enabled,
	selected,
	setSelected,
}: {
	canvas: RefObject<HTMLElement | null>;
	enabled: boolean;
	selected: ReadonlySet<string>;
	setSelected: (update: (current: Set<string>) => Set<string>) => void;
}): { multi: boolean; done: () => void } {
	const api = useStoreApi();
	const [multi, setMulti] = useState(false);
	const multiRef = useRef(multi);
	multiRef.current = multi;
	const setSelectedRef = useRef(setSelected);
	setSelectedRef.current = setSelected;

	// Nothing left selected (a tap on the empty board, Escape): done.
	useEffect(() => {
		if (multi && selected.size === 0) setMulti(false);
	}, [multi, selected.size]);
	useEffect(() => {
		if (!enabled) setMulti(false);
	}, [enabled]);

	// While selecting several, a tap adds or removes, as Shift-click does.
	useEffect(() => {
		api.setState({ multiSelectionActive: multi });
	}, [api, multi]);

	useEffect(() => {
		const element = canvas.current;
		if (!enabled || !element) return;
		let press: {
			id: string;
			pointer: number;
			x: number;
			y: number;
			timer: ReturnType<typeof setTimeout>;
		} | null = null;
		// The click that ends a long-press isn't also a tap.
		let swallowUntil = 0;
		const cancel = () => {
			if (press) clearTimeout(press.timer);
			press = null;
		};
		const onDown = (event: PointerEvent) => {
			// React Flow forgets Shift-click on any key; keep it on while selecting several.
			if (multiRef.current) api.setState({ multiSelectionActive: true });
			if (event.pointerType === "mouse" || !event.isPrimary) return cancel();
			const target = event.target as Element | null;
			if (target?.closest("textarea, input, button, a, [contenteditable]")) return;
			const node = target?.closest<HTMLElement>(".react-flow__node");
			const id = node?.dataset.id;
			if (!id) return;
			cancel();
			const at = { x: event.clientX, y: event.clientY };
			press = {
				id,
				pointer: event.pointerId,
				...at,
				timer: setTimeout(() => {
					if (!press) return;
					const { id } = press;
					press = null;
					swallowUntil = performance.now() + 1500;
					const adding = multiRef.current;
					setSelectedRef.current((current) => {
						const next = new Set(current);
						// Already selecting several: a long-press toggles too.
						if (adding && next.has(id)) next.delete(id);
						else next.add(id);
						return next;
					});
					setMulti(true);
					ring(element, at);
					navigator.vibrate?.(12);
				}, LONG_PRESS_MS),
			};
		};
		const onMove = (event: PointerEvent) => {
			if (
				press &&
				event.pointerId === press.pointer &&
				movedTooFar(press, { x: event.clientX, y: event.clientY })
			) {
				cancel();
			}
		};
		const onUp = (event: PointerEvent) => {
			if (press && event.pointerId === press.pointer) cancel();
		};
		const onClick = (event: MouseEvent) => {
			if (performance.now() > swallowUntil) return;
			swallowUntil = 0;
			event.stopPropagation();
			event.preventDefault();
		};
		// A long-press is ours, not the browser's menu or text selection.
		const onMenu = (event: Event) => {
			if ((event.target as Element | null)?.closest(".react-flow__node")) event.preventDefault();
		};
		element.addEventListener("pointerdown", onDown, true);
		element.addEventListener("pointermove", onMove, true);
		element.addEventListener("pointerup", onUp, true);
		element.addEventListener("pointercancel", onUp, true);
		element.addEventListener("click", onClick, true);
		element.addEventListener("contextmenu", onMenu);
		return () => {
			cancel();
			element.removeEventListener("pointerdown", onDown, true);
			element.removeEventListener("pointermove", onMove, true);
			element.removeEventListener("pointerup", onUp, true);
			element.removeEventListener("pointercancel", onUp, true);
			element.removeEventListener("click", onClick, true);
			element.removeEventListener("contextmenu", onMenu);
		};
	}, [canvas, enabled, api]);

	return { multi, done: () => setMulti(false) };
}

/** A ring that spreads from where a long-press landed: it took. */
function ring(canvas: HTMLElement, at: { x: number; y: number }) {
	const bounds = canvas.getBoundingClientRect();
	const element = document.createElement("span");
	element.className = "press-ring";
	element.setAttribute("aria-hidden", "true");
	element.style.left = `${at.x - bounds.left}px`;
	element.style.top = `${at.y - bounds.top}px`;
	element.addEventListener("animationend", () => element.remove());
	canvas.appendChild(element);
	// Reduced motion has no animation to end it.
	setTimeout(() => element.remove(), 1500);
}
