import { useReactFlow, useStoreApi } from "@xyflow/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import type * as Y from "yjs";
import type { SizeOf } from "../shared/sections.ts";
import { describeNudge } from "../shared/a11y.ts";
import { type ShapeType, readShape, shapesMap } from "../shared/shapes.ts";
import {
	commitMoves,
	copyClosure,
	readShapes,
	settlePasted,
	unstagedByDeleting,
} from "../shared/structure.ts";
import { align, distribute, type Item, tidy } from "./arrange.ts";
import { announce } from "./announce.tsx";
import {
	type Position,
	type ShapeNode,
	type StickyColor,
	addSticky,
	deleteShapes,
	setStickyText,
} from "./board.ts";
import { RUN_COLUMNS } from "../shared/addCards.ts";
import { LINK_CARD } from "../shared/linkPreview.ts";
import { PLACE_GAP, PLACED_CARD, slideClear } from "../shared/placement.ts";
import { cardStore } from "./cardStore.ts";
import { fitBoxes, shapeBoxes } from "./fitting.ts";
import { isOffBoardTarget, isOnUnselectedShape } from "./keys.ts";
import { scaledDuration } from "./motion.ts";
import {
	CLIPBOARD_TYPE,
	type ClipboardPayload,
	copyShapes,
	fromHtml,
	interpretText,
	parsePayload,
	pasteShapes,
	payloadBounds,
	toHtml,
	toPlainText,
} from "./clipboard.ts";
import { imageFilesOf } from "./images/useBoardImages.tsx";
import { type User, authorFor } from "./presence.ts";
import type { ActionCommand } from "./actions/selection.ts";
import { type CommandId, isApplePlatform, matchShortcut, shortcutHint } from "./shortcuts.ts";
import { type Rect, intersects, unionRect } from "./snapping.ts";
import type { ToastStore } from "./Toasts.tsx";
import { type History, transactLocal } from "./undo.ts";

// Everything you can do to the canvas from the keyboard and the clipboard:
// undo, copy and paste, nudging, arranging and zooming. Shortcuts never fire
// while you're typing in a text field, so sticky editing keeps every key.

type Size = { width: number; height: number };

/** How far a paste or duplicate lands from the original. */
const PASTE_OFFSET = 24;
/** Nudges are shown live and committed once you pause. */
const NUDGE_COMMIT_MS = 400;
/** Deleting more than this many shapes shows an undo toast. */
const QUIET_DELETE_LIMIT = 3;

const apple = isApplePlatform();

function hasTextSelection(): boolean {
	const selection = window.getSelection();
	return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

interface CommandsOptions {
	doc: Y.Doc;
	board: string;
	history: History;
	nodes: ShapeNode[];
	selected: Set<string>;
	setSelected: (ids: Set<string>) => void;
	sizeOf: (id: string) => Size | undefined;
	/** Sizes for structural edits: sections, connector ends. */
	boxSize?: SizeOf;
	user: User;
	stickyColor: StickyColor;
	/** Shows nudges live, through presence, until they're committed. */
	previewPositions: (positions: Map<string, Position | null>) => void;
	toasts: ToastStore;
	canvas: RefObject<HTMLElement | null>;
	toggleShortcuts: () => void;
	/** Called when a shortcut moves the view, e.g. to stop following someone. */
	onNavigate?: () => void;
	/** View only: copying and moving the view still work, but nothing that changes the board. */
	readOnly?: boolean;
	/** Open a selection action (src/client/actions/); false if none applies. */
	onAction?: (id: ActionCommand) => boolean;
	/**
	 * Arrow keys on rows in a list move through it, and Shift-arrows move
	 * them up and down it (#72): true if that's what happened.
	 */
	onListKey?: (id: CommandId) => boolean;
	/** Shapes drawn in a list, whose free-form positions arranging leaves alone. */
	inList?: (id: string) => boolean;
	/** Where a shape is drawn, if not at its document position (a row in a list). */
	drawnAt?: (id: string) => { x: number; y: number } | undefined;
	/**
	 * Add cards for pasted links, starting at `at` (the first's top left):
	 * in free space, and saying so for any already on the board.
	 */
	addCards?: (keys: string[], options: { at: Position }) => { added: string[] };
	/** Add link cards for pasted web addresses (links.ts), starting at `at`, as cards are. */
	addLinks?: (urls: string[], options: { at: Position }) => void;
	/** Image files pasted: placed around `at`. False if none could be taken. */
	addImages?: (files: File[], at: Position) => boolean;
	/**
	 * Shapes just pasted, inside the paste's transaction: images from another
	 * board are marked as arriving. Returns the ids marked, for `onPastedImages`.
	 */
	markPasted?: (ids: string[], from: string | undefined) => string[];
	/** After the paste: bring marked images' files over from the board they came from. */
	onPastedImages?: (from: string, ids: string[]) => void;
	/** Open the file picker for images. */
	onInsertImage?: () => boolean;
}

/** How much each step in or out zooms by: React Flow's own step. */
const ZOOM_STEP = 1.2;

/** Commands that change the document, which view-only boards ignore. */
const WRITES =
	/^(undo|redo|duplicate|delete|insertImage|nudge|align|distribute|tidy|makeIssues|parentIssue|labels|milestone|assign|closeReopen|backlink|blockedBy|expandRelated|toActions|carryOver|stackThese|groupThese|unstack|fitSection|summarise|draftDecision)/;

export function useCanvasCommands(options: CommandsOptions) {
	const flow = useReactFlow<ShapeNode>();
	const store = useStoreApi<ShapeNode>();
	const latest = useRef(options);
	latest.current = options;
	const pointer = useRef<{ x: number; y: number } | null>(null);
	const nudge = useRef<{
		base: Map<string, Position>;
		dx: number;
		dy: number;
		timer: ReturnType<typeof setTimeout>;
	} | null>(null);
	const lastPaste = useRef<{ key: string; count: number } | null>(null);
	const lastDuplicate = useRef<{ sources: string[]; copies: string[] } | null>(null);
	/** Where a step in or out is zooming to, until it gets there. */
	const zoomGoal = useRef<{ zoom: number; until: number } | null>(null);

	const { doc, history } = options;

	const duration = useCallback((ms: number) => scaledDuration(ms), []);

	/** Let shapes glide to positions set by undo, redo or arranging. */
	const settle = useCallback(() => {
		const el = latest.current.canvas.current;
		if (!el) return;
		el.dataset.settling = "true";
		clearTimeout(Number(el.dataset.settleTimer));
		el.dataset.settleTimer = String(
			setTimeout(() => {
				delete el.dataset.settling;
			}, duration(600)),
		);
	}, [duration]);

	const flowRect = useCallback((): Rect => {
		const { transform, width, height } = store.getState();
		const [tx, ty, zoom] = transform;
		return { x: -tx / zoom, y: -ty / zoom, width: width / zoom, height: height / zoom };
	}, [store]);

	const rectOf = useCallback((id: string): Rect | null => {
		const { nodes, sizeOf } = latest.current;
		const node = nodes.find((n) => n.id === id);
		if (!node) return null;
		return { ...node.position, ...(sizeOf(id) ?? { width: 0, height: 0 }) };
	}, []);

	// Nudges ---------------------------------------------------------------

	const flushNudge = useCallback(() => {
		const pending = nudge.current;
		if (!pending) return;
		nudge.current = null;
		clearTimeout(pending.timer);
		// Like a drop, but without bringing anything to the front: sections
		// take their contents, and shapes nudged into a section join it.
		const moves = new Map(
			[...pending.base].map(([id, base]) => [
				id,
				{ x: base.x + pending.dx, y: base.y + pending.dy },
			]),
		);
		transactLocal(doc, () => commitMoves(doc, moves, latest.current.boxSize, { raise: false }));
		latest.current.previewPositions(new Map([...pending.base.keys()].map((id) => [id, null])));
		// Said once the nudges settle, for screen readers (#61).
		const shapes = shapesMap(doc);
		const types = [...pending.base.keys()].map(
			(id) => (shapes.get(id)?.get("type") ?? "sticky") as ShapeType,
		);
		announce(describeNudge(types, pending.dx, pending.dy));
	}, [doc]);

	const nudgeBy = useCallback(
		(dx: number, dy: number) => {
			const { selected, previewPositions } = latest.current;
			if (selected.size === 0) return;
			let pending = nudge.current;
			const sameSelection =
				pending &&
				pending.base.size === selected.size &&
				[...selected].every((id) => pending?.base.has(id));
			if (!pending || !sameSelection) {
				flushNudge();
				const base = new Map<string, Position>();
				const shapes = shapesMap(doc);
				for (const id of selected) {
					const shape = shapes.get(id);
					if (shape) base.set(id, { x: Number(shape.get("x")), y: Number(shape.get("y")) });
				}
				pending = { base, dx: 0, dy: 0, timer: setTimeout(() => {}, 0) };
				nudge.current = pending;
			}
			pending.dx += dx;
			pending.dy += dy;
			clearTimeout(pending.timer);
			pending.timer = setTimeout(flushNudge, NUDGE_COMMIT_MS);
			const { dx: totalX, dy: totalY } = pending;
			previewPositions(
				new Map(
					[...pending.base].map(([id, base]) => [id, { x: base.x + totalX, y: base.y + totalY }]),
				),
			);
		},
		[doc, flushNudge],
	);

	// Undo -----------------------------------------------------------------

	useEffect(
		() =>
			history.bindSelection({
				get: () => [...latest.current.selected],
				restore: (ids, affected) => {
					const shapes = shapesMap(doc);
					latest.current.setSelected(new Set(ids.filter((id) => shapes.has(id))));
					// If nothing that changed is on screen, bring it into view.
					const changed = [...affected].map(rectOf).filter((rect) => rect !== null);
					const bounds = unionRect(changed);
					const view = flowRect();
					if (bounds && !changed.some((rect) => intersects(rect, view))) {
						latest.current.onNavigate?.();
						void flow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
							zoom: store.getState().transform[2],
							duration: duration(420),
						});
					}
				},
			}),
		[history, doc, flow, store, flowRect, rectOf, duration],
	);

	// Clipboard ------------------------------------------------------------

	const copySelection = useCallback((): ClipboardPayload | null => {
		const { selected, board, sizeOf } = latest.current;
		if (selected.size === 0) return null;
		// Sections come with what's in them, and connectors between copied
		// shapes come too.
		const payload = copyShapes(doc, copyClosure(doc, selected), {
			board,
			sizes: sizeOf,
			positions: latest.current.drawnAt,
		});
		lastPaste.current = null;
		return payload.shapes.length > 0 ? payload : null;
	}, [doc]);

	const writeClipboard = useCallback((payload: ClipboardPayload, data: DataTransfer | null) => {
		const json = JSON.stringify(payload);
		const text = toPlainText(payload, (key) => {
			const card = cardStore.get(key);
			return card && !("missing" in card) ? card.url : undefined;
		});
		const html = toHtml(payload, text);
		if (data) {
			data.setData(CLIPBOARD_TYPE, json);
			data.setData("text/html", html);
			data.setData("text/plain", text);
			return;
		}
		// No clipboard event to write into (Safari, with nothing selected).
		if (typeof ClipboardItem === "undefined") return;
		void navigator.clipboard
			?.write([
				new ClipboardItem({
					"text/html": new Blob([html], { type: "text/html" }),
					"text/plain": new Blob([text], { type: "text/plain" }),
				}),
			])
			.catch(() => {});
	}, []);

	const pointerOrCentre = useCallback((): Position => {
		if (pointer.current) return flow.screenToFlowPosition(pointer.current);
		const view = flowRect();
		return { x: view.x + view.width / 2, y: view.y + view.height / 2 };
	}, [flow, flowRect]);

	/** Where a paste lands: offset from the originals if they're in view, else under the pointer. */
	const placePaste = useCallback(
		(payload: ClipboardPayload): Position => {
			const bounds = payloadBounds(payload);
			if (!bounds) return { x: 0, y: 0 };
			const key = payload.shapes.map((shape) => shape.id).join(",");
			const count = lastPaste.current?.key === key ? lastPaste.current.count + 1 : 1;
			lastPaste.current = { key, count };
			const sameBoard = payload.board === latest.current.board;
			if (sameBoard && intersects(bounds, flowRect())) {
				return { x: PASTE_OFFSET * count, y: PASTE_OFFSET * count };
			}
			const at = pointerOrCentre();
			return {
				x: at.x - (bounds.x + bounds.width / 2),
				y: at.y - (bounds.y + bounds.height / 2),
			};
		},
		[flowRect, pointerOrCentre],
	);

	const pastePayload = useCallback(
		(payload: ClipboardPayload, offset: Position): string[] => {
			let arriving: string[] = [];
			const ids = transactLocal(doc, () => {
				const added = pasteShapes(doc, payload, offset);
				settlePasted(doc, added, offset, latest.current.boxSize);
				arriving = latest.current.markPasted?.(added, payload.board) ?? [];
				return added;
			});
			latest.current.setSelected(new Set(ids));
			if (arriving.length > 0 && payload.board) {
				latest.current.onPastedImages?.(payload.board, arriving);
			}
			return ids;
		},
		[doc],
	);

	const pasteText = useCallback(
		(text: string, where?: Position): boolean => {
			const paste = interpretText(text);
			if (!paste) return false;
			const at = where ?? pointerOrCentre();
			const { user, stickyColor, addCards, addLinks } = latest.current;
			if (paste.kind === "cards") {
				if (!addCards || (paste.links.length > 0 && !addLinks)) return false;
				// Centred under the pointer, then in rows (see shared/addCards.ts):
				// cards first, then link cards in rows of their own below them.
				const columns = Math.min(Math.max(paste.keys.length, paste.links.length), RUN_COLUMNS);
				const left = Math.round(at.x - (columns * (PLACED_CARD.w + PLACE_GAP) - PLACE_GAP) / 2);
				const top = Math.round(at.y - (paste.keys.length > 0 ? PLACED_CARD.h : LINK_CARD.h) / 2);
				if (paste.keys.length > 0) addCards(paste.keys, { at: { x: left, y: top } });
				if (paste.links.length > 0) {
					const rows = Math.ceil(paste.keys.length / RUN_COLUMNS);
					addLinks?.(paste.links, {
						at: { x: left, y: top + rows * (PLACED_CARD.h + PLACE_GAP) },
					});
				}
				return true;
			}
			const id = transactLocal(doc, () => {
				const id = addSticky(doc, at, {
					color: stickyColor,
					author: authorFor(user),
				});
				setStickyText(doc, id, paste.text);
				return id;
			});
			latest.current.setSelected(new Set([id]));
			return true;
		},
		[doc, pointerOrCentre],
	);

	const pasteFrom = useCallback(
		(read: (type: string) => string): boolean => {
			const payload = parsePayload(read(CLIPBOARD_TYPE)) ?? fromHtml(read("text/html"));
			if (payload) {
				pastePayload(payload, placePaste(payload));
				return true;
			}
			return pasteText(read("text/plain"));
		},
		[pastePayload, placePaste, pasteText],
	);

	// Shapes and connectors are deleted together, as one undo step, with
	// whatever must go with them (see deleteShapes).
	const removeSelection = useCallback(
		(quiet: boolean) => {
			const { selected, setSelected, boxSize } = latest.current;
			const ids = [...selected];
			if (ids.length === 0) return;
			if (!quiet) onRemoveRef.current(ids);
			deleteShapes(doc, ids, boxSize);
			setSelected(new Set());
		},
		[doc],
	);

	const duplicate = useCallback(() => {
		const payload = copySelection();
		if (!payload) return;
		const sources = payload.shapes.map((shape) => shape.id);
		// Duplicate again after moving a duplicate, and the next one repeats
		// that move, so a row of copies is quick to make.
		let offset = { x: PASTE_OFFSET, y: PASTE_OFFSET };
		const previous = lastDuplicate.current;
		if (
			previous &&
			previous.copies.length === sources.length &&
			previous.copies.every((id, i) => id === sources[i])
		) {
			const shapes = shapesMap(doc);
			const source = shapes.get(previous.sources[0] ?? "");
			const copy = shapes.get(previous.copies[0] ?? "");
			if (source && copy) {
				offset = {
					x: Number(copy.get("x")) - Number(source.get("x")),
					y: Number(copy.get("y")) - Number(source.get("y")),
				};
			}
		}
		const copies = pastePayload(payload, offset);
		lastDuplicate.current = { sources, copies };
	}, [copySelection, doc, pastePayload]);

	// Arranging ------------------------------------------------------------

	const arrange = useCallback(
		(layout: (items: Item[]) => Map<string, Position>) => {
			const { selected, inList } = latest.current;
			const items: Item[] = [];
			for (const id of selected) {
				if (inList?.(id)) continue;
				const rect = rectOf(id);
				if (rect) items.push({ id, ...rect });
			}
			const positions = layout(items);
			if (positions.size === 0) return;
			settle();
			transactLocal(doc, () =>
				commitMoves(doc, positions, latest.current.boxSize, { raise: false }),
			);
		},
		[doc, rectOf, settle],
	);

	/**
	 * Laid out on top of shapes that weren't selected: the whole layout
	 * slides, as one, to the nearest space that's clear of them.
	 */
	const clearOfOthers = useCallback(
		(positions: Map<string, Position>, items: Item[]): Map<string, Position> => {
			if (positions.size === 0) return positions;
			const at = (item: Item) => positions.get(item.id) ?? item;
			const left = Math.min(...items.map((item) => at(item).x));
			const top = Math.min(...items.map((item) => at(item).y));
			const right = Math.max(...items.map((item) => at(item).x + item.width));
			const bottom = Math.max(...items.map((item) => at(item).y + item.height));
			const box = { x: left, y: top, w: right - left, h: bottom - top };
			const ids = new Set(items.map((item) => item.id));
			const spot = slideClear(readShapes(doc), ids, box, latest.current.boxSize);
			if (!spot) return positions;
			const dx = spot.x - left;
			const dy = spot.y - top;
			return new Map(items.map((item) => [item.id, { x: at(item).x + dx, y: at(item).y + dy }]));
		},
		[doc],
	);

	// Commands -------------------------------------------------------------

	const run = useCallback(
		(id: CommandId): boolean => {
			if (id.startsWith("nudge") && latest.current.onListKey?.(id)) return true;
			if (latest.current.readOnly && WRITES.test(id)) return false;
			if (!id.startsWith("nudge")) flushNudge();
			const { selected, setSelected, nodes, toggleShortcuts } = latest.current;
			const zoomOptions = { duration: duration(260) };
			if (id.startsWith("zoom")) latest.current.onNavigate?.();
			switch (id) {
				case "undo":
				case "redo":
					settle();
					return id === "undo" ? history.undo() : history.redo();
				case "duplicate":
					duplicate();
					return true;
				case "delete":
					removeSelection(false);
					return true;
				case "selectAll":
					setSelected(new Set(nodes.map((node) => node.id)));
					return true;
				case "deselect":
					if (selected.size === 0) return false;
					setSelected(new Set());
					store.setState({ nodesSelectionActive: false });
					return true;
				case "nudgeLeft":
					nudgeBy(-1, 0);
					return true;
				case "nudgeRight":
					nudgeBy(1, 0);
					return true;
				case "nudgeUp":
					nudgeBy(0, -1);
					return true;
				case "nudgeDown":
					nudgeBy(0, 1);
					return true;
				case "nudgeLeftFar":
					nudgeBy(-10, 0);
					return true;
				case "nudgeRightFar":
					nudgeBy(10, 0);
					return true;
				case "nudgeUpFar":
					nudgeBy(0, -10);
					return true;
				case "nudgeDownFar":
					nudgeBy(0, 10);
					return true;
				case "alignLeft":
				case "alignCenter":
				case "alignRight":
				case "alignTop":
				case "alignMiddle":
				case "alignBottom": {
					const how = id.slice("align".length).toLowerCase() as Parameters<typeof align>[1];
					arrange((items) => align(items, how));
					return true;
				}
				case "distributeHorizontal":
					arrange((items) => distribute(items, "horizontal"));
					return true;
				case "distributeVertical":
					arrange((items) => distribute(items, "vertical"));
					return true;
				case "tidy":
					arrange((items) => clearOfOthers(tidy(items), items));
					return true;
				case "zoomIn":
				case "zoomOut": {
					// A step from where the last step is heading, so steps in
					// quick succession (clicking Zoom out four times) add up,
					// rather than each starting from partway through the last.
					const { transform, minZoom, maxZoom } = store.getState();
					const now = performance.now();
					const goal = zoomGoal.current;
					const from = goal && now < goal.until ? goal.zoom : transform[2];
					const step = id === "zoomIn" ? ZOOM_STEP : 1 / ZOOM_STEP;
					const zoom = Math.min(maxZoom, Math.max(minZoom, from * step));
					zoomGoal.current = { zoom, until: now + zoomOptions.duration };
					void flow.zoomTo(zoom, zoomOptions);
					return true;
				}
				case "zoomTo100":
					void flow.zoomTo(1, zoomOptions);
					return true;
				case "zoomToFit": {
					// Everything, shapes off screen too, clear of the dock and the minimap.
					const { canvas, sizeOf, boxSize } = latest.current;
					const viewport = fitBoxes(canvas.current, shapeBoxes(nodes, sizeOf, boxSize), {
						maxZoom: 2,
					});
					if (viewport) void flow.setViewport(viewport, zoomOptions);
					return true;
				}
				case "zoomToSelection": {
					if (selected.size === 0) return false;
					const { canvas, sizeOf, boxSize } = latest.current;
					const chosen = nodes.filter((node) => selected.has(node.id));
					const viewport = fitBoxes(canvas.current, shapeBoxes(chosen, sizeOf, boxSize), {
						maxZoom: 1.5,
						gap: 96,
					});
					if (viewport) void flow.setViewport(viewport, zoomOptions);
					return true;
				}
				case "shortcuts":
					toggleShortcuts();
					return true;
				case "insertImage":
					return latest.current.onInsertImage?.() ?? false;
				case "makeIssues":
				case "parentIssue":
				case "labels":
				case "milestone":
				case "assign":
				case "closeReopen":
				case "backlink":
				case "blockedBy":
				case "expandRelated":
				case "toActions":
				case "carryOver":
				case "stackThese":
				case "groupThese":
				case "unstack":
				case "fitSection":
				case "summarise":
				case "draftDecision":
					return latest.current.onAction?.(id) ?? false;
				case "copy":
				case "cut":
				case "paste":
					// Handled by the clipboard events below.
					return false;
			}
		},
		[
			duplicate,
			flow,
			flushNudge,
			history,
			nudgeBy,
			removeSelection,
			settle,
			arrange,
			clearOfOthers,
			store,
			duration,
		],
	);

	// Keys -----------------------------------------------------------------

	useEffect(() => {
		let pendingCopy: { cut: boolean } | null = null;

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || isOffBoardTarget(event.target)) return;
			const shortcut = matchShortcut(event, apple);
			if (!shortcut) return;
			const id = shortcut.id as CommandId;
			// Arrows with nothing selected, or on a shape the keyboard moved to,
			// move between shapes (navigation.ts).
			const nothingToNudge =
				latest.current.selected.size === 0 || isOnUnselectedShape(event.target);
			if (id.startsWith("nudge") && nothingToNudge) return;
			if (id === "copy" || id === "cut") {
				// The copy event that follows does the work. Safari doesn't fire
				// one without a text selection, so fall back after this task.
				if (hasTextSelection() || latest.current.selected.size === 0) return;
				pendingCopy = { cut: id === "cut" };
				setTimeout(() => {
					if (!pendingCopy) return;
					const payload = copySelection();
					if (payload) writeClipboard(payload, null);
					if (pendingCopy.cut && !latest.current.readOnly) removeSelection(true);
					pendingCopy = null;
				});
				return;
			}
			if (id === "paste") return; // Paste events.
			if (run(id)) event.preventDefault();
		};

		// Arrow keys are taken before React Flow's own handling on a focused
		// node, which moves by 5px rather than 1 and 10.
		const onArrowCapture = (event: KeyboardEvent) => {
			if (!event.key.startsWith("Arrow") || isOffBoardTarget(event.target)) return;
			// On a shape the keyboard moved to, arrows move between shapes (navigation.ts).
			if (isOnUnselectedShape(event.target)) return;
			// A toolbar's arrow keys move along it (the selection's action bar).
			if (event.target instanceof Element && event.target.closest("[role='toolbar']")) return;
			const shortcut = matchShortcut(event, apple);
			if (shortcut?.id.startsWith("nudge") && latest.current.selected.size > 0) {
				event.preventDefault();
				event.stopPropagation();
				run(shortcut.id as CommandId);
			}
		};

		const onCopy = (event: ClipboardEvent) => {
			if (isOffBoardTarget(event.target) || hasTextSelection()) return;
			const cut = event.type === "cut";
			pendingCopy = null;
			flushNudge();
			const payload = copySelection();
			if (!payload) return;
			event.preventDefault();
			writeClipboard(payload, event.clipboardData);
			if (cut && !latest.current.readOnly) removeSelection(true);
		};

		const onPaste = (event: ClipboardEvent) => {
			if (latest.current.readOnly || isOffBoardTarget(event.target)) return;
			const data = event.clipboardData;
			if (!data) return;
			flushNudge();
			// Image files first (a screenshot, a copied image), then text.
			const files = imageFilesOf(data);
			if (files.length > 0 && latest.current.addImages?.(files, pointerOrCentre())) {
				event.preventDefault();
				return;
			}
			if (pasteFrom((type) => data.getData(type))) event.preventDefault();
		};

		const onPointerMove = (event: PointerEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			const overBoard = target?.closest(".react-flow") && !target.closest(".react-flow__panel");
			pointer.current = overBoard ? { x: event.clientX, y: event.clientY } : null;
		};

		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keydown", onArrowCapture, true);
		window.addEventListener("copy", onCopy);
		window.addEventListener("cut", onCopy);
		window.addEventListener("paste", onPaste);
		window.addEventListener("pointermove", onPointerMove, { passive: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keydown", onArrowCapture, true);
			window.removeEventListener("copy", onCopy);
			window.removeEventListener("cut", onCopy);
			window.removeEventListener("paste", onPaste);
			window.removeEventListener("pointermove", onPointerMove);
		};
	}, [copySelection, flushNudge, pasteFrom, pointerOrCentre, removeSelection, run, writeClipboard]);

	// Commit a pending nudge if the board goes away.
	useEffect(() => () => flushNudge(), [flushNudge]);

	// Deletes ----------------------------------------------------------------

	/**
	 * Call with shapes React Flow is about to remove, before the removal is
	 * written. Deletes that matter get an undo toast instead of a dialog.
	 */
	const onRemove = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			const shapes = shapesMap(doc);
			const removed = ids.flatMap((id) => {
				const shape = shapes.get(id);
				return shape ? [readShape(shape)] : [];
			});
			// A decision always matters: it carries votes and a status, not just
			// words. So does an action item with someone's name on it.
			const hasContent = removed.some(
				(shape) =>
					hasWords(shape.text) ||
					shape.type === "decision" ||
					// A stack holds stickies: deleting one always says so.
					shape.type === "stack" ||
					(shape.type === "action" && (shape.owner !== undefined || shape.ref !== undefined)),
			);
			// Anything staged from them goes too: say so, so Undo is the obvious way back.
			const unstaged = unstagedByDeleting(doc, ids);
			if (removed.length <= QUIET_DELETE_LIMIT && !hasContent && unstaged.length === 0) return;
			const { toasts } = latest.current;
			// Show it once the deletion is on the undo stack, and drop it as soon
			// as something else is, since Undo would then undo that instead.
			queueMicrotask(() => {
				const step = history.top();
				const toast = toasts.show({
					message: `Deleted ${describe(removed)}${unstaged.length > 0 ? ` and unstaged ${describeUnstaged(unstaged)}` : ""}`,
					action: {
						label: "Undo",
						hint: shortcutHint("undo", apple),
						run: () => {
							if (history.top() === step) {
								settle();
								history.undo();
							}
						},
					},
				});
				const unsubscribe = history.subscribe(() => {
					if (history.top() !== step) {
						toasts.dismiss(toast);
						unsubscribe();
					}
				});
			});
		},
		[doc, history, settle],
	);
	const onRemoveRef = useRef(onRemove);
	onRemoveRef.current = onRemove;

	return useMemo(
		() => ({ run, onRemove, settle, dropText: pasteText }),
		[run, onRemove, settle, pasteText],
	);
}

function hasWords(text: unknown): boolean {
	return typeof text === "string" && text.trim().length > 0;
}

const NOUNS: Record<string, [string, string]> = {
	sticky: ["sticky", "stickies"],
	card: ["card", "cards"],
	section: ["section", "sections"],
	connector: ["connector", "connectors"],
	decision: ["decision", "decisions"],
	widget: ["widget", "widgets"],
	action: ["action item", "action items"],
	stack: ["stack", "stacks"],
	link: ["link card", "link cards"],
};

/** "its issue", "3 issues", "4 changes": what deleting shapes unstaged. */
function describeUnstaged(changes: { op: { kind: string } }[]): string {
	const issues = changes.every((change) => change.op.kind === "issue.create");
	if (changes.length === 1) return issues ? "its issue" : "its change";
	return `${changes.length} ${issues ? "issues" : "changes"}`;
}

/** "a sticky", "5 cards", "3 shapes" */
function describe(shapes: { type: string }[]): string {
	const types = new Set(shapes.map((shape) => shape.type));
	const [one, many] = (types.size === 1 && NOUNS[[...types][0] ?? ""]) || ["shape", "shapes"];
	return shapes.length === 1 ? `a ${one}` : `${shapes.length} ${many}`;
}
