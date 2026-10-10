import { useStore } from "@xyflow/react";
import {
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type * as Y from "yjs";
import { boardRepos } from "../../shared/actions.ts";
import type { Card } from "../../shared/cards.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { readConfig, updateWidgetConfig } from "../../shared/widgetRegistry.ts";
import type {
	QueryError,
	SearchResult,
	WidgetDefinition,
	WidgetQuery,
} from "../../shared/widgets.ts";
import { isFresh, takeFocus } from "../board.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { transactLocal } from "../undo.ts";
import { WidgetContext } from "./context.ts";
import { useRowDrag } from "./RowDrag.tsx";
import { WidgetPanel } from "./WidgetPanel.tsx";
import {
	type WidgetData,
	linkStore,
	useBoardCards,
	useRefreshing,
	useWidgetData,
	widgetStore,
} from "./store.ts";

// What every widget node shares, whatever its kind: its config read through
// its schema, its data, refreshing, the panel beside it, resize grips, rows
// that come out as cards and light up with theirs, and when to draw it
// simplified for reading zoomed out.

/** Below this zoom, widgets draw their simplified, zoomed-out view (as cards do). */
export const COMPACT_ZOOM = 0.45;

/** Results older than this many refresh periods are stale: a refresh must have failed. */
const STALE_PERIODS = 2;

/** What a widget built on searches shows. */
export type SearchStatus =
	| { kind: "unconfigured" }
	| { kind: "loading" }
	| { kind: "ready"; results: Record<string, SearchResult>; at: number; stale: boolean }
	| { kind: "error"; error: QueryError };

/**
 * A search widget's status, from its queries and the latest data: loading
 * until every query has answered, an error if any did, otherwise ready
 * (stale once it's missed refreshes).
 */
export function searchStatus(
	queries: Record<string, WidgetQuery>,
	data: Pick<WidgetData, "results" | "at"> | undefined,
	now: number,
	refresh = 300,
): SearchStatus {
	const names = Object.keys(queries);
	if (names.length === 0) return { kind: "unconfigured" };
	if (!data) return { kind: "loading" };
	const results: Record<string, SearchResult> = {};
	for (const name of names) {
		const result = data.results[name];
		if (!result) return { kind: "loading" };
		if (result.kind === "error") return { kind: "error", error: result };
		if (result.kind !== "search") return { kind: "loading" };
		results[name] = result;
	}
	return {
		kind: "ready",
		results,
		at: data.at,
		stale: now - data.at > refresh * 1000 * STALE_PERIODS,
	};
}

/** The board's busiest repository, for ready-made settings: its host and `owner/name`. */
export function suggestedRepo(doc: Y.Doc | null): { host: string; repo: string } | null {
	const busiest = doc ? boardRepos(doc)[0]?.repo : undefined;
	if (!busiest) return null;
	const [host = "", ...rest] = busiest.split("/");
	return { host, repo: rest.join("/") };
}

/** Whether the board is zoomed out far enough for widgets' simplified views. */
export function useCompact(): boolean {
	// A boolean selector only re-renders when the threshold is crossed.
	return useStore((state) => state.transform[2] < COMPACT_ZOOM);
}

/** Everything a widget node of a kind needs, read once. */
export function useWidgetHost<Config>(
	id: string,
	shape: ShapeProps,
	definition: WidgetDefinition<Config>,
) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const board = useContext(WidgetContext);
	const config = useMemo(() => readConfig(definition, shape.config), [definition, shape.config]);
	const queries = useMemo(
		() => definition.queries(config, { now: Date.now(), cardsIn: () => [] }),
		[definition, config],
	);
	const configured = Object.keys(queries).length > 0;
	const data = useWidgetData(id);
	const refreshing = useRefreshing(id);
	const [enter] = useState(() => isFresh(id));
	// One this person just added, that needs setting up, opens its panel.
	const [configOpen, setConfigOpen] = useState(() => takeFocus(id) && !readOnly && !configured);

	// After the queries change, the results on hand are for the old ones.
	const queryKey = JSON.stringify(queries);
	const [awaiting, setAwaiting] = useState(false);
	const lastQuery = useRef(queryKey);
	const lastData = useRef(data);
	useEffect(() => {
		if (lastQuery.current !== queryKey) setAwaiting(true);
		lastQuery.current = queryKey;
	}, [queryKey]);
	useEffect(() => {
		if (lastData.current !== data) setAwaiting(false);
		lastData.current = data;
	}, [data]);

	const status = searchStatus(queries, data, Date.now(), definition.refresh);
	return {
		doc,
		readOnly,
		board,
		config,
		configured,
		status,
		enter,
		refreshing: refreshing || (awaiting && status.kind === "ready"),
		configOpen,
		setConfigOpen,
		toggleConfig: readOnly ? undefined : () => setConfigOpen((open) => !open),
		refresh: configured ? () => widgetStore.refresh(id) : undefined,
		change: (changes: Partial<Config>) => {
			if (doc) transactLocal(doc, () => updateWidgetConfig(doc, id, changes));
		},
	};
}

/** Rows of items: dragged out as cards, lit up with their cards, pinned when on the board. */
export interface RowProps {
	readOnly?: boolean;
	onBoard?: (key: string) => boolean;
	/** The item someone's pointing at on the board. */
	linked?: string | null;
	/** The row being dragged out. */
	lifted?: string | null;
	onRowHover?: (key: string | null) => void;
	onRowPointerDown?: (event: ReactPointerEvent<HTMLElement>, card: Card) => void;
	onReveal?: (key: string) => void;
	/** Clicked, or Enter: its card on the board, shown if it's there, else added beside the widget. */
	onRowActivate?: (card: Card) => void;
}

/** Row behaviour for a widget on the board. */
export function useRows(id: string): RowProps {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const board = useContext(WidgetContext);
	const cards = useBoardCards(doc);
	const linked = useSyncExternalStore(linkStore.subscribe, () => {
		const { key, source } = linkStore.get();
		return source === "card" ? key : null;
	});
	const drag = useRowDrag({
		widget: id,
		doc,
		enabled: !readOnly,
		onPlaced: (shape) => board.select([shape]),
		seedCard: board.seedCard,
	});
	return {
		readOnly,
		onBoard: (key) => (cards?.shapesFor(key).length ?? 0) > 0,
		linked,
		lifted: drag.lifted,
		onRowHover: (key) => linkStore.set(key, "row"),
		onRowPointerDown: drag.onPointerDown,
		onReveal: (key) => board.reveal(cards?.shapesFor(key) ?? []),
		onRowActivate: (card) => {
			const placed = cards?.shapesFor(card.key) ?? [];
			if (placed.length > 0) board.reveal(placed);
			else drag.activate(card);
		},
	};
}

/** A widget's config panel, floating beside it. */
export function ConfigToolbar({
	id,
	open,
	children,
}: {
	id: string;
	open: boolean;
	children: ReactNode;
}) {
	return (
		<WidgetPanel nodeId={id} open={open}>
			{children}
		</WidgetPanel>
	);
}
