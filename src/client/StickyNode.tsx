import type { NodeProps } from "@xyflow/react";
import {
	type PointerEvent,
	type MouseEvent,
	type Ref,
	memo,
	useContext,
	useRef,
	useState,
} from "react";
import type { Author, ShapeFont } from "../shared/shapes.ts";
import { isFresh, type ShapeNode, setStickyText, takeFocus } from "./board.ts";
import { DocContext } from "./DocContext.ts";
import { STICKY_FONT_SIZES } from "./textFit.ts";
import { useEditing } from "./useEditing.ts";
import { useFitText } from "./useFitText.ts";

/**
 * The text area inside a sticky: its size less padding, and less the author
 * line when there is one. Keep in step with `.sticky` in styles.css.
 */
const TEXT_BOX = { width: 144, height: 124 };
const TEXT_BOX_NO_AUTHOR = { width: 144, height: 144 };
const PLACEHOLDER = "Type something…";

/** A small, stable tilt per sticky, so a cluster looks hand-placed. */
export function tilt(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return ((hash % 300) / 100) * 0.6;
}

export interface StickyViewProps {
	text: string;
	color: string;
	font?: ShapeFont;
	author?: Author;
	tilt?: number;
	selected?: boolean;
	editing?: boolean;
	enter?: boolean;
	field?: Ref<HTMLTextAreaElement>;
	onText?: (text: string) => void;
	onStopEditing?: () => void;
	onPointerDown?: (event: PointerEvent) => void;
	onClick?: (event: MouseEvent) => void;
	onDoubleClick?: () => void;
}

/** A sticky note, without any board behaviour (the gallery uses it too). */
export function StickyView({
	text,
	color,
	font = "sans",
	author,
	tilt = 0,
	selected = false,
	editing = false,
	enter = false,
	field,
	onText,
	onStopEditing,
	...handlers
}: StickyViewProps) {
	const fit = useFitText(
		text,
		font,
		author ? TEXT_BOX : TEXT_BOX_NO_AUTHOR,
		STICKY_FONT_SIZES,
		"sticky-type",
	);
	return (
		<div
			className="sticky"
			data-enter={enter}
			data-color={color}
			data-selected={selected}
			data-editing={editing}
			style={{ "--tilt": `${tilt}deg`, "--fit-size": `${fit.size}px` } as React.CSSProperties}
			{...handlers}
		>
			<div className="sticky-body">
				{editing ? (
					<textarea
						ref={field}
						className="sticky-type nodrag nowheel"
						data-font={font}
						data-overflow={fit.overflows}
						aria-label="Sticky note"
						placeholder={PLACEHOLDER}
						value={text}
						onChange={(event) => onText?.(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								onStopEditing?.();
							}
						}}
						onBlur={() => onStopEditing?.()}
					/>
				) : (
					<div
						className="sticky-type sticky-text"
						data-font={font}
						data-empty={text === ""}
						data-overflow={fit.overflows}
					>
						{text || (selected ? PLACEHOLDER : "")}
					</div>
				)}
			</div>
			{author && (
				<span
					className="sticky-author"
					style={{ "--author": author.color || "var(--muted)" } as React.CSSProperties}
					title={author.name}
				>
					<span className="sticky-author-name">{author.name || "Someone"}</span>
				</span>
			)}
		</div>
	);
}

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const [enter] = useState(() => isFresh(data.id));
	// A sticky this client just placed starts in editing mode.
	const [startEditing] = useState(() => takeFocus(data.id));
	const value = data.shape.text ?? "";
	const latest = useRef(value);
	latest.current = value;
	const { editing, setEditing, field, handlers } = useEditing({
		selected: !!selected,
		startEditing,
		onType: (char) => doc && setStickyText(doc, data.id, latest.current + char),
	});

	return (
		<StickyView
			text={value}
			color={data.shape.color ?? "yellow"}
			font={data.shape.font}
			author={data.shape.author}
			tilt={tilt(data.id)}
			selected={selected}
			editing={editing}
			enter={enter}
			field={field}
			onText={(text) => doc && setStickyText(doc, data.id, text)}
			onStopEditing={() => setEditing(false)}
			{...handlers}
		/>
	);
});
