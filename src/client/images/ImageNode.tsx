import { NodeToolbar, type NodeProps, Position } from "@xyflow/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { Rect } from "../../shared/geometry.ts";
import {
	IMAGE_LIMITS,
	IMAGE_MIN,
	type ImageState,
	cleanAlt,
	imageSize,
	imageState,
	keepAspect,
} from "../../shared/images.ts";
import type * as Y from "yjs";
import { type ShapeProps, shapesMap } from "../../shared/shapes.ts";
import { resizeImage } from "../../shared/structure.ts";
import { deleteShapes, isFresh, type ShapeNode } from "../board.ts";
import { DocContext, ReadOnlyContext, SectionContext } from "../DocContext.ts";
import { RESIZE_HANDLES, ResizeGrip } from "../sections.tsx";
import { useEditing } from "../useEditing.ts";
import { useInsideCanvas } from "../useInsideCanvas.ts";
import { transactLocal } from "../undo.ts";
import { settleUpload, useUpload } from "./insert.ts";
import { useImageSrc } from "./service.ts";
import "./images.css";

// An image on the board: its file, filling the shape's box (cropped, never
// stretched, if someone's resized it out of proportion with Shift), with
// rounded corners and a card's shadow; while it uploads, the uploader sees
// their own picture filling in and everyone else a blurred stand-in that
// shimmers; a file that can't be shown says so, with its alt text. Its alt
// text is its words for screen readers and AI, and can show beneath it as a
// caption. Resizing keeps its proportions unless Shift's held.

/** How often an upload's age is looked at again, to notice one that was abandoned. */
const STALE_CHECK_MS = 15_000;

export const ImageNode = memo(function ImageNode({ id, data, selected }: NodeProps<ShapeNode>) {
	const shape = data.shape;
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const ui = useContext(SectionContext);
	const upload = useUpload(id);
	const now = useNow(shape.upload ? STALE_CHECK_MS : null);
	const state = imageState(shape, now);
	const src = useImageSrc(shape.image);
	const [enter] = useState(() => isFresh(id));
	const { editing, setEditing, field, handlers } = useEditing({
		id,
		selected: !!selected,
		startEditing: false,
		onType: (chars) => {
			if (doc) transactLocal(doc, () => setAlt(doc, id, `${shape.alt ?? ""}${chars}`));
		},
	});

	// Redone after its upload finished: it still says it's uploading.
	useEffect(() => {
		if (doc && shape.upload && upload?.done) settleUpload(doc, id);
	}, [doc, id, shape.upload, upload?.done]);

	const grips =
		selected && doc && !readOnly
			? RESIZE_HANDLES.map((handle) => (
					<ResizeGrip
						key={handle}
						id={id}
						handle={handle}
						min={{ w: IMAGE_MIN, h: IMAGE_MIN }}
						start={() => ({ x: shape.x, y: shape.y, ...imageSize(shape) })}
						ui={ui}
						// Its proportions stay, unless Shift's held.
						constrain={(start, raw, which, shift) => (shift ? null : keepAspect(start, raw, which))}
						onCommit={(rect: Rect) =>
							transactLocal(doc, () => resizeImage(doc, id, rect, ui.sizeOf))
						}
					/>
				))
			: null;

	return (
		<>
			<ImageView
				shape={shape}
				state={state}
				src={upload?.local ?? src}
				progress={upload && !upload.done ? upload.progress : null}
				selected={!!selected}
				enter={enter}
				onDoubleClick={readOnly ? undefined : handlers.onDoubleClick}
				onRemove={
					doc && !readOnly && state === "interrupted" ? () => deleteShapes(doc, [id]) : undefined
				}
			/>
			{grips}
			{doc && !readOnly && (
				<ImageToolbar
					id={id}
					shape={shape}
					visible={!!selected}
					editing={editing}
					field={field}
					src={src}
					onEdit={setEditing}
					onAlt={(alt) => transactLocal(doc, () => setAlt(doc, id, alt))}
					onCaption={(caption) =>
						transactLocal(doc, () => {
							const map = shapesMap(doc).get(id);
							if (!map) return;
							if (caption) map.set("caption", true);
							else if (map.has("caption")) map.delete("caption");
						})
					}
					onProportions={() =>
						transactLocal(doc, () => {
							const { w, h } = imageSize(shape);
							const ratio = (shape.iw ?? w) / Math.max(shape.ih ?? h, 1);
							// Keep its width, and its middle where it is.
							const height = w / ratio;
							resizeImage(
								doc,
								id,
								{ x: shape.x, y: shape.y + (h - height) / 2, w, h: height },
								ui.sizeOf,
							);
						})
					}
				/>
			)}
		</>
	);
});

function setAlt(doc: Y.Doc, id: string, alt: string): void {
	const map = shapesMap(doc).get(id);
	if (!map) return;
	const text = alt.slice(0, IMAGE_LIMITS.alt);
	if (text.trim()) map.set("alt", text);
	else if (map.has("alt")) map.delete("alt");
}

/** The time, looked at again every `ms` (or never). */
function useNow(ms: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (ms === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return now;
}

export interface ImageViewProps {
	shape: Pick<ShapeProps, "alt" | "caption" | "preview" | "upload" | "mime" | "w" | "h">;
	state: ImageState;
	/** Where the file loads from: undefined while that's being found, null if it isn't here. */
	src: string | null | undefined;
	/** This tab's upload's progress, 0 to 1; null if it isn't uploading it. */
	progress?: number | null;
	selected?: boolean;
	enter?: boolean;
	onDoubleClick?: () => void;
	/** An abandoned upload: take it off the board. */
	onRemove?: () => void;
}

/** An image, without any board behaviour (the gallery uses it too). */
export function ImageView({
	shape,
	state,
	src,
	progress = null,
	selected = false,
	enter = false,
	onDoubleClick,
	onRemove,
}: ImageViewProps) {
	const [loaded, setLoaded] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const mine = progress !== null;
	// Its own picture for whoever's uploading it; the file, once it's stored.
	const showFile = !!src && (state === "ready" || mine);
	const broken = showFile && failed === src;
	const shown =
		state === "uploading" && !mine
			? "uploading"
			: state === "interrupted"
				? "interrupted"
				: state === "missing" || src === null || broken
					? "missing"
					: loaded === src
						? "ready"
						: "loading";
	const alt = shape.alt?.trim() ?? "";
	return (
		<figure
			className="image-node"
			data-state={shown}
			data-selected={selected || undefined}
			data-enter={enter || undefined}
			data-uploading={mine || undefined}
			onDoubleClick={onDoubleClick}
		>
			<div className="image-frame">
				{shape.preview && shown !== "ready" && shown !== "missing" && (
					<img className="image-preview" src={shape.preview} alt="" draggable={false} />
				)}
				{showFile && !broken && (
					<img
						key={src}
						className="image-file"
						src={src}
						alt=""
						draggable={false}
						decoding="async"
						data-loaded={loaded === src || undefined}
						onLoad={() => setLoaded(src)}
						onError={() => setFailed(src)}
					/>
				)}
				{(shown === "uploading" || shown === "loading") && (
					<span className="image-shimmer" aria-hidden="true" />
				)}
				{mine && <ProgressRing value={progress ?? 0} />}
				{shown === "uploading" && shape.upload && (
					<span className="image-badge">
						<span className="image-badge-dot" aria-hidden="true" />
						Uploading · {shape.upload.by}
					</span>
				)}
				{shown === "interrupted" && (
					<div className="image-empty">
						<BrokenIcon />
						<span className="image-empty-title">The upload didn’t finish</span>
						{shape.upload && (
							<span className="image-empty-detail">{shape.upload.by} stopped adding it</span>
						)}
						{onRemove && (
							<button type="button" className="image-empty-action nodrag" onClick={onRemove}>
								Remove
							</button>
						)}
					</div>
				)}
				{shown === "missing" && (
					<div className="image-empty">
						<BrokenIcon />
						<span className="image-empty-title">Image unavailable</span>
						{alt && <span className="image-empty-detail">{alt}</span>}
					</div>
				)}
			</div>
			{shape.caption && alt && <figcaption className="image-caption">{alt}</figcaption>}
		</figure>
	);
}

/** How far an upload has got, as a ring that fills, then a tick. */
function ProgressRing({ value }: { value: number }) {
	const r = 9;
	const length = 2 * Math.PI * r;
	return (
		<span
			className="image-progress"
			role="progressbar"
			aria-label="Uploading"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(value * 100)}
		>
			<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
				<circle cx="12" cy="12" r={r} className="image-progress-track" />
				<circle
					cx="12"
					cy="12"
					r={r}
					className="image-progress-fill"
					strokeDasharray={length}
					strokeDashoffset={length * (1 - Math.max(0.04, value))}
				/>
			</svg>
		</span>
	);
}

function BrokenIcon() {
	return (
		<svg className="image-empty-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
			<rect x="3.5" y="4.5" width="17" height="15" rx="3" />
			<path d="m3.5 15.5 4.6-4.6a1.6 1.6 0 0 1 2.3 0l3.1 3.1M13 12.5l1.6-1.6a1.6 1.6 0 0 1 2.3 0l3.6 3.6" />
			<circle cx="15.5" cy="8.5" r="1.4" />
		</svg>
	);
}

// --- The toolbar above a selected image -----------------------------------------------

function ImageToolbar({
	id,
	shape,
	visible,
	editing,
	field,
	src,
	onEdit,
	onAlt,
	onCaption,
	onProportions,
}: {
	id: string;
	shape: ShapeProps;
	visible: boolean;
	editing: boolean;
	field: React.RefObject<HTMLTextAreaElement | null>;
	src: string | null | undefined;
	onEdit: (editing: boolean) => void;
	onAlt: (alt: string) => void;
	onCaption: (caption: boolean) => void;
	onProportions: () => void;
}) {
	const clamp = useRef<HTMLDivElement>(null);
	useInsideCanvas(clamp);
	const { w, h } = imageSize(shape);
	const natural = shape.iw && shape.ih ? shape.iw / shape.ih : null;
	const stretched = natural !== null && Math.abs(w / h / natural - 1) > 0.01;
	const alt = shape.alt ?? "";
	const keepFocus = (event: React.PointerEvent) => event.preventDefault();
	const onKeyDown = (event: ReactKeyboardEvent) => {
		event.stopPropagation();
		if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
			event.preventDefault();
			onAlt(cleanAlt(alt));
			onEdit(false);
		}
	};
	return (
		<NodeToolbar nodeId={id} isVisible={visible} position={Position.Top} offset={14}>
			<div ref={clamp} className="shape-toolbar-clamp">
				<div className="image-toolbar">
					<div className="shape-toolbar nodrag nopan" role="toolbar" aria-label="Image options">
						<div className="shape-toolbar-group">
							<button
								type="button"
								className="shape-toolbar-option image-toolbar-alt"
								aria-label="Alt text"
								aria-pressed={editing}
								data-empty={alt.trim() ? undefined : true}
								title="Describe it for people who can’t see it (↵)"
								onPointerDown={keepFocus}
								onClick={() => onEdit(!editing)}
							>
								<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
									<path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h5" />
								</svg>
								Alt text
							</button>
							<button
								type="button"
								role="switch"
								className="shape-toolbar-option"
								aria-label="Caption"
								aria-checked={!!shape.caption}
								disabled={!alt.trim()}
								title={
									alt.trim() ? "Show the alt text beneath it" : "Add alt text to show a caption"
								}
								onPointerDown={keepFocus}
								onClick={() => onCaption(!shape.caption)}
							>
								Caption
							</button>
						</div>
						<div className="shape-toolbar-group">
							{stretched && (
								<button
									type="button"
									className="shape-toolbar-option"
									title="Back to its own proportions"
									aria-label="Original proportions"
									onPointerDown={keepFocus}
									onClick={onProportions}
								>
									<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
										<rect x="2.5" y="3.5" width="11" height="9" rx="2" />
										<path d="M5.5 8h5M8 5.5v5" />
									</svg>
								</button>
							)}
							{src && shape.image && (
								<a
									className="shape-toolbar-option image-toolbar-open"
									href={src}
									target="_blank"
									rel="noreferrer"
									title="Open the full image"
									aria-label="Open the full image"
								>
									<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
										<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
									</svg>
								</a>
							)}
						</div>
					</div>
					{editing && (
						<div className="image-alt nodrag nopan">
							<label className="image-alt-label" htmlFor={`image-alt-${id}`}>
								Alt text
							</label>
							<textarea
								id={`image-alt-${id}`}
								ref={field}
								className="image-alt-field"
								value={alt}
								rows={3}
								maxLength={IMAGE_LIMITS.alt}
								placeholder="What does it show?"
								onChange={(event) => onAlt(event.target.value.replace(/\n/g, " "))}
								onKeyDown={onKeyDown}
								onBlur={() => {
									onAlt(cleanAlt(alt));
									onEdit(false);
								}}
							/>
							<p className="image-alt-hint">
								For people who can’t see it. AI reads this, never the picture.
							</p>
						</div>
					)}
				</div>
			</div>
		</NodeToolbar>
	);
}
