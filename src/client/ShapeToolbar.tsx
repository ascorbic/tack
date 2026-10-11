import { NodeToolbar, Position } from "@xyflow/react";
import { useRef } from "react";
import type * as Y from "yjs";
import { type ShapeFont, type TextSize, updateShapes } from "../shared/shapes.ts";
import { STICKY_COLORS, type ShapeNode, type StickyColor } from "./board.ts";
import { useInsideCanvas } from "./useInsideCanvas.ts";

const SIZES: { size: TextSize; label: string; name: string }[] = [
	{ size: "s", label: "S", name: "Small" },
	{ size: "m", label: "M", name: "Medium" },
	{ size: "l", label: "L", name: "Large" },
	{ size: "xl", label: "XL", name: "Extra large" },
];

/** The value every item shares, or undefined when they differ. */
function common<T>(values: T[]): T | undefined {
	const first = values[0];
	return values.every((value) => value === first) ? first : undefined;
}

/** The selected shapes this toolbar styles: stickies and text. */
export function styledShapes(selected: ShapeNode[]): ShapeNode[] {
	return selected.filter((node) => node.type === "sticky" || node.type === "text");
}

/**
 * A small toolbar floating above the selected stickies and text, like
 * FigJam's: colour, typeface and size. Each change is one transaction
 * across the whole selection.
 */
export function ShapeToolbar({
	doc,
	selected,
	dragging,
	onStickyColor,
}: {
	doc: Y.Doc;
	/** The selected nodes; cards and other shapes are ignored. */
	selected: ShapeNode[];
	/**
	 * Hidden while shapes are dragged. (React Flow's own `dragging` flag
	 * never reaches our controlled nodes, so the board passes this in.)
	 */
	dragging: boolean;
	/** Called when stickies are recoloured, so new ones match. */
	onStickyColor?: (color: StickyColor) => void;
}) {
	const stickies = selected.filter((node) => node.type === "sticky");
	const texts = selected.filter((node) => node.type === "text");
	const shapes = [...stickies, ...texts];
	const toolbar = useRef<HTMLDivElement>(null);
	// With two or more selected, the arrange toolbar sits above this one.
	const stacked = selected.length >= 2;
	useInsideCanvas(toolbar, { top: stacked ? 60 : undefined });
	if (shapes.length === 0) return null;
	const ids = shapes.map((node) => node.id);

	return (
		// Above the whole selection, as the arrange toolbar is: not in the
		// middle of it, over a card, when only some of it is stickies.
		<NodeToolbar
			nodeId={selected.map((node) => node.id)}
			isVisible={!dragging}
			position={Position.Top}
			offset={18}
		>
			<div ref={toolbar} className="shape-toolbar-clamp">
				<ShapeToolbarView
					color={
						stickies.length > 0
							? common(stickies.map((node) => node.data.shape.color ?? "yellow"))
							: null
					}
					size={texts.length > 0 ? common(texts.map((node) => node.data.shape.size ?? "m")) : null}
					font={common(shapes.map((node) => node.data.shape.font ?? "sans"))}
					onColor={(color) => {
						updateShapes(
							doc,
							stickies.map((node) => node.id),
							{ color },
						);
						onStickyColor?.(color);
					}}
					onSize={(size) =>
						updateShapes(
							doc,
							texts.map((node) => node.id),
							{ size },
						)
					}
					onFont={(font) => updateShapes(doc, ids, { font })}
				/>
			</div>
		</NodeToolbar>
	);
}

export interface ShapeToolbarViewProps {
	/** The shared colour; undefined when mixed, null to hide colours. */
	color: string | undefined | null;
	/** The shared text size; undefined when mixed, null to hide sizes. */
	size: TextSize | undefined | null;
	font: ShapeFont | undefined;
	onColor?: (color: StickyColor) => void;
	onSize?: (size: TextSize) => void;
	onFont?: (font: ShapeFont) => void;
}

// Buttons keep focus where it was, so recolouring a sticky you're typing in
// doesn't end editing.
const keepFocus = (event: React.PointerEvent) => event.preventDefault();

export function ShapeToolbarView({
	color,
	size,
	font,
	onColor,
	onSize,
	onFont,
}: ShapeToolbarViewProps) {
	return (
		<div className="shape-toolbar nodrag nopan" role="toolbar" aria-label="Shape options">
			{color !== null && (
				<div className="shape-toolbar-group" role="radiogroup" aria-label="Colour">
					{STICKY_COLORS.map((c) => (
						<button
							key={c}
							type="button"
							role="radio"
							aria-checked={c === color}
							aria-label={c}
							title={c[0]?.toUpperCase() + c.slice(1)}
							className="swatch"
							data-color={c}
							onPointerDown={keepFocus}
							onClick={() => onColor?.(c)}
						/>
					))}
				</div>
			)}
			{size !== null && (
				<div className="shape-toolbar-group" role="radiogroup" aria-label="Text size">
					{SIZES.map((s) => (
						<button
							key={s.size}
							type="button"
							role="radio"
							aria-checked={s.size === size}
							aria-label={s.name}
							title={s.name}
							className="shape-toolbar-option"
							onPointerDown={keepFocus}
							onClick={() => onSize?.(s.size)}
						>
							{s.label}
						</button>
					))}
				</div>
			)}
			<div className="shape-toolbar-group" role="radiogroup" aria-label="Typeface">
				<button
					type="button"
					role="radio"
					aria-checked={font === "sans"}
					aria-label="Sans"
					title="Sans"
					className="shape-toolbar-option shape-toolbar-font"
					data-font="sans"
					onPointerDown={keepFocus}
					onClick={() => onFont?.("sans")}
				>
					Aa
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={font === "hand"}
					aria-label="Handwriting"
					title="Handwriting"
					className="shape-toolbar-option shape-toolbar-font"
					data-font="hand"
					onPointerDown={keepFocus}
					onClick={() => onFont?.("hand")}
				>
					Aa
				</button>
			</div>
		</div>
	);
}
