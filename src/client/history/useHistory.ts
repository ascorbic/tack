import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { shapesMap } from "../../shared/shapes.ts";
import { HistoryController, type HistoryState } from "./controller.ts";
import type { HistorySource } from "./source.ts";

const CLOSED: HistoryState = {
	open: false,
	status: "idle",
	error: null,
	timeline: null,
	position: null,
	seeking: false,
	playing: false,
	speed: 1,
	section: null,
	steps: [],
	beat: 0,
};

const noSubscribe = () => () => {};

/** History mode for a board, if it has a history to read. */
export function useHistoryMode(live: Y.Doc, source: HistorySource | null) {
	const controller = useMemo(
		() => (source ? new HistoryController(live, source) : null),
		[live, source],
	);
	useEffect(() => () => controller?.destroy(), [controller]);
	const state = useSyncExternalStore(
		controller?.subscribe ?? noSubscribe,
		controller?.getSnapshot ?? (() => CLOSED),
	);
	return { controller, state, view: state.open ? (controller?.view ?? null) : null };
}

/** Which shapes are on a board, re-read whenever shapes come or go. */
export function useShapeIds(doc: Y.Doc): ReadonlySet<string> {
	const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set(shapesMap(doc).keys()));
	useEffect(() => {
		const shapes = shapesMap(doc);
		const update = () => setIds(new Set(shapes.keys()));
		update();
		shapes.observe(update);
		return () => shapes.unobserve(update);
	}, [doc]);
	return ids;
}
