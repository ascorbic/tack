import { useEffect, useRef } from "react";

// The panels on the right of the board (what's new, history, rules,
// comments, changes) share one place, so they're one group: opening one
// closes whichever was open, so only one top bar button ever looks pressed,
// and Escape closes the one that's open.

export interface PanelState {
	id: string;
	open: boolean;
	close: () => void;
}

/**
 * The panels to close now: every open one other than those that have just
 * opened (were closed last time). If several opened at once, the last
 * listed wins.
 */
export function panelsToClose(wasOpen: ReadonlySet<string>, panels: PanelState[]): string[] {
	const opened = panels.filter((panel) => panel.open && !wasOpen.has(panel.id));
	const keep = opened.at(-1);
	if (!keep) return [];
	return panels.filter((panel) => panel.open && panel.id !== keep.id).map((panel) => panel.id);
}

/**
 * Keep the board's panels exclusive, and let Escape close the open one
 * while focus is in the top bar, where its button is (inside a panel, the
 * panel's own Escape handling applies).
 */
export function useExclusivePanels(panels: PanelState[]): void {
	const wasOpen = useRef<Set<string>>(new Set());
	const latest = useRef(panels);
	latest.current = panels;
	const key = panels.map((panel) => `${panel.id}:${panel.open}`).join(",");

	useEffect(() => {
		const current = latest.current;
		const close = new Set(panelsToClose(wasOpen.current, current));
		for (const panel of current) if (close.has(panel.id)) panel.close();
		wasOpen.current = new Set(
			current.filter((panel) => panel.open && !close.has(panel.id)).map((panel) => panel.id),
		);
	}, [key]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const focus = document.activeElement;
			if (!focus?.closest(".topbar")) return;
			// A menu or field of its own takes Escape first.
			if (focus.closest("input, textarea, select, [role=menu], dialog")) return;
			for (const panel of latest.current) if (panel.open) panel.close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
