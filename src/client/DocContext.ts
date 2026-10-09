import { createContext } from "react";
import type * as Y from "yjs";
import type { History } from "./undo.ts";

/** The board's document, for nodes that write to it. */
export const DocContext = createContext<Y.Doc | null>(null);

/** The board's undo history, for nodes that group their edits into one step. */
export const HistoryContext = createContext<History | null>(null);
