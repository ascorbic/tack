import { type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { STICKY_COLORS, type StickyColor } from "./board.ts";
import { GavelPaths } from "./decisions/icons.tsx";
import { ListPaths } from "./widgets/icons.tsx";
import { type AddWidget, WidgetPicker } from "./widgets/WidgetPicker.tsx";

export type Tool =
	| "select"
	| "hand"
	| "sticky"
	| "text"
	| "card"
	| "section"
	| "connector"
	| "decision"
	| "widget";

export const TOOL_KEYS: Record<string, Tool> = {
	v: "select",
	h: "hand",
	s: "sticky",
	t: "text",
	c: "card",
	f: "section",
	x: "connector",
	d: "decision",
	w: "widget",
};

/** The MIME type for dragging a new sticky off the toolbar onto the canvas. */
export const STICKY_DRAG_TYPE = "application/x-tack-sticky";

interface ToolbarProps {
	tool: Tool;
	onTool: (tool: Tool) => void;
	stickyColor: StickyColor;
	onStickyColor: (color: StickyColor) => void;
	/** Returns false if the reference couldn't be parsed. */
	onAddCard: (input: string) => boolean;
	/** Add a widget from the picker (#37). */
	onAddWidget?: AddWidget;
	/** The board's busiest repository, for ready-made lists: `owner/name`. */
	suggestedRepo?: string | null;
}

export function Toolbar({
	tool,
	onTool,
	stickyColor,
	onStickyColor,
	onAddCard,
	onAddWidget,
	suggestedRepo = null,
}: ToolbarProps) {
	return (
		<div className="toolbar-dock">
			{tool === "sticky" && <StickyOptions color={stickyColor} onColor={onStickyColor} />}
			{tool === "text" && (
				<div className="toolbar-options">
					<span className="toolbar-hint">Click anywhere to start typing</span>
				</div>
			)}
			{tool === "card" && <CardOptions onAddCard={onAddCard} onDone={() => onTool("select")} />}
			{tool === "section" && (
				<ToolHint>Drag out a section around things, or click to place one</ToolHint>
			)}
			{tool === "connector" && <ToolHint>Drag from a shape to another, or anywhere</ToolHint>}
			{tool === "decision" && (
				<ToolHint>Click to propose a decision, then connect the issues it settles</ToolHint>
			)}
			{tool === "widget" && onAddWidget && (
				<WidgetPicker
					suggestedRepo={suggestedRepo}
					onAdd={(kind, config) => {
						onAddWidget(kind, config);
						onTool("select");
					}}
				/>
			)}
			<div className="toolbar" role="toolbar" aria-label="Tools">
				<ToolButton tool="select" active={tool} onTool={onTool} label="Select" shortcut="V">
					<path d="M5 3.5l12 7-5.5 1.6L9 17.5z" />
				</ToolButton>
				<ToolButton tool="hand" active={tool} onTool={onTool} label="Hand" shortcut="H">
					<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10m0-.5V4a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V12a6 6 0 0 1-6 6h-.6a5 5 0 0 1-3.9-1.9L3.3 13a1.5 1.5 0 0 1 2.3-1.9L7 12.5" />
				</ToolButton>
				<span className="toolbar-divider" aria-hidden="true" />
				<StickyButton
					active={tool === "sticky"}
					color={stickyColor}
					onSelect={() => onTool("sticky")}
				/>
				<ToolButton tool="text" active={tool} onTool={onTool} label="Text" shortcut="T">
					<path d="M4.5 5.5V4h11v1.5M10 4v12M7.5 16h5" />
				</ToolButton>
				<ToolButton tool="card" active={tool} onTool={onTool} label="Issue or PR" shortcut="C">
					<circle cx="10" cy="10" r="6.5" />
					<circle cx="10" cy="10" r="1.8" className="fill" />
				</ToolButton>
				<ToolButton tool="section" active={tool} onTool={onTool} label="Section" shortcut="F">
					<rect x="3" y="7.5" width="14" height="9.5" rx="2" />
					<path d="M3 4h6.5" />
				</ToolButton>
				<ToolButton tool="connector" active={tool} onTool={onTool} label="Connector" shortcut="X">
					<circle cx="4.8" cy="15.2" r="1.8" className="fill" />
					<path d="M6.3 13.7C8 7.5 10.5 5.5 15.5 5.5M13 3l2.5 2.5L13 8" />
				</ToolButton>
				<span className="toolbar-divider" aria-hidden="true" />
				<ToolButton tool="decision" active={tool} onTool={onTool} label="Decision" shortcut="D">
					<GavelPaths />
				</ToolButton>
				{onAddWidget && (
					<ToolButton tool="widget" active={tool} onTool={onTool} label="Widget" shortcut="W">
						<g transform="translate(2 2)">
							<ListPaths />
						</g>
					</ToolButton>
				)}
			</div>
		</div>
	);
}

function ToolButton({
	tool,
	active,
	onTool,
	label,
	shortcut,
	children,
}: {
	tool: Tool;
	active: Tool;
	onTool: (tool: Tool) => void;
	label: string;
	shortcut: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className="tool"
			aria-label={label}
			aria-pressed={active === tool}
			data-tooltip={label}
			data-shortcut={shortcut}
			onClick={() => onTool(tool)}
		>
			<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
				{children}
			</svg>
		</button>
	);
}

/** The sticky tool: click to pick it, or drag a sticky straight off it. */
function StickyButton({
	active,
	color,
	onSelect,
}: {
	active: boolean;
	color: StickyColor;
	onSelect: () => void;
}) {
	const onDragStart = (event: DragEvent) => {
		event.dataTransfer.setData(STICKY_DRAG_TYPE, color);
		event.dataTransfer.effectAllowed = "copy";
	};
	return (
		<button
			type="button"
			className="tool tool-sticky"
			aria-label="Sticky note"
			aria-pressed={active}
			data-tooltip="Sticky note"
			data-shortcut="S"
			draggable
			onDragStart={onDragStart}
			onClick={onSelect}
		>
			<span className="tool-sticky-paper" data-color={color} aria-hidden="true" />
		</button>
	);
}

function ToolHint({ children }: { children: React.ReactNode }) {
	return (
		<div className="toolbar-options">
			<span className="toolbar-hint">{children}</span>
		</div>
	);
}

function StickyOptions({
	color,
	onColor,
}: {
	color: StickyColor;
	onColor: (color: StickyColor) => void;
}) {
	return (
		<div className="toolbar-options" role="radiogroup" aria-label="Sticky colour">
			{STICKY_COLORS.map((c) => (
				<button
					key={c}
					type="button"
					role="radio"
					aria-checked={c === color}
					aria-label={c}
					className="swatch"
					data-color={c}
					onClick={() => onColor(c)}
				/>
			))}
			<span className="toolbar-hint">Click the board, or drag a sticky out</span>
		</div>
	);
}

function CardOptions({
	onAddCard,
	onDone,
}: {
	onAddCard: (input: string) => boolean;
	onDone: () => void;
}) {
	const [value, setValue] = useState("");
	const [invalid, setInvalid] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus(), []);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (onAddCard(value)) {
			setValue("");
			onDone();
		} else {
			setInvalid(true);
		}
	};

	return (
		<form className="toolbar-options card-options" onSubmit={submit}>
			<label htmlFor="card-ref" className="visually-hidden">
				Issue or pull request
			</label>
			<input
				id="card-ref"
				ref={input}
				value={value}
				aria-invalid={invalid}
				placeholder="owner/repo#123 or paste a URL"
				onChange={(event) => {
					setValue(event.target.value);
					setInvalid(false);
				}}
				onKeyDown={(event) => event.key === "Escape" && onDone()}
			/>
			<button type="submit" className="primary">
				Add
			</button>
		</form>
	);
}
