import { NodeToolbar, Position, ViewportPortal } from "@xyflow/react";
import type { Actor, StepMeta } from "../../shared/history.ts";
import type { SizeOf } from "../../shared/sections.ts";
import type { HistoryController, HistoryState } from "./controller.ts";
import { ActorAvatar, RestoreIcon, actorColor } from "./parts.tsx";
import { useShapeIds } from "./useHistory.ts";
import type * as Y from "yjs";

// What history draws on the canvas while it's open: who changed what at the
// step shown (outlines in their colour, with their name, flashing as the
// step lands; dashed ghosts where shapes were removed), and, for shapes
// selected in the past, a bar to bring them back.

/** More marks than this and they'd only be noise. */
const MAX_MARKS = 40;

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
					const actor = actors[key];
					const [x, y, w, h] = change.box!;
					// Shapes on the board now have a measured size; removed ones keep their nominal one.
					const size = change.op === "remove" ? undefined : sizeOf(change.id);
					const showName = !named.has(key);
					named.add(key);
					return (
						<div
							key={`${change.id}-${i}`}
							className="replay-mark"
							data-op={change.op}
							style={
								{
									transform: `translate(${x}px, ${y}px)`,
									width: `${size?.w ?? w}px`,
									height: `${size?.h ?? h}px`,
									"--mark": actorColor(actor),
									"--i": i,
								} as React.CSSProperties
							}
						>
							{showName && actor && (
								<span className="replay-mark-flag">
									<ActorAvatar actor={actor} size={14} />
									{actor.name}
									{change.op === "remove" && <span className="replay-mark-op">removed</span>}
								</span>
							)}
						</div>
					);
				})}
			</div>
		</ViewportPortal>
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
	const anyLive = selected.some((id) => liveIds.has(id));
	const label = anyLive ? "Restore a copy" : "Bring back";
	const hint = anyLive
		? "As it was then, beside what’s there now"
		: "Where it was, as your own edit";
	return (
		<NodeToolbar nodeId={[...selected]} isVisible position={Position.Top} offset={16}>
			<div className="history-restore-bar nodrag nopan" role="toolbar" aria-label="Restore">
				<button
					type="button"
					className="history-restore-button"
					data-tooltip={`${hint} (⌘Z undoes it)`}
					onClick={() => controller.restore(selected, sizeOf)}
				>
					<RestoreIcon />
					{label}
					{selected.length > 1 && <span className="history-restore-count">{selected.length}</span>}
				</button>
			</div>
		</NodeToolbar>
	);
}
