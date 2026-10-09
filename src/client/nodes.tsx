import { type NodeProps, useStore } from "@xyflow/react";
import { memo, useState } from "react";
import { isFresh, type ShapeNode } from "./board.ts";
import { CardView } from "./CardView.tsx";
import { useCard } from "./cardStore.ts";
import { StickyNode } from "./StickyNode.tsx";
import { TextNode } from "./TextNode.tsx";

export { DocContext } from "./DocContext.ts";

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

export const nodeTypes = { card: CardNode, sticky: StickyNode, text: TextNode };
