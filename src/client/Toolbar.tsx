import type { DragEvent } from "react";
import { STAMPS, type StampEmoji } from "../shared/facilitation.ts";
import { STICKY_COLORS, type StickyColor } from "./board.ts";
import { type AddOutcome, CardPicker, type CardScope } from "./CardPicker.tsx";
import type { QueryError, SearchResult } from "../shared/widgets.ts";
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
	/** Action items (#52). */
	| "action"
	| "widget"
	/** Stamping shapes (#50). */
	| "stamp"
	/** Placing dot votes on shapes (#48), from a vote's bar. */
	| "vote"
	| "comment";

export const TOOL_KEYS: Record<string, Tool> = {
	v: "select",
	h: "hand",
	s: "sticky",
	t: "text",
	c: "card",
	f: "section",
	x: "connector",
	d: "decision",
	a: "action",
	w: "widget",
	m: "stamp",
	b: "comment",
};

/** Tools for people who can look and comment, but not edit. */
export const VIEW_TOOLS: ReadonlySet<Tool> = new Set(["select", "hand", "comment"]);

/** The MIME type for dragging a new sticky off the toolbar onto the canvas. */
export const STICKY_DRAG_TYPE = "application/x-tack-sticky";

interface ToolbarProps {
	tool: Tool;
	onTool: (tool: Tool) => void;
	stickyColor: StickyColor;
	onStickyColor: (color: StickyColor) => void;
	/** Add cards for these items (the card tool). */
	onAddCards: (keys: string[], copies?: boolean) => AddOutcome;
	/** Where the card tool searches: the board's repositories. */
	cardScope: CardScope;
	/** Searching for items to add; without it the card tool only takes references. */
	searchItems?: (host: string, q: string) => Promise<SearchResult | QueryError>;
	/** Whether an item already has a card on the board. */
	onBoard: (key: string) => boolean;
	/** Add a widget from the picker (#37). */
	onAddWidget?: AddWidget;
	/** The board's busiest repository, for ready-made lists: `owner/name`. */
	suggestedRepo?: string | null;
	/** Who's here, signed in: `@me` in ready-made lists. */
	login?: string | null;
	stamp: StampEmoji;
	onStamp: (stamp: StampEmoji) => void;
	/** View only: just selecting, the hand, and comments. */
	viewOnly?: boolean;
	/** Whether there's a comment tool: you can comment here. */
	commenting?: boolean;
	/**
	 * A word about the last click ("No dots left…"), in place of the tool's
	 * hint for a moment rather than stacked above it. `key` replays it.
	 */
	note?: { text: string; key: number } | null;
}

const CommentPaths = () => <path d="M4 16.5V10a6 6 0 1 1 6 6Z" />;

export function Toolbar({
	tool,
	onTool,
	stickyColor,
	onStickyColor,
	onAddCards,
	cardScope,
	searchItems,
	onBoard,
	onAddWidget,
	suggestedRepo = null,
	login = null,
	stamp,
	onStamp,
	viewOnly = false,
	commenting = true,
	note = null,
}: ToolbarProps) {
	const commentHint = tool === "comment" && (
		<ToolHint>Click anything to comment on it, or anywhere on the board</ToolHint>
	);
	if (viewOnly) {
		return (
			<div className="toolbar-dock">
				{commentHint}
				<div className="toolbar" role="toolbar" aria-label="Tools">
					<ToolButton tool="select" active={tool} onTool={onTool} label="Select" shortcut="V">
						<path d="M5 3.5l12 7-5.5 1.6L9 17.5z" />
					</ToolButton>
					<ToolButton tool="hand" active={tool} onTool={onTool} label="Hand" shortcut="H">
						<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10m0-.5V4a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V12a6 6 0 0 1-6 6h-.6a5 5 0 0 1-3.9-1.9L3.3 13a1.5 1.5 0 0 1 2.3-1.9L7 12.5" />
					</ToolButton>
					<span className="toolbar-divider" aria-hidden="true" />
					<ToolButton tool="comment" active={tool} onTool={onTool} label="Comment" shortcut="B">
						<CommentPaths />
					</ToolButton>
				</div>
			</div>
		);
	}
	return (
		<div className="toolbar-dock">
			{tool === "stamp" && <StampOptions stamp={stamp} onStamp={onStamp} />}
			{tool === "vote" &&
				(note ? (
					<ToolHint key={note.key} note>
						{note.text}
					</ToolHint>
				) : (
					<ToolHint>
						Click shapes to put your dots on them; click one of yours to take it back
					</ToolHint>
				))}
			{commentHint}
			{tool === "sticky" && <StickyOptions color={stickyColor} onColor={onStickyColor} />}
			{tool === "text" && (
				<div className="toolbar-options">
					<span className="toolbar-hint">Click anywhere to start typing</span>
				</div>
			)}
			{tool === "card" && (
				<CardPicker
					scope={cardScope}
					search={searchItems}
					onBoard={onBoard}
					onAdd={onAddCards}
					onDone={() => onTool("select")}
				/>
			)}
			{tool === "section" && (
				<ToolHint>Drag out a section around things, or click to place one</ToolHint>
			)}
			{tool === "connector" && <ToolHint>Drag from a shape to another, or anywhere</ToolHint>}
			{tool === "decision" && (
				<ToolHint>Click to propose a decision, then connect the issues it settles</ToolHint>
			)}
			{tool === "action" && (
				<ToolHint>Click to add an action item, then give it an owner and a due date</ToolHint>
			)}
			{tool === "widget" && onAddWidget && (
				<WidgetPicker
					suggestedRepo={suggestedRepo}
					login={login}
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
				<ToolButton tool="action" active={tool} onTool={onTool} label="Action item" shortcut="A">
					<rect x="3" y="4.5" width="7" height="7" rx="2.2" />
					<path d="m4.9 8.1 1.4 1.4 2.3-2.6M12.5 6.5h4.5M12.5 9.5h3M3 15h14" />
				</ToolButton>
				{onAddWidget && (
					<ToolButton tool="widget" active={tool} onTool={onTool} label="Widget" shortcut="W">
						<g transform="translate(2 2)">
							<ListPaths />
						</g>
					</ToolButton>
				)}
				<button
					type="button"
					className="tool tool-stamp"
					aria-label="Stamp"
					aria-pressed={tool === "stamp"}
					data-tooltip="Stamp"
					data-shortcut="M"
					onClick={() => onTool("stamp")}
				>
					{/* A rubber stamp in the dock's own line, with the stamp it makes
					    as a small badge: the full-colour emoji alone shouted. */}
					<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
						<path d="M8 10.5V9a2.6 2.6 0 1 1 4 0v1.5" />
						<rect x="3.5" y="10.5" width="13" height="3.5" rx="1.4" />
						<path d="M5 16.5h10" />
					</svg>
					<span className="tool-stamp-emoji" aria-hidden="true">
						{stamp}
					</span>
				</button>
				{commenting && (
					<ToolButton tool="comment" active={tool} onTool={onTool} label="Comment" shortcut="B">
						<CommentPaths />
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

function ToolHint({ children, note = false }: { children: React.ReactNode; note?: boolean }) {
	return (
		<div className="toolbar-options" data-note={note || undefined}>
			<span className="toolbar-hint" role={note ? "status" : undefined}>
				{children}
			</span>
		</div>
	);
}

function StampOptions({
	stamp,
	onStamp,
}: {
	stamp: StampEmoji;
	onStamp: (stamp: StampEmoji) => void;
}) {
	return (
		<div className="toolbar-options" role="radiogroup" aria-label="Stamp">
			{STAMPS.map((s, i) => (
				<button
					key={s}
					type="button"
					role="radio"
					aria-checked={s === stamp}
					aria-label={`Stamp ${s}`}
					aria-keyshortcuts={String(i + 1)}
					className="stamp-choice"
					onClick={() => onStamp(s)}
				>
					{s}
					<kbd className="stamp-choice-key" aria-hidden="true">
						{i + 1}
					</kbd>
				</button>
			))}
			<span className="toolbar-hint">Click shapes to stamp them; again to take it off</span>
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
