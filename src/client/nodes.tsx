import { type NodeProps, useStore } from "@xyflow/react";
import { createContext, memo, useContext, useState } from "react";
import type * as Y from "yjs";
import { isFresh, type ShapeNode, setStickyText } from "./board.ts";
import { CardView } from "./CardView.tsx";
import { useCard } from "./cardStore.ts";

export const DocContext = createContext<Y.Doc | null>(null);

/** Below this zoom, cards switch to their simplified rendering. */
const COMPACT_ZOOM = 0.45;

export const CardNode = memo(function CardNode({ data, selected }: NodeProps<ShapeNode>) {
	const key = data.shape.ref ?? "";
	const card = useCard(key);
	// A boolean selector only re-renders when the threshold is crossed.
	const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM);
	const [enter] = useState(() => isFresh(data.id));
	return <CardView card={card} cardKey={key} selected={selected} compact={compact} enter={enter} />;
});

/** A small, stable tilt per sticky, so a cluster looks hand-placed. */
function tilt(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return ((hash % 300) / 100) * 0.6;
}

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const [enter] = useState(() => isFresh(data.id));
	return (
		<div
			className="sticky"
			data-enter={enter}
			data-color={data.shape.color ?? "yellow"}
			data-selected={selected}
			style={{ "--tilt": `${tilt(data.id)}deg` } as React.CSSProperties}
		>
			<textarea
				className="nodrag"
				aria-label="Sticky note"
				placeholder="Type something…"
				value={data.shape.text ?? ""}
				onChange={(event) => doc && setStickyText(doc, data.id, event.target.value)}
			/>
		</div>
	);
});

export const nodeTypes = { card: CardNode, sticky: StickyNode };
