import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { describeBoard } from "../shared/a11y.ts";
import { type ShapeType, shapesMap } from "../shared/shapes.ts";
import { type EditEntry, describeEdits, isNews, shapeChanges } from "../shared/since.ts";
import { announce } from "./announce.tsx";
import type { ShapeNode } from "./board.ts";

// The board for screen readers (#61): a link past the top bar to the board,
// the board in a few sentences (its region's description), and other
// people's changes said as they land, gathered up so a busy session isn't
// a stream of chatter.

/** The first thing on a board's page for the keyboard: straight to the board. */
export function SkipToBoard({ onSkip }: { onSkip: () => void }) {
	return (
		<a
			className="skip-link"
			href="#board"
			onClick={(event) => {
				event.preventDefault();
				onSkip();
			}}
		>
			Skip to board
		</a>
	);
}

/** How long the summary waits for the board to settle before it's rewritten. */
const SUMMARY_MS = 600;

/** The board in words, kept current (a little behind) as it changes. */
export function BoardSummary({ id, nodes }: { id: string; nodes: readonly ShapeNode[] }) {
	const [settled, setSettled] = useState(nodes);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(nodes), SUMMARY_MS);
		return () => clearTimeout(timer);
	}, [nodes]);
	const text = useMemo(
		() =>
			describeBoard(
				settled.map((node) => ({
					id: node.id,
					type: node.data.shape.type,
					parent: node.data.shape.parent ?? null,
					title: node.data.shape.title,
					x: node.data.shape.x,
					y: node.data.shape.y,
				})),
			),
		[settled],
	);
	return (
		<p id={id} className="visually-hidden">
			{text}
		</p>
	);
}

/** Gather other people's changes for this long after the last before saying them. */
const QUIET_MS = 2500;
/** …but never hold them for longer than this. */
const MAX_WAIT_MS = 8000;
/** Changes arriving this soon after opening are the board loading, not news. */
const SETTLE_MS = 2000;

/**
 * Say other people's changes to the board, politely: "Others added 2 sticky
 * notes and moved 1 card". Changes made here, and the board loading, aren't
 * said.
 */
export function useAnnounceRemoteChanges(doc: Y.Doc, synced: boolean): void {
	useEffect(() => {
		if (!synced) return;
		const shapes = shapesMap(doc);
		const types = new Map<string, string>();
		for (const [id, shape] of shapes) {
			const type = shape.get("type");
			if (typeof type === "string") types.set(id, type);
		}
		const since = performance.now();
		// One entry per shape and kind of change: typing in a sticky is one edit.
		let pending = new Map<string, EditEntry>();
		let first = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = () => {
			timer = undefined;
			// A shape that arrived was added, whatever happened to it next.
			const edits = [...pending.values()].filter(
				(edit) => edit.kind === "added" || !pending.has(`${edit.shape}:added`),
			);
			pending = new Map();
			if (edits.length > 0) announce(`Others ${describeEdits(edits)}`);
		};
		const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
			const { changes } = shapeChanges(events, shapes);
			for (const change of changes) {
				const live = shapes.get(change.shape)?.get("type");
				const type = typeof live === "string" ? live : (types.get(change.shape) ?? "");
				if (change.kind === "removed") types.delete(change.shape);
				else types.set(change.shape, type);
				if (transaction.local || !type || !isNews(type, change.kind)) continue;
				if (performance.now() - since < SETTLE_MS) continue;
				pending.set(`${change.shape}:${change.kind}`, {
					shape: change.shape,
					kind: change.kind,
					type: type as ShapeType,
					at: Date.now(),
					by: { kind: "person" },
				});
			}
			if (pending.size === 0) return;
			const now = performance.now();
			if (!timer) first = now;
			clearTimeout(timer);
			timer = setTimeout(flush, Math.max(0, Math.min(QUIET_MS, first + MAX_WAIT_MS - now)));
		};
		shapes.observeDeep(observer);
		return () => {
			shapes.unobserveDeep(observer);
			clearTimeout(timer);
		};
	}, [doc, synced]);
}
