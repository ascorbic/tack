import { MiniMap, type MiniMapProps, useStore } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { ShapeNode } from "./board.ts";

// The board's minimap, which gets out of the way (#71). It sits over the
// canvas's bottom-right corner, so shapes, their controls and popovers can
// end up under it, where clicks meant for them would land on the minimap.
// So it fades back and lets the pointer through to what's beneath:
//
// - while the pointer is over it with something under the pointer worth
//   reaching (a shape, a toolbar, a popover, a connector), and not over
//   empty canvas, where the minimap is still the minimap;
// - while something's dragged (a shape, a selection box) towards it;
// - while a selected shape, a toolbar or a popover overlaps it.
//
// It never dodges while it's being used itself (panning or zooming in it).

/** What's worth reaching under the minimap. */
const REACHABLE =
	".react-flow__node, .react-flow__node-toolbar, .react-flow__nodesselection-rect, .action-popover, .connector, .connector-label, .inbox-tray";
/** What makes it step aside by overlapping it. */
const OVERLAPPING = ".react-flow__node.selected, .react-flow__node-toolbar, .action-popover";
/** How near a drag has to come, in pixels, before it steps aside. */
const REACH = 48;
/** How long it waits, once nothing needs it out of the way, before coming back. */
const RETURN_MS = 140;

type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

const meets = (a: Box, b: Box) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where the minimap is at full size: it shrinks a little into its
 * bottom-right corner while it's out of the way, and what's near it
 * mustn't change when it does.
 */
function boxOf(map: HTMLElement): Box {
	const { right, bottom } = map.getBoundingClientRect();
	return { left: right - map.offsetWidth, top: bottom - map.offsetHeight, right, bottom };
}

export function BoardMinimap(props: MiniMapProps<ShapeNode>) {
	const domNode = useStore((s) => s.domNode);
	const transform = useStore((s) => s.transform);
	const [dodging, setDodging] = useState(false);
	const check = useRef<() => void>(() => {});

	useEffect(() => {
		if (!domNode) return;
		const minimap = () => domNode.querySelector<HTMLElement>(".react-flow__minimap");
		// Why it's out of the way, if it is.
		let reaching = false;
		let overlapped = false;
		// Pressed on the minimap itself: it's being used.
		let held = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let frame = 0;
		const apply = () => setDodging(!held && (reaching || overlapped));

		const setReaching = (next: boolean) => {
			clearTimeout(timer);
			if (next === reaching) return;
			if (next) {
				reaching = true;
				apply();
			} else {
				timer = setTimeout(() => {
					reaching = false;
					apply();
				}, RETURN_MS);
			}
		};

		/** Whether what's under the minimap at this point is worth reaching. */
		const beneath = (x: number, y: number, map: HTMLElement) => {
			for (const element of document.elementsFromPoint(x, y)) {
				if (map.contains(element)) continue;
				return element.closest(REACHABLE) !== null;
			}
			return false;
		};

		const onMove = (event: PointerEvent) => {
			const map = minimap();
			if (!map || held) return;
			const box = boxOf(map);
			const reach = event.buttons ? REACH : 0;
			const near =
				event.clientX >= box.left - reach &&
				event.clientX <= box.right + reach &&
				event.clientY >= box.top - reach &&
				event.clientY <= box.bottom + reach;
			setReaching(near && (event.buttons !== 0 || beneath(event.clientX, event.clientY, map)));
		};
		const onDown = (event: PointerEvent) => {
			const map = minimap();
			held = !!map && !reaching && map.contains(event.target as Node);
			if (held) apply();
		};
		const onUp = () => {
			if (!held) return;
			held = false;
			apply();
		};

		const overlap = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const map = minimap();
				if (!map) return;
				const box = boxOf(map);
				const next = [...document.querySelectorAll(OVERLAPPING)].some((element) =>
					meets(element.getBoundingClientRect(), box),
				);
				if (next === overlapped) return;
				overlapped = next;
				apply();
			});
		};
		check.current = overlap;
		overlap();

		// Selections, toolbars and popovers coming and going.
		const observer = new MutationObserver(overlap);
		observer.observe(domNode, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		const options = { capture: true, passive: true };
		window.addEventListener("pointermove", onMove, options);
		window.addEventListener("pointerdown", onDown, options);
		window.addEventListener("pointerup", onUp, options);
		window.addEventListener("pointercancel", onUp, options);
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("pointermove", onMove, options);
			window.removeEventListener("pointerdown", onDown, options);
			window.removeEventListener("pointerup", onUp, options);
			window.removeEventListener("pointercancel", onUp, options);
		};
	}, [domNode]);

	// The view moving can slide a selection under it, or out from under it.
	useEffect(() => check.current(), [transform]);

	return (
		<MiniMap
			{...props}
			className={[props.className, dodging ? "minimap-dodging" : ""].filter(Boolean).join(" ")}
		/>
	);
}
