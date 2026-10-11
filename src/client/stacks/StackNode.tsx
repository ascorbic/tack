import type { NodeProps } from "@xyflow/react";
import { type KeyboardEvent, memo, useContext, useEffect, useRef, useState } from "react";
import { setStackName } from "../../shared/stackEdits.ts";
import { UNTITLED_STACK, nameState, stackName, readSuggestion } from "../../shared/stacks.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { silentOf } from "../../shared/silent.ts";
import { isFresh, type ShapeNode } from "../board.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { useSilentTexts } from "../facilitation/store.ts";
import { StickyView } from "../StickyNode.tsx";
import { transactLocal } from "../undo.ts";
import { stackStore, useStacks } from "./store.ts";
import type { StackView } from "./view.ts";
import "./stacks.css";

/** The stack as `Board` draws it: a stack, or when open, the tray its stickies spread out on. */
export const StackNode = memo(function StackNode({ id, data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const { ai } = useStacks();
	const [enter] = useState(() => isFresh(id));
	const view = data.stack;
	if (!view) return null;
	const rename = (name: string) => {
		if (doc && !readOnly) transactLocal(doc, () => setStackName(doc, id, name));
	};
	return (
		<StackPapers
			id={id}
			shape={data.shape}
			view={view}
			selected={!!selected}
			enter={enter}
			naming={ai === true}
			editable={!!doc && !readOnly}
			onRename={rename}
			onGather={() => stackStore.setOpen(null)}
		/>
	);
});

const TILTS = [-3.5, 4.5, -1.5];

/** A stack, without any board behaviour: the gallery uses it too. */
export function StackPapers({
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
	view: StackView;
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
		<StackName
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
				className="stack-tray"
				data-stack={id}
				data-selected={selected || undefined}
				role="group"
				aria-label={`${stackName(shape) ?? UNTITLED_STACK}, ${count} ${count === 1 ? "sticky" : "stickies"}, open`}
			>
				<header className="stack-tray-head">
					{name}
					<span className="stack-tray-count">
						{count} {count === 1 ? "sticky" : "stickies"}
					</span>
					<button
						type="button"
						className="stack-gather nodrag"
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
			className="stack"
			data-stack={id}
			data-enter={enter || undefined}
			data-receiving={view.receiving || undefined}
			data-fed={view.fed || undefined}
			data-selected={selected || undefined}
			data-count={Math.min(count, 3)}
			role="group"
			aria-label={`${stackName(shape) ?? UNTITLED_STACK}: a stack of ${count} ${count === 1 ? "sticky" : "stickies"}`}
		>
			<div className="stack-papers" key={view.fed || undefined}>
				{under.slice(0, 2).map((member, i) => (
					<div
						key={member.id}
						className="stack-paper"
						data-color={member.shape.color ?? "yellow"}
						style={
							{ "--paper-tilt": `${TILTS[i] ?? 0}deg`, "--paper-i": i + 1 } as React.CSSProperties
						}
						aria-hidden="true"
					/>
				))}
				{top && (
					<div className="stack-top">
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
				<span className="stack-count" aria-hidden="true">
					{count}
				</span>
			</div>
			<div className="stack-label">{name}</div>
		</div>
	);
}

/**
 * A stack's name: a person's (as written), a suggestion (✨, until someone
 * names it), or "Untitled stack" with a pencil. Click to rename once it's
 * selected (or double-click); Enter keeps it, Escape doesn't, an empty name
 * goes back to suggestions.
 */
export function StackName({
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
	const name = stackName(shape);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const field = useRef<HTMLInputElement>(null);
	// Asked for from outside (the action bar's Rename, or Enter on a selected stack's name).
	useEffect(() => {
		if (!editable) return;
		const onRequest = (event: Event) => {
			const { detail } = event as CustomEvent<string>;
			if (detail !== id) return;
			setDraft(state === "person" ? (name ?? "") : "");
			setEditing(true);
		};
		const target = document;
		target.addEventListener(`tack:rename-stack`, onRequest);
		return () => target.removeEventListener(`tack:rename-stack`, onRequest);
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
				className="stack-name-input nodrag"
				value={draft}
				maxLength={60}
				placeholder={
					state === "suggested" ? (readSuggestion(shape.suggested)?.title ?? "") : "Name this stack"
				}
				aria-label="Stack name"
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
		<span className="stack-name-row">
			<button
				type="button"
				className="stack-name"
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
					// The first click selects the stack (or opens it); renaming is for once it's selected.
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
					<span className="stack-spark" aria-label="Suggested">
						✨
					</span>
				)}
				<span className="stack-name-text">
					{name ?? (state === "none" && waiting ? "Naming…" : UNTITLED_STACK)}
				</span>
				{state === "none" && !waiting && editable && <PencilIcon />}
			</button>
			{state === "suggested" && selected && editable && (
				<button
					type="button"
					className="stack-keep nodrag"
					title="Keep this name: it won’t change as the stack does"
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

/** Ask a stack's name to start editing (the action bar's Rename). */
export function renameStack(id: string): void {
	document.dispatchEvent(new CustomEvent("tack:rename-stack", { detail: id }));
}

export function StackIcon({ size = 16 }: { size?: number }) {
	return (
		<svg className="stack-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
			<rect x="4.5" y="1.75" width="9" height="9" rx="1.2" transform="rotate(6 9 6.25)" />
			<rect x="2.5" y="4.5" width="9.5" height="9.5" rx="1.2" />
		</svg>
	);
}

export function SpreadIcon() {
	return (
		<svg className="stack-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
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
			className="stack-icon stack-icon-spark"
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
		<svg className="stack-pencil" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<path d="M10.75 2.75l2.5 2.5L6 12.5 3 13l.5-3z" />
		</svg>
	);
}
