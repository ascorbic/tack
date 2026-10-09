import { useStoreApi } from "@xyflow/react";
import { type PointerEvent, type MouseEvent, useContext, useEffect, useRef, useState } from "react";
import { HistoryContext, ReadOnlyContext } from "./DocContext.ts";
import { isEditableTarget } from "./keys.ts";

/** Keys that start editing a selected shape and go into its text. */
function isTypingKey(event: KeyboardEvent): boolean {
	// "/" opens cursor chat instead (see CursorChat.tsx).
	return (
		event.key.length === 1 && event.key !== "/" && !event.metaKey && !event.ctrlKey && !event.altKey
	);
}

/**
 * Text shapes (stickies and text blocks) edit like FigJam's: the whole shape
 * is a drag handle until it's selected. Then a click, a double-click, Enter,
 * or just typing starts editing. Escape or clicking away stops it.
 */
export function useEditing({
	selected,
	startEditing,
	onType,
}: {
	selected: boolean;
	/** Start in editing mode, for a shape this client just placed. */
	startEditing: boolean;
	/** A character typed while the shape was selected but not editing. */
	onType: (char: string) => void;
}) {
	const readOnly = useContext(ReadOnlyContext);
	const [editingState, setEditing] = useState(startEditing);
	// View-only boards never edit in place.
	const editing = editingState && !readOnly;
	const field = useRef<HTMLTextAreaElement>(null);
	const store = useStoreApi();
	const history = useContext(HistoryContext);
	const onTypeRef = useRef(onType);
	onTypeRef.current = onType;

	// Distinguish "click a shape that was already selected" from "click to
	// select it" and from the end of a drag.
	const press = useRef<{ wasSelected: boolean; x: number; y: number } | null>(null);

	// Stop editing when the shape loses selection (not merely because it
	// hasn't been selected yet, as with one that was just placed).
	const wasSelected = useRef(selected);
	useEffect(() => {
		if (wasSelected.current && !selected) setEditing(false);
		wasSelected.current = selected;
	}, [selected]);

	// Everything typed in one go is one undo step, however long it takes. The
	// session ends a moment after editing does, so tidying up on the way out
	// (an empty text block removing itself) joins the same step.
	useEffect(() => {
		if (!editing || !history) return;
		const end = history.beginSession();
		return () => queueMicrotask(end);
	}, [editing, history]);

	// React Flow keeps a new node hidden until it has measured it, and hidden
	// elements can't take focus, so keep trying for a few frames.
	useEffect(() => {
		if (!editing) return;
		let frame = 0;
		let tries = 0;
		const focus = () => {
			const el = field.current;
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

	// Typing or Enter on a selected shape starts editing. This listens in the
	// capture phase and stops the event, so the keystroke isn't also taken as
	// a tool shortcut. With several shapes selected, keys are left alone.
	useEffect(() => {
		if (!selected || editing || readOnly) return;
		const onKey = (event: KeyboardEvent) => {
			if (isEditableTarget(event.target)) return;
			if (event.key !== "Enter" && !isTypingKey(event)) return;
			let count = 0;
			for (const node of store.getState().nodes) if (node.selected) count++;
			if (count !== 1) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.key !== "Enter") onTypeRef.current(event.key);
			setEditing(true);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [selected, editing, readOnly, store]);

	const handlers = {
		onPointerDown: (event: PointerEvent) => {
			// Only a click on a shape that was selected on its own edits it. One
			// in a multi-selection narrows the selection to it instead.
			let count = 0;
			for (const node of store.getState().nodes) if (node.selected) count++;
			press.current = {
				wasSelected: selected && count === 1,
				x: event.clientX,
				y: event.clientY,
			};
		},
		onClick: (event: MouseEvent) => {
			const p = press.current;
			const moved = p ? Math.hypot(event.clientX - p.x, event.clientY - p.y) > 4 : true;
			if (p?.wasSelected && !moved && !event.shiftKey) setEditing(true);
		},
		onDoubleClick: () => setEditing(true),
	};

	return { editing, setEditing, field, handlers };
}
