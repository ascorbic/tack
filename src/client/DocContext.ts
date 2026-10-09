import { createContext } from "react";
import type * as Y from "yjs";

/** The board's document, for nodes that write to it. */
export const DocContext = createContext<Y.Doc | null>(null);
