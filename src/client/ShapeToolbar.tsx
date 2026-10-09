import { NodeToolbar, Position, useStore } from "@xyflow/react";
import type * as Y from "yjs";
import { type ShapeFont, type TextSize, updateShapes } from "../shared/shapes.ts";
import { STICKY_COLORS, type ShapeNode, type StickyColor } from "./board.ts";

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

/**
 * A small toolbar floating above the selected stickies and text, like
 * FigJam's: colour, typeface and size. Each change is one transaction
 * across the whole selection.
 */
export function ShapeToolbar({
	doc,
	selected,
	onStickyColor,
}: {
	doc: Y.Doc;
	/** The selected nodes; cards and other shapes are ignored. */
	selected: ShapeNode[];
	/** Called when stickies are recoloured, so new ones match. */
	onStickyColor?: (color: StickyColor) => void;
}) {
	const dragging = useStore((state) => state.nodes.some((node) => node.dragging));
	const stickies = selected.filter((node) => node.type === "sticky");
	const texts = selected.filter((node) => node.type === "text");
	const shapes = [...stickies, ...texts];
	if (shapes.length === 0) return null;
	const ids = shapes.map((node) => node.id);

	return (
		<NodeToolbar nodeId={ids} isVisible={!dragging} position={Position.Top} offset={18}>
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
