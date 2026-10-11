import { useReactFlow } from "@xyflow/react";
import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { isOpen } from "../../shared/dotvotes.ts";
import { spotNear } from "../../shared/placement.ts";
import type { SizeOf } from "../../shared/sections.ts";
import { transactLocal } from "../../shared/shapes.ts";
import { readShapes } from "../../shared/structure.ts";
import {
	STICKY_SIZE,
	type ShapeNode,
	type StickyColor,
	addSticky,
	setStickyText,
} from "../board.ts";
import { commentStore, useComments, useCommentUI } from "../comments/store.ts";
import { useServerNow, useVotes } from "../facilitation/hooks.ts";
import { facilitation } from "../facilitation/store.ts";
import { scaledDuration } from "../motion.ts";
import { type User, authorFor } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { BottomSheet } from "./BottomSheet.tsx";
import { clearOfSheet, panToShow } from "./gestures.ts";
import { QuickSticky } from "./QuickSticky.tsx";
import { ShapeHeading, ShapeSheet, ThreadSheet } from "./ShapeSheet.tsx";

/**
 * The board on a phone (#67), over the canvas: the sheet a tapped shape
 * opens in (or a comment thread, from its pin or the Comments panel), the
 * big + for writing stickies, and a button to see the whole board. The
 * canvas itself pans with a finger and zooms with a pinch.
 */
export function PhoneBoard({
	doc,
	nodes,
	user,
	readOnly,
	toasts,
	shape,
	onShape,
	boxSize,
	drawnSize,
	canvas,
	onFit,
	stickyColor,
	onStickyColor,
	onAdded,
}: {
	doc: Y.Doc;
	nodes: readonly ShapeNode[];
	user: User;
	readOnly: boolean;
	toasts: ToastStore;
	/** The shape whose sheet is open. */
	shape: string | null;
	onShape: (id: string | null) => void;
	boxSize: SizeOf;
	/** The size a shape's drawn at (a row's, in a list). */
	drawnSize: (id: string) => { w: number; h: number } | undefined;
	canvas: RefObject<HTMLElement | null>;
	onFit: () => void;
	stickyColor: StickyColor;
	onStickyColor: (color: StickyColor) => void;
	/** A sticky was added from the pad. */
	onAdded?: (id: string) => void;
}) {
	const flow = useReactFlow();
	const [writing, setWriting] = useState(false);
	const ui = useCommentUI();
	const { threads } = useComments();
	const thread = ui.open ? threads.get(ui.open) : undefined;
	const node = shape ? nodes.find((n) => n.id === shape) : undefined;
	const allVotes = useVotes(doc);
	const now = useServerNow(30_000, allVotes.length > 0);
	const votes = useMemo(() => allVotes.filter((vote) => isOpen(vote, now)), [allVotes, now]);
	const shapes = useMemo(
		() =>
			new Map(nodes.map((n) => [n.id, { type: n.data.shape.type, parent: n.data.shape.parent }])),
		[nodes],
	);

	// A shape that's gone (someone deleted it) takes its sheet with it.
	useEffect(() => {
		if (shape && !node) onShape(null);
	}, [shape, node, onShape]);
	// Opening a thread or a shape puts the pad away.
	useEffect(() => {
		if (shape || ui.open) setWriting(false);
	}, [shape, ui.open]);

	const boxOf = useCallback(
		(target: ShapeNode) => {
			const size = drawnSize(target.id) ?? { w: STICKY_SIZE, h: STICKY_SIZE };
			return { x: target.position.x, y: target.position.y, w: size.w, h: size.h };
		},
		[drawnSize],
	);

	/** What the sheet leaves of the canvas to see the board through, on screen. */
	const clearArea = useCallback(() => {
		const bounds = canvas.current?.getBoundingClientRect();
		if (!bounds) return null;
		const sheet = canvas.current?.querySelector<HTMLElement>(".phone-sheet");
		const top = sheet ? bounds.height - sheet.offsetHeight : null;
		return { bounds, clear: clearOfSheet(bounds, top) };
	}, [canvas]);

	// The tapped shape stays in sight above its sheet.
	const focused =
		node ?? (thread?.anchor.shape ? nodes.find((n) => n.id === thread.anchor.shape) : undefined);
	const focusedId = focused?.id ?? null;
	useEffect(() => {
		if (!focusedId) return;
		// Once the sheet's in the page and has its height.
		const frame = requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const target = flow.getNode(focusedId) as ShapeNode | undefined;
				const area = clearArea();
				if (!target || !area) return;
				const box = boxOf(target);
				const { x, y, zoom } = flow.getViewport();
				// Too big for the space: zoom out until it fits.
				const fit = Math.min(
					1,
					(area.clear.w - 40) / (box.w * zoom),
					(area.clear.h - 40) / (box.h * zoom),
				);
				const scale = zoom * Math.max(0.2, fit);
				// Where it'd be on screen at that zoom, the view's corner where it is.
				const screen = {
					x: x + box.x * scale,
					y: y + box.y * scale,
					w: box.w * scale,
					h: box.h * scale,
				};
				const pan = panToShow(screen, area.clear);
				if (!pan && scale === zoom) return;
				void flow.setViewport(
					{ x: x + (pan?.dx ?? 0), y: y + (pan?.dy ?? 0), zoom: scale },
					{ duration: scaledDuration(420) },
				);
			}),
		);
		return () => cancelAnimationFrame(frame);
	}, [focusedId, flow, clearArea, boxOf]);

	const addFromPad = (text: string) => {
		const area = clearArea();
		if (!area) return;
		// The middle of what you can see above the pad.
		const middle = flow.screenToFlowPosition({
			x: area.bounds.left + area.clear.w / 2,
			y: area.bounds.top + area.clear.h / 2,
		});
		const size = { w: STICKY_SIZE, h: STICKY_SIZE };
		const ideal = { x: middle.x - size.w / 2, y: middle.y - size.h / 2 };
		const spot = spotNear(readShapes(doc), ideal, size, boxSize) ?? ideal;
		const id = transactLocal(doc, () => {
			const id = addSticky(
				doc,
				{ x: spot.x + size.w / 2, y: spot.y + size.h / 2 },
				{
					color: stickyColor,
					author: authorFor(user),
				},
			);
			setStickyText(doc, id, text);
			return id;
		});
		// In a silent section, its text goes to the server rather than the document.
		facilitation.flush(id);
		onAdded?.(id);
		// Slid out of sight to find room: bring it into view, above the pad.
		const { x, y, zoom } = flow.getViewport();
		const screen = {
			x: x + spot.x * zoom,
			y: y + spot.y * zoom,
			w: size.w * zoom,
			h: size.h * zoom,
		};
		const pan = panToShow(screen, area.clear);
		if (pan) {
			void flow.setViewport(
				{ x: x + pan.dx, y: y + pan.dy, zoom },
				{ duration: scaledDuration(420) },
			);
		}
	};

	const closeAll = () => {
		setWriting(false);
		onShape(null);
		if (commentStore.getUI().open) commentStore.openThread(null);
	};

	let sheet: {
		kind: string;
		label: string;
		header: React.ReactNode;
		body: React.ReactNode;
	} | null = null;
	if (writing && !readOnly) {
		sheet = {
			kind: "sticky",
			label: "New sticky",
			header: (
				<span className="phone-sheet-title">
					<span className="phone-sheet-kind">New sticky</span>
				</span>
			),
			body: <QuickSticky color={stickyColor} onColor={onStickyColor} onAdd={addFromPad} />,
		};
	} else if (thread) {
		const back = node && thread.anchor.shape === node.id;
		sheet = {
			kind: "thread",
			label: "Comment",
			header: back ? (
				<button
					type="button"
					className="phone-sheet-back"
					onClick={() => commentStore.openThread(null)}
				>
					<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
						<path d="M8.5 3L4.5 7l4 4" />
					</svg>
					<ShapeHeading node={node} />
				</button>
			) : (
				<span className="phone-sheet-title">
					<span className="phone-sheet-kind">Comment</span>
				</span>
			),
			body: <ThreadSheet thread={thread} login={user.login} toasts={toasts} doc={doc} />,
		};
	} else if (node) {
		sheet = {
			kind: "shape",
			label: node.data.shape.type === "card" ? "Card" : "Shape",
			header: <ShapeHeading node={node} />,
			body: (
				<ShapeSheet
					doc={doc}
					node={node}
					user={user}
					readOnly={readOnly}
					toasts={toasts}
					votes={votes}
					shapes={shapes}
					box={boxOf(node)}
					onOpenThread={(id) => commentStore.openThread(id)}
				/>
			),
		};
	}

	return (
		<>
			<PhoneDock
				sheet={sheet?.kind ?? null}
				readOnly={readOnly}
				writing={writing}
				color={stickyColor}
				onFit={onFit}
				onAdd={() => {
					if (writing) return setWriting(false);
					onShape(null);
					if (commentStore.getUI().open) commentStore.openThread(null);
					setWriting(true);
				}}
			/>
			<BottomSheet
				open={sheet !== null}
				kind={sheet?.kind}
				label={sheet?.label ?? ""}
				header={sheet?.header}
				onClose={closeAll}
				initialFocus={sheet?.kind === "sticky" ? "content" : "sheet"}
			>
				{sheet?.body}
			</BottomSheet>
		</>
	);
}

/**
 * The bottom of a phone's board: a button to see all of it, and the big +
 * that opens the pad for writing stickies (its corner is a sticky in the
 * colour you'll write on). It steps aside while a sheet is up.
 */
export function PhoneDock({
	sheet,
	readOnly,
	writing,
	color,
	onFit,
	onAdd,
}: {
	/** What the sheet's showing, if one's up. */
	sheet: string | null;
	readOnly: boolean;
	writing: boolean;
	color: StickyColor;
	onFit: () => void;
	onAdd: () => void;
}) {
	return (
		<div className="phone-dock" data-chrome data-sheet={sheet ?? undefined}>
			<button type="button" className="phone-fit" aria-label="Show the whole board" onClick={onFit}>
				<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
					<path d="M2.5 6.5v-4h4M11.5 2.5h4v4M15.5 11.5v4h-4M6.5 15.5h-4v-4" />
				</svg>
			</button>
			{!readOnly && (
				<button
					type="button"
					className="phone-add"
					aria-label={writing ? "Close the new sticky" : "Add a sticky"}
					aria-expanded={writing}
					data-color={color}
					onClick={onAdd}
				>
					<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>
			)}
		</div>
	);
}
