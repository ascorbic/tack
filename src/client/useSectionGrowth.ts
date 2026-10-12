import { useEffect, useRef } from "react";
import type * as Y from "yjs";
import type { Rect } from "../shared/geometry.ts";
import { GROW_ORIGIN, growSections, planGrowth, writeBoxes } from "../shared/growth.ts";
import { type SizeOf, boxOf } from "../shared/sections.ts";
import { LOCAL_ORIGIN, shapesMap } from "../shared/shapes.ts";
import { readShapes } from "../shared/structure.ts";
import { type History, affectedEntries } from "./undo.ts";

// Sections growing for what changes size after it's placed (growth.ts). A
// drop, a paste or a new shape grows its section in its own transaction, at
// the size the shape is known to be then; a card that was placed at its
// nominal size and loads taller, or text that wraps onto another line,
// changes size afterwards, with no transaction of its own. So shapes this
// person touched a moment ago are watched as they're measured, and if one
// now reaches over its section's edge the section grows, as part of the
// undo step that placed it while that's still the latest (undo takes both
// back), or otherwise on its own, untracked. Only what this person touched:
// everyone measures, but the person who placed a shape grows its section,
// and growing only ever makes a section bigger, so nothing fights.
//
// An open stack's tray is this person's view, but it's on the board for
// everyone to see them work in, so its section grows to hold it too.

/** How long after touching a shape its size changing still grows its section. */
const WATCH_MS = 20_000;

type Measured = ReadonlyMap<string, { width: number; height: number }>;

interface Touched {
	at: number;
	/** The undo step that touched it, to grow its section in. */
	step: ReturnType<History["top"]>;
}

export function useSectionGrowth({
	doc,
	history,
	measured,
	boxSize,
	open,
	enabled,
}: {
	/** The live board. */
	doc: Y.Doc;
	history: History;
	/** Shapes' measured sizes: a new map whenever any change. */
	measured: Measured;
	boxSize: SizeOf;
	/** The stack open here, and its tray as drawn. */
	open: { id: string; tray: Rect } | null;
	/** Off on view-only boards and while history's open. */
	enabled: boolean;
}): void {
	const touched = useRef(new Map<string, Touched>());

	// What this person's own changes touched, and which undo step they're in.
	// The undo manager hears each transaction first, so its step is on top.
	useEffect(() => {
		if (!enabled) return;
		const shapes = shapesMap(doc);
		const onTransaction = (transaction: Y.Transaction) => {
			if (transaction.origin !== LOCAL_ORIGIN) return;
			const step = history.top();
			const at = Date.now();
			for (const id of affectedEntries(transaction.changedParentTypes)) {
				if (shapes.has(id)) touched.current.set(id, { at, step });
			}
		};
		doc.on("afterTransaction", onTransaction);
		return () => {
			doc.off("afterTransaction", onTransaction);
			touched.current.clear();
		};
	}, [doc, history, enabled]);

	// Something touched changed size: grow its section if it reaches over.
	const last = useRef<Measured>(measured);
	useEffect(() => {
		const before = last.current;
		last.current = measured;
		if (!enabled || touched.current.size === 0) return;
		const now = Date.now();
		const steps = new Map<Touched["step"], string[]>();
		for (const [id, entry] of touched.current) {
			if (now - entry.at > WATCH_MS) {
				touched.current.delete(id);
				continue;
			}
			const size = measured.get(id);
			const was = before.get(id);
			if (!size || (was && was.width === size.width && was.height === size.height)) continue;
			const list = steps.get(entry.step);
			if (list) list.push(id);
			else steps.set(entry.step, [id]);
		}
		if (steps.size === 0) return;
		const shapes = readShapes(doc);
		for (const [step, ids] of steps) {
			const boxes = ids.flatMap((id) => {
				const shape = shapes.get(id);
				return shape ? [[id, boxOf(id, shape, boxSize)] as const] : [];
			});
			const plan = planGrowth(shapes, boxes);
			if (plan.size === 0) continue;
			if (!history.amend(step, () => writeBoxes(doc, plan))) {
				doc.transact(() => writeBoxes(doc, plan), GROW_ORIGIN);
			}
		}
	}, [doc, history, measured, boxSize, enabled]);

	// A stack opened here: its section holds its tray, as it grows with what's measured in it.
	const trayKey = open
		? `${open.id}:${open.tray.x},${open.tray.y},${open.tray.w},${open.tray.h}`
		: "";
	const openRef = useRef(open);
	openRef.current = open;
	useEffect(() => {
		const current = openRef.current;
		if (!enabled || !current) return;
		doc.transact(() => {
			growSections(doc, [current.id], boxSize, (id) =>
				id === current.id ? current.tray : undefined,
			);
		}, GROW_ORIGIN);
	}, [doc, boxSize, enabled, trayKey]);
}
