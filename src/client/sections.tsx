import { type NodeProps, ViewportPortal, useReactFlow, useStoreApi } from "@xyflow/react";
import {
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import type * as Y from "yjs";
import { type Point, type Rect, distance, rectFromPoints } from "../shared/geometry.ts";
import {
	type ResizeHandle,
	SECTION_COLORS,
	SECTION_DEFAULT,
	type SectionColor,
	type SizeOf,
	resizeRect,
} from "../shared/sections.ts";
import { transactLocal, updateShapes } from "../shared/shapes.ts";
import { addSection, resizeSection } from "../shared/structure.ts";
import { type ShapeNode, focusWhenMounted, isFresh, takeFocus } from "./board.ts";
import { DocContext, ReadOnlyContext, SectionContext, type SectionUI } from "./DocContext.ts";
import { TrayIcon } from "./inbox/icons.tsx";
import { inboxUI, useTray } from "./inbox/useTray.ts";
import "./sections.css";

const HANDLES: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/**
 * A section: a tinted area that holds shapes. It's picked up by its title
 * (dragging inside it selects what's in it, as in FigJam), shows how many
 * shapes it holds, lights up when something is about to land in it, and
 * gives a little "gulp" when something does.
 */
export const SectionNode = memo(function SectionNode({ id, data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const ui = useContext(SectionContext);
	// View-only boards can't rename, recolour or resize sections.
	const readOnly = useContext(ReadOnlyContext);
	const shape = data.shape;
	const count = data.count ?? 0;
	const [enter] = useState(() => isFresh(id));
	const [editingState, setEditing] = useState(() => takeFocus(id));
	const editing = editingState && !readOnly;

	// Enter renames a section selected on its own.
	const alone = selected && ui.selectionSize === 1;
	useEffect(() => {
		if (!alone || editing || readOnly) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable]")) return;
			event.preventDefault();
			setEditing(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [alone, editing, readOnly]);

	// Each time the count goes up, replay the "received" animation.
	const [received, setReceived] = useState(0);
	const lastCount = useRef(count);
	useEffect(() => {
		if (count > lastCount.current) setReceived((n) => n + 1);
		lastCount.current = count;
	}, [count]);

	const title = shape.title ?? "";
	const color = (SECTION_COLORS as readonly string[]).includes(shape.color ?? "")
		? shape.color
		: "grey";

	return (
		<div
			className="section"
			data-color={color}
			data-selected={!!selected}
			data-drop-target={ui.dropTargets.has(id)}
			data-enter={enter}
		>
			{received > 0 && <span key={received} className="section-received" aria-hidden="true" />}
			<div className="section-header">
				<div
					className="section-title section-handle"
					onDoubleClick={(event) => {
						event.stopPropagation();
						setEditing(true);
					}}
				>
					{editing && doc ? (
						<TitleInput
							value={title}
							onChange={(value) => updateShapes(doc, [id], { title: value })}
							onDone={() => setEditing(false)}
						/>
					) : (
						<span className="section-name" data-empty={title === ""}>
							{title || "Untitled section"}
						</span>
					)}
					<span
						key={`count-${received}`}
						className="section-count"
						data-pop={received > 0}
						title={`${count} ${count === 1 ? "item" : "items"}`}
					>
						{count}
					</span>
					{shape.inbox && <InboxBadge id={id} shape={shape} />}
				</div>
				{selected && doc && !readOnly && (
					<SectionColors
						color={color as SectionColor}
						onColor={(next) => updateShapes(doc, [id], { color: next })}
					/>
				)}
				{alone && doc && !readOnly && !shape.inbox && (
					<button
						type="button"
						className="section-make-inbox nodrag nopan"
						title="Collect new matches for a search in this section"
						onClick={(event) => {
							event.stopPropagation();
							inboxUI.edit(id);
						}}
					>
						<TrayIcon size={14} />
						Make inbox
					</button>
				)}
			</div>
			{selected &&
				doc &&
				!readOnly &&
				HANDLES.map((handle) => (
					<ResizeGrip
						key={handle}
						id={id}
						handle={handle}
						start={() => ({
							x: shape.x,
							y: shape.y,
							w: shape.w ?? SECTION_DEFAULT.w,
							h: shape.h ?? SECTION_DEFAULT.h,
						})}
						ui={ui}
						onCommit={(rect) => transactLocal(doc, () => resizeSection(doc, id, rect, ui.sizeOf))}
					/>
				))}
		</div>
	);
});

export const sectionNodeTypes = { section: SectionNode };

/** An inbox section's title says how many new matches wait in its tray. */
function InboxBadge({ id, shape }: { id: string; shape: ShapeNode["data"]["shape"] }) {
	const doc = useContext(DocContext);
	const tray = useTray(doc, id, shape);
	const count = tray.items.length;
	return (
		<button
			type="button"
			className="section-inbox nodrag nopan"
			data-new={count > 0}
			title={count > 0 ? `${count} new in the inbox` : "Inbox: nothing new"}
			aria-label={count > 0 ? `Inbox: ${count} new` : "Inbox: nothing new"}
			onClick={(event) => {
				event.stopPropagation();
				inboxUI.toggle(id);
			}}
		>
			<TrayIcon size={12} />
			{count > 0 && (
				<span key={count} className="section-inbox-count">
					{count}
				</span>
			)}
		</button>
	);
}

function TitleInput({
	value,
	onChange,
	onDone,
}: {
	value: string;
	onChange: (value: string) => void;
	onDone: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	// React Flow hides a new node until it's measured, and hidden elements
	// can't take focus, so keep trying for a few frames.
	useEffect(() => {
		let frame = 0;
		let tries = 0;
		const focus = () => {
			const el = input.current;
			if (!el) return;
			el.focus();
			if (document.activeElement === el) el.select();
			else if (tries++ < 20) frame = requestAnimationFrame(focus);
		};
		focus();
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<span className="section-title-edit" data-value={value || "Name this section"}>
			<input
				ref={input}
				className="nodrag nopan"
				aria-label="Section title"
				placeholder="Name this section"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Enter" || event.key === "Escape") onDone();
				}}
				onBlur={onDone}
			/>
		</span>
	);
}

function SectionColors({
	color,
	onColor,
}: {
	color: SectionColor;
	onColor: (color: SectionColor) => void;
}) {
	return (
		<div className="section-colors nodrag nopan" role="radiogroup" aria-label="Section colour">
			{SECTION_COLORS.map((c) => (
				<button
					key={c}
					type="button"
					role="radio"
					aria-checked={c === color}
					aria-label={c}
					className="section-swatch"
					data-color={c}
					onClick={(event) => {
						event.stopPropagation();
						onColor(c);
					}}
				/>
			))}
		</div>
	);
}

export const RESIZE_HANDLES = HANDLES;

/**
 * One of a selected box's eight resize handles (sections, widgets). The
 * resize shows to everyone while it's in progress, snaps to other shapes,
 * and is committed once, when it ends.
 */
export function ResizeGrip({
	id,
	handle,
	start: startRect,
	min,
	ui,
	onCommit,
	className = "section-resize",
}: {
	id: string;
	handle: ResizeHandle;
	/** The box as it is now, when the resize starts. */
	start: () => Rect;
	/** The smallest it can be; a section's minimum, unless given. */
	min?: { w: number; h: number };
	ui: SectionUI;
	onCommit: (rect: Rect) => void;
	className?: string;
}) {
	const flow = useReactFlow();
	// A resize in progress, abandoned if the handle goes away mid-gesture
	// (say, someone else deletes the section).
	const cancel = useRef<(() => void) | null>(null);
	useEffect(() => () => cancel.current?.(), []);
	const onPointerDown = (event: ReactPointerEvent) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		event.preventDefault();
		cancel.current?.();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		const start: Rect = startRect();
		const origin = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		let rect = start;
		const onMove = (move: PointerEvent) => {
			const at = flow.screenToFlowPosition({ x: move.clientX, y: move.clientY });
			const raw = resizeRect(start, handle, { x: at.x - origin.x, y: at.y - origin.y }, min);
			rect = ui.snapResize(id, raw, handle);
			ui.setResize(id, rect);
		};
		const finish = (commit: boolean) => {
			target.removeEventListener("pointermove", onMove);
			target.removeEventListener("pointerup", onUp);
			target.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("keydown", onKey, true);
			cancel.current = null;
			ui.snapResize(id, rect, null);
			if (commit && rect !== start) onCommit(rect);
			ui.setResize(id, null);
		};
		const onUp = () => finish(true);
		const onCancel = () => finish(false);
		const onKey = (key: KeyboardEvent) => {
			if (key.key !== "Escape") return;
			key.stopPropagation();
			finish(false);
		};
		target.addEventListener("pointermove", onMove);
		target.addEventListener("pointerup", onUp);
		target.addEventListener("pointercancel", onCancel);
		window.addEventListener("keydown", onKey, true);
		cancel.current = onCancel;
	};
	return (
		<span
			className={`${className} nodrag nopan`}
			data-handle={handle}
			aria-hidden="true"
			onPointerDown={onPointerDown}
		/>
	);
}

/**
 * Keeps a `--zoom` custom property on the canvas, so things that should stay
 * the same size on screen (section titles, handles, hit areas) can scale
 * against the zoom in CSS without re-rendering.
 */
export function ZoomVariable() {
	const store = useStoreApi();
	useEffect(() => {
		let last = -1;
		const apply = () => {
			const { domNode, transform } = store.getState();
			const zoom = transform[2];
			if (!domNode || zoom === last) return;
			last = zoom;
			domNode.style.setProperty("--zoom", String(zoom));
		};
		apply();
		return store.subscribe(apply);
	}, [store]);
	return null;
}

/** Below this many screen pixels, a press-and-release counts as a click. */
const CLICK_SLOP = 6;

/**
 * The section tool: drag out a section on the board (around shapes to take
 * them in), or click to place a default-sized one. Its title is ready to
 * type into straight away.
 */
export function SectionTool({
	doc,
	sizeOf,
	onCreate,
}: {
	doc: Y.Doc;
	sizeOf: SizeOf;
	onCreate: (id: string) => void;
}) {
	const store = useStoreApi();
	const flow = useReactFlow();
	const [draft, setDraft] = useState<Rect | null>(null);
	const onCreateRef = useRef(onCreate);
	onCreateRef.current = onCreate;

	useEffect(() => {
		const dom = store.getState().domNode;
		if (!dom) return;
		// The section being drawn, abandoned if the tool is put down mid-draw.
		let cancel: (() => void) | null = null;
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0 || !event.isPrimary) return;
			if ((event.target as Element | null)?.closest(".react-flow__panel")) return;
			event.preventDefault();
			event.stopPropagation();
			cancel?.();
			const startScreen = { x: event.clientX, y: event.clientY };
			const start = flow.screenToFlowPosition(startScreen);
			let end: Point = start;
			let dragged = false;
			const onMove = (move: PointerEvent) => {
				dragged ||= distance(startScreen, { x: move.clientX, y: move.clientY }) > CLICK_SLOP;
				end = flow.screenToFlowPosition({ x: move.clientX, y: move.clientY });
				if (dragged) setDraft(rectFromPoints(start, end));
			};
			const finish = (commit: boolean) => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("keydown", onKey, true);
				cancel = null;
				setDraft(null);
				if (!commit) return;
				const rect = dragged
					? rectFromPoints(start, end)
					: {
							x: start.x - SECTION_DEFAULT.w / 2,
							y: start.y - SECTION_DEFAULT.h / 2,
							w: SECTION_DEFAULT.w,
							h: SECTION_DEFAULT.h,
						};
				const id = transactLocal(doc, () => addSection(doc, rect, {}, sizeOf));
				focusWhenMounted(id);
				onCreateRef.current(id);
			};
			const onUp = () => finish(true);
			const onKey = (key: KeyboardEvent) => {
				if (key.key !== "Escape") return;
				key.stopPropagation();
				finish(false);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("keydown", onKey, true);
			cancel = () => finish(false);
		};
		dom.addEventListener("pointerdown", onDown, true);
		return () => {
			dom.removeEventListener("pointerdown", onDown, true);
			cancel?.();
		};
	}, [store, flow, doc, sizeOf]);

	if (!draft) return null;
	return (
		<ViewportPortal>
			<div
				className="section section-draft"
				data-color="grey"
				aria-hidden="true"
				style={{
					transform: `translate(${draft.x}px, ${draft.y}px)`,
					width: draft.w,
					height: draft.h,
				}}
			/>
		</ViewportPortal>
	);
}
