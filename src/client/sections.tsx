import { type NodeProps, ViewportPortal, useReactFlow, useStoreApi } from "@xyflow/react";
import {
	type ReactNode,
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
import { addSection, fitSection, readShapes, resizeSection } from "../shared/structure.ts";
import { sectionSpot } from "../shared/placement.ts";
import { sortOf } from "../shared/display.ts";
import { DisplaySwitch, sortLabel } from "./display/DisplaySwitch.tsx";
import { type ShapeNode, focusWhenMounted, isFresh, takeFocus } from "./board.ts";
import { scaledDuration } from "./motion.ts";
import { DocContext, ReadOnlyContext, SectionContext, type SectionUI } from "./DocContext.ts";
import { SilentBadge, SilentButton } from "./facilitation/Silent.tsx";
import { VoteButton } from "./facilitation/Votes.tsx";
import { TrayIcon } from "./inbox/icons.tsx";
import { inboxUI, useTray } from "./inbox/useTray.ts";
import { isOnUnselectedShape } from "./keys.ts";
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
			// Enter on a shape the keyboard moved to selects that shape, not this.
			if (isOnUnselectedShape(target)) return;
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

	// Growing for what's dropped in it, or fitting to it: the edges glide.
	const gliding = useGlide(`${shape.x},${shape.y},${shape.w},${shape.h}`);

	const title = shape.title ?? "";
	const color = (SECTION_COLORS as readonly string[]).includes(shape.color ?? "")
		? shape.color
		: "grey";
	// Showing a list or mini cards (#72), or drawn as a group inside one.
	const display = data.display;
	const listed = display === "list" || display === "grid";
	const sort = listed ? sortOf(shape) : null;

	if (display === "group") {
		return (
			<SectionGroup
				id={id}
				title={title}
				color={color ?? "grey"}
				count={count}
				selected={!!selected}
				dropTarget={ui.dropTargets.has(id)}
				editing={editing}
				onEdit={setEditing}
			/>
		);
	}

	return (
		<div
			className="section"
			data-color={color}
			data-selected={!!selected}
			data-drop-target={ui.dropTargets.has(id)}
			data-enter={enter}
			data-silent={shape.silent ? true : undefined}
			data-display={display}
			data-gliding={gliding || undefined}
		>
			{listed && count === 0 && (
				<span className="section-list-empty" aria-hidden="true">
					Drop cards or stickies here
				</span>
			)}
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
					{sort && (
						<span className="section-sorted" title={`Sorted by ${sortLabel(sort)}`}>
							{sortLabel(sort)}
						</span>
					)}
					{shape.inbox && <InboxBadge id={id} shape={shape} />}
					{shape.silent && <SilentBadge shape={shape} />}
				</div>
				{selected && doc && !readOnly && (
					<SectionTools>
						<SectionColors
							color={color as SectionColor}
							onColor={(next) => updateShapes(doc, [id], { color: next })}
						/>
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
						{alone && doc && !readOnly && !shape.silent && <SilentButton id={id} />}
						{alone && doc && !readOnly && <VoteButton id={id} />}
						{alone && doc && !readOnly && <DisplaySwitch id={id} shape={shape} />}
					</SectionTools>
				)}
			</div>
			{/* A list or grid is as big as what's in it: switch back to cards to resize. */}
			{selected &&
				doc &&
				!readOnly &&
				!listed &&
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
						// Double-click a handle: snap to what's in it, as Fit to contents does.
						onDoubleClick={() => transactLocal(doc, () => fitSection(doc, id, ui.sizeOf))}
					/>
				))}
		</div>
	);
});

export const sectionNodeTypes = { section: SectionNode };

/** How long a section's edges glide to a size it didn't get from your hand (sections.css). */
const GLIDE_MS = 320;

/**
 * True for a moment after `box` changes, so the change can be animated:
 * set in the same render as the new size, since a transition has to be
 * there when the size changes to play. Your own resizes land where the
 * handle let go, so there's nothing for them to glide.
 */
function useGlide(box: string): boolean {
	const last = useRef<{ box: string; at: number }>({ box, at: 0 });
	if (last.current.box !== box) last.current = { box, at: performance.now() };
	const since = performance.now() - last.current.at;
	const gliding = since < scaledDuration(GLIDE_MS);
	const [, settle] = useState(0);
	useEffect(() => {
		if (!gliding) return;
		const timer = setTimeout(() => settle((n) => n + 1), scaledDuration(GLIDE_MS) - since + 16);
		return () => clearTimeout(timer);
	}, [gliding, box, since]);
	return gliding;
}

/**
 * A selected section's colours and actions, beside its title: as many as
 * fit across the section, and the rest in a row above (see sections.css),
 * so they never reach over the title of the section beside it.
 */
function SectionTools({ children }: { children: ReactNode }) {
	return <div className="section-tools">{children}</div>;
}

/**
 * A section inside a list or grid (#72): a group, with its title in a header
 * row it's picked up by, and its own contents below.
 */
function SectionGroup({
	id,
	title,
	color,
	count,
	selected,
	dropTarget,
	editing,
	onEdit,
}: {
	id: string;
	title: string;
	color: string;
	count: number;
	selected: boolean;
	dropTarget: boolean;
	editing: boolean;
	onEdit: (editing: boolean) => void;
}) {
	const doc = useContext(DocContext);
	return (
		<div
			className="section section-group"
			data-color={color}
			data-selected={selected}
			data-drop-target={dropTarget}
		>
			<div
				className="section-group-head section-handle"
				onDoubleClick={(event) => {
					event.stopPropagation();
					onEdit(true);
				}}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 12 12"
					aria-hidden="true"
					className="section-group-glyph"
				>
					<rect x="1" y="2" width="10" height="8" rx="2" />
				</svg>
				{editing && doc ? (
					<TitleInput
						value={title}
						onChange={(value) => updateShapes(doc, [id], { title: value })}
						onDone={() => onEdit(false)}
					/>
				) : (
					<span className="section-name" data-empty={title === ""}>
						{title || "Untitled section"}
					</span>
				)}
				<span className="section-count">{count}</span>
			</div>
		</div>
	);
}

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
	onDoubleClick,
	constrain,
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
	onDoubleClick?: () => void;
	/**
	 * A box of its own making from the raw one (an image keeping its
	 * proportions unless Shift's held), or null to snap the raw one as usual.
	 */
	constrain?: (start: Rect, raw: Rect, handle: ResizeHandle, shift: boolean) => Rect | null;
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
			const own = constrain?.(start, raw, handle, move.shiftKey);
			if (own) ui.snapResize(id, own, null);
			rect = own ?? ui.snapResize(id, raw, handle);
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
			onDoubleClick={
				onDoubleClick &&
				((event) => {
					event.stopPropagation();
					onDoubleClick();
				})
			}
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
				// Drawn: around whatever it's drawn around. Clicked: an empty section
				// in the space there, never taking shapes from another section.
				const rect = dragged
					? rectFromPoints(start, end)
					: sectionSpot(readShapes(doc), start, SECTION_DEFAULT, sizeOf);
				const place = () => {
					const id = transactLocal(doc, () => addSection(doc, rect, {}, sizeOf));
					focusWhenMounted(id);
					onCreateRef.current(id);
				};
				// Free space wasn't where you clicked: glide there first, title and
				// all, and it pops in once it's in view (ready to name).
				const { width, height, transform } = store.getState();
				const [tx, ty, zoom] = transform;
				const seen = { x: -tx / zoom, y: -ty / zoom, w: width / zoom, h: height / zoom };
				const inView =
					rect.x >= seen.x &&
					rect.y - 40 >= seen.y &&
					rect.x + rect.w <= seen.x + seen.w &&
					rect.y + rect.h <= seen.y + seen.h;
				if (dragged || inView) {
					place();
					return;
				}
				void flow
					.setCenter(rect.x + rect.w / 2, rect.y + rect.h / 2 - 20, {
						zoom: Math.min(zoom, (height * 0.8) / (rect.h + 60), (width * 0.9) / rect.w),
						duration: scaledDuration(420),
					})
					.then(place);
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
