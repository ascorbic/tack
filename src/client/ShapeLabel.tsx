import type { NodeProps } from "@xyflow/react";
import { type ComponentType, memo, useContext } from "react";
import type * as Y from "yjs";
import { type CardWords, describeShape } from "../shared/a11y.ts";
import { type ShapeType, shapesMap } from "../shared/shapes.ts";
import { widgetDefinition } from "../shared/widgetRegistry.ts";
import { type ShapeNode, shapeLabelId } from "./board.ts";
import { useCard } from "./cardStore.ts";
import { DocContext } from "./DocContext.ts";
import { useSilentTexts } from "./facilitation/store.ts";

// Every shape's accessible name (#61): its node is labelled by this hidden
// element (`aria-labelledby`, set with its role description in board.ts),
// so screen readers say "sticky note, Ship the docs, by Kai, in Went well"
// rather than everything inside it, and a card's name follows its live data.

/** A node type whose node is named for screen readers. */
export function withShapeLabel(Node: ComponentType<NodeProps<ShapeNode>>) {
	return memo(function WithShapeLabel(props: NodeProps<ShapeNode>) {
		return (
			<>
				<Node {...props} />
				<ShapeLabel id={props.id} shape={props.data.shape} count={props.data.count} />
			</>
		);
	});
}

interface LabelProps {
	id: string;
	shape: ShapeNode["data"]["shape"];
	/** A section's count, so its name is said again when what's in it changes. */
	count?: number;
}

/**
 * Only what a shape's name depends on is watched: a card's live data for
 * shapes that follow an item, your own hidden words for stickies, so a
 * board of 500 cards doesn't re-render every name when one changes.
 */
function ShapeLabel(props: LabelProps) {
	if (props.shape.type === "sticky") return <StickyLabel {...props} />;
	if (props.shape.ref) return <ItemLabel {...props} />;
	return <Label {...props} />;
}

function StickyLabel(props: LabelProps) {
	const hidden = useSilentTexts();
	return <Label {...props} hiddenText={hidden.get(props.id)} />;
}

function ItemLabel(props: LabelProps) {
	const card = useCard(props.shape.ref ?? "");
	return <Label {...props} card={card ? cardWords(card) : undefined} />;
}

function Label({
	id,
	shape,
	card,
	hiddenText,
}: LabelProps & { card?: CardWords; hiddenText?: string }) {
	const doc = useContext(DocContext);
	const text = describeShape(id, shape, {
		card: () => card,
		sectionTitle: (section) => (doc ? titleOf(doc, section) : undefined),
		contents: (section) => (doc ? contentsOf(doc, section) : []),
		widgetName: (kind) => widgetDefinition(kind)?.title,
		hiddenText: () => hiddenText,
	});
	return (
		// Its own aria-label, not text, so it's never found as text on the page.
		<span id={shapeLabelId(id)} hidden aria-label={text} />
	);
}

function cardWords(card: NonNullable<ReturnType<typeof useCard>>): CardWords {
	if ("missing" in card) return { missing: true };
	return {
		item: card.item,
		repo: card.repo.split("/").at(-1),
		title: card.title,
		state: card.state,
		kind: card.kind,
	};
}

function titleOf(doc: Y.Doc, id: string): string | undefined {
	const section = shapesMap(doc).get(id);
	if (!section || section.get("type") !== "section") return undefined;
	const title = section.get("title");
	return typeof title === "string" ? title : "";
}

function contentsOf(doc: Y.Doc, id: string): ShapeType[] {
	const out: ShapeType[] = [];
	for (const shape of shapesMap(doc).values()) {
		if (shape.get("parent") === id) out.push(shape.get("type") as ShapeType);
	}
	return out;
}
