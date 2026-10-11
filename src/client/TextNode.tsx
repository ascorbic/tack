import type { NodeProps } from "@xyflow/react";
import {
	type MouseEvent,
	type PointerEvent,
	type Ref,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ShapeFont, TextSize } from "../shared/shapes.ts";
import { deleteShapes, isFresh, type ShapeNode, setStickyText, takeFocus } from "./board.ts";
import { DocContext } from "./DocContext.ts";
import { EditHint } from "./EditHint.tsx";
import { useEditing } from "./useEditing.ts";

const PLACEHOLDER = "Type something";

export interface TextViewProps {
	text: string;
	size?: TextSize;
	font?: ShapeFont;
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

/** A text block, without any board behaviour (the gallery uses it too). */
export function TextView({
	text,
	size = "m",
	font = "sans",
	selected = false,
	editing = false,
	enter = false,
	field,
	onText,
	onStopEditing,
	...handlers
}: TextViewProps) {
	// The invisible copy that sizes the block. A trailing newline needs a
	// character after it to take up a line, as it does in the textarea.
	const sizing = text === "" ? PLACEHOLDER : text.endsWith("\n") ? `${text}​` : text;
	return (
		<div
			className="text-block"
			data-enter={enter}
			data-size={size}
			data-font={font}
			data-selected={selected}
			data-editing={editing}
			{...handlers}
		>
			<div className="text-sizer text-type" data-value={sizing}>
				{editing ? (
					<textarea
						ref={field}
						className="nodrag nowheel"
						rows={1}
						aria-label="Text"
						placeholder={PLACEHOLDER}
						value={text}
						onChange={(event) => onText?.(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" || (event.key === "Enter" && event.metaKey)) {
								event.preventDefault();
								event.stopPropagation();
								onStopEditing?.();
							}
						}}
						onBlur={() => onStopEditing?.()}
					/>
				) : (
					<div className="text-block-text" data-empty={text === ""}>
						{text || PLACEHOLDER}
					</div>
				)}
			</div>
		</div>
	);
}

export const TextNode = memo(function TextNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const [enter] = useState(() => isFresh(data.id));
	const [startEditing] = useState(() => takeFocus(data.id));
	const value = data.shape.text ?? "";
	const latest = useRef(value);
	latest.current = value;
	const { editing, setEditing, field, handlers, hint } = useEditing({
		id: data.id,
		selected: !!selected,
		startEditing,
		onType: (chars) => doc && setStickyText(doc, data.id, latest.current + chars),
	});

	// Text left empty when editing ends is removed, as in FigJam: clicking
	// with the text tool and then away again leaves nothing behind. Only the
	// person who was editing removes it.
	const wasEditing = useRef(editing);
	useEffect(() => {
		if (wasEditing.current && !editing && doc && latest.current.trim() === "") {
			deleteShapes(doc, [data.id]);
		}
		wasEditing.current = editing;
	}, [editing, doc, data.id]);

	return (
		<>
			<TextView
				text={value}
				size={data.shape.size}
				font={data.shape.font}
				selected={selected}
				editing={editing}
				enter={enter}
				field={field}
				onText={(text) => doc && setStickyText(doc, data.id, text)}
				onStopEditing={() => setEditing(false)}
				{...handlers}
			/>
			<EditHint show={hint} />
		</>
	);
});
