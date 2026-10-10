import {
	Background,
	BackgroundVariant,
	ControlButton,
	Controls,
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
import { readVotes } from "../shared/dotvotes.ts";
import type { StampEmoji } from "../shared/facilitation.ts";
import { itemKey, parseRef } from "../shared/refs.ts";
import {
	type Position,
	STICKY_SIZE,
	type ShapeNode,
	type StickyColor,
	addCard,
	addDecisionAt,
	addSticky,
	addText,
	applyNodeChanges,
	focusWhenMounted,
	useShapeNodes,
} from "./board.ts";
import { ActionBar } from "./actions/ActionBar.tsx";
import { BlockedByAction } from "./actions/BlockedBy.tsx";
import { ActionRequests } from "./actions/selection.ts";
import { ServicesContext, type WriteServices, liveServices } from "./actions/services.ts";
import type { BoardSource } from "./connection.ts";
import { BrandMark } from "./BrandMark.tsx";
import type { PushClient } from "./changes/api.ts";
import { ChangesButton } from "./changes/ChangesButton.tsx";
import { ChangesPanel } from "./changes/ChangesPanel.tsx";
import { ChangesContext } from "./changes/context.ts";
import { PushSheet } from "./changes/PushSheet.tsx";
import { withStagedMarks } from "./changes/StagedMarks.tsx";
import { useChangesState } from "./changes/useChanges.ts";
import { useCanvasStructure, useSizeOf } from "./canvasStructure.ts";
import { useCanvasCommands } from "./commands.ts";
import { ConnectorLayer } from "./connectors.tsx";
import { CursorChat } from "./CursorChat.tsx";
import { Cursors } from "./Cursors.tsx";
import { EmptyBoard } from "./EmptyBoard.tsx";
import { Emotes } from "./facilitation/Emotes.tsx";
import { FacilitateMenu } from "./facilitation/FacilitateMenu.tsx";
import { MarksLayer, dotShape, stampShape } from "./facilitation/Marks.tsx";
import { useSilentToasts } from "./facilitation/Silent.tsx";
import { SpotlightIndicator, useSpotlightFollow } from "./facilitation/Spotlight.tsx";
import { facilitation } from "./facilitation/store.ts";
import { TimerPill } from "./facilitation/Timer.tsx";
import { StartVoteDialog, TallyPanel, VoteBars, useVoteUI, voteUI } from "./facilitation/Votes.tsx";
import { FollowIndicator, ViewPublisher, useFollow } from "./Follow.tsx";
import { Guides, useSnapping } from "./Guides.tsx";
import { BoardContext } from "./DocContext.ts";
import { isOffBoardTarget } from "./keys.ts";
import { BoardMinimap } from "./Minimap.tsx";
import { nodeTypes } from "./nodes.tsx";
import { People } from "./People.tsx";
import { type User, usePresence } from "./presence.ts";
import { SectionTool, ZoomVariable, sectionNodeTypes } from "./sections.tsx";
import { SelectionTools } from "./SelectionTools.tsx";
import { ShapeToolbar, styledShapes } from "./ShapeToolbar.tsx";
import { ShortcutSheet } from "./Shortcuts.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { Toasts, ToastStore } from "./Toasts.tsx";
import { STICKY_DRAG_TYPE, TOOL_KEYS, type Tool, Toolbar, VIEW_TOOLS } from "./Toolbar.tsx";
import { History } from "./undo.ts";
import { usePublishStatus } from "./useActivity.ts";
import { InboxLayer } from "./inbox/InboxTray.tsx";
import { scaledDuration } from "./motion.ts";
import { RulesButton, RulesPanel } from "./rules/RulesPanel.tsx";
import { boardRepos } from "../shared/actions.ts";
import { transactLocal } from "../shared/shapes.ts";
import { placeInSections } from "../shared/structure.ts";
import { addWidget, widgetDefinition } from "../shared/widgetRegistry.ts";
import { cardStore } from "./cardStore.ts";
import type { WidgetBoard } from "./widgets/context.ts";
import { RowGhost } from "./widgets/RowDrag.tsx";
import { linkStore } from "./widgets/store.ts";
import { useDropToMatch } from "./widgets/useDropToMatch.ts";
import { WIDGET_DRAG_TYPE } from "./widgets/WidgetPicker.tsx";
import { useCommentsOnBoard } from "./comments/useCommentsOnBoard.ts";
import { CommentLayer } from "./comments/CommentLayer.tsx";
import { CommentsButton, CommentsPanel } from "./comments/CommentsPanel.tsx";
import { HighlightLayer } from "./since/Highlights.tsx";
import { SinceButton, SincePanel } from "./since/SincePanel.tsx";

// Every shape shows the changes staged about it.
const NODE_TYPES = Object.fromEntries(
	Object.entries({ ...nodeTypes, ...sectionNodeTypes }).map(([type, node]) => [
		type,
		withStagedMarks(node),
	]),
);

interface BoardProps extends BoardSource {
	name: string;
	/** The board's title in the top bar, e.g. one you can rename. Defaults to `name`. */
	title?: ReactNode;
	/**
	 * View only: no tools, no dragging, no editing in place, no sections or
	 * connectors. For viewers, the public and archived boards (the server
	 * refuses their writes anyway).
	 */
	readOnly?: boolean;
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
	/**
	 * What the selection actions need from outside the document (repository
	 * metadata, snapshot uploads). Defaults to the Worker's API for board `name`.
	 */
	services?: WriteServices;
	/**
	 * Where staged changes are pushed (see changes/api.ts). Without it the
	 * changes panel still shows what's staged, but there's no push.
	 */
	push?: PushClient | null;
}

export function Board({
	name,
	title,
	readOnly = false,
	doc,
	awareness,
	synced,
	user,
	account,
	actions,
	children,
	services,
	push = null,
}: BoardProps) {
	const shapeNodes = useShapeNodes(doc);
	const flow = useReactFlow();
	const presence = usePresence(awareness, user);
	const follow = useFollow(awareness, presence.people);
	// Spotlight: someone bringing everyone to their view (#50).
	const spotlight = useSpotlightFollow(awareness, presence.people, follow);
	usePublishStatus(awareness);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
		() => new Map(),
	);
	const measuredRef = useRef(measured);
	measuredRef.current = measured;
	const sizeOf = useCallback((id: string) => measuredRef.current.get(id), []);
	// The same, as boxes for structural edits (see shared/structure.ts).
	const boxSize = useSizeOf(measured);
	// Sections: contents following a dragged section, resizes in progress,
	// and where a dragged shape would land.
	const structure = useCanvasStructure({
		shapeNodes,
		drags: presence.overrides,
		measured,
		awareness,
	});

	// Undo and redo this person's own changes, never anyone else's.
	const history = useMemo(() => new History(doc), [doc]);
	useEffect(() => () => history.destroy(), [history]);
	const [toasts] = useState(() => new ToastStore());
	useSilentToasts(doc, toasts);
	// Selection actions: staging changes for the forge (src/client/actions/).
	const writeServices = useMemo(() => services ?? liveServices(name), [services, name]);
	const [actionRequests] = useState(() => new ActionRequests());
	const canvas = useRef<HTMLElement>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const undo = useCallback(() => void history.undo(), [history]);
	const focusShapes = useCallback(
		(ids: string[]) => {
			follow.stop();
			void flow.fitView({
				nodes: ids.map((id) => ({ id })),
				padding: 0.6,
				maxZoom: 1.1,
				duration: 420,
			});
		},
		[flow, follow.stop],
	);
	const changesUI = useChangesState({
		doc,
		client: push,
		readOnly,
		user,
		toasts,
		undo,
		focusShapes,
	});
	// Shift-dragging a marquee adds to the selection instead of replacing it.
	const marqueeBase = useRef<Set<string> | null>(null);

	// Cards dragged over a list, and dropped on one to match it (#39).
	const matching = useDropToMatch(shapeNodes, sizeOf);

	// Selection, measured sizes and in-progress drags are local UI state, so
	// they live outside the document. Unchanged nodes keep their identity so
	// React Flow's memoised nodes skip re-rendering.
	const merged = useRef(new Map<string, { base: ShapeNode; out: ShapeNode }>());
	const nodes = useMemo(
		() =>
			shapeNodes.map((base) => {
				const isSelected = selected.has(base.id);
				const size = measured.get(base.id);
				const drag = structure.overrides.get(base.id);
				const resize = structure.resizes.get(base.id);
				const position = resize
					? { x: resize.x, y: resize.y }
					: drag
						? { x: drag.x, y: drag.y }
						: base.position;
				const width = resize?.w ?? base.width;
				const height = resize?.h ?? base.height;
				// Shapes being dragged float above everything else.
				const zIndex = structure.zIndexOf(base);
				const remoteColor = drag?.user?.color;
				const className = remoteColor
					? "remote-drag"
					: structure.followsRemote.has(base.id)
						? "remote-follow"
						: matching.returning.has(base.id)
							? "snap-back"
							: undefined;
				const cached = merged.current.get(base.id)?.out;
				if (
					cached &&
					merged.current.get(base.id)?.base === base &&
					cached.selected === isSelected &&
					cached.measured === size &&
					cached.position.x === position.x &&
					cached.position.y === position.y &&
					cached.width === width &&
					cached.height === height &&
					cached.zIndex === zIndex &&
					cached.className === className
				) {
					return cached;
				}
				const out: ShapeNode = {
					...base,
					selected: isSelected,
					measured: size,
					position,
					width,
					height,
					className,
					zIndex,
					style: remoteColor ? ({ "--drag-color": remoteColor } as React.CSSProperties) : undefined,
				};
				merged.current.set(base.id, { base, out });
				return out;
			}),
		[shapeNodes, selected, measured, structure, matching.returning],
	);

	// A dragged section's contents move with it, so they're never snapped to.
	const snapping = useSnapping(nodes, sizeOf, structure.contentsOf);

	// Who's voting on decisions, and the board a written-back record links to.
	const decisionBoard = useMemo(
		() => ({ user, boardUrl: `${location.origin}${location.pathname}` }),
		[user],
	);

	const [tool, setTool] = useState<Tool>("select");
	const [stickyColor, setStickyColor] = useState<StickyColor>("yellow");
	const [stamp, setStamp] = useState<StampEmoji>("👍");
	const voteState = useVoteUI();
	const setVoting = useCallback(
		(on: boolean) => setTool((current) => (on ? "vote" : current === "vote" ? "select" : current)),
		[],
	);

	// Rules (automation that places cards) and inbox frames.
	const [rulesOpen, setRulesOpen] = useState(false);
	const reveal = useCallback(
		(id: string) => {
			if (!flow.getNode(id)) return;
			setSelected(new Set([id]));
			void flow.fitView({
				nodes: [{ id }],
				padding: 1.2,
				maxZoom: Math.max(flow.getZoom(), 0.9),
				duration: scaledDuration(500),
			});
		},
		[flow],
	);

	// What widgets need from the board (#37, #38, #39).
	const widgetBoard = useMemo<WidgetBoard>(
		() => ({
			user,
			toasts,
			hovering: matching.hovering,
			dropped: matching.dropped,
			closeDrop: matching.closeDrop,
			select: (ids) => setSelected(new Set(ids)),
			reveal: (ids) => {
				if (ids.length === 0) return;
				follow.stop();
				setSelected(new Set(ids));
				void flow.fitView({
					nodes: ids.map((id) => ({ id })),
					duration: scaledDuration(520),
					padding: 0.6,
					maxZoom: Math.max(flow.getZoom(), 1),
				});
			},
			seedCard: (card) => {
				if (!cardStore.get(card.key)) cardStore.set(card);
			},
		}),
		[user, toasts, matching, follow.stop, flow],
	);
	const suggestedRepo = useMemo(() => {
		const busiest = boardRepos(doc)[0]?.repo;
		return busiest ? busiest.split("/").slice(1).join("/") : null;
		// Read again whenever the tool changes: it's only needed when the picker opens.
	}, [doc, tool]);

	/** Add a widget centred on `at` (or the middle of the view), selected, with its panel open if it needs setting up. */
	const addWidgetAt = useCallback(
		(kind: string, config?: Record<string, unknown>, at?: { x: number; y: number }) => {
			const definition = widgetDefinition(kind);
			if (!definition || readOnly) return;
			const busiestHost = boardRepos(doc)[0]?.repo.split("/")[0];
			const centreAt =
				at ?? flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
			const id = transactLocal(doc, () => {
				const id = addWidget(
					doc,
					kind,
					{ x: centreAt.x - definition.size.w / 2, y: centreAt.y - definition.size.h / 2 },
					{
						...(definition.defaults as object),
						// Lists search the forge the board's cards are mostly on.
						...(kind === "list" && busiestHost ? { host: busiestHost } : {}),
						...config,
					},
				);
				placeInSections(doc, [id], boxSize);
				return id;
			});
			if (!config?.q) focusWhenMounted(id);
			setSelected(new Set([id]));
			setTool("select");
		},
		[doc, flow, readOnly, boxSize],
	);

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
		boxSize,
		user,
		stickyColor,
		previewPositions,
		toasts,
		canvas,
		toggleShortcuts: () => setSheetOpen((open) => !open),
		onNavigate: follow.stop,
		readOnly,
		onAction: (id) => actionRequests.request(id),
	});

	const onNodesChange: OnNodesChange<ShapeNode> = useCallback(
		(incoming) => {
			const changes = snapping.snapChanges(incoming);
			const selection = changes.filter((change) => change.type === "select");
			if (selection.length > 0) {
				// Read it now: the update below can run after the marquee has ended.
				const base = marqueeBase.current;
				for (const change of selection) {
					// React Flow's marquee replaces the selection, so it marks the
					// shapes a Shift-marquee keeps as unselected in its own copies
					// before telling us. It only re-reads a shape given to it as a new
					// object, so make sure it is, or React Flow goes on treating it as
					// unselected: no highlight, and left behind when the selection is
					// dragged.
					if (!change.selected && base?.has(change.id)) merged.current.delete(change.id);
				}
				setSelected((current) => {
					const next = new Set(current);
					for (const change of selection) {
						if (change.selected) next.add(change.id);
						else next.delete(change.id);
					}
					for (const id of base ?? []) next.add(id);
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
			if (readOnly) return;
			presence.onPositionChanges(changes);
			commands.onRemove(changes.flatMap((change) => (change.type === "remove" ? [change.id] : [])));
			// Cards dropped on a list don't move: they ask to match it (#39).
			const dropped = matching.track(changes);
			applyNodeChanges(
				doc,
				dropped
					? changes.filter((change) => change.type !== "position" || !dropped.has(change.id))
					: changes,
				presence.lastDragPosition,
				boxSize,
			);
		},
		[doc, presence, snapping, commands, boxSize, readOnly, matching],
	);

	const sectionUI = useMemo(
		() => ({
			dropTargets: structure.dropTargets,
			selectionSize: selected.size,
			setResize: structure.setResize,
			snapResize: snapping.snapResize,
			sizeOf: boxSize,
		}),
		[structure.dropTargets, selected.size, structure.setResize, snapping.snapResize, boxSize],
	);

	const centre = useCallback(
		() =>
			flow.screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 60 }),
		[flow],
	);

	// Where the pointer is in flow space, only tracked while placing a sticky.
	const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

	// Comments (#51) and "since you were here" (#46).
	const comments = useCommentsOnBoard({
		user,
		nodes,
		sizeOf: boxSize,
		toasts,
		onPanel: () => setRulesOpen(false),
		board: name,
	});

	// Tool shortcuts, ignored while typing.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (isOffBoardTarget(event.target)) return;
			if (event.key === "Escape") setTool("select");
			const next = TOOL_KEYS[event.key.toLowerCase()];
			// View only: just the select and hand tools, and comments, no sections (F) or connectors (X).
			if (next && readOnly && !VIEW_TOOLS.has(next)) return;
			if (next) {
				event.preventDefault();
				setTool(next);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [readOnly]);

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
		if (readOnly) return;
		const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		if (tool === "sticky") {
			placeSticky(at, stickyColor);
		} else if (tool === "text") {
			const id = addText(doc, at);
			focusWhenMounted(id);
			setSelected(new Set([id]));
		} else if (tool === "decision") {
			const id = addDecisionAt(doc, at, { name: user.name, color: user.color });
			focusWhenMounted(id);
			setSelected(new Set([id]));
		} else if (tool === "widget") {
			addWidgetAt("list", undefined, at);
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
		const types = event.dataTransfer.types;
		if (types.includes(STICKY_DRAG_TYPE) || types.includes(WIDGET_DRAG_TYPE)) {
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		}
	};
	const onDrop = (event: DragEvent) => {
		const widget = event.dataTransfer.getData(WIDGET_DRAG_TYPE);
		if (widget && !readOnly) {
			event.preventDefault();
			try {
				const { kind, config } = JSON.parse(widget) as {
					kind: string;
					config?: Record<string, unknown>;
				};
				addWidgetAt(
					kind,
					config,
					flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
				);
			} catch {
				// Not something we made.
			}
			return;
		}
		const color = event.dataTransfer.getData(STICKY_DRAG_TYPE) as StickyColor;
		if (!color || readOnly) return;
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
	// Hand: drag to pan, and shapes can't be picked up. Section and connector:
	// drag to draw, so shapes can't be picked up either.
	// Comment: click anything to comment on it, so nothing can be picked up either.
	const shapesInteractive =
		tool !== "hand" &&
		tool !== "section" &&
		tool !== "connector" &&
		tool !== "stamp" &&
		tool !== "vote" &&
		tool !== "comment";
	return (
		<ChangesContext value={changesUI}>
			<BoardContext
				doc={doc}
				history={history}
				sections={sectionUI}
				readOnly={readOnly}
				decisions={decisionBoard}
				widgets={widgetBoard}
			>
				<ServicesContext value={writeServices}>
					<div className="app" data-read-only={readOnly || undefined}>
						<header className="topbar">
							<a className="brand" href="/" aria-label="Tack: all boards">
								<BrandMark />
								tack
							</a>
							{title ?? <span className="board-name">{name}</span>}
							<People
								user={user}
								selfId={awareness.clientID}
								people={presence.people}
								following={follow.following}
								onFollow={follow.follow}
								self={account}
							/>
							<SinceButton doc={doc} login={user.login} youId={comments.youId} />
							<RulesButton
								doc={doc}
								open={rulesOpen}
								onToggle={() => {
									setRulesOpen((open) => !open);
									comments.closePanel();
								}}
								toasts={toasts}
								onReveal={reveal}
							/>
							<FacilitateMenu doc={doc} awareness={awareness} user={user} readOnly={readOnly} />
							<CommentsButton />
							<ThemeToggle />
							<span className="status" data-synced={synced}>
								{synced ? "Synced" : "Connecting…"}
							</span>
							<ChangesButton />
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
								nodeTypes={NODE_TYPES}
								onNodesChange={onNodesChange}
								onPaneClick={onPaneClick}
								onMoveStart={follow.onMoveStart}
								proOptions={{ hideAttribution: true }}
								onlyRenderVisibleElements
								selectionOnDrag={tool === "select"}
								panOnDrag={tool === "hand" ? true : [1, 2]}
								panOnScroll
								nodesDraggable={!readOnly && shapesInteractive}
								elementsSelectable={shapesInteractive}
								minZoom={0.1}
								// Deleting is a board command (see commands.ts), so that shapes
								// and connectors go together, as one undo step.
								deleteKeyCode={null}
								selectionMode={SelectionMode.Partial}
								selectionKeyCode={null}
								multiSelectionKeyCode={["Shift", "Meta", "Control"]}
								onSelectionStart={(event) => {
									// React Flow has just deselected every shape, before calling
									// this. A plain marquee replaces the whole selection,
									// connectors too; with Shift, it adds to what was selected.
									const base = event.shiftKey ? new Set(selected) : null;
									marqueeBase.current = base;
									setSelected(new Set(base));
								}}
								onSelectionEnd={() => {
									marqueeBase.current = null;
								}}
								onNodeMouseEnter={(_event, node) => {
									// Light up this item's rows in any list (#38).
									if (node.type === "card" && node.data.shape.ref) {
										linkStore.set(node.data.shape.ref, "card");
									}
								}}
								onNodeMouseLeave={(_event, node) => {
									if (node.type === "card") linkStore.set(null, "card");
								}}
								onNodeClick={(event, node) => {
									// Stamping and dot voting: a click puts yours on the shape.
									if (!readOnly && tool === "stamp" && node.type !== "connector") {
										stampShape(doc, node.id, stamp, user);
										return;
									}
									if (!readOnly && tool === "vote") {
										const shapes = new Map(nodes.map((n) => [n.id, n.data.shape] as const));
										const result = dotShape(
											doc,
											readVotes(doc),
											shapes,
											node.id,
											user,
											event.altKey,
										);
										if (result === "none_left") {
											toasts.show({ message: "No dots left: click one of yours to move it" });
										} else if (result === "no_vote") {
											toasts.show({ message: "That’s not part of a vote" });
										}
										return;
									}
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
								<BoardMinimap pannable zoomable nodeClassName={minimapClass} />
								<ZoomVariable />
								<ConnectorLayer
									doc={doc}
									awareness={awareness}
									nodes={nodes}
									sectionDrags={structure.sectionDrags}
									drawing={!readOnly && tool === "connector"}
									interactive={!readOnly && tool !== "hand"}
									onDrawn={() => setTool("select")}
									selected={selected}
									setSelected={setSelected}
									sizeOf={boxSize}
									connectorActions={
										readOnly
											? undefined
											: (id) => (
													<BlockedByAction
														key={id}
														doc={doc}
														connector={id}
														user={user}
														toasts={toasts}
														history={history}
														requests={actionRequests}
													/>
												)
									}
								/>
								{!readOnly && tool === "section" && (
									<SectionTool
										doc={doc}
										sizeOf={boxSize}
										onCreate={(id) => {
											setSelected(new Set([id]));
											setTool("select");
										}}
									/>
								)}
								<InboxLayer
									doc={doc}
									nodes={nodes}
									readOnly={readOnly}
									user={user}
									toasts={toasts}
									sizeOf={boxSize}
									onPlaced={(id) => setSelected(new Set([id]))}
								/>
								<HighlightLayer doc={doc} nodes={nodes} sizeOf={boxSize} />
								<CommentLayer
									nodes={nodes}
									sizeOf={boxSize}
									placing={tool === "comment"}
									user={user}
									toasts={toasts}
								/>
								<Guides store={snapping.guides} />
								{!readOnly && (
									<SelectionTools
										nodes={nodes}
										selected={selected}
										sizeOf={sizeOf}
										dragging={snapping.dragging}
										stacked={styledShapes(selectedNodes).length > 0}
										onCommand={commands.run}
									/>
								)}
								<MarksLayer
									doc={doc}
									nodes={nodes}
									sizeOf={boxSize}
									me={user}
									readOnly={readOnly}
									voting={!readOnly && tool === "vote"}
								/>
								<Cursors people={presence.people} />
								<Emotes awareness={awareness} user={user} people={presence.people} />
								<ViewPublisher awareness={awareness} />
								{!readOnly && (
									<ShapeToolbar
										doc={doc}
										selected={selectedNodes}
										dragging={snapping.dragging}
										onStickyColor={setStickyColor}
									/>
								)}
								{!readOnly && (
									<ActionBar
										doc={doc}
										selected={selectedNodes}
										nodes={nodes}
										dragging={snapping.dragging}
										user={user}
										toasts={toasts}
										history={history}
										requests={actionRequests}
										sizeOf={sizeOf}
									/>
								)}
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
							<EmptyBoard empty={!readOnly && synced && shapeNodes.length === 0} onTool={setTool} />
							{spotlight.along ? null : (
								<FollowIndicator person={follow.target} onStop={follow.stop} />
							)}
							<SpotlightIndicator
								state={spotlight}
								withYou={
									presence.people.filter((person) => person.following === awareness.clientID).length
								}
								onBreakOut={follow.stop}
							/>
							<div className="facilitation-dock">
								<TimerPill doc={doc} user={user} readOnly={readOnly} />
								<VoteBars
									doc={doc}
									user={user}
									readOnly={readOnly}
									voting={tool === "vote"}
									onVoting={setVoting}
									toasts={toasts}
								/>
							</div>
							{!readOnly && <StartVoteDialog doc={doc} user={user} now={facilitation.serverNow} />}
							{voteState.tally && (
								<TallyPanel
									doc={doc}
									voteId={voteState.tally}
									user={user}
									readOnly={readOnly}
									onClose={() => voteUI.showTally(null)}
									onReveal={reveal}
								/>
							)}
							<CursorChat awareness={awareness} user={user} />
							{(!readOnly || comments.canComment) && (
								<Toolbar
									tool={tool}
									onTool={setTool}
									stickyColor={stickyColor}
									onStickyColor={setStickyColor}
									onAddCard={onAddCard}
									onAddWidget={addWidgetAt}
									suggestedRepo={suggestedRepo}
									stamp={stamp}
									onStamp={setStamp}
									viewOnly={readOnly}
									commenting={comments.canComment}
								/>
							)}
							<SincePanel
								doc={doc}
								login={user.login}
								youId={comments.youId}
								onJump={comments.jumpToShape}
								onOpenThread={comments.jumpToThread}
							/>
							<CommentsPanel doc={doc} login={user.login} onJump={comments.jumpToThread} />
							{rulesOpen && (
								<RulesPanel
									doc={doc}
									user={{ name: user.name, color: user.color }}
									readOnly={readOnly}
									onClose={() => setRulesOpen(false)}
									onReveal={reveal}
									onUndo={() => history.undo()}
									toasts={toasts}
								/>
							)}
							<RowGhost />
							<Toasts store={toasts} />
							<ShortcutSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
							<ChangesPanel />
							<PushSheet />
							{children}
						</main>
					</div>
				</ServicesContext>
			</BoardContext>
		</ChangesContext>
	);
}

/** Minimap shapes take their own colour: stickies show as their paper. */
function minimapClass(node: ShapeNode): string {
	const { type, color } = node.data.shape;
	if (type === "sticky") return `minimap-sticky minimap-${color ?? "yellow"}`;
	if (type === "section") return `minimap-section minimap-section-${color ?? "grey"}`;
	if (type === "decision")
		return `minimap-decision minimap-decision-${node.data.shape.status ?? "proposed"}`;
	if (type === "widget") return "minimap-widget";
	return `minimap-${type}`;
}
