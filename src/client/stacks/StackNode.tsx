import { type NodeProps, useStore } from "@xyflow/react";
import {
	type KeyboardEvent,
	type PointerEvent,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { isMissing } from "../../shared/cards.ts";
import { setStackName } from "../../shared/stackEdits.ts";
import {
	UNTITLED_STACK,
	countMembers,
	excerptCount,
	nameState,
	readSuggestion,
	stackName,
} from "../../shared/stacks.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { silentOf } from "../../shared/silent.ts";
import { isFresh, type ShapeNode } from "../board.ts";
import { StateIcon } from "../CardView.tsx";
import { useCard } from "../cardStore.ts";
import { useChangesUI } from "../changes/context.ts";
import { useShapeChanges } from "../changes/store.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { useSilentTexts } from "../facilitation/store.ts";
import { isOnUnselectedShape } from "../keys.ts";
import { transactLocal } from "../undo.ts";
import { stackStore, useStacks } from "./store.ts";
import type { StackView } from "./view.ts";
import "./stacks.css";

// A stack (#73) on the board is a theme card: its name as the headline, in
// the display face, with how many it holds beside it; then its first few
// stickies and cards as one-line excerpts (a sticky's colour, a card's state,
// number and title), and "+N more". Two papers peek out behind it, in its
// members' colours, so it still reads as a stack. Click its name to rename it
// in place (a ✨ suggestion is kept by editing it, or with ✓); click anywhere
// else to spread it open. Zoomed out past where cards go compact, it's only
// its name and count, big, so a board reads as labelled themes.

/** Below this zoom it shows only its name and count, as cards go compact. */
const FAR_ZOOM = 0.45;

/** The stack as `Board` draws it: a theme card, or when open, the tray its members spread out on. */
export const StackNode = memo(function StackNode({ id, data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const { ai } = useStacks();
	const [enter] = useState(() => isFresh(id));
	const far = useStore((state) => state.transform[2] < FAR_ZOOM);
	const view = data.stack;
	// Enter spreads a selected stack open, as a click does (#61's keyboard rule:
	// Enter selects a shape, then Enter acts on it).
	const closed = !!selected && !!view && !view.open;
	useEffect(() => {
		if (!closed) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, button, [contenteditable]")) return;
			if (isOnUnselectedShape(target)) return;
			event.preventDefault();
			stackStore.setOpen(id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [closed, id]);
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
			far={far}
			naming={ai === true}
			editable={!!doc && !readOnly}
			onRename={rename}
			onGather={() => stackStore.setOpen(null)}
		/>
	);
});

type Member = StackView["members"][number];

/** A member's paper colour, for the edges behind the card: a sticky's, or a card's tint. */
function paperOf(member: Member | undefined): string | undefined {
	if (!member) return undefined;
	return member.shape.type === "card" ? "card" : (member.shape.color ?? "yellow");
}

/** Whether a member has words to read (so a name's on its way). */
function hasWords(member: Member): boolean {
	if (member.shape.type === "card") return true;
	return !silentOf(member.shape) && (member.shape.text ?? "").trim() !== "";
}

/** A stack, without any board behaviour: the gallery uses it too. */
export function StackPapers({
	id,
	shape,
	view,
	selected = false,
	enter = false,
	far = false,
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
	/** Zoomed out: only its name and count. */
	far?: boolean;
	/** Whether names are suggested here (AI suggestions are on). */
	naming?: boolean;
	editable?: boolean;
	onRename?: (name: string) => void;
	onGather?: () => void;
}) {
	const count = view.members.length;
	const holds = countMembers(view.members.map((member) => member.shape.type));
	const waiting = naming && view.members.some(hasWords);
	const label = stackName(shape) ?? UNTITLED_STACK;
	if (view.open) {
		return (
			<div
				className="stack-tray"
				data-stack={id}
				data-selected={selected || undefined}
				role="group"
				aria-label={`${label}, ${holds}, open`}
			>
				<header className="stack-tray-head">
					<StackName
						id={id}
						shape={shape}
						editable={editable}
						waiting={waiting}
						onRename={onRename}
					/>
					<span className="stack-tray-count">{holds}</span>
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
	const shown = view.members.slice(0, excerptCount(count));
	const more = count - shown.length;
	return (
		<div
			className="stack"
			data-stack={id}
			data-enter={enter || undefined}
			data-receiving={view.receiving || undefined}
			data-fed={view.fed || undefined}
			data-selected={selected || undefined}
			data-far={far || undefined}
			data-count={Math.min(count, 3)}
			role="group"
			aria-label={`${label}: a stack of ${holds}`}
		>
			<div className="stack-lift" key={view.fed || undefined}>
				<span className="stack-paper" data-paper={paperOf(view.members[1])} aria-hidden="true" />
				<span
					className="stack-paper stack-paper-2"
					data-paper={paperOf(view.members[2] ?? view.members[1])}
					aria-hidden="true"
				/>
				<div className="stack-card">
					<div className="stack-head">
						<StackName
							id={id}
							shape={shape}
							editable={editable}
							waiting={waiting}
							headline
							onRename={onRename}
						/>
						<span className="stack-count" title={holds}>
							{count}
						</span>
					</div>
					<ul className="stack-rows" aria-label="In it">
						{shown.map((member) => (
							<li key={member.id}>
								<Excerpt member={member} />
							</li>
						))}
						{more > 0 && (
							<li className="stack-more">
								+{more} more
								<StagedAmong members={view.members.slice(shown.length)} />
							</li>
						)}
					</ul>
					{/* Zoomed out: its name and count, big, over the same box. */}
					<div className="stack-far" aria-hidden="true">
						<span className="stack-far-name" data-state={nameState(shape)}>
							{label} <span className="stack-far-count">{count}</span>
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

/** One member, in a line: a sticky's colour and words, or a card's state, number and title. */
function Excerpt({ member }: { member: Member }) {
	if (member.shape.type === "card") return <CardExcerpt id={member.id} shape={member.shape} />;
	return <StickyExcerpt id={member.id} shape={member.shape} />;
}

function StickyExcerpt({ id, shape }: { id: string; shape: ShapeProps }) {
	const texts = useSilentTexts();
	const session = silentOf(shape);
	const mine = session !== null && texts.has(id);
	const text = (mine ? texts.get(id) : shape.text)?.replace(/\s+/g, " ").trim() ?? "";
	const faceDown = session !== null && !mine;
	return (
		<span className="stack-row" data-kind="sticky" data-hidden={mine || undefined}>
			<span className="stack-dot" data-color={shape.color ?? "yellow"} aria-hidden="true" />
			<span className="stack-row-text" data-quiet={faceDown || !text || undefined}>
				{faceDown ? "Face down" : text || "Empty sticky"}
			</span>
			<StagedMark id={id} />
		</span>
	);
}

function CardExcerpt({ id, shape }: { id: string; shape: ShapeProps }) {
	const card = useCard(shape.ref ?? "");
	if (!card) {
		return (
			<span className="stack-row" data-kind="card" data-loading>
				<span className="stack-row-skeleton" aria-label="Loading" />
			</span>
		);
	}
	if (isMissing(card)) {
		return (
			<span className="stack-row" data-kind="card" data-missing>
				<LockIcon />
				<span className="stack-row-text" data-quiet>
					{card.reason === "private" ? "Private item" : "Unavailable item"}
				</span>
				<StagedMark id={id} />
			</span>
		);
	}
	return (
		<span className="stack-row" data-kind="card" data-state={card.state}>
			<span
				className="state-icon stack-state"
				title={card.kind === "pull" ? "Pull request" : "Issue"}
			>
				<StateIcon card={card} size={13} />
			</span>
			<span className="stack-ref">{card.item}</span>
			<span className="stack-row-text">{card.title}</span>
			<StagedMark id={id} />
		</span>
	);
}

/** A dot on an excerpt whose sticky or card has changes staged (#24), as the board marks them. */
function StagedMark({ id }: { id: string }) {
	const ui = useChangesUI();
	const changes = useShapeChanges(ui?.store ?? null, id);
	if (changes.length === 0) return null;
	return (
		<span
			className="stack-staged"
			title={`${changes.length} staged ${changes.length === 1 ? "change" : "changes"}`}
			aria-label="Changes staged"
		/>
	);
}

/** "+N more" says if any of those have changes staged too (one dot, however many). */
function StagedAmong({ members }: { members: readonly Member[] }) {
	const ui = useChangesUI();
	const store = ui?.store ?? null;
	const staged = useSyncExternalStore(store?.subscribe ?? noSubscribe, () =>
		members.some((member) => (store?.forShape(member.id).length ?? 0) > 0),
	);
	return staged ? (
		<span className="stack-staged" title="Changes staged" aria-label="Changes staged" />
	) : null;
}

const noSubscribe = () => () => {};

/**
 * A stack's name: a person's (as written), a suggestion (✨, until someone
 * keeps it by editing it or with ✓), or "Untitled stack". Click it to rename
 * in place; Enter keeps it (a suggestion too, as it is), Escape doesn't, an
 * empty name goes back to suggestions.
 */
export function StackName({
	id,
	shape,
	editable,
	waiting,
	headline = false,
	onRename,
}: {
	id: string;
	shape: ShapeProps;
	editable: boolean;
	/** Suggestions are on and there's something to read: a name's on its way. */
	waiting: boolean;
	/** The theme card's headline, rather than the open tray's. */
	headline?: boolean;
	onRename?: (name: string) => void;
}) {
	const state = nameState(shape);
	const name = stackName(shape);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const down = useRef<{ x: number; y: number } | null>(null);
	const start = () => {
		if (!editable) return;
		setDraft(name ?? "");
		setEditing(true);
	};
	// Asked for from outside (the action bar's Rename).
	useEffect(() => {
		if (!editable) return;
		const onRequest = (event: Event) => {
			const { detail } = event as CustomEvent<string>;
			if (detail !== id) return;
			setDraft(name ?? "");
			setEditing(true);
		};
		document.addEventListener("tack:rename-stack", onRequest);
		return () => document.removeEventListener("tack:rename-stack", onRequest);
	}, [editable, id, name]);
	useEffect(() => {
		if (editing) field.current?.select();
	}, [editing]);
	if (editing) {
		const finish = (keep: boolean) => {
			setEditing(false);
			const next = draft.replace(/\s+/g, " ").trim();
			// A suggestion kept as it is (Enter) becomes theirs; changed, it's theirs anyway.
			if (keep ? next !== (state === "person" ? name : "") || state === "suggested" : false) {
				onRename?.(next);
			}
		};
		const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
			event.stopPropagation();
			if (event.key === "Enter") {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				setEditing(false);
			}
		};
		return (
			<textarea
				ref={field}
				className="stack-name-input nodrag nowheel"
				data-headline={headline || undefined}
				value={draft}
				rows={headline ? 2 : 1}
				maxLength={60}
				placeholder="Name this stack"
				aria-label="Stack name"
				onChange={(event) => setDraft(event.target.value.replace(/\n/g, " "))}
				onKeyDown={onKey}
				// Leaving it keeps a change, but not a suggestion nobody touched.
				onBlur={() => {
					const next = draft.replace(/\s+/g, " ").trim();
					if (state === "suggested" && next === name) setEditing(false);
					else finish(true);
				}}
				onPointerDown={(event) => event.stopPropagation()}
			/>
		);
	}
	const text = name ?? (state === "none" && waiting ? "Naming…" : UNTITLED_STACK);
	const suggestion = state === "suggested" ? readSuggestion(shape.suggested)?.title : null;
	return (
		<span className="stack-name-row" data-headline={headline || undefined}>
			{editable ? (
				<button
					type="button"
					className="stack-name"
					data-state={state}
					data-waiting={(state === "none" && waiting) || undefined}
					title={
						state === "suggested"
							? "Suggested from what’s in it. Click to rename, or ✓ to keep it"
							: "Rename"
					}
					onPointerDown={(event: PointerEvent) => {
						down.current = { x: event.clientX, y: event.clientY };
					}}
					onClick={(event) => {
						// A drag that started on the name moved the stack: that's not a click.
						const from = down.current;
						down.current = null;
						if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4) return;
						event.stopPropagation();
						start();
					}}
				>
					<span className="stack-name-text">
						{text}
						{state === "suggested" && <SparkMark />}
					</span>
					{state === "none" && !waiting && <PencilIcon />}
				</button>
			) : (
				<span
					className="stack-name"
					data-state={state}
					data-waiting={(state === "none" && waiting) || undefined}
				>
					<span className="stack-name-text">
						{text}
						{state === "suggested" && <SparkMark />}
					</span>
				</span>
			)}
			{suggestion && editable && (
				<button
					type="button"
					className="stack-accept nodrag"
					aria-label={`Keep “${suggestion}” as its name`}
					title="Keep this name: it won’t change as the stack does"
					onClick={(event) => {
						event.stopPropagation();
						onRename?.(suggestion);
					}}
				>
					<CheckIcon />
				</button>
			)}
		</span>
	);
}

/** The quiet mark on a suggested name. */
function SparkMark() {
	return (
		<span className="stack-spark" role="img" aria-label="Suggested">
			<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
				<path d="M8 1.5c.4 2.9 1.6 4.1 4.5 4.5-2.9.4-4.1 1.6-4.5 4.5-.4-2.9-1.6-4.1-4.5-4.5 2.9-.4 4.1-1.6 4.5-4.5z" />
				<path d="M12.5 10.25c.2 1.3.75 1.85 2 2-1.25.15-1.8.7-2 2-.2-1.3-.75-1.85-2-2 1.25-.15 1.8-.7 2-2z" />
			</svg>
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

function CheckIcon() {
	return (
		<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
			<path d="M3.5 8.5l3 3 6-7" />
		</svg>
	);
}

function LockIcon() {
	return (
		<svg className="stack-lock" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
			<rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
			<path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
		</svg>
	);
}
