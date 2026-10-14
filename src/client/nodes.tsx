import { type NodeProps, useStore } from "@xyflow/react";
import { memo, useContext, useState } from "react";
import { isFresh, type ShapeNode } from "./board.ts";
import { CardView } from "./CardView.tsx";
import { useCard } from "./cardStore.ts";
import { DocContext, ReadOnlyContext } from "./DocContext.ts";
import { entranceOf } from "./entering.ts";
import { useCardProvenance } from "./Provenance.tsx";
import { StickyNode } from "./StickyNode.tsx";
import { TextNode } from "./TextNode.tsx";
import { ActionItemNode } from "./actionItems/ActionItemNode.tsx";
import { DecisionNode } from "./decisions/DecisionNode.tsx";
import { LinkNode } from "./links/LinkNode.tsx";
import { ImageNode } from "./images/ImageNode.tsx";
import { StackNode } from "./stacks/StackNode.tsx";
import { useLinked } from "./widgets/store.ts";
import { useCardVolunteers } from "./volunteers/Volunteers.tsx";
import { isMissing } from "../shared/cards.ts";
import { WidgetNode } from "./widgets/WidgetNode.tsx";

export { DocContext };

/** Below this zoom, cards switch to their simplified rendering. */
const COMPACT_ZOOM = 0.45;

export const CardNode = memo(function CardNode({ data, selected }: NodeProps<ShapeNode>) {
	const key = data.shape.ref ?? "";
	const card = useCard(key);
	// A boolean selector only re-renders when the threshold is crossed.
	const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM);
	const [enter] = useState(() => isFresh(data.id));
	const [entrance] = useState(() => entranceOf(data.id));
	const { origin, unmatched } = useCardProvenance(
		useContext(DocContext),
		data.id,
		data.shape,
		useContext(ReadOnlyContext),
	);
	// Someone's pointing at this item's row in a list (#38).
	const linked = useLinked(key, "row");
	// Who's put their hand up for it, on this board.
	const volunteers = useCardVolunteers(data.id, card && !isMissing(card) ? card : null);
	return (
		<div className="card-link" data-linked={linked || undefined}>
			<CardView
				card={card}
				cardKey={key}
				selected={selected}
				compact={compact}
				enter={enter}
				entrance={entrance}
				origin={origin}
				unmatched={unmatched}
				volunteers={volunteers}
			/>
		</div>
	);
});

export const nodeTypes = {
	card: CardNode,
	sticky: StickyNode,
	text: TextNode,
	decision: DecisionNode,
	widget: WidgetNode,
	action: ActionItemNode,
	stack: StackNode,
	link: LinkNode,
	image: ImageNode,
};
