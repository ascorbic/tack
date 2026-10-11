import type { NodeProps } from "@xyflow/react";
import { type KeyboardEvent, memo, useContext, useEffect, useRef, useState } from "react";
import { setPileName } from "../../shared/pileEdits.ts";
import { UNTITLED_PILE, nameState, pileName, readSuggestion } from "../../shared/piles.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { silentOf } from "../../shared/silent.ts";
import { isFresh, type ShapeNode } from "../board.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { useSilentTexts } from "../facilitation/store.ts";
import { StickyView } from "../StickyNode.tsx";
import { transactLocal } from "../undo.ts";
import { pileStore, usePiles } from "./store.ts";
import type { PileView } from "./view.ts";
import "./piles.css";

/** The pile as `Board` draws it: a stack, or when open, the tray its stickies spread out on. */
export const PileNode = memo(function PileNode({ id, data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const { ai } = usePiles();
	const [enter] = useState(() => isFresh(id));
	const view = data.pile;
	if (!view) return null;
	const rename = (name: string) => {
		if (doc && !readOnly) transactLocal(doc, () => setPileName(doc, id, name));
	};
	return (
		<PileStack
			id={id}
			shape={data.shape}
			view={view}
			selected={!!selected}
			enter={enter}
			naming={ai === true}
			editable={!!doc && !readOnly}
			onRename={rename}
			onGather={() => pileStore.setOpen(null)}
		/>
	);
});

const TILTS = [-3.5, 4.5, -1.5];

/** A pile, without any board behaviour: the gallery uses it too. */
export function PileStack({
	id,
	shape,
	view,
	selected = false,
	enter = false,
	naming = false,
	editable = false,
	onRename,
	onGather,
}: {
	id: string;
	shape: ShapeProps;
	view: PileView;
	selected?: boolean;
	enter?: boolean;
	/** Whether names are suggested here (AI suggestions are on). */
	naming?: boolean;
	editable?: boolean;
	onRename?: (name: string) => void;
	onGather?: () => void;
}) {
	const texts = useSilentTexts();
	const [top, ...under] = view.members;
	const count = view.members.length;
	const words = view.members.some(
		(member) => !silentOf(member.shape) && (member.shape.text ?? "").trim() !== "",
	);
	const name = (
		<PileName
			id={id}
			shape={shape}
			selected={selected || view.open}
			editable={editable}
			waiting={naming && words}
			onRename={onRename}
		/>
	);
	if (view.open) {
		return (
			<div
				className="pile-tray"
				data-pile={id}
				data-selected={selected || undefined}
				role="group"
				aria-label={`${pileName(shape) ?? UNTITLED_PILE}, ${count} ${count === 1 ? "sticky" : "stickies"}, open`}
			>
				<header className="pile-tray-head">
					{name}
					<span className="pile-tray-count">
						{count} {count === 1 ? "sticky" : "stickies"}
					</span>
					<button
						type="button"
						className="pile-gather nodrag"
						onClick={(event) => {
							event.stopPropagation();
							onGather?.();
						}}
						title="Gather them back up (Esc)"
					>
						<GatherIcon />
						<span>Gather</span>
					</button>
				</header>
			</div>
		);
	}
	const topSession = top ? silentOf(top.shape) : null;
	const mine = top !== undefined && topSession !== null && texts.has(top.id);
	return (
		<div
			className="pile"
			data-pile={id}
			data-enter={enter || undefined}
			data-receiving={view.receiving || undefined}
			data-fed={view.fed || undefined}
			data-selected={selected || undefined}
			data-count={Math.min(count, 3)}
			role="group"
			aria-label={`${pileName(shape) ?? UNTITLED_PILE}: a pile of ${count} ${count === 1 ? "sticky" : "stickies"}`}
		>
			<div className="pile-stack" key={view.fed || undefined}>
				{under.slice(0, 2).map((member, i) => (
					<div
						key={member.id}
						className="pile-paper"
						data-color={member.shape.color ?? "yellow"}
						style={
							{ "--paper-tilt": `${TILTS[i] ?? 0}deg`, "--paper-i": i + 1 } as React.CSSProperties
						}
						aria-hidden="true"
					/>
				))}
				{top && (
					<div className="pile-top">
						<StickyView
							text={
								topSession !== null && !mine
									? ""
									: ((mine ? texts.get(top.id) : top.shape.text) ?? "")
							}
							color={top.shape.color ?? "yellow"}
							font={top.shape.font}
							author={top.shape.author}
							faceDown={topSession !== null && !mine}
							hidden={mine}
						/>
					</div>
				)}
				<span className="pile-count" aria-hidden="true">
					{count}
				</span>
			</div>
			<div className="pile-label">{name}</div>
		</div>
	);
}

/**
 * A pile's name: a person's (as written), a suggestion (✨, until someone
 * names it), or "Untitled pile" with a pencil. Click to rename once it's
 * selected (or double-click); Enter keeps it, Escape doesn't, an empty name
 * goes back to suggestions.
 */
export function PileName({
	id,
	shape,
	selected,
	editable,
	waiting,
	onRename,
}: {
	id: string;
	shape: ShapeProps;
	selected: boolean;
	editable: boolean;
	/** Suggestions are on and there's something to read: a name's on its way. */
	waiting: boolean;
	onRename?: (name: string) => void;
}) {
	const state = nameState(shape);
	const name = pileName(shape);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const field = useRef<HTMLInputElement>(null);
	// Asked for from outside (the action bar's Rename, or Enter on a selected pile's name).
	useEffect(() => {
		if (!editable) return;
		const onRequest = (event: Event) => {
			const { detail } = event as CustomEvent<string>;
			if (detail !== id) return;
			setDraft(state === "person" ? (name ?? "") : "");
			setEditing(true);
		};
		const target = document;
		target.addEventListener(`tack:rename-pile`, onRequest);
		return () => target.removeEventListener(`tack:rename-pile`, onRequest);
	}, [editable, id, state, name]);
	useEffect(() => {
		if (editing) field.current?.select();
	}, [editing]);
	if (editing) {
		const commit = () => {
			setEditing(false);
			if (draft.trim() !== (state === "person" ? name : "")) onRename?.(draft);
		};
		const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
			event.stopPropagation();
			if (event.key === "Enter") commit();
			else if (event.key === "Escape") setEditing(false);
		};
		return (
			<input
				ref={field}
				className="pile-name-input nodrag"
				value={draft}
				maxLength={60}
				placeholder={
					state === "suggested" ? (readSuggestion(shape.suggested)?.title ?? "") : "Name this pile"
				}
				aria-label="Pile name"
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onKey}
				onBlur={commit}
				onPointerDown={(event) => event.stopPropagation()}
			/>
		);
	}
	const start = () => {
		if (!editable) return;
		setDraft(state === "person" ? (name ?? "") : "");
		setEditing(true);
	};
	return (
		<span className="pile-name-row">
			<button
				type="button"
				className="pile-name"
				data-state={state}
				data-waiting={(state === "none" && waiting) || undefined}
				disabled={!editable}
				title={
					state === "suggested"
						? "Suggested from what’s on its stickies. Click to rename"
						: editable
							? "Rename"
							: undefined
				}
				onClick={(event) => {
					// The first click selects the pile (or opens it); renaming is for once it's selected.
					if (!selected) return;
					event.stopPropagation();
					start();
				}}
				onDoubleClick={(event) => {
					event.stopPropagation();
					start();
				}}
			>
				{state === "suggested" && (
					<span className="pile-spark" aria-label="Suggested">
						✨
					</span>
				)}
				<span className="pile-name-text">
					{name ?? (state === "none" && waiting ? "Naming…" : UNTITLED_PILE)}
				</span>
				{state === "none" && !waiting && editable && <PencilIcon />}
			</button>
			{state === "suggested" && selected && editable && (
				<button
					type="button"
					className="pile-keep nodrag"
					title="Keep this name: it won’t change as the pile does"
					onClick={(event) => {
						event.stopPropagation();
						if (name) onRename?.(name);
					}}
				>
					Keep
				</button>
			)}
		</span>
	);
}

/** Ask a pile's name to start editing (the action bar's Rename). */
export function renamePile(id: string): void {
	document.dispatchEvent(new CustomEvent("tack:rename-pile", { detail: id }));
}

export function PileIcon({ size = 16 }: { size?: number }) {
	return (
		<svg className="pile-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
			<rect x="4.5" y="1.75" width="9" height="9" rx="1.2" transform="rotate(6 9 6.25)" />
			<rect x="2.5" y="4.5" width="9.5" height="9.5" rx="1.2" />
		</svg>
	);
}

export function SpreadIcon() {
	return (
		<svg className="pile-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<rect x="1.75" y="1.75" width="5.25" height="5.25" rx="1" />
			<rect x="9" y="1.75" width="5.25" height="5.25" rx="1" />
			<rect x="1.75" y="9" width="5.25" height="5.25" rx="1" />
			<rect x="9" y="9" width="5.25" height="5.25" rx="1" />
		</svg>
	);
}

export function SparkIcon() {
	return (
		<svg
			className="pile-icon pile-icon-spark"
			viewBox="0 0 16 16"
			width="16"
			height="16"
			aria-hidden="true"
		>
			<path d="M8 1.5c.4 2.9 1.6 4.1 4.5 4.5-2.9.4-4.1 1.6-4.5 4.5-.4-2.9-1.6-4.1-4.5-4.5 2.9-.4 4.1-1.6 4.5-4.5z" />
			<path d="M12.5 10.25c.2 1.3.75 1.85 2 2-1.25.15-1.8.7-2 2-.2-1.3-.75-1.85-2-2 1.25-.15 1.8-.7 2-2z" />
		</svg>
	);
}

function GatherIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path d="M3 3l3.5 3.5M13 3 9.5 6.5M3 13l3.5-3.5M13 13l-3.5-3.5" />
			<path d="M6.5 3.5v3h-3M9.5 3.5v3h3M6.5 12.5v-3h-3M9.5 12.5v-3h3" />
		</svg>
	);
}

function PencilIcon() {
	return (
		<svg className="pile-pencil" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<path d="M10.75 2.75l2.5 2.5L6 12.5 3 13l.5-3z" />
		</svg>
	);
}
