import { createContext } from "react";
import type { Card } from "../../shared/cards.ts";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";

/** Cards being dragged over (or just dropped on) a list, to make them match it (#39). */
export interface MatchDrop {
	widget: string;
	/** The dragged cards' shapes. */
	shapes: string[];
}

/** What widget nodes need from the board around them. */
export interface WidgetBoard {
	user: User | null;
	toasts: ToastStore | null;
	/** Cards being dragged over a list right now. */
	hovering: MatchDrop | null;
	/** Cards just dropped on a list, waiting for the person to confirm the changes. */
	dropped: MatchDrop | null;
	/** Close the drop-to-match confirmation. */
	closeDrop: () => void;
	/** Select these shapes (say, a card just dragged out of a list). */
	select: (ids: string[]) => void;
	/** Bring these shapes into view, and flash them. */
	reveal: (ids: string[]) => void;
	/** Put a card's data where the board's cards read it, before its shape appears. */
	seedCard: (card: Card) => void;
}

export const NO_WIDGET_BOARD: WidgetBoard = {
	user: null,
	toasts: null,
	hovering: null,
	dropped: null,
	closeDrop: () => {},
	select: () => {},
	reveal: () => {},
	seedCard: () => {},
};

export const WidgetContext = createContext<WidgetBoard>(NO_WIDGET_BOARD);
