import { useStoreApi } from "@xyflow/react";
import {
	type PointerEvent,
	type MouseEvent,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { HistoryContext, ReadOnlyContext } from "./DocContext.ts";
import { isOffBoardTarget } from "./keys.ts";

/** A key that would type a character, rather than a combination or a named key. */
export function isCharacterKey(
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): boolean {
	return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** How long "↵ to edit" shows on a shape after a key that did nothing. */
const HINT_MS = 1800;

// Which shapes this client is typing into, so the UI around the selection
// (the action bar) can step aside while you write.
const editingShapes = new Map<symbol, string | undefined>();
const editingListeners = new Set<() => void>();
const subscribeEditing = (listener: () => void) => {
	editingListeners.add(listener);
	return () => {
		editingListeners.delete(listener);
	};
};
function setShapeEditing(token: symbol, on: boolean, id?: string): void {
	if (on === editingShapes.has(token)) return;
	if (on) editingShapes.set(token, id);
	else editingShapes.delete(token);
	for (const listener of editingListeners) listener();
}

/** Whether this shape's text is being typed into here. */
export function isEditingShape(id: string): boolean {
	for (const editing of editingShapes.values()) if (editing === id) return true;
	return false;
}

/** Whether a shape's text is being typed into here. */
export function useTextEditing(): boolean {
	return useSyncExternalStore(
		subscribeEditing,
		() => editingShapes.size > 0,
		() => false,
	);
}

/**
 * Text shapes (stickies and text blocks) edit like FigJam's: the whole shape
 * is a drag handle until it's selected. Then a click, a double-click or
 * Enter starts editing, and Escape or clicking away stops it.
 *
 * Typing on a selected shape doesn't start editing. In a session people
 * select each other's stickies all the time, and single keys are shortcuts
 * (tools, Space to pan, Shift+1 to fit) that must never land in someone's
 * note. A key that does nothing else shows "↵ to edit" on the shape instead.
 */
export function useEditing({
	id,
	selected,
	startEditing,
	onType,
}: {
	/** The shape's id, so someone deleting it while you type can be told (see Board). */
	id?: string;
	selected: boolean;
	/** Start in editing mode, for a shape this client just placed. */
	startEditing: boolean;
	/**
	 * Characters typed before the text box could take focus (a shape just
	 * placed takes a few frames to appear): they go at the end of its text.
	 */
	onType: (chars: string) => void;
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
	const [hint, setHint] = useState(false);
	const [token] = useState(() => Symbol("editing"));

	useEffect(() => {
		setShapeEditing(token, editing, id);
		return () => setShapeEditing(token, false);
	}, [token, editing, id]);

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
	// elements can't take focus, so keep trying for a few frames. What's typed
	// meanwhile is held for the text box rather than taken as shortcuts.
	useEffect(() => {
		if (!editing) return;
		let frame = 0;
		let tries = 0;
		let typed = "";
		const hold = (event: KeyboardEvent) => {
			if (isOffBoardTarget(event.target)) return;
			if (isCharacterKey(event)) typed += event.key;
			else if (event.key === "Backspace") typed = typed.slice(0, -1);
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		const release = () => window.removeEventListener("keydown", hold, true);
		const focus = () => {
			const el = field.current;
			el?.focus();
			if (el && document.activeElement === el) {
				release();
				if (typed) onTypeRef.current(typed);
				typed = "";
				el.setSelectionRange(el.value.length, el.value.length);
			} else if (tries++ < 20) {
				frame = requestAnimationFrame(focus);
			} else {
				release();
			}
		};
		window.addEventListener("keydown", hold, true);
		focus();
		return () => {
			release();
			cancelAnimationFrame(frame);
		};
	}, [editing]);

	// Enter on a selected shape starts editing. This listens in the capture
	// phase and stops the event, so it isn't also taken as a shortcut. With
	// several shapes selected, Enter is left alone.
	useEffect(() => {
		if (!selected || editing || readOnly) return;
		const alone = () => {
			let count = 0;
			for (const node of store.getState().nodes) if (node.selected) count++;
			return count === 1;
		};
		const onKey = (event: KeyboardEvent) => {
			if (isOffBoardTarget(event.target)) return;
			if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
				if (!alone()) return;
				event.preventDefault();
				event.stopPropagation();
				setHint(false);
				setEditing(true);
				return;
			}
			// A character no shortcut took: once that's clear, say how to edit.
			if (!isCharacterKey(event) || event.key === " ") return;
			setTimeout(() => {
				if (!event.defaultPrevented && alone()) setHint(true);
			});
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [selected, editing, readOnly, store]);

	useEffect(() => {
		if (!hint) return;
		const timer = setTimeout(() => setHint(false), HINT_MS);
		return () => clearTimeout(timer);
	}, [hint]);

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

	return { editing, setEditing, field, handlers, hint: hint && selected && !editing };
}
