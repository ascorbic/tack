import { ViewportPortal, useStore } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { NOMINAL_SIZE, type SizeOf } from "../../shared/sections.ts";
import type { Highlight, HighlightKind } from "../../shared/since.ts";
import type { ShapeNode } from "../board.ts";
import { scaledDuration } from "../motion.ts";
import { clearView } from "../clearView.ts";
import { useHighlights } from "./SincePanel.tsx";
import { type SinceStore, sinceStore, useSince } from "./store.ts";
import "./since.css";

// Highlights on the canvas for "since you were here" (#46): a soft ring
// around each shape that's new, changed, moved or closed since your last
// visit, with a small label. Each fades once it's been on screen for a
// moment, so the board quietens as you look around. Only once you're
// looking, though: nothing counts as seen until you've moved the pointer,
// scrolled or pressed a key, and never while it's under a panel (the
// digest itself, on arrival).

/** How long a highlight has to be in view to count as seen. */
export const SEEN_AFTER_MS = 4500;
/** How long a seen highlight takes to fade. */
const FADE_MS = 900;

const LABELS: Record<HighlightKind, string> = {
	new: "New",
	changed: "Changed",
	moved: "Moved",
	closed: "Closed",
};

export function HighlightLayer({
	doc,
	nodes,
	sizeOf,
	store = sinceStore,
}: {
	doc: Y.Doc;
	nodes: ShapeNode[];
	sizeOf: SizeOf;
	store?: SinceStore;
}) {
	const state = useSince(store);
	const highlights = useHighlights(doc, state.digest);
	const [fading, setFading] = useState<Set<string>>(new Set());
	const transform = useStore((s) => s.transform);
	const width = useStore((s) => s.width);
	const height = useStore((s) => s.height);

	const boxes = useMemo(() => {
		const map = new Map<string, { x: number; y: number; w: number; h: number }>();
		for (const node of nodes) {
			const size = sizeOf(node.id) ?? NOMINAL_SIZE[node.data.shape.type];
			map.set(node.id, {
				x: node.position.x,
				y: node.position.y,
				w: node.width ?? node.data.shape.w ?? size?.w ?? 200,
				h: node.height ?? node.data.shape.h ?? size?.h ?? 120,
			});
		}
		return map;
	}, [nodes, sizeOf]);

	const unseen = highlights.filter((h) => !state.seen.has(h.shape));
	const engaged = useEngaged();

	// Which unseen highlights are in view now (clear of panels), and since when.
	const inView = useRef(new Map<string, number>());
	useEffect(() => {
		if (!engaged || unseen.length === 0) {
			inView.current.clear();
			return;
		}
		const [tx, ty, zoom] = transform;
		const clear = clearView();
		const view = {
			x: (-tx + clear.left) / zoom,
			y: -ty / zoom,
			w: Math.max(0, width - clear.left - clear.right) / zoom,
			h: height / zoom,
		};
		const now = performance.now();
		const visible = new Set<string>();
		for (const highlight of unseen) {
			const box = boxes.get(highlight.shape);
			if (!box) continue;
			// Mostly on screen, and not so small it can't be made out.
			const cx = box.x + box.w / 2;
			const cy = box.y + box.h / 2;
			const onScreen =
				cx > view.x && cx < view.x + view.w && cy > view.y && cy < view.y + view.h && zoom > 0.25;
			if (!onScreen) continue;
			visible.add(highlight.shape);
			if (!inView.current.has(highlight.shape)) inView.current.set(highlight.shape, now);
		}
		for (const id of inView.current.keys()) if (!visible.has(id)) inView.current.delete(id);
	});

	useEffect(() => {
		if (unseen.length === 0) return;
		const timer = setInterval(() => {
			const now = performance.now();
			const due = [...inView.current]
				.filter(([, since]) => now - since > scaledDuration(SEEN_AFTER_MS))
				.map(([id]) => id);
			if (due.length === 0) return;
			for (const id of due) inView.current.delete(id);
			setFading((current) => new Set([...current, ...due]));
			setTimeout(
				() => {
					store.see(due);
					setFading((current) => {
						const next = new Set(current);
						for (const id of due) next.delete(id);
						return next;
					});
				},
				Math.max(scaledDuration(FADE_MS), 1),
			);
		}, 300);
		return () => clearInterval(timer);
	}, [unseen.length, store]);

	if (unseen.length === 0) return null;
	return (
		<ViewportPortal>
			<div className="since-layer" aria-hidden="true">
				{unseen.map((highlight, i) => {
					const box = boxes.get(highlight.shape);
					if (!box) return null;
					return (
						<HighlightRing
							key={highlight.shape}
							highlight={highlight}
							box={box}
							index={i}
							fading={fading.has(highlight.shape)}
						/>
					);
				})}
			</div>
		</ViewportPortal>
	);
}

/**
 * Whether the person has done anything yet: moved the pointer, scrolled,
 * clicked or pressed a key. Until then they're reading, not looking around.
 */
function useEngaged(): boolean {
	const [engaged, setEngaged] = useState(false);
	useEffect(() => {
		if (engaged) return;
		const events = ["pointermove", "pointerdown", "wheel", "keydown"] as const;
		const on = () => setEngaged(true);
		for (const type of events) window.addEventListener(type, on, { passive: true, once: true });
		return () => {
			for (const type of events) window.removeEventListener(type, on);
		};
	}, [engaged]);
	return engaged;
}

export function HighlightRing({
	highlight,
	box,
	index,
	fading,
}: {
	highlight: Highlight;
	box: { x: number; y: number; w: number; h: number };
	index: number;
	fading: boolean;
}) {
	return (
		<div
			className="since-ring"
			data-kind={highlight.kind}
			data-shape={highlight.shape}
			data-fading={fading || undefined}
			style={
				{
					transform: `translate(${box.x}px, ${box.y}px)`,
					width: box.w,
					height: box.h,
					"--i": Math.min(index, 20),
				} as React.CSSProperties
			}
		>
			<span className="since-label">
				{LABELS[highlight.kind]}
				{highlight.by && <span className="since-label-by"> · {highlight.by}</span>}
			</span>
		</div>
	);
}
