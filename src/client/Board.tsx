import {
	Background,
	BackgroundVariant,
	ControlButton,
	Controls,
	MiniMap,
	type OnNodesChange,
	ReactFlow,
	SelectionMode,
	ViewportPortal,
	useReactFlow,
} from "@xyflow/react";
import {
	type DragEvent,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { itemKey, parseRef } from "../shared/refs.ts";
import {
	type Position,
	STICKY_SIZE,
	type ShapeNode,
	type StickyColor,
	addCard,
	addSticky,
	addText,
	applyNodeChanges,
	focusWhenMounted,
	useShapeNodes,
} from "./board.ts";
import type { BoardSource } from "./connection.ts";
import { BrandMark } from "./BrandMark.tsx";
import { useCanvasCommands } from "./commands.ts";
import { CursorChat } from "./CursorChat.tsx";
import { Cursors } from "./Cursors.tsx";
import { EmptyBoard } from "./EmptyBoard.tsx";
import { FollowIndicator, ViewPublisher, useFollow } from "./Follow.tsx";
import { Guides, useSnapping } from "./Guides.tsx";
import { HistoryContext } from "./DocContext.ts";
import { isOffBoardTarget } from "./keys.ts";
import { DocContext, nodeTypes } from "./nodes.tsx";
import { People } from "./People.tsx";
import { type User, usePresence } from "./presence.ts";
import { SelectionTools } from "./SelectionTools.tsx";
import { ShapeToolbar, styledShapes } from "./ShapeToolbar.tsx";
import { ShortcutSheet } from "./Shortcuts.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { Toasts, ToastStore } from "./Toasts.tsx";
import { STICKY_DRAG_TYPE, TOOL_KEYS, type Tool, Toolbar } from "./Toolbar.tsx";
import { History } from "./undo.ts";
import { usePublishStatus } from "./useActivity.ts";

interface BoardProps extends BoardSource {
	name: string;
	user: User;
	/**
	 * Your avatar in the top bar, e.g. an account menu, given the label the
	 * plain avatar would have. Defaults to a plain avatar.
	 */
	account?: (label: string) => ReactNode;
	/** Extra controls at the end of the top bar, e.g. a sign-in button. */
	actions?: ReactNode;
	/** Extra UI drawn over the canvas, e.g. the playground's controls. */
	children?: ReactNode;
}

export function Board({
	name,
	doc,
	awareness,
	synced,
	user,
	account,
	actions,
	children,
}: BoardProps) {
	const shapeNodes = useShapeNodes(doc);
	const flow = useReactFlow();
	const presence = usePresence(awareness, user);
	const follow = useFollow(awareness, presence.people);
	usePublishStatus(awareness);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
		() => new Map(),
	);
	const measuredRef = useRef(measured);
	measuredRef.current = measured;
	const sizeOf = useCallback((id: string) => measuredRef.current.get(id), []);

	// Undo and redo this person's own changes, never anyone else's.
	const history = useMemo(() => new History(doc), [doc]);
	useEffect(() => () => history.destroy(), [history]);
	const [toasts] = useState(() => new ToastStore());
	const canvas = useRef<HTMLElement>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	// Shift-dragging a marquee adds to the selection instead of replacing it.
	const marqueeBase = useRef<Set<string> | null>(null);

	// Selection, measured sizes and in-progress drags are local UI state, so
	// they live outside the document. Unchanged nodes keep their identity so
	// React Flow's memoised nodes skip re-rendering.
	const merged = useRef(new Map<string, { base: ShapeNode; out: ShapeNode }>());
	const nodes = useMemo(
		() =>
			shapeNodes.map((base) => {
				const isSelected = selected.has(base.id);
				const size = measured.get(base.id);
				const drag = presence.overrides.get(base.id);
				const position = drag ? { x: drag.x, y: drag.y } : base.position;
				const remoteColor = drag?.user?.color;
				const cached = merged.current.get(base.id)?.out;
				if (
					cached &&
					merged.current.get(base.id)?.base === base &&
					cached.selected === isSelected &&
					cached.measured === size &&
					cached.position.x === position.x &&
					cached.position.y === position.y &&
					cached.className === (remoteColor ? "remote-drag" : undefined)
				) {
					return cached;
				}
				const out: ShapeNode = {
					...base,
					selected: isSelected,
					measured: size,
					position,
					className: remoteColor ? "remote-drag" : undefined,
					// Shapes being dragged float above everything else.
					zIndex: drag ? 1000 : base.zIndex,
					style: remoteColor ? ({ "--drag-color": remoteColor } as React.CSSProperties) : undefined,
				};
				merged.current.set(base.id, { base, out });
				return out;
			}),
		[shapeNodes, selected, measured, presence.overrides],
	);

	const snapping = useSnapping(nodes, sizeOf);

	const [tool, setTool] = useState<Tool>("select");
	const [stickyColor, setStickyColor] = useState<StickyColor>("yellow");

	// Keyboard shortcuts, the clipboard (paste a URL for a card, or text for
	// a sticky), nudging, arranging and the delete toast.
	const previewPositions = useCallback(
		(positions: Map<string, Position | null>) =>
			presence.onPositionChanges(
				[...positions].map(([id, position]) => ({
					type: "position" as const,
					id,
					position: position ?? undefined,
					dragging: position !== null,
				})),
			),
		[presence.onPositionChanges],
	);
	const commands = useCanvasCommands({
		doc,
		board: name,
		history,
		nodes,
		selected,
		setSelected,
		sizeOf,
		user,
		stickyColor,
		previewPositions,
		toasts,
		canvas,
		toggleShortcuts: () => setSheetOpen((open) => !open),
		onNavigate: follow.stop,
	});

	const onNodesChange: OnNodesChange<ShapeNode> = useCallback(
		(incoming) => {
			const changes = snapping.snapChanges(incoming);
			const selection = changes.filter((change) => change.type === "select");
			if (selection.length > 0) {
				setSelected((current) => {
					const next = new Set(current);
					for (const change of selection) {
						if (change.selected) next.add(change.id);
						else next.delete(change.id);
					}
					for (const id of marqueeBase.current ?? []) next.add(id);
					return next;
				});
			}
			const sizes = changes.filter((change) => change.type === "dimensions" && change.dimensions);
			if (sizes.length > 0) {
				setMeasured((current) => {
					const next = new Map(current);
					for (const change of sizes) {
						if (change.type === "dimensions" && change.dimensions) {
							next.set(change.id, change.dimensions);
						}
					}
					return next;
				});
			}
			presence.onPositionChanges(changes);
			commands.onRemove(changes.flatMap((change) => (change.type === "remove" ? [change.id] : [])));
			applyNodeChanges(doc, changes, presence.lastDragPosition);
		},
		[doc, presence, snapping, commands],
	);

	const centre = useCallback(
		() =>
			flow.screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 60 }),
		[flow],
	);

	// Where the pointer is in flow space, only tracked while placing a sticky.
	const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

	// Tool shortcuts, ignored while typing.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (isOffBoardTarget(event.target)) return;
			if (event.key === "Escape") setTool("select");
			const next = TOOL_KEYS[event.key.toLowerCase()];
			if (next) {
				event.preventDefault();
				setTool(next);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		if (tool !== "sticky") setGhost(null);
	}, [tool]);

	const placeSticky = useCallback(
		(at: { x: number; y: number }, color: StickyColor) => {
			const id = addSticky(doc, at, { color, author: { name: user.name, color: user.color } });
			focusWhenMounted(id);
			setSelected(new Set([id]));
		},
		[doc, user],
	);

	const onPaneClick = (event: MouseEvent) => {
		const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		if (tool === "sticky") {
			placeSticky(at, stickyColor);
		} else if (tool === "text") {
			const id = addText(doc, at);
			focusWhenMounted(id);
			setSelected(new Set([id]));
		} else {
			return;
		}
		setTool("select");
	};

	const selectedNodes = useMemo(
		() => nodes.filter((node) => selected.has(node.id)),
		[nodes, selected],
	);

	// Drag a sticky straight off the toolbar.
	const onDragOver = (event: DragEvent) => {
		if (event.dataTransfer.types.includes(STICKY_DRAG_TYPE)) {
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		}
	};
	const onDrop = (event: DragEvent) => {
		const color = event.dataTransfer.getData(STICKY_DRAG_TYPE) as StickyColor;
		if (!color) return;
		event.preventDefault();
		placeSticky(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), color);
		setTool("select");
	};

	const onAddCard = (input: string) => {
		const ref = parseRef(input);
		if (!ref) return false;
		addCard(doc, itemKey(ref), centre());
		return true;
	};

	// Select: drag the canvas to marquee-select; scroll or space-drag to pan.
	// Hand: drag to pan, and shapes can't be picked up.
	return (
		<DocContext value={doc}>
			<HistoryContext value={history}>
				<div className="app">
					<header className="topbar">
						<span className="brand">
							<BrandMark />
							tack
						</span>
						<span className="board-name">{name}</span>
						<People
							user={user}
							selfId={awareness.clientID}
							people={presence.people}
							following={follow.following}
							onFollow={follow.follow}
							self={account}
						/>
						<ThemeToggle />
						<span className="status" data-synced={synced}>
							{synced ? "Synced" : "Connecting…"}
						</span>
						{actions}
					</header>
					<main
						ref={canvas}
						className="canvas"
						data-tool={tool}
						onPointerMove={(event) => {
							const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
							presence.setCursor(at);
							if (tool === "sticky") setGhost(at);
						}}
						onPointerLeave={() => {
							presence.setCursor(null);
							setGhost(null);
						}}
						onDragOver={onDragOver}
						onDrop={onDrop}
					>
						<ReactFlow
							nodes={nodes}
							nodeTypes={nodeTypes}
							onNodesChange={onNodesChange}
							onPaneClick={onPaneClick}
							onMoveStart={follow.onMoveStart}
							proOptions={{ hideAttribution: true }}
							onlyRenderVisibleElements
							selectionOnDrag={tool === "select"}
							panOnDrag={tool === "hand" ? true : [1, 2]}
							panOnScroll
							nodesDraggable={tool !== "hand"}
							elementsSelectable={tool !== "hand"}
							minZoom={0.1}
							deleteKeyCode={["Backspace", "Delete"]}
							selectionMode={SelectionMode.Partial}
							selectionKeyCode={null}
							multiSelectionKeyCode={["Shift", "Meta", "Control"]}
							onSelectionStart={(event) => {
								marqueeBase.current = event.shiftKey ? new Set(selected) : null;
							}}
							onSelectionEnd={() => {
								marqueeBase.current = null;
							}}
							onNodeClick={(event, node) => {
								// Clicking one shape in a multi-selection selects just that one.
								if (event.shiftKey || event.metaKey || event.ctrlKey) return;
								if (selected.size > 1 && selected.has(node.id)) setSelected(new Set([node.id]));
							}}
						>
							<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
							<Controls
								showInteractive={false}
								onZoomIn={follow.stop}
								onZoomOut={follow.stop}
								onFitView={follow.stop}
							>
								<ControlButton
									onClick={() => setSheetOpen(true)}
									title="Keyboard shortcuts (?)"
									aria-label="Keyboard shortcuts"
									className="shortcuts-button"
								>
									?
								</ControlButton>
							</Controls>
							<MiniMap pannable zoomable nodeClassName={minimapClass} />
							<Guides store={snapping.guides} />
							<SelectionTools
								nodes={nodes}
								selected={selected}
								sizeOf={sizeOf}
								dragging={snapping.dragging}
								stacked={styledShapes(selectedNodes).length > 0}
								onCommand={commands.run}
							/>
							<Cursors people={presence.people} />
							<ViewPublisher awareness={awareness} />
							<ShapeToolbar doc={doc} selected={selectedNodes} onStickyColor={setStickyColor} />
							{ghost && (
								<ViewportPortal>
									<div
										className="sticky sticky-ghost"
										data-color={stickyColor}
										aria-hidden="true"
										style={{
											transform: `translate(${ghost.x - STICKY_SIZE / 2}px, ${ghost.y - STICKY_SIZE / 2}px)`,
										}}
									/>
								</ViewportPortal>
							)}
						</ReactFlow>
						<EmptyBoard empty={synced && shapeNodes.length === 0} onTool={setTool} />
						<FollowIndicator person={follow.target} onStop={follow.stop} />
						<CursorChat awareness={awareness} user={user} />
						<Toolbar
							tool={tool}
							onTool={setTool}
							stickyColor={stickyColor}
							onStickyColor={setStickyColor}
							onAddCard={onAddCard}
						/>
						<Toasts store={toasts} />
						<ShortcutSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
						{children}
					</main>
				</div>
			</HistoryContext>
		</DocContext>
	);
}

/** Minimap shapes take their own colour: stickies show as their paper. */
function minimapClass(node: ShapeNode): string {
	const { type, color } = node.data.shape;
	return type === "sticky" ? `minimap-sticky minimap-${color ?? "yellow"}` : `minimap-${type}`;
}
