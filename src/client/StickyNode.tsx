import type { NodeProps } from "@xyflow/react";
import {
	type PointerEvent,
	type MouseEvent,
	type ReactNode,
	type Ref,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type * as Y from "yjs";
import { type Author, type ShapeFont, shapesMap } from "../shared/shapes.ts";
import { silentOf } from "../shared/silent.ts";
import { isFresh, type ShapeNode, setStickyText, takeFocus } from "./board.ts";
import { DocContext } from "./DocContext.ts";
import { facilitation, useSilentTexts } from "./facilitation/store.ts";
import { scaledDuration } from "./motion.ts";
import { initials } from "./People.tsx";
import { STICKY_FONT_SIZES } from "./textFit.ts";
import { EditHint } from "./EditHint.tsx";
import { useEditing } from "./useEditing.ts";
import { useFitText } from "./useFitText.ts";
import { useStickyVolunteers } from "./volunteers/Volunteers.tsx";

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
	/**
	 * Silent mode: someone else's sticky, lying face down until the reveal
	 * (its text isn't in the document at all).
	 */
	faceDown?: boolean;
	/** Silent mode: yours, which only you can see for now. */
	hidden?: boolean;
	/** Turning over at the reveal: a new number each time, and when in the wave. */
	flip?: { n: number; delay: number } | null;
	/** Who's volunteered, after the author's name (volunteers/): it takes a line. */
	volunteers?: ReactNode;
	/** The hand to volunteer with: after the author, or in the corner without one. */
	hand?: ReactNode;
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
	faceDown = false,
	hidden = false,
	flip = null,
	volunteers,
	hand,
	...handlers
}: StickyViewProps) {
	const foot = !!author || !!volunteers;
	const fit = useFitText(
		text,
		font,
		foot ? TEXT_BOX : TEXT_BOX_NO_AUTHOR,
		STICKY_FONT_SIZES,
		"sticky-type",
	);
	return (
		<div
			key={flip?.n}
			className="sticky"
			data-enter={enter}
			data-color={color}
			data-selected={selected}
			data-editing={editing}
			data-face-down={faceDown || undefined}
			data-hidden={hidden || undefined}
			data-flip={flip ? true : undefined}
			style={
				{
					"--tilt": `${tilt}deg`,
					"--fit-size": `${fit.size}px`,
					"--author": author?.color || "var(--muted)",
					...(flip ? { "--flip-delay": `${flip.delay}ms` } : {}),
				} as React.CSSProperties
			}
			{...handlers}
		>
			{flip && <FaceDownBack author={author} />}
			{hidden && (
				<span className="sticky-hidden" title="Only you can see this until it’s revealed">
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
						<path d="M1.5 6s1.6-3 4.5-3 4.5 3 4.5 3-1.6 3-4.5 3-4.5-3-4.5-3z" />
						<path d="M2 10 10 2" />
					</svg>
					<span className="visually-hidden">Only you can see this until it’s revealed</span>
				</span>
			)}
			<div className="sticky-body">
				{faceDown ? (
					<FaceDownMark author={author} />
				) : editing ? (
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
			{foot && (
				<div className="sticky-foot">
					{author && (
						<span
							className="sticky-author"
							style={{ "--author": author.color || "var(--muted)" } as React.CSSProperties}
							title={author.name}
						>
							<span className="sticky-author-name">{author.name || "Someone"}</span>
						</span>
					)}
					{volunteers ?? hand}
				</div>
			)}
			{!foot && hand}
		</div>
	);
}

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const [enter, setEnter] = useState(() => isFresh(data.id));
	// A sticky this client just placed starts in editing mode.
	const [startEditing] = useState(() => takeFocus(data.id));
	// Silent mode: yours show your own text (kept off the document); everyone
	// else's lie face down.
	const session = silentOf(data.shape);
	const texts = useSilentTexts();
	const mine = session !== null && texts.has(data.id);
	const faceDown = session !== null && !mine;
	const value = (mine ? texts.get(data.id) : data.shape.text) ?? "";
	const latest = useRef(value);
	latest.current = value;
	const flip = useRevealFlip(doc, session, data.shape);
	// It drops in once: turning over remounts it (twice), and it mustn't drop in again.
	useEffect(() => {
		if (flip) setEnter(false);
	}, [flip]);
	const volunteers = useStickyVolunteers(data.id, faceDown);
	const { editing, setEditing, field, handlers, hint } = useEditing({
		id: data.id,
		selected: !!selected && !faceDown,
		startEditing: startEditing && !faceDown,
		onType: (chars) => doc && setStickyText(doc, data.id, latest.current + chars),
	});

	return (
		<>
			<StickyView
				faceDown={faceDown}
				hidden={mine}
				flip={flip}
				text={faceDown ? "" : value}
				color={data.shape.color ?? "yellow"}
				font={data.shape.font}
				author={data.shape.author}
				tilt={tilt(data.id)}
				selected={selected}
				editing={editing}
				enter={enter}
				field={field}
				volunteers={volunteers.chip}
				hand={editing ? null : volunteers.hand}
				onText={(text) => doc && setStickyText(doc, data.id, text)}
				onStopEditing={() => {
					if (mine) facilitation.flush(data.id);
					setEditing(false);
				}}
				{...(faceDown ? {} : handlers)}
			/>
			<EditHint show={hint} />
		</>
	);
});

/** How long the reveal's wave takes to cross a section, before motion scaling. */
const WAVE_MS = 700;
/** How long one sticky takes to turn over; keep in step with `.sticky[data-flip]`. */
const FLIP_MS = 760;

/**
 * When a face-down sticky is revealed, it turns over: each a little after
 * the last, in a wave from the section's top-left corner.
 */
function useRevealFlip(
	doc: Y.Doc | null,
	session: string | null,
	shape: ShapeNode["data"]["shape"],
): { n: number; delay: number } | null {
	const [flip, setFlip] = useState<{ n: number; delay: number } | null>(null);
	const was = useRef(session);
	useEffect(() => {
		const before = was.current;
		was.current = session;
		if (before === null || session !== null) return;
		let delay = 0;
		const parent = doc && shape.parent ? shapesMap(doc).get(shape.parent) : undefined;
		if (parent) {
			const sx = Number(parent.get("x")) || 0;
			const sy = Number(parent.get("y")) || 0;
			const sw = Number(parent.get("w")) || 1;
			const sh = Number(parent.get("h")) || 1;
			const t = ((shape.x - sx) / sw + (shape.y - sy) / sh) / 2;
			delay = Math.round(Math.min(1, Math.max(0, t)) * WAVE_MS);
		}
		setFlip((current) => ({ n: (current?.n ?? 0) + 1, delay }));
	}, [session, doc, shape.parent, shape.x, shape.y]);
	// Once it's turned over, it's an ordinary sticky again.
	useEffect(() => {
		if (!flip) return;
		const timer = setTimeout(() => setFlip(null), scaledDuration(flip.delay + FLIP_MS) + 100);
		return () => clearTimeout(timer);
	}, [flip]);
	return flip;
}

/** The back of a face-down sticky: its author's mark on a hatched back. */
function FaceDownMark({ author }: { author?: Author }) {
	return (
		<div
			className="sticky-face-down"
			role="img"
			aria-label={`${author?.name || "Someone"}’s sticky, face down`}
		>
			<span className="sticky-face-down-mark" aria-hidden="true">
				{initials(author?.name || "?")}
			</span>
		</div>
	);
}

/** The face-down side, shown over a sticky for the first half of its turn. */
function FaceDownBack({ author }: { author?: Author }) {
	return (
		<span className="sticky-back" aria-hidden="true">
			<span className="sticky-face-down">
				<span className="sticky-face-down-mark">{initials(author?.name || "?")}</span>
			</span>
		</span>
	);
}
