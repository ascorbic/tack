import { clock } from "../clock.ts";
import { ViewportPortal, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	type Box,
	type CommentAnchor,
	type CommentThread,
	anchorAt,
	excerpt,
	isVisible,
	liveMessages,
	pinPosition,
	starter,
} from "../../shared/comments.ts";
import { NOMINAL_SIZE, type SizeOf } from "../../shared/sections.ts";
import type { ShapeNode } from "../board.ts";
import { relativeTime } from "../boards/api.ts";
import { Avatar, initials } from "../People.tsx";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { Composer } from "./Composer.tsx";
import { CheckIcon } from "./icons.tsx";
import { type CommentStore, commentStore, useCommentUI, useComments } from "./store.ts";
import { ThreadView, authorUser, cantComment, useNow } from "./Thread.tsx";
import "./comments.css";

// Comments on the canvas (#51): a pin for every thread, on its shape (so it
// follows the shape about, live while it's dragged) or at its point; the
// open thread in a popover by its pin; and the comment tool, which drops a
// new comment wherever you click, on whatever's there. Pins and popovers
// are in board space but stay the same size on screen at any zoom, so they
// stay legible when zoomed out.

/** Below this many screen pixels, a press-and-release counts as a click. */
const CLICK_SLOP = 5;
/** Popovers flip to the pin's left when there's less room than this on its right. */
const POPOVER_ROOM = 380;
/** Where a popover's top is, from its pin's point (as in comments.css). */
const POPOVER_TOP = -40;

export interface CommentLayerProps {
	nodes: ShapeNode[];
	sizeOf: SizeOf;
	/** Whether the comment tool is in hand. */
	placing: boolean;
	user: User;
	toasts: ToastStore;
	store?: CommentStore;
}

/** Shapes' boxes on the canvas now, with drags and resizes in progress. */
function useBoxes(nodes: ShapeNode[], sizeOf: SizeOf): Map<string, Box & { section: boolean }> {
	return useMemo(() => {
		const boxes = new Map<string, Box & { section: boolean }>();
		for (const node of nodes) {
			const shape = node.data.shape;
			const size = sizeOf(node.id) ?? NOMINAL_SIZE[shape.type];
			const w = node.width ?? shape.w ?? size?.w ?? 200;
			const h = node.height ?? shape.h ?? size?.h ?? 120;
			boxes.set(node.id, {
				x: node.position.x,
				y: node.position.y,
				w,
				h,
				section: shape.type === "section",
			});
		}
		return boxes;
	}, [nodes, sizeOf]);
}

/** The shape under a point: the topmost non-section, or else the innermost section. */
export function shapeUnder(
	point: { x: number; y: number },
	nodes: ShapeNode[],
	boxes: Map<string, Box & { section: boolean }>,
): { id: string; box: Box } | undefined {
	let section: { id: string; box: Box; depth: number } | undefined;
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		const box = node && boxes.get(node.id);
		if (!node || !box) continue;
		const inside =
			point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
		if (!inside) continue;
		if (!box.section) return { id: node.id, box };
		const depth = node.zIndex ?? 0;
		if (!section || depth > section.depth) section = { id: node.id, box, depth };
	}
	return section;
}

export function CommentLayer({
	nodes,
	sizeOf,
	placing,
	user,
	toasts,
	store = commentStore,
}: CommentLayerProps) {
	const { threads, you } = useComments(store);
	const ui = useCommentUI(store);
	const boxes = useBoxes(nodes, sizeOf);
	const flow = useReactFlow();
	const api = useStoreApi();
	const [mountedAt] = useState(() => clock.now());

	// The comment tool: click anywhere (on a shape or not) to start a comment there.
	const latest = useRef({ nodes, boxes });
	latest.current = { nodes, boxes };
	useEffect(() => {
		if (!placing) return;
		const dom = api.getState().domNode;
		if (!dom) return;
		const onDown = (event: PointerEvent) => {
			if (event.button !== 0 || !event.isPrimary) return;
			const target = event.target as Element | null;
			if (target?.closest(".react-flow__panel, .comment-ui")) return;
			event.preventDefault();
			event.stopPropagation();
			const start = { x: event.clientX, y: event.clientY };
			const onUp = (up: PointerEvent) => {
				window.removeEventListener("pointerup", onUp, true);
				if (Math.hypot(up.clientX - start.x, up.clientY - start.y) > CLICK_SLOP) return;
				if (!store.getState().you.canComment) {
					toasts.show({ message: cantComment(store.getState().you) });
					return;
				}
				const point = flow.screenToFlowPosition(start);
				const { nodes, boxes } = latest.current;
				store.setUI({ draft: anchorAt(point, shapeUnder(point, nodes, boxes)), open: null });
			};
			window.addEventListener("pointerup", onUp, true);
		};
		dom.addEventListener("pointerdown", onDown, true);
		return () => dom.removeEventListener("pointerdown", onDown, true);
	}, [placing, api, flow, store, toasts]);

	// Clicking away (or Escape) closes the open thread or draft.
	const active = ui.open !== null || ui.draft !== null;
	useEffect(() => {
		if (!active) return;
		const onDown = (event: PointerEvent) => {
			if ((event.target as Element | null)?.closest(".comment-ui")) return;
			// With the comment tool in hand, a click elsewhere starts a new one instead.
			if (placing && (event.target as Element | null)?.closest(".react-flow")) return;
			store.setUI({ open: null, draft: null });
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") store.setUI({ open: null, draft: null });
		};
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [active, placing, store]);

	const shown = [...threads.values()].filter(
		(thread) => isVisible(thread) && (!thread.resolved || ui.showResolved || ui.open === thread.id),
	);
	const positionOf = (anchor: CommentAnchor) =>
		pinPosition(anchor, anchor.shape ? boxes.get(anchor.shape) : undefined);
	const open = ui.open ? threads.get(ui.open) : undefined;

	return (
		<ViewportPortal>
			<div className="comment-layer" data-placing={placing || undefined}>
				{shown.map((thread) => (
					<Pin
						key={thread.id}
						thread={thread}
						at={positionOf(thread.anchor)}
						unread={store.isUnread(thread)}
						open={ui.open === thread.id}
						flash={ui.flash?.id === thread.id ? ui.flash.at : undefined}
						arrived={thread.createdAt > mountedAt && starter(thread)?.id !== you.id}
						movable={store.canTriage(thread)}
						onOpen={() => store.openThread(ui.open === thread.id ? null : thread.id)}
						onMove={(point) => {
							const { nodes, boxes } = latest.current;
							store.move(thread.id, anchorAt(point, shapeUnder(point, nodes, boxes)));
						}}
					/>
				))}
				{ui.draft && (
					<DraftPin at={positionOf(ui.draft)} user={user}>
						<Popover at={positionOf(ui.draft)}>
							<div className="comment-thread comment-draft">
								<Composer
									placeholder="Add a comment"
									onSubmit={(body) => {
										const draft = store.getUI().draft;
										if (!draft) return;
										const id = store.start(draft, body);
										store.setUI({ draft: null, open: id });
									}}
									onCancel={() => store.setUI({ draft: null })}
								/>
							</div>
						</Popover>
					</DraftPin>
				)}
				{open && (
					<Popover at={positionOf(open.anchor)} key={open.id}>
						<OpenThread thread={open} store={store} toasts={toasts} login={user.login} />
					</Popover>
				)}
			</div>
		</ViewportPortal>
	);
}

/** The open thread, wired to the store. */
function OpenThread({
	thread,
	store,
	toasts,
	login,
}: {
	thread: CommentThread;
	store: CommentStore;
	toasts: ToastStore;
	login?: string;
}) {
	const { you } = useComments(store);
	// What was new when it opened stays marked new while it's open.
	const since = useCommentUI(store).unreadSince ?? undefined;
	// Messages that arrive while it's open are read as they arrive.
	useEffect(() => {
		store.markRead(thread.id);
	}, [store, thread]);
	return (
		<ThreadView
			thread={thread}
			you={you}
			login={login}
			canTriage={store.canTriage(thread)}
			unreadSince={since}
			actions={{
				reply: (body) => store.reply(thread.id, body),
				edit: (message, body) => store.edit(thread.id, message, body),
				delete: (message) => {
					const last = store.delete(thread.id, message);
					toasts.show({
						message: last ? "Deleted the comment" : "Deleted your reply",
						action: { label: "Undo", run: () => store.restore(thread.id, message) },
					});
				},
				resolve: (resolved) => {
					store.resolve(thread.id, resolved);
					if (resolved) {
						store.setUI({ open: null });
						toasts.show({
							message: "Resolved",
							action: { label: "Undo", run: () => store.resolve(thread.id, false) },
						});
					}
				},
				close: () => store.setUI({ open: null }),
			}}
		/>
	);
}

/** A popover by a pin, in board space, the same size on screen at any zoom. */
function Popover({ at, children }: { at: { x: number; y: number }; children: React.ReactNode }) {
	const flow = useReactFlow();
	// Re-place when the view moves, to flip it to whichever side has room.
	const transform = useStore((state) => state.transform);
	const screen = flow.flowToScreenPosition(at);
	const flip = screen.x > window.innerWidth - POPOVER_ROOM;
	const ref = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(0);
	// Keep it on screen vertically too, above the toolbar, as it grows.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		setHeight(element.offsetHeight);
		const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	void transform;
	const top = screen.y + POPOVER_TOP;
	const lift = Math.max(0, Math.min(top + height - (window.innerHeight - 96), top - 64));
	return (
		<div
			className="comment-anchor comment-ui"
			style={{ transform: `translate(${at.x}px, ${at.y}px) scale(var(--inv-zoom, 1))` }}
		>
			<div
				ref={ref}
				className="comment-popover nodrag nopan nowheel"
				data-flip={flip || undefined}
				style={{ "--lift": `${lift}px` } as React.CSSProperties}
				onPointerDown={(event) => event.stopPropagation()}
				onWheel={(event) => event.stopPropagation()}
			>
				{children}
			</div>
		</div>
	);
}

/** Where a new comment will go: your avatar, waiting. */
function DraftPin({
	at,
	user,
	children,
}: {
	at: { x: number; y: number };
	user: User;
	children: React.ReactNode;
}) {
	return (
		<>
			<div
				className="comment-anchor comment-ui"
				style={{ transform: `translate(${at.x}px, ${at.y}px) scale(var(--inv-zoom, 1))` }}
			>
				<span className="comment-pin" data-draft aria-hidden="true">
					<span className="comment-pin-face">
						<Avatar user={user} />
					</span>
				</span>
			</div>
			{children}
		</>
	);
}

const Pin = memo(function Pin({
	thread,
	at,
	unread,
	open,
	flash,
	arrived,
	movable,
	onOpen,
	onMove,
}: {
	thread: CommentThread;
	at: { x: number; y: number };
	unread: boolean;
	open: boolean;
	flash?: number;
	arrived: boolean;
	movable: boolean;
	onOpen: () => void;
	onMove: (point: { x: number; y: number }) => void;
}) {
	const flow = useReactFlow();
	const now = useNow(60_000);
	const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
	const messages = liveMessages(thread);
	const first = messages[0];
	const last = messages.at(-1);
	const author = starter(thread);
	const others = new Set(messages.map((m) => m.author.id)).size;
	const where = drag ?? at;

	const onPointerDown = (event: React.PointerEvent) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		const start = { x: event.clientX, y: event.clientY };
		const origin = flow.screenToFlowPosition(start);
		let dragging = false;
		const onMovePointer = (move: PointerEvent) => {
			if (!movable) return;
			dragging ||= Math.hypot(move.clientX - start.x, move.clientY - start.y) > CLICK_SLOP;
			if (!dragging) return;
			const p = flow.screenToFlowPosition({ x: move.clientX, y: move.clientY });
			setDrag({ x: at.x + p.x - origin.x, y: at.y + p.y - origin.y });
		};
		const onUp = (up: PointerEvent) => {
			window.removeEventListener("pointermove", onMovePointer);
			window.removeEventListener("pointerup", onUp);
			if (!dragging) {
				onOpen();
				return;
			}
			const p = flow.screenToFlowPosition({ x: up.clientX, y: up.clientY });
			onMove({ x: at.x + p.x - origin.x, y: at.y + p.y - origin.y });
			setDrag(null);
		};
		window.addEventListener("pointermove", onMovePointer);
		window.addEventListener("pointerup", onUp);
	};

	const name = author?.name || author?.login || "Someone";
	const replies = messages.length - 1;
	return (
		<div
			className="comment-anchor comment-ui"
			style={{ transform: `translate(${where.x}px, ${where.y}px) scale(var(--inv-zoom, 1))` }}
			data-dragging={drag ? true : undefined}
		>
			<button
				type="button"
				className="comment-pin nodrag nopan"
				data-thread={thread.id}
				data-unread={unread || undefined}
				data-open={open || undefined}
				data-resolved={!!thread.resolved || undefined}
				data-arrived={arrived || undefined}
				key={flash}
				data-flash={flash !== undefined || undefined}
				aria-label={`Comment by ${name}${replies > 0 ? `, ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}${unread ? ", unread" : ""}${thread.resolved ? ", resolved" : ""}`}
				aria-expanded={open}
				onPointerDown={onPointerDown}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen();
					}
				}}
			>
				<span className="comment-pin-face">
					{thread.resolved ? (
						<span className="comment-pin-check">
							<CheckIcon size={14} />
						</span>
					) : author ? (
						<Avatar user={authorUser(author)} />
					) : (
						<span className="avatar">{initials(name)}</span>
					)}
					{others > 1 && <span className="comment-pin-count">{messages.length}</span>}
				</span>
				{first && (
					<span className="comment-pin-preview" aria-hidden="true">
						<span className="comment-pin-meta">
							<strong>{name}</strong>
							<span>{relativeTime(last?.at ?? first.at, now)}</span>
						</span>
						<span className="comment-pin-text">{excerpt(first.body, 90)}</span>
						{replies > 0 && (
							<span className="comment-pin-replies">
								{replies} {replies === 1 ? "reply" : "replies"}
							</span>
						)}
					</span>
				)}
			</button>
		</div>
	);
});
