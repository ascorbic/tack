import { type NodeProps, useStore } from "@xyflow/react";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { isFresh, type ShapeNode, setStickyText, takeFocus } from "./board.ts";
import { CardView } from "./CardView.tsx";
import { useCard } from "./cardStore.ts";

export const DocContext = createContext<Y.Doc | null>(null);

/** Below this zoom, cards switch to their simplified rendering. */
const COMPACT_ZOOM = 0.45;

export const CardNode = memo(function CardNode({ data, selected }: NodeProps<ShapeNode>) {
	const key = data.shape.ref ?? "";
	const card = useCard(key);
	// A boolean selector only re-renders when the threshold is crossed.
	const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM);
	const [enter] = useState(() => isFresh(data.id));
	return <CardView card={card} cardKey={key} selected={selected} compact={compact} enter={enter} />;
});

/** A small, stable tilt per sticky, so a cluster looks hand-placed. */
function tilt(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return ((hash % 300) / 100) * 0.6;
}

/** Keys that start editing a selected sticky and go into its text. */
function isTypingKey(event: KeyboardEvent): boolean {
	return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * Stickies work like FigJam's: the whole note is a drag handle until it's
 * selected. Then a click, a double-click, Enter, or just typing starts
 * editing. Escape or clicking away stops it.
 */
export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const [enter] = useState(() => isFresh(data.id));
	// A sticky this client just placed starts in editing mode.
	const [editing, setEditing] = useState(() => takeFocus(data.id));
	const text = useRef<HTMLTextAreaElement>(null);
	const value = data.shape.text ?? "";
	const author = data.shape.author;

	// Distinguish "click a sticky that was already selected" from "click to
	// select it" and from the end of a drag.
	const press = useRef<{ wasSelected: boolean; x: number; y: number } | null>(null);

	// Stop editing when the sticky loses selection (not merely because it
	// hasn't been selected yet, as with one that was just placed).
	const wasSelected = useRef(selected);
	useEffect(() => {
		if (wasSelected.current && !selected) setEditing(false);
		wasSelected.current = selected;
	}, [selected]);

	// React Flow keeps a new node hidden until it has measured it, and hidden
	// elements can't take focus, so keep trying for a few frames.
	useEffect(() => {
		if (!editing) return;
		let frame = 0;
		let tries = 0;
		const focus = () => {
			const el = text.current;
			if (!el) return;
			el.focus();
			if (document.activeElement === el) {
				el.setSelectionRange(el.value.length, el.value.length);
			} else if (tries++ < 20) {
				frame = requestAnimationFrame(focus);
			}
		};
		focus();
		return () => cancelAnimationFrame(frame);
	}, [editing]);

	// Typing or Enter on a selected sticky starts editing. This listens in the
	// capture phase and stops the event, so the keystroke isn't also taken as
	// a tool shortcut.
	useEffect(() => {
		if (!selected || editing) return;
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable]")) return;
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				setEditing(true);
			} else if (isTypingKey(event) && doc) {
				event.preventDefault();
				event.stopPropagation();
				setStickyText(doc, data.id, value + event.key);
				setEditing(true);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [selected, editing, doc, data.id, value]);

	return (
		<div
			className="sticky"
			data-enter={enter}
			data-color={data.shape.color ?? "yellow"}
			data-selected={selected}
			data-editing={editing}
			style={{ "--tilt": `${tilt(data.id)}deg` } as React.CSSProperties}
			onPointerDown={(event) => {
				press.current = { wasSelected: !!selected, x: event.clientX, y: event.clientY };
			}}
			onClick={(event) => {
				const p = press.current;
				const moved = p ? Math.hypot(event.clientX - p.x, event.clientY - p.y) > 4 : true;
				if (p?.wasSelected && !moved && !event.shiftKey) setEditing(true);
			}}
			onDoubleClick={() => setEditing(true)}
		>
			{editing ? (
				<textarea
					ref={text}
					className="nodrag nowheel"
					aria-label="Sticky note"
					placeholder="Type something…"
					value={value}
					onChange={(event) => doc && setStickyText(doc, data.id, event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setEditing(false);
						}
					}}
					onBlur={() => setEditing(false)}
				/>
			) : (
				<div className="sticky-text" data-empty={value === ""}>
					{value || (selected ? "Type something…" : "")}
				</div>
			)}
			{author && (
				<span className="sticky-author" style={{ "--author": author.color } as React.CSSProperties}>
					{author.name}
				</span>
			)}
		</div>
	);
});

export const nodeTypes = { card: CardNode, sticky: StickyNode };
