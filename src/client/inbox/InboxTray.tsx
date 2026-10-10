import { type ReactFlowState, ViewportPortal, useReactFlow, useStore } from "@xyflow/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { dismissFromInbox, restoreToInbox, sortFromInbox } from "../../shared/inbox.ts";
import { PLACED_CARD, spotBelow, spotInSection } from "../../shared/placement.ts";
import { SECTION_DEFAULT, type SizeOf } from "../../shared/sections.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { shortRef } from "../../shared/rules.ts";
import { type ShapeProps, LOCAL_ORIGIN } from "../../shared/shapes.ts";
import { readShapes } from "../../shared/structure.ts";
import type { ShapeNode } from "../board.ts";
import { focusWhenMounted } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { CardView, StateIcon } from "../CardView.tsx";
import type { ToastStore } from "../Toasts.tsx";
import {
	CheckIcon,
	ChevronIcon,
	CloseIcon,
	EditIcon,
	RefreshIcon,
	TrayIcon,
	UndoDismissIcon,
} from "./icons.tsx";
import { chromeWithin } from "../actions/Popover.tsx";
import { panIntoView } from "../actions/popoverPlacement.ts";
import { scaledDuration } from "../motion.ts";
import type { Rect } from "../../shared/geometry.ts";
import { boxOf } from "../../shared/sections.ts";
import { InboxEditor } from "./InboxEditor.tsx";
import { TRAY_GAP, TRAY_WIDTH, type TraySide, trayHeight, traySide } from "./layout.ts";
import { inboxStore, useRefreshing } from "./store.ts";
import { inboxUI, isFolded, useInboxUI, useTray } from "./useTray.ts";
import "./inbox.css";

// Inbox trays: on the right edge of every inbox section, new matches wait,
// marked new, for someone to sort them: drag one out onto the board (or
// click to drop it into the section), or dismiss it. Trays are drawn above
// the board's shapes, in board space so they travel with their section, and
// stay readable when zoomed out, as section titles do.

/** Movement before a press on a tray item becomes a drag, in screen pixels. */
const DRAG_SLOP = 4;
/** Items shown before the list scrolls. */
const VISIBLE = 6;

/** An item as people say it within its repository: `#12`. */
const itemRef = (key: string) => shortRef(key, repoKeyOf(key));

export interface InboxLayerProps {
	doc: Y.Doc;
	nodes: ShapeNode[];
	readOnly: boolean;
	user: { name: string };
	toasts: ToastStore;
	sizeOf: SizeOf;
	onPlaced?: (id: string) => void;
}

/** Every inbox section's tray (and the one being set up). */
export function InboxLayer(props: InboxLayerProps) {
	const ui = useInboxUI();
	const { nodes, sizeOf } = props;
	const sections = useMemo(
		() =>
			nodes.filter(
				(node) => node.type === "section" && (node.data.shape.inbox || ui.editing === node.id),
			),
		[nodes, ui.editing],
	);
	// Everything on the board, to keep trays from covering it.
	const boxes = useMemo(() => {
		if (sections.length === 0) return [];
		return nodes
			.filter((node) => node.data.shape.type !== "connector")
			.map((node) => ({
				id: node.id,
				parent: node.data.shape.parent ?? null,
				box: {
					...boxOf(node.id, node.data.shape, sizeOf),
					x: node.position.x,
					y: node.position.y,
				},
			}));
	}, [nodes, sections.length, sizeOf]);
	if (sections.length === 0) return null;
	return (
		<ViewportPortal>
			{sections.map((node) => {
				const box = boxes.find((entry) => entry.id === node.id)?.box ?? {
					x: node.position.x,
					y: node.position.y,
					w: node.width ?? node.data.shape.w ?? SECTION_DEFAULT.w,
					h: node.height ?? node.data.shape.h ?? SECTION_DEFAULT.h,
				};
				return (
					<InboxTray
						key={node.id}
						id={node.id}
						shape={node.data.shape}
						section={box}
						others={othersFor(node.id, boxes)}
						editing={ui.editing === node.id}
						collapsed={isFolded(ui, node.id)}
						{...props}
					/>
				);
			})}
		</ViewportPortal>
	);
}

/**
 * What a section's tray mustn't cover: everything but the section, what's
 * in it, and the sections it's in (a tray over its own parent's background
 * covers nothing).
 */
function othersFor(
	id: string,
	boxes: readonly { id: string; parent: string | null; box: Rect }[],
): Rect[] {
	const parents = new Map(boxes.map((entry) => [entry.id, entry.parent]));
	const ancestors = new Set<string>();
	for (let at = parents.get(id); at && !ancestors.has(at); at = parents.get(at)) ancestors.add(at);
	const inside = (shape: string) => {
		const seen = new Set<string>();
		for (let at = parents.get(shape); at && !seen.has(at); at = parents.get(at)) {
			if (at === id) return true;
			seen.add(at);
		}
		return false;
	};
	return boxes
		.filter((entry) => entry.id !== id && !ancestors.has(entry.id) && !inside(entry.id))
		.map((entry) => entry.box);
}

export interface TrayProps extends Omit<InboxLayerProps, "nodes"> {
	id: string;
	shape: ShapeProps;
	/** The section, on the board. Without it, the tray sits in the page (the gallery). */
	section?: Rect;
	/** What the tray mustn't cover, on the board. */
	others?: readonly Rect[];
	editing: boolean;
	collapsed: boolean;
}

/** Which side of its section a tray goes, at the board's zoom: null when it has no room. */
function useTraySide(
	section: Rect | undefined,
	others: readonly Rect[] | undefined,
	height: number,
): TraySide | null {
	return useStore(
		useCallback(
			(state: ReactFlowState) =>
				section
					? traySide(section, { w: TRAY_WIDTH, h: height }, state.transform[2], others ?? [])
					: "right",
			[section, others, height],
		),
	);
}

export const InboxTray = memo(function InboxTray({
	id,
	shape,
	section,
	others,
	editing,
	collapsed,
	doc,
	readOnly,
	user,
	toasts,
	sizeOf,
	onPlaced,
}: TrayProps) {
	const isStatic = section === undefined;
	const tray = useTray(doc, id, shape);
	const fits = useTraySide(section, others, trayHeight(tray.items.length, tray.dismissed.size > 0));
	// No room either side, or only here to look: folded to its pill unless you open it.
	const autoFold = !isStatic && (fits === null || readOnly);
	useEffect(() => {
		if (isStatic) return;
		inboxUI.auto(id, autoFold);
	}, [id, isStatic, autoFold]);
	useEffect(() => () => inboxUI.auto(id, false), [id]);
	const side: TraySide = fits ?? "right";
	const x = section
		? side === "right"
			? section.x + section.w + TRAY_GAP
			: section.x - TRAY_GAP
		: 0;
	const y = section?.y ?? 0;
	const anchor = isStatic ? undefined : { transform: `translate(${x}px, ${y}px)` };
	const trayRef = useRef<HTMLElement>(null);
	useKeepInView(trayRef, editing && !isStatic);
	const refreshing = useRefreshing(id);
	const [showDismissed, setShowDismissed] = useState(false);
	const arrivals = useArrivals(tray.items);
	const title = shape.title || "Untitled section";
	const isInbox = Boolean(shape.inbox);
	const count = tray.items.length;

	const place = (card: Card, at?: { x: number; y: number }) => {
		cardStore.set(card);
		let spot = at;
		if (!spot) {
			const shapes = readShapes(doc);
			spot = spotInSection(shapes, id, PLACED_CARD, sizeOf) ??
				spotBelow(shapes, id, PLACED_CARD, sizeOf) ?? { x, y };
		}
		// Clicked in (rather than dropped): into the section, even one showing a list.
		const shapeId = sortFromInbox(doc, id, card.key, spot, LOCAL_ORIGIN, !at);
		focusWhenMounted(shapeId);
		onPlaced?.(shapeId);
	};

	const dismiss = (card: Card) => {
		dismissFromInbox(doc, id, [card.key], user.name, LOCAL_ORIGIN);
		toasts.show({
			message: `Dismissed ${itemRef(card.key)} from ${title}`,
			action: {
				label: "Undo",
				run: () => restoreToInbox(doc, id, [card.key], LOCAL_ORIGIN),
			},
		});
	};

	const state = editing
		? "editing"
		: tray.loading
			? "loading"
			: tray.error
				? "error"
				: count === 0
					? "empty"
					: "items";

	if (collapsed && !editing) {
		return (
			<div
				className="inbox-anchor"
				data-static={isStatic || undefined}
				data-side={side}
				style={anchor}
			>
				<button
					type="button"
					className="inbox-pill nodrag nopan"
					data-has-new={count > 0}
					onClick={() => inboxUI.toggle(id)}
					aria-label={`Open ${title}'s inbox: ${count} new`}
				>
					<TrayIcon size={14} />
					<span key={count} className="inbox-pill-count" data-pop={count > 0}>
						{count}
					</span>
					<span>new</span>
				</button>
			</div>
		);
	}

	return (
		<div
			className="inbox-anchor"
			data-static={isStatic || undefined}
			data-side={side}
			style={anchor}
		>
			<aside
				ref={trayRef}
				className="inbox-tray nodrag nopan nowheel"
				data-state={state}
				aria-label={`Inbox: ${title}`}
			>
				<header className="inbox-tray-head">
					<span className="inbox-tray-title">
						<TrayIcon size={14} />
						{isInbox && !editing ? (
							count > 0 ? (
								<span className="inbox-new" key={count} data-pop="true">
									<strong>{count}</strong> new
								</span>
							) : (
								<span>Inbox</span>
							)
						) : (
							<span>{isInbox ? "Edit inbox" : "New inbox"}</span>
						)}
					</span>
					{isInbox && !editing && tray.entry?.result.kind === "search" && (
						<span className="inbox-tray-total" title={`Matches for ${shape.inbox?.query.q}`}>
							{tray.total} {tray.total === 1 ? "match" : "matches"}
						</span>
					)}
					<span className="inbox-tray-tools">
						{isInbox && !editing && (
							<button
								type="button"
								className="inbox-tool"
								data-spinning={refreshing}
								aria-label="Check for new matches"
								title="Check for new matches"
								onClick={() => inboxStore.refresh(id)}
							>
								<RefreshIcon />
							</button>
						)}
						{isInbox && !editing && !readOnly && (
							<button
								type="button"
								className="inbox-tool"
								aria-label="Edit query"
								title="Edit query"
								onClick={() => inboxUI.edit(id)}
							>
								<EditIcon />
							</button>
						)}
						{!editing && (
							<button
								type="button"
								className="inbox-tool inbox-fold"
								aria-label="Fold the tray away"
								title="Fold away"
								onClick={() => inboxUI.toggle(id)}
							>
								<ChevronIcon />
							</button>
						)}
					</span>
				</header>

				{editing ? (
					<InboxEditor doc={doc} id={id} shape={shape} onDone={() => inboxUI.edit(null)} />
				) : (
					<>
						{shape.inbox && (
							<p className="inbox-query mono" title={shape.inbox.query.q}>
								{shape.inbox.query.q}
							</p>
						)}
						{state === "loading" && <TraySkeleton />}
						{state === "error" && tray.error && (
							<div className="inbox-message" data-tone="error">
								<p>{tray.error.message}</p>
								<span className="inbox-message-actions">
									<button type="button" onClick={() => inboxStore.refresh(id)}>
										Try again
									</button>
									{!readOnly && (
										<button type="button" onClick={() => inboxUI.edit(id)}>
											Edit query
										</button>
									)}
								</span>
							</div>
						)}
						{state === "empty" && (
							<div className="inbox-message" data-tone="done">
								<span className="inbox-done-mark">
									<CheckIcon size={18} />
								</span>
								<p>
									<strong>All sorted.</strong> New matches land here as they arrive.
								</p>
							</div>
						)}
						{state === "items" && (
							<ol
								className="inbox-items"
								style={{ "--visible": VISIBLE } as React.CSSProperties}
								aria-label="New matches"
							>
								{tray.items.map((card, i) => (
									<TrayItem
										key={card.key}
										card={card}
										index={i}
										arrived={arrivals.has(card.key)}
										readOnly={readOnly}
										onPlace={place}
										onDismiss={dismiss}
									/>
								))}
							</ol>
						)}
						{tray.dismissed.size > 0 && !readOnly && (
							<footer className="inbox-tray-foot">
								<button
									type="button"
									className="inbox-link"
									aria-expanded={showDismissed}
									onClick={() => setShowDismissed((open) => !open)}
								>
									{tray.dismissed.size} dismissed
								</button>
								{showDismissed && (
									<ul className="inbox-dismissed">
										{[...tray.dismissed].map((key) => (
											<li key={key}>
												<span className="mono">{itemRef(key)}</span>
												<button
													type="button"
													className="inbox-tool"
													aria-label={`Bring ${itemRef(key)} back`}
													title="Bring back"
													onClick={() => restoreToInbox(doc, id, [key], LOCAL_ORIGIN)}
												>
													<UndoDismissIcon />
												</button>
											</li>
										))}
									</ul>
								)}
							</footer>
						)}
					</>
				)}
			</aside>
		</div>
	);
});

/**
 * While `active`, keep what `ref` holds on the visible canvas and out from
 * under its chrome, panning the board to bring it into view: an inbox's
 * editor opened on a section low on the screen, say, and again as it grows.
 */
function useKeepInView(ref: RefObject<HTMLElement | null>, active: boolean) {
	const flow = useReactFlow();
	useEffect(() => {
		const el = ref.current;
		const canvas = el?.closest<HTMLElement>(".react-flow");
		if (!active || !el || !canvas) return;
		let frame = 0;
		const check = () => {
			const screen = canvas.getBoundingClientRect();
			const rect = el.getBoundingClientRect();
			const bounds = {
				left: screen.left,
				top: screen.top,
				right: screen.right,
				bottom: screen.bottom,
			};
			const { dx, dy } = panIntoView({
				rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
				bounds,
				obstacles: chromeWithin(bounds, [el]),
			});
			if (dx === 0 && dy === 0) return;
			const { x, y, zoom } = flow.getViewport();
			void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: scaledDuration(320) });
		};
		// Once it's drawn, and again whenever it grows (the count, a warning).
		frame = requestAnimationFrame(check);
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(check);
		});
		observer.observe(el);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [ref, active, flow]);
}

/** Keys that arrived since the tray first showed results: they slide in, marked new. */
function useArrivals(items: Card[]): Set<string> {
	const seen = useRef<Set<string> | null>(null);
	const [arrivals, setArrivals] = useState<Set<string>>(new Set());
	useLayoutEffect(() => {
		const keys = items.map((card) => card.key);
		if (seen.current === null) {
			if (keys.length > 0) seen.current = new Set(keys);
			return;
		}
		const fresh = keys.filter((key) => !seen.current?.has(key));
		for (const key of fresh) seen.current.add(key);
		if (fresh.length > 0) setArrivals((current) => new Set([...current, ...fresh]));
	}, [items]);
	return arrivals;
}

function TraySkeleton() {
	return (
		<div className="inbox-skeleton" aria-busy="true" aria-label="Searching">
			{[0, 1, 2].map((i) => (
				<span key={i} className="inbox-skeleton-row" style={{ animationDelay: `${i * 90}ms` }}>
					<span className="skeleton" style={{ width: "40%" }} />
					<span className="skeleton" style={{ width: "88%" }} />
				</span>
			))}
		</div>
	);
}

interface Drag {
	card: Card;
	pointer: { x: number; y: number };
	/** Where in the item it was picked up, in screen pixels. */
	grab: { x: number; y: number };
	/** Released over the tray: it flies back. */
	returning: boolean;
}

function TrayItem({
	card,
	index,
	arrived,
	readOnly,
	onPlace,
	onDismiss,
}: {
	card: Card;
	index: number;
	arrived: boolean;
	readOnly: boolean;
	onPlace: (card: Card, at?: { x: number; y: number }) => void;
	onDismiss: (card: Card) => void;
}) {
	const flow = useReactFlow();
	const zoom = useStore((state) => state.transform[2]);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [leaving, setLeaving] = useState<"placed" | "dismissed" | null>(null);
	const press = useRef<{ x: number; y: number; id: number; grab: { x: number; y: number } } | null>(
		null,
	);

	const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>) => {
		if (readOnly || event.button !== 0) return;
		if ((event.target as Element).closest("button")) return;
		const box = event.currentTarget.getBoundingClientRect();
		press.current = {
			x: event.clientX,
			y: event.clientY,
			id: event.pointerId,
			grab: { x: event.clientX - box.left, y: event.clientY - box.top },
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLLIElement>) => {
		const start = press.current;
		if (!start) return;
		const pointer = { x: event.clientX, y: event.clientY };
		if (!drag && Math.hypot(pointer.x - start.x, pointer.y - start.y) < DRAG_SLOP) return;
		setDrag({ card, pointer, grab: start.grab, returning: false });
	};
	const finish = (event: ReactPointerEvent<HTMLLIElement>, commit: boolean) => {
		const start = press.current;
		press.current = null;
		if (!start) return;
		if (!drag) {
			// A click: straight into the section.
			if (commit) {
				setLeaving("placed");
				onPlace(card);
			}
			return;
		}
		const over = document.elementFromPoint(event.clientX, event.clientY);
		if (!commit || over?.closest(".inbox-tray, .play-panel, .topbar, .toolbar")) {
			setDrag({ ...drag, returning: true });
			return;
		}
		const at = flow.screenToFlowPosition({
			x: event.clientX - drag.grab.x,
			y: event.clientY - drag.grab.y,
		});
		setDrag(null);
		setLeaving("placed");
		onPlace(card, at);
	};

	useEffect(() => {
		if (!drag) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			press.current = null;
			setDrag((current) => (current ? { ...current, returning: true } : null));
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [drag]);

	const onKeyDown = (event: ReactKeyboardEvent) => {
		if (readOnly || event.target !== event.currentTarget) return;
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			setLeaving("placed");
			onPlace(card);
		} else if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			setLeaving("dismissed");
			onDismiss(card);
		}
	};

	return (
		<li
			className="inbox-item"
			data-arrived={arrived}
			data-dragging={drag !== null && !drag.returning}
			data-leaving={leaving ?? undefined}
			data-state={card.state}
			style={{ "--i": index } as React.CSSProperties}
			tabIndex={readOnly ? -1 : 0}
			aria-label={`${itemRef(card.key)}: ${card.title}${readOnly ? "" : ". Enter to add it, Delete to dismiss"}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={(event) => finish(event, true)}
			onPointerCancel={(event) => finish(event, false)}
			onKeyDown={onKeyDown}
		>
			<span className="inbox-item-head">
				<span className="state-icon" data-state={card.state}>
					<StateIcon card={card} size={13} />
				</span>
				<span className="mono">
					{card.repo.split("/").at(-1)} {card.item}
				</span>
				{card.labels.length > 0 && (
					<span className="inbox-item-labels" aria-hidden="true">
						{card.labels.slice(0, 4).map((label) => (
							<span
								key={label.name}
								className="inbox-label-dot"
								title={label.name}
								style={{ "--label": `#${label.color}` } as React.CSSProperties}
							/>
						))}
					</span>
				)}
				{arrived && (
					<span className="inbox-item-new" aria-hidden="true">
						New
					</span>
				)}
			</span>
			<span className="inbox-item-title">{card.title}</span>
			{!readOnly && (
				<button
					type="button"
					className="inbox-dismiss"
					aria-label={`Dismiss ${itemRef(card.key)}`}
					title="Dismiss"
					onClick={(event) => {
						event.stopPropagation();
						setLeaving("dismissed");
						onDismiss(card);
					}}
				>
					<CloseIcon size={12} />
				</button>
			)}
			{drag &&
				createPortal(
					<div
						className="inbox-ghost"
						data-returning={drag.returning}
						style={
							{
								"--x": `${drag.pointer.x - drag.grab.x}px`,
								"--y": `${drag.pointer.y - drag.grab.y}px`,
								"--zoom": zoom,
							} as React.CSSProperties
						}
						onTransitionEnd={() => drag.returning && setDrag(null)}
						onAnimationEnd={() => drag.returning && setDrag(null)}
						aria-hidden="true"
					>
						<CardView card={card} cardKey={card.key} />
					</div>,
					document.body,
				)}
		</li>
	);
}
