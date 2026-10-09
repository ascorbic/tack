import { createContext } from "react";
import type { User } from "../presence.ts";

/**
 * What decision nodes need from the board around them: who's looking (to
 * vote, and to sign what they stage) and the board's address, which the
 * written-back record links to.
 */
export interface DecisionBoard {
	user: User | null;
	boardUrl?: string;
}

export const DecisionContext = createContext<DecisionBoard>({ user: null });
