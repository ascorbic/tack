import { useReactFlow, useStoreApi } from "@xyflow/react";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import type * as Y from "yjs";
import { readShape, shapesMap } from "../shared/shapes.ts";
import { align, distribute, type Item, tidy } from "./arrange.ts";
import {
	type Position,
	type ShapeNode,
	type StickyColor,
	addCard,
	addSticky,
	setStickyText,
} from "./board.ts";
import { cardStore } from "./cardStore.ts";
import { isOffBoardTarget } from "./keys.ts";
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
import type { User } from "./presence.ts";
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
	user: User;
	stickyColor: StickyColor;
	/** Shows nudges live, through presence, until they're committed. */
	previewPositions: (positions: Map<string, Position | null>) => void;
	toasts: ToastStore;
	canvas: RefObject<HTMLElement | null>;
	toggleShortcuts: () => void;
	/** Called when a shortcut moves the view, e.g. to stop following someone. */
	onNavigate?: () => void;
}

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
	const quietDelete = useRef(false);

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
		const shapes = shapesMap(doc);
		transactLocal(doc, () => {
			for (const [id, base] of pending.base) {
				const shape = shapes.get(id);
				if (!shape) continue;
				shape.set("x", Math.round(base.x + pending.dx));
				shape.set("y", Math.round(base.y + pending.dy));
			}
		});
		latest.current.previewPositions(new Map([...pending.base.keys()].map((id) => [id, null])));
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
		const payload = copyShapes(doc, selected, { board, sizes: sizeOf });
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
			const ids = transactLocal(doc, () => pasteShapes(doc, payload, offset));
			latest.current.setSelected(new Set(ids));
			return ids;
		},
		[doc],
	);

	const pasteText = useCallback(
		(text: string): boolean => {
			const paste = interpretText(text);
			if (!paste) return false;
			const at = pointerOrCentre();
			const { user, stickyColor } = latest.current;
			const ids = transactLocal(doc, () => {
				if (paste.kind === "cards") {
					const columns = Math.min(paste.keys.length, 4);
					return paste.keys.map((key, i) =>
						addCard(doc, key, {
							x: Math.round(at.x - (columns * 290) / 2 + (i % columns) * 290 + 20),
							y: Math.round(at.y - 60 + Math.floor(i / columns) * 230),
						}),
					);
				}
				const id = addSticky(doc, at, {
					color: stickyColor,
					author: { name: user.name, color: user.color },
				});
				setStickyText(doc, id, paste.text);
				return [id];
			});
			latest.current.setSelected(new Set(ids));
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

	const removeSelection = useCallback(
		(quiet: boolean) => {
			const ids = [...latest.current.selected];
			if (ids.length === 0) return;
			quietDelete.current = quiet;
			void flow.deleteElements({ nodes: ids.map((id) => ({ id })) }).finally(() => {
				quietDelete.current = false;
			});
		},
		[flow],
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
			const { selected } = latest.current;
			const items: Item[] = [];
			for (const id of selected) {
				const rect = rectOf(id);
				if (rect) items.push({ id, ...rect });
			}
			const positions = layout(items);
			if (positions.size === 0) return;
			const shapes = shapesMap(doc);
			settle();
			transactLocal(doc, () => {
				for (const [id, position] of positions) {
					shapes.get(id)?.set("x", position.x);
					shapes.get(id)?.set("y", position.y);
				}
			});
		},
		[doc, rectOf, settle],
	);

	// Commands -------------------------------------------------------------

	const run = useCallback(
		(id: CommandId): boolean => {
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
					arrange((items) => tidy(items));
					return true;
				case "zoomIn":
					void flow.zoomIn(zoomOptions);
					return true;
				case "zoomOut":
					void flow.zoomOut(zoomOptions);
					return true;
				case "zoomTo100":
					void flow.zoomTo(1, zoomOptions);
					return true;
				case "zoomToFit":
					void flow.fitView({ ...zoomOptions, padding: 0.15 });
					return true;
				case "zoomToSelection":
					if (selected.size === 0) return false;
					void flow.fitView({
						...zoomOptions,
						padding: 0.3,
						maxZoom: 1.5,
						nodes: [...selected].map((nodeId) => ({ id: nodeId })),
					});
					return true;
				case "shortcuts":
					toggleShortcuts();
					return true;
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
			if (id === "copy" || id === "cut") {
				// The copy event that follows does the work. Safari doesn't fire
				// one without a text selection, so fall back after this task.
				if (hasTextSelection() || latest.current.selected.size === 0) return;
				pendingCopy = { cut: id === "cut" };
				setTimeout(() => {
					if (!pendingCopy) return;
					const payload = copySelection();
					if (payload) writeClipboard(payload, null);
					if (pendingCopy.cut) removeSelection(true);
					pendingCopy = null;
				});
				return;
			}
			if (id === "paste" || id === "delete") return; // Paste events, and React Flow.
			if (run(id)) event.preventDefault();
		};

		// Arrow keys are taken before React Flow's own handling on a focused
		// node, which moves by 5px rather than 1 and 10.
		const onArrowCapture = (event: KeyboardEvent) => {
			if (!event.key.startsWith("Arrow") || isOffBoardTarget(event.target)) return;
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
			if (cut) removeSelection(true);
		};

		const onPaste = (event: ClipboardEvent) => {
			if (isOffBoardTarget(event.target)) return;
			const data = event.clipboardData;
			if (!data) return;
			flushNudge();
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
	}, [copySelection, flushNudge, pasteFrom, removeSelection, run, writeClipboard]);

	// Commit a pending nudge if the board goes away.
	useEffect(() => () => flushNudge(), [flushNudge]);

	// Deletes ----------------------------------------------------------------

	/**
	 * Call with shapes React Flow is about to remove, before the removal is
	 * written. Deletes that matter get an undo toast instead of a dialog.
	 */
	const onRemove = useCallback(
		(ids: string[]) => {
			if (ids.length === 0 || quietDelete.current) return;
			const shapes = shapesMap(doc);
			const removed = ids.flatMap((id) => {
				const shape = shapes.get(id);
				return shape ? [readShape(shape)] : [];
			});
			const hasContent = removed.some((shape) => hasWords(shape.text));
			if (removed.length <= QUIET_DELETE_LIMIT && !hasContent) return;
			const { toasts } = latest.current;
			// Show it once the deletion is on the undo stack, and drop it as soon
			// as something else is, since Undo would then undo that instead.
			queueMicrotask(() => {
				const step = history.top();
				const toast = toasts.show({
					message: `Deleted ${describe(removed)}`,
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

	return useMemo(() => ({ run, onRemove, settle }), [run, onRemove, settle]);
}

function hasWords(text: unknown): boolean {
	return typeof text === "string" && text.trim().length > 0;
}

const NOUNS: Record<string, [string, string]> = {
	sticky: ["sticky", "stickies"],
	card: ["card", "cards"],
};

/** "a sticky", "5 cards", "3 shapes" */
function describe(shapes: { type: string }[]): string {
	const types = new Set(shapes.map((shape) => shape.type));
	const [one, many] = (types.size === 1 && NOUNS[[...types][0] ?? ""]) || ["shape", "shapes"];
	return shapes.length === 1 ? `a ${one}` : `${shapes.length} ${many}`;
}
