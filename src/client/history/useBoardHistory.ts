import { useEffect, useRef } from "react";
import { markFresh } from "../board.ts";
import { isOffBoardTarget } from "../keys.ts";
import { SHORTCUTS, isApplePlatform, matchesCombo } from "../shortcuts.ts";
import type { ToastStore } from "../Toasts.tsx";
import type { HistoryController } from "./controller.ts";
import type { Restored } from "./restore.ts";

// History mode's wiring into the board: what happens after restoring, and
// the keys that drive it.

const NOUNS: Record<string, [string, string]> = {
	card: ["card", "cards"],
	sticky: ["sticky", "stickies"],
	text: ["text", "texts"],
	section: ["section", "sections"],
	connector: ["connector", "connectors"],
	decision: ["decision", "decisions"],
	widget: ["widget", "widgets"],
	pile: ["pile", "piles"],
};

/** "Brought back 2 stickies", "Restored a copy of a section". */
export function restoredMessage(restored: Restored): string {
	const [one, many] = NOUNS[restored.type ?? ""] ?? ["shape", "shapes"];
	const things =
		restored.count === 1
			? `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`
			: `${restored.count} ${many}`;
	return restored.inPlace ? `Brought back ${things}` : `Restored a copy of ${things}`;
}

/** After restoring: back to the live board, with what came back selected, shown and undoable. */
export function useRestored(
	controller: HistoryController | null,
	board: {
		toasts: ToastStore;
		undo: () => void;
		select: (ids: string[]) => void;
		reveal: (ids: string[]) => void;
	},
): void {
	const latest = useRef(board);
	latest.current = board;
	useEffect(() => {
		if (!controller) return;
		controller.onRestored = (restored) => {
			const { toasts, undo, select, reveal } = latest.current;
			markFresh(restored.ids);
			controller.close();
			select(restored.ids);
			toasts.show({
				message: restoredMessage(restored),
				action: { label: "Undo", hint: "⌘Z", run: undo },
			});
			// Once the live board is back on the canvas.
			requestAnimationFrame(() => reveal(restored.ids));
		};
		return () => {
			controller.onRestored = null;
		};
	}, [controller]);
}

const OPEN = SHORTCUTS.find((shortcut) => shortcut.id === "history")?.combos ?? [];

/**
 * ⌘⌥⇧H opens and closes history. While it's open: Space plays and pauses,
 * ← and → step, Escape closes. Keys typed into fields are left alone.
 */
export function useHistoryKeys(
	controller: HistoryController | null,
	open: boolean,
	toggle: () => void,
): void {
	useEffect(() => {
		if (!controller) return;
		const apple = isApplePlatform();
		const onKey = (event: KeyboardEvent) => {
			if (OPEN.some((combo) => matchesCombo(event, combo, apple))) {
				event.preventDefault();
				toggle();
				return;
			}
			if (!open || isOffBoardTarget(event.target)) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				controller.toggle();
			} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				event.stopPropagation();
				controller.pause();
				controller.stepBy((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
			} else if (event.key === "Escape") {
				controller.close();
			}
		};
		// Before the board's own keys (nudging, panning with Space).
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [controller, open, toggle]);
}
