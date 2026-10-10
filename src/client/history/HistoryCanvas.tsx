import { NodeToolbar, Position, ViewportPortal } from "@xyflow/react";
import type * as Y from "yjs";
import type { Actor, ShapeChange, StepMeta } from "../../shared/history.ts";
import type { SizeOf } from "../../shared/sections.ts";
import type { HistoryController, HistoryState } from "./controller.ts";
import { ActorAvatar, RestoreIcon, actorColor } from "./parts.tsx";
import { useShapeIds } from "./useHistory.ts";

// What history draws on the canvas while it's open: who changed what at the
// step shown (outlines in their colour, with their name, flashing as the
// step lands; dashed ghosts where shapes were removed), and, for shapes
// selected in the past, a bar to bring them back.

/** More marks than this and they'd only be noise. */
const MAX_MARKS = 40;
/** Above every shape, as the selection actions are. */
const TOOLBAR_Z = 3000;

export function HistoryCanvas({
	controller,
	state,
	live,
	selected,
	readOnly,
	sizeOf,
}: {
	controller: HistoryController;
	state: HistoryState;
	live: Y.Doc;
	/** Shapes selected on the replayed board. */
	selected: readonly string[];
	/** View only: nothing can be brought back. */
	readOnly: boolean;
	sizeOf: SizeOf;
}) {
	const step =
		state.position === null
			? null
			: (state.timeline?.steps.find((s) => s.id === state.position) ?? null);
	return (
		<>
			{step && !step.origin && (
				<ReplayMarks
					key={state.beat}
					step={step}
					actors={state.timeline?.actors ?? {}}
					sizeOf={sizeOf}
				/>
			)}
			{!readOnly && state.position !== null && selected.length > 0 && (
				<RestoreBar controller={controller} live={live} selected={selected} sizeOf={sizeOf} />
			)}
		</>
	);
}

function ReplayMarks({
	step,
	actors,
	sizeOf,
}: {
	step: StepMeta;
	actors: Record<string, Actor>;
	sizeOf: SizeOf;
}) {
	const marks = step.changes.filter((change) => change.box).slice(0, MAX_MARKS);
	// One name per person: on the first of their marks.
	const named = new Set<string>();
	return (
		<ViewportPortal>
			<div className="replay-marks" aria-hidden="true">
				{marks.map((change, i) => {
					const key = change.by?.[0] ?? step.actors[0] ?? "";
					const first = !named.has(key);
					named.add(key);
					// Shapes on the board then have a measured size now; removed ones keep their nominal one.
					const size = change.op === "remove" ? undefined : sizeOf(change.id);
					return (
						<ReplayMark
							key={`${change.id}-${i}`}
							change={change}
							actor={actors[key]}
							named={first}
							index={i}
							size={size}
						/>
					);
				})}
			</div>
		</ViewportPortal>
	);
}

/** One shape's mark: an outline in its author's colour, with their name if it's their first. */
export function ReplayMark({
	change,
	actor,
	named,
	index = 0,
	size,
}: {
	change: ShapeChange;
	actor: Actor | undefined;
	named: boolean;
	index?: number;
	size?: { w: number; h: number };
}) {
	const [x, y, w, h] = change.box ?? [0, 0, 0, 0];
	return (
		<div
			className="replay-mark"
			data-op={change.op}
			style={
				{
					transform: `translate(${x}px, ${y}px)`,
					width: `${size?.w ?? w}px`,
					height: `${size?.h ?? h}px`,
					"--mark": actorColor(actor),
					"--i": index,
				} as React.CSSProperties
			}
		>
			{named && actor && (
				<span className="replay-mark-flag">
					<ActorAvatar actor={actor} size={14} />
					{actor.name}
					{change.op === "remove" && <span className="replay-mark-op">removed</span>}
				</span>
			)}
		</div>
	);
}

function RestoreBar({
	controller,
	live,
	selected,
	sizeOf,
}: {
	controller: HistoryController;
	live: Y.Doc;
	selected: readonly string[];
	sizeOf: SizeOf;
}) {
	const liveIds = useShapeIds(live);
	return (
		<NodeToolbar
			nodeId={[...selected]}
			isVisible
			position={Position.Top}
			offset={16}
			style={{ zIndex: TOOLBAR_Z }}
		>
			<RestoreButton
				count={selected.length}
				copy={selected.some((id) => liveIds.has(id))}
				onRestore={() => controller.restore(selected, sizeOf)}
			/>
		</NodeToolbar>
	);
}

/**
 * Bring back what's selected: "Bring back" for shapes that are gone,
 * "Restore a copy" when any of them is still on the board.
 */
export function RestoreButton({
	count,
	copy,
	onRestore,
}: {
	count: number;
	copy: boolean;
	onRestore: () => void;
}) {
	const hint = copy ? "As it was then, beside what’s there now" : "Where it was, as your own edit";
	return (
		<div className="history-restore-bar nodrag nopan" role="toolbar" aria-label="Restore">
			<button
				type="button"
				className="history-restore-button"
				title={`${hint}. ⌘Z undoes it.`}
				onClick={onRestore}
			>
				<RestoreIcon />
				{copy ? "Restore a copy" : "Bring back"}
				{count > 1 && <span className="history-restore-count">{count}</span>}
			</button>
		</div>
	);
}
