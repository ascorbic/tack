import { type ReactNode, createContext, createElement } from "react";
import type * as Y from "yjs";
import type { Rect } from "../shared/geometry.ts";
import type { ResizeHandle, SizeOf } from "../shared/sections.ts";
import { type DecisionBoard, DecisionContext } from "./decisions/context.ts";
import type { History } from "./undo.ts";
import { NO_WIDGET_BOARD, type WidgetBoard, WidgetContext } from "./widgets/context.ts";

/** The board's document, for nodes that write to it. */
export const DocContext = createContext<Y.Doc | null>(null);

/** The board's undo history, for nodes that group their edits into one step. */
export const HistoryContext = createContext<History | null>(null);

/**
 * Whether the board is view-only for you (a viewer, the public, or an
 * archived board). Everything that edits in place (stickies, text, section
 * titles and resizing, connectors) checks it. The server enforces it
 * regardless: read-only connections can't write.
 */
export const ReadOnlyContext = createContext(false);

/** What section nodes need from the board around them. */
export interface SectionUI {
	/** Sections a dragged shape would land in if dropped now. */
	dropTargets: ReadonlySet<string>;
	/** How many things are selected: Enter only renames a section selected alone. */
	selectionSize: number;
	/** Show a resize in progress, or stop showing it. */
	setResize: (id: string, rect: Rect | null) => void;
	/** Snap a resize in progress to other shapes, showing guides; null clears them. */
	snapResize: (id: string, rect: Rect, handle: ResizeHandle | null) => Rect;
	sizeOf: SizeOf;
}

export const SectionContext = createContext<SectionUI>({
	dropTargets: new Set(),
	selectionSize: 0,
	setResize: () => {},
	snapResize: (_id, rect) => rect,
	sizeOf: () => undefined,
});

/** Everything a board's nodes read from the board, in one provider. */
export function BoardContext({
	doc,
	history,
	sections,
	readOnly = false,
	decisions = NO_DECISION_BOARD,
	widgets = NO_WIDGET_BOARD,
	children,
}: {
	doc: Y.Doc;
	history: History | null;
	sections: SectionUI;
	readOnly?: boolean;
	/** Who's voting on decisions, and the board's address. */
	decisions?: DecisionBoard;
	/** What widgets need from the board: who's looking, cards being dropped on them (#37). */
	widgets?: WidgetBoard;
	children: ReactNode;
}) {
	return createElement(
		DocContext,
		{ value: doc },
		createElement(
			HistoryContext,
			{ value: history },
			createElement(
				SectionContext,
				{ value: sections },
				createElement(
					ReadOnlyContext,
					{ value: readOnly },
					createElement(
						DecisionContext,
						{ value: decisions },
						createElement(WidgetContext, { value: widgets }, children),
					),
				),
			),
		),
	);
}

const NO_DECISION_BOARD: DecisionBoard = { user: null };
