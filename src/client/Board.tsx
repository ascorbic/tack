import {
	Background,
	BackgroundVariant,
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
import { STAMPS, type StampEmoji } from "../shared/facilitation.ts";
import { type CardRun, addCardsInRun, cardsOnBoard, searchScopeOf } from "../shared/addCards.ts";
import { intersects } from "../shared/geometry.ts";
import { parseKey } from "../shared/refs.ts";
import { boxOf } from "../shared/sections.ts";
import {
	type DisplayKind,
	type Position,
	STICKY_SIZE,
	type ShapeNode,
	type StickyColor,
	addActionItemAt,
	addDecisionAt,
	addSticky,
	addText,
	applyNodeChanges,
	SECTION_Z,
	focusWhenMounted,
	useShapeNodes,
} from "./board.ts";
import { ActionBar } from "./actions/ActionBar.tsx";
import { BlockedByAction } from "./actions/BlockedBy.tsx";
import { ActionRequests } from "./actions/selection.ts";
import { ServicesContext, type WriteServices, liveServices } from "./actions/services.ts";
import type { BoardSource } from "./connection.ts";
import type { PushClient } from "./changes/api.ts";
import { ChangesButton } from "./changes/ChangesButton.tsx";
import { ChangesPanel } from "./changes/ChangesPanel.tsx";
import { ChangesContext } from "./changes/context.ts";
import { PushSheet } from "./changes/PushSheet.tsx";
import { withStagedMarks } from "./changes/StagedMarks.tsx";
import { useChangesState } from "./changes/useChanges.ts";
import { useCanvasStructure, useSizeOf } from "./canvasStructure.ts";
import { DisplayMarksContext, withDisplay } from "./display/DisplayItem.tsx";
import { planDisplayDrop } from "./display/drop.ts";
import { listKey } from "./display/keys.ts";
import { moveInList } from "../shared/display.ts";
import { DisplayPreview, previewStore } from "./display/Preview.tsx";
import { useDisplay } from "./display/useDisplay.ts";
import { useServerNow, useStampCounts, useVotes } from "./facilitation/hooks.ts";
import { isOpen } from "../shared/dotvotes.ts";
import { useCanvasCommands } from "./commands.ts";
import { ConnectorLayer } from "./connectors.tsx";
import { CursorChat } from "./CursorChat.tsx";
import { Cursors } from "./Cursors.tsx";
import { EmptyBoard } from "./EmptyBoard.tsx";
import { useCalls } from "./facilitation/Call.tsx";
import { Emotes } from "./facilitation/Emotes.tsx";
import { FacilitateMenu, facilitationKey } from "./facilitation/FacilitateMenu.tsx";
import { MarksLayer, dotShape, stampShape } from "./facilitation/Marks.tsx";
import {
	type PickKind,
	SectionPickerHint,
	sectionAt,
	sectionPicker,
	useSectionPicker,
} from "./facilitation/SectionPicker.tsx";
import { startSilent, useSilentToasts } from "./facilitation/Silent.tsx";
import { SpotlightIndicator, useSpotlightFollow } from "./facilitation/Spotlight.tsx";
import { facilitation } from "./facilitation/store.ts";
import { TimerPill, useTimerToasts } from "./facilitation/Timer.tsx";
import { StartVoteDialog, TallyPanel, VoteBars, useVoteUI, voteUI } from "./facilitation/Votes.tsx";
import { FollowIndicator, ViewPublisher, useFollow } from "./Follow.tsx";
import { HistoryButton } from "./history/HistoryButton.tsx";
import { HistoryCanvas } from "./history/HistoryCanvas.tsx";
import { HistoryDock } from "./history/HistoryDock.tsx";
import { HistoryPanel } from "./history/HistoryPanel.tsx";
import type { HistorySource } from "./history/source.ts";
import { useHistoryKeys, useRestored } from "./history/useBoardHistory.ts";
import { useHistoryMode } from "./history/useHistory.ts";
import { Guides, useSnapping } from "./Guides.tsx";
import { BoardContext } from "./DocContext.ts";
import { fitBoxes, saveViewport, savedViewport, shapeBoxes } from "./fitting.ts";
import { isOffBoardTarget } from "./keys.ts";
import { Announcer } from "./announce.tsx";
import { BoardSummary, SkipToBoard, useAnnounceRemoteChanges } from "./BoardSummary.tsx";
import { useShapeNavigation } from "./navigation.ts";
import { withShapeLabel } from "./ShapeLabel.tsx";
import { BoardMinimap, useMinimapPreference } from "./Minimap.tsx";
import { nodeTypes } from "./nodes.tsx";
import { ZoomControls } from "./ZoomControls.tsx";
import { ExportDialog } from "./export/ExportDialog.tsx";
import { useBoardExport } from "./export/useBoardExport.ts";
import { PanelBoundary, withBoundary } from "./ShapeBoundary.tsx";
import { People } from "./People.tsx";
import { type User, authorFor, useBoardColor, usePresence } from "./presence.ts";
import { SectionTool, ZoomVariable, sectionNodeTypes } from "./sections.tsx";
import { SelectionTools } from "./SelectionTools.tsx";
import { ShapeToolbar, styledShapes } from "./ShapeToolbar.tsx";
import { ShortcutSheet } from "./Shortcuts.tsx";
import { Toasts, ToastStore } from "./Toasts.tsx";
import type { AddOutcome } from "./cardInput.ts";
import { SyncStatus, TopBar } from "./TopBar.tsx";
import { useExclusivePanels } from "./panels.ts";
import { STICKY_DRAG_TYPE, TOOL_KEYS, type Tool, Toolbar, VIEW_TOOLS } from "./Toolbar.tsx";
import { History } from "./undo.ts";
import { usePublishStatus } from "./useActivity.ts";
import { InboxLayer } from "./inbox/InboxTray.tsx";
import { scaledDuration } from "./motion.ts";
import { RulesButton, RulesPanel } from "./rules/RulesPanel.tsx";
import { boardRepos } from "../shared/actions.ts";
import { addShape, readShape, shapesMap, transactLocal } from "../shared/shapes.ts";
import type * as Y from "yjs";
import { isEditingShape } from "./useEditing.ts";
import { spotNear } from "../shared/placement.ts";
import { addSection, placeInSections, readShapes } from "../shared/structure.ts";
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
import { useCommentUI } from "./comments/store.ts";
import { HighlightLayer } from "./since/Highlights.tsx";
import { SinceButton, SincePanel } from "./since/SincePanel.tsx";
import { sinceStore, useSince } from "./since/store.ts";

// Every shape shows the changes staged about it, and shapes in a section
// showing a list or mini cards draw as rows or mini cards (#72). Each is named
// for screen readers (#61).
const NODE_TYPES = Object.fromEntries([
	...Object.entries(nodeTypes).map(([type, node]) => [
		type,
		withBoundary(withShapeLabel(withStagedMarks(withDisplay(node)))),
	]),
	...Object.entries(sectionNodeTypes).map(([type, node]) => [
		type,
		withBoundary(withShapeLabel(withStagedMarks(node))),
	]),
]);

/**
 * Groups in a list sit above any section lifted by being selected (React
 * Flow adds 1000), and rows above any group lifted the same way.
 */
const LIST_GROUP_Z = SECTION_Z + 1000;
const LIST_ROW_Z = 50;

/**
 * What screen readers hear about shapes, besides each one's name: how to
 * get around (#61, navigation.ts). React Flow says it after a shape's name.
 */
const SHAPE_HELP =
	"Arrow keys or Tab move between shapes. Enter selects; then Enter edits, the arrow keys move it, and Tab reaches its actions. O opens a card’s issue or pull request.";
const ARIA_LABELS = {
	"node.a11yDescription.default": SHAPE_HELP,
	"node.a11yDescription.keyboardDisabled": SHAPE_HELP,
	"node.a11yDescription.ariaLiveMessage": ({ direction }: { direction: string }) =>
		`Moved ${direction}`,
	"minimap.ariaLabel": "Minimap",
	"controls.ariaLabel": "Zoom",
};

/** The id of the board's summary, its region's description. */
const SUMMARY_ID = "board-summary";

/** How often pressing an edit tool's key on a view-only board says why nothing happened. */
const VIEW_ONLY_TOAST_MS = 4000;

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
	/** Why it's view only, said when someone presses a tool's key that would change it. */
	readOnlyReason?: string;
	user: User;
	/**
	 * Your avatar in the top bar, e.g. an account menu, given the label the
	 * plain avatar would have and you as you appear here (in your colour on
	 * this board). Defaults to a plain avatar.
	 */
	account?: (label: string, user: User) => ReactNode;
	/** Beside your avatar, as on the home page: the notifications bell. */
	inbox?: ReactNode;
	/** Extra controls at the end of the top bar, e.g. Share. */
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
	/**
	 * Where the board's history comes from (#47): the Worker's history routes,
	 * or the playground's. Without it there's no History button.
	 */
	historySource?: HistorySource | null;
	/** Show everything on the board once it's loaded, as a board just made from a template does. */
	fitOnLoad?: boolean;
	/**
	 * Remember where you leave the board, in this browser, under this key, and
	 * open there next time (as long as something's still there to see).
	 */
	rememberView?: string;
}

export function Board({
	name,
	title,
	readOnly: viewOnly = false,
	readOnlyReason = "You can view this board, but not edit it. Ask its owner if you need to.",
	doc: liveDoc,
	awareness,
	synced,
	waiting = 0,
	user: person,
	account,
	inbox,
	actions,
	children,
	services,
	push = null,
	historySource = null,
	fitOnLoad = false,
	rememberView,
}: BoardProps) {
	// History (#47): while it's open the canvas shows the board as it was, view only.
	const replay = useHistoryMode(liveDoc, historySource);
	const doc = replay.view ?? liveDoc;
	const readOnly = viewOnly || replay.state.open;
	const shapeNodes = useShapeNodes(doc);
	const flow = useReactFlow();
	// Your colour here: one nobody else present has, while there's one free.
	const user = useBoardColor(awareness, person, name);
	const presence = usePresence(awareness, user);
	const follow = useFollow(awareness, presence.people);
	// Opening a board: where you left it, if you've been here and there's
	// still something to see there; otherwise (with `fitOnLoad`) all of it,
	// clear of the dock and minimap, once its shapes have been measured.
	const fitted = useRef(false);
	const fitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(fitTimer.current), []);
	const canvas = useRef<HTMLElement>(null);
	useEffect(() => {
		if (fitted.current || !synced) return;
		// An empty board stays where it is: the first sticky mustn't move the view.
		if (shapeNodes.length === 0) {
			fitted.current = true;
			return;
		}
		const saved = rememberView ? savedViewport(rememberView) : null;
		const bounds = canvas.current?.getBoundingClientRect();
		if (saved && bounds) {
			const view = {
				x: -saved.x / saved.zoom,
				y: -saved.y / saved.zoom,
				w: bounds.width / saved.zoom,
				h: bounds.height / saved.zoom,
			};
			const boxes = shapeBoxes(shapeNodes, (id) => measuredRef.current.get(id));
			if (boxes.some((box) => intersects(view, box))) {
				fitted.current = true;
				void flow.setViewport(saved);
				return;
			}
		}
		fitted.current = true;
		if (!fitOnLoad) return;
		// Kept past later renders: more shapes arriving mustn't cancel it.
		fitTimer.current = setTimeout(() => {
			const viewport = fitBoxes(
				canvas.current,
				shapeBoxes(shapeNodesRef.current, (id) => measuredRef.current.get(id), boxSizeRef.current),
			);
			if (viewport) void flow.setViewport(viewport, { duration: scaledDuration(700) });
		}, 120);
	}, [fitOnLoad, rememberView, synced, shapeNodes, flow]);
	// Spotlight: someone bringing everyone to their view (#50).
	const spotlight = useSpotlightFollow(awareness, presence.people, follow);
	usePublishStatus(awareness);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// Export (#59): drawing the board as an image draws all of it, at 100%, for a moment.
	const exporter = useBoardExport({ doc, canvas, selected });
	const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
		() => new Map(),
	);
	const measuredRef = useRef(measured);
	measuredRef.current = measured;
	// Free-form sizes, as boxes for structural edits (see shared/structure.ts):
	// never a row's, since a row's document position is where it'd be as a card.
	const boxSize = useSizeOf(measured);
	// For the first fit, which waits a moment for shapes to be measured.
	const boxSizeRef = useRef(boxSize);
	boxSizeRef.current = boxSize;
	const shapeNodesRef = useRef(shapeNodes);
	shapeNodesRef.current = shapeNodes;
	// Sections: contents following a dragged section, resizes in progress,
	// and where a dragged shape would land.
	const structure = useCanvasStructure({
		shapeNodes,
		drags: presence.overrides,
		measured,
		awareness,
	});
	// Sections showing lists and mini cards: where their contents draw (#72).
	const display = useDisplay({
		shapeNodes,
		drags: presence.overrides,
		overrides: structure.overrides,
		measured,
	});
	const displayRef = useRef(display);
	displayRef.current = display;
	// The size each shape is drawn at, rows and lists included, for the UI around them.
	const sizeOf = useCallback((id: string) => {
		const { slots, sections } = displayRef.current;
		const rect = slots.get(id)?.rect ?? sections.get(id)?.box;
		return rect ? { width: rect.w, height: rect.h } : measuredRef.current.get(id);
	}, []);
	/** The same, as boxes, for layers drawn over shapes where they show (comments, highlights). */
	const drawnSize = useCallback(
		(id: string) => {
			const { slots, sections } = displayRef.current;
			const rect = slots.get(id)?.rect ?? sections.get(id)?.box;
			return rect ? { w: rect.w, h: rect.h } : boxSize(id);
		},
		[boxSize],
	);

	// Undo and redo this person's own changes, never anyone else's. Always on
	// the live board, so what's restored from history can be undone.
	const history = useMemo(() => new History(liveDoc), [liveDoc]);
	useEffect(() => () => history.destroy(), [history]);
	const [toasts] = useState(() => new ToastStore());
	// Someone else deleting the sticky or text you're typing in says so, and
	// offers it back as you last had it.
	useEffect(() => {
		const map = shapesMap(liveDoc);
		const onChange = (event: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) => {
			if (transaction.local) return;
			for (const [id, change] of event.changes.keys) {
				if (change.action !== "delete" || !isEditingShape(id)) continue;
				const shape = shapeNodesRef.current.find((node) => node.id === id)?.data.shape;
				if (!shape) continue;
				const what = shape.type === "text" ? "text" : "sticky";
				toasts.show({
					message: `Someone else deleted the ${what} you were writing in`,
					action: {
						label: "Restore",
						run: () => {
							if (shapesMap(liveDoc).has(id)) return;
							const parent =
								typeof shape.parent === "string" && shapesMap(liveDoc).has(shape.parent)
									? shape.parent
									: null;
							transactLocal(liveDoc, () => addShape(liveDoc, id, { ...shape, parent }));
							setSelected(new Set([id]));
						},
					},
				});
			}
		};
		map.observe(onChange);
		return () => map.unobserve(onChange);
	}, [liveDoc, toasts]);
	// Selection actions: staging changes for the forge (src/client/actions/).
	const writeServices = useMemo(() => services ?? liveServices(name), [services, name]);
	const [actionRequests] = useState(() => new ActionRequests());
	const [sheetOpen, setSheetOpen] = useState(false);
	const [minimapOn, setMinimapOn] = useMinimapPreference();
	const undo = useCallback(() => void history.undo(), [history]);
	const focusShapes = useCallback(
		(ids: string[]) => {
			follow.stop();
			void flow.fitView({
				nodes: ids.map((id) => ({ id })),
				padding: 0.6,
				maxZoom: 1.1,
				duration: scaledDuration(420),
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
	// Shapes drawing attention to themselves for a moment (see `pulse`).
	const [pulsing, setPulsing] = useState<ReadonlySet<string>>(() => new Set());
	const pulseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const pulse = useCallback((ids: string[]) => {
		clearTimeout(pulseTimer.current);
		setPulsing(new Set());
		requestAnimationFrame(() => setPulsing(new Set(ids)));
		pulseTimer.current = setTimeout(() => setPulsing(new Set()), scaledDuration(1600));
	}, []);
	useEffect(() => () => clearTimeout(pulseTimer.current), []);

	// Cards dragged over a list, and dropped on one to match it (#39).
	const matching = useDropToMatch(shapeNodes, sizeOf);

	// Selection, measured sizes and in-progress drags are local UI state, so
	// they live outside the document. Unchanged nodes keep their identity so
	// React Flow's memoised nodes skip re-rendering.
	const merged = useRef(new Map<string, { base: ShapeNode; out: ShapeNode }>());
	const displayData = useRef(
		new Map<string, { data: ShapeNode["data"]; kind: DisplayKind; out: ShapeNode["data"] }>(),
	);
	const styleKeys = useRef(new Map<string, string>()).current;
	/** A node's data, saying how it's drawn: the same object until either changes. */
	const displayDataFor = (data: ShapeNode["data"], kind: DisplayKind): ShapeNode["data"] => {
		const cached = displayData.current.get(data.id);
		if (cached && cached.data === data && cached.kind === kind) return cached.out;
		const out = { ...data, display: kind };
		displayData.current.set(data.id, { data, kind, out });
		return out;
	};
	const nodes = useMemo(
		() =>
			shapeNodes.map((base) => {
				const isSelected = selected.has(base.id);
				let size = measured.get(base.id);
				const drag = structure.overrides.get(base.id);
				const resize = structure.resizes.get(base.id);
				let position = resize
					? { x: resize.x, y: resize.y }
					: drag
						? { x: drag.x, y: drag.y }
						: base.position;
				let width = resize?.w ?? base.width;
				let height = resize?.h ?? base.height;
				// Shapes being dragged float above everything else.
				let zIndex = structure.zIndexOf(base);
				const remoteColor = drag?.user?.color;
				let className = remoteColor
					? "remote-drag"
					: structure.followsRemote.has(base.id)
						? "remote-follow"
						: matching.returning.has(base.id)
							? "snap-back"
							: undefined;
				// "It's already here": a card someone tried to add again.
				if (pulsing.has(base.id)) className = `${className ?? ""} pulse`.trim();

				// In a list or grid: drawn in its slot, at its slot's size (#72).
				let kind: DisplayKind | undefined;
				let index: number | undefined;
				const slot = display.slots.get(base.id);
				const list = display.sections.get(base.id);
				if (slot) {
					kind = slot.kind;
					index = slot.index;
					position = { x: slot.rect.x, y: slot.rect.y };
					width = slot.rect.w;
					height = slot.rect.h;
					size = { width, height };
					// Stacked so a selected list (lifted by React Flow) stays beneath
					// its groups, and a selected group beneath its rows.
					if (zIndex === base.zIndex) {
						zIndex =
							slot.kind === "group"
								? LIST_GROUP_Z + ((base.zIndex ?? SECTION_Z) - SECTION_Z)
								: LIST_ROW_Z;
					}
					if (!slot.dragging) {
						const root = display.rootOf(base.id);
						const rootDrag = root ? presence.overrides.get(root) : undefined;
						const carried =
							root !== null && (rootDrag !== undefined || structure.overrides.has(root));
						// Rows glide to new places, except while their list is carried along.
						className = carried
							? rootDrag?.user || structure.followsRemote.has(root)
								? "remote-follow display-node"
								: "display-node display-still"
							: `${className ?? ""} display-node`.trim();
					}
				} else if (list) {
					kind = list.mode === "mini" ? "grid" : "list";
					width = list.box.w;
					height = list.box.h;
					className = `${className ?? ""} display-section`.trim();
				}
				if (list && slot) kind = "group";
				const morph = display.morphing.get(base.id);
				if (morph !== undefined) className = `${className ?? ""} display-morph`.trim();
				const data = kind ? displayDataFor(base.data, kind) : base.data;
				const style =
					remoteColor || morph !== undefined || index !== undefined
						? ({
								...(remoteColor && { "--drag-color": remoteColor }),
								...(morph !== undefined && { "--morph-i": Math.min(morph, 16) }),
								...(index !== undefined && { "--display-i": Math.min(index, 24) }),
							} as React.CSSProperties)
						: undefined;
				const styleKey = `${remoteColor ?? ""}|${morph ?? ""}|${index ?? ""}`;

				const cached = merged.current.get(base.id)?.out;
				if (
					cached &&
					merged.current.get(base.id)?.base === base &&
					cached.data === data &&
					cached.selected === isSelected &&
					cached.measured?.width === size?.width &&
					cached.measured?.height === size?.height &&
					cached.position.x === position.x &&
					cached.position.y === position.y &&
					cached.width === width &&
					cached.height === height &&
					cached.zIndex === zIndex &&
					cached.className === className &&
					styleKeys.get(base.id) === styleKey
				) {
					return cached;
				}
				const out: ShapeNode = {
					...base,
					data,
					selected: isSelected,
					measured: size,
					position,
					width,
					height,
					className,
					zIndex,
					style,
				};
				merged.current.set(base.id, { base, out });
				styleKeys.set(base.id, styleKey);
				return out;
			}),
		[
			shapeNodes,
			selected,
			measured,
			structure,
			matching.returning,
			display,
			presence.overrides,
			pulsing,
		],
	);

	// A dragged section's contents move with it, so they're never snapped to.
	const snapping = useSnapping(nodes, sizeOf, structure.contentsOf, (id) =>
		displayRef.current.slots.has(id),
	);

	// Who's voting on decisions, and the board a written-back record links to.
	const decisionBoard = useMemo(
		() => ({ user, boardUrl: `${location.origin}${location.pathname}` }),
		[user],
	);

	const [tool, setTool] = useState<Tool>("select");
	const [stickyColor, setStickyColor] = useState<StickyColor>("yellow");
	const [stamp, setStamp] = useState<StampEmoji>("👍");
	const voteState = useVoteUI();
	// Stamps and dots, counted inline on rows and mini cards (#72).
	const stampCounts = useStampCounts(doc, user);
	const allVotes = useVotes(doc);
	const voteNow = useServerNow(30_000, allVotes.length > 0);
	const displayMarks = useMemo(
		() => ({
			doc,
			me: user,
			stamps: stampCounts,
			votes: allVotes.filter((vote) => isOpen(vote, voteNow)),
			shapes: display.shapes,
			now: voteNow,
		}),
		[doc, user, stampCounts, allVotes, voteNow, display.shapes],
	);
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
	// Silent mode and the timer, as they change: with a way to the section.
	useSilentToasts(liveDoc, toasts, reveal);
	useTimerToasts(toasts);
	useCalls({ awareness, people: presence.people, toasts, onGo: follow.jump });

	// Restoring from history: back to the live board, with what came back selected.
	useRestored(replay.controller, {
		toasts,
		undo,
		select: (ids) => setSelected(new Set(ids)),
		reveal: (ids) => {
			follow.stop();
			void flow.fitView({
				nodes: ids.map((id) => ({ id })),
				padding: 0.8,
				// Never closer than you were: just enough to bring it into view.
				maxZoom: flow.getZoom(),
				duration: scaledDuration(520),
			});
		},
	});
	const toggleHistory = useCallback(() => {
		const controller = replay.controller;
		if (!controller) return;
		if (controller.getSnapshot().open) return controller.close();
		setRulesOpen(false);
		// Opened with a section selected on its own: that section's history.
		const [only] = selected.size === 1 ? [...selected] : [];
		const section = only && nodes.find((node) => node.id === only)?.type === "section";
		void controller.open({ section: section ? only : null });
	}, [replay.controller, selected, nodes]);
	useHistoryKeys(replay.controller, replay.state.open, toggleHistory);
	/** Bring part of the board into view, unless it's already there (clear of the panel). */
	const focusArea = useCallback(
		(area: { x: number; y: number; w: number; h: number }) => {
			const bounds = canvas.current?.getBoundingClientRect();
			if (!bounds) return;
			const { x, y, zoom } = flow.getViewport();
			const panel = Math.min(384, bounds.width / 2);
			const width = bounds.width - panel;
			const visible = { x: -x / zoom, y: -y / zoom, w: width / zoom, h: bounds.height / zoom };
			const inside =
				area.x >= visible.x &&
				area.y >= visible.y &&
				area.x + area.w <= visible.x + visible.w &&
				area.y + area.h <= visible.y + visible.h - 140 / zoom;
			if (inside) return;
			follow.stop();
			const fit = Math.min(
				zoom,
				(width * 0.75) / Math.max(1, area.w),
				((bounds.height - 160) * 0.75) / Math.max(1, area.h),
			);
			const next = Math.max(0.2, fit);
			void flow.setCenter(area.x + area.w / 2 + panel / 2 / next, area.y + area.h / 2 + 50 / next, {
				zoom: next,
				duration: scaledDuration(520),
			});
		},
		[flow, follow.stop],
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

	/**
	 * Add a widget centred on `at` (where it was dropped or clicked), or in the
	 * free space nearest the middle of the view (from the picker, so it never
	 * lands on top of what's there), selected, with its panel open if it needs
	 * setting up.
	 */
	const addWidgetAt = useCallback(
		(kind: string, config?: Record<string, unknown>, at?: { x: number; y: number }) => {
			const definition = widgetDefinition(kind);
			if (!definition || readOnly) return;
			const busiestHost = boardRepos(doc)[0]?.repo.split("/")[0];
			const centreAt =
				at ?? flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
			const ideal = {
				x: centreAt.x - definition.size.w / 2,
				y: centreAt.y - definition.size.h / 2,
			};
			const spot = at
				? ideal
				: (spotNear(readShapes(doc), ideal, definition.size, boxSize) ?? ideal);
			const create = () => {
				const id = transactLocal(doc, () => {
					const id = addWidget(doc, kind, spot, {
						...(definition.defaults as object),
						// Lists search the forge the board's cards are mostly on.
						...(kind === "list" && busiestHost ? { host: busiestHost } : {}),
						...config,
					});
					placeInSections(doc, [id], boxSize);
					return id;
				});
				if (!config?.q) focusWhenMounted(id);
				setSelected(new Set([id]));
			};
			setTool("select");
			// The nearest free space may be off screen on a full board: glide
			// there, then add it, so it arrives where you can see it.
			const corner = flow.flowToScreenPosition(spot);
			const far = flow.flowToScreenPosition({
				x: spot.x + definition.size.w,
				y: spot.y + definition.size.h,
			});
			const canvas = document.querySelector(".react-flow")?.getBoundingClientRect();
			const visible =
				!canvas ||
				(corner.x >= canvas.left &&
					corner.y >= canvas.top &&
					far.x <= canvas.right &&
					far.y <= canvas.bottom);
			if (visible) create();
			else
				void flow
					.setCenter(spot.x + definition.size.w / 2, spot.y + definition.size.h / 2, {
						zoom: flow.getZoom(),
						duration: scaledDuration(420),
					})
					.then(create);
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
	// Pasted links add cards as the card tool does (defined below, with what it needs).
	const addCardsRef = useRef<(keys: string[], options: { at: Position }) => AddOutcome>(() => ({
		added: [],
		existing: [],
	}));
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
		onListKey: (id) => {
			const key = listKey(displayRef.current, selected, id);
			if (!key) return false;
			if (key.kind === "select") {
				setSelected(new Set([key.id]));
				// Focus follows, if it was on a shape, so the keys stay the selection's.
				const active = document.activeElement;
				if (active?.classList.contains("react-flow__node")) {
					requestAnimationFrame(() =>
						document
							.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(key.id)}"]`)
							?.focus({ preventScroll: true }),
					);
				}
			} else if (key.kind === "move" && !readOnly) {
				const unsorted = transactLocal(doc, () =>
					moveInList(doc, key.section, key.ids, key.index, displayRef.current.cardOf),
				);
				if (unsorted) toasts.show({ message: "Back to ordering by hand" });
			}
			return true;
		},
		inList: (id) => displayRef.current.slots.has(id),
		drawnAt: (id) => displayRef.current.slots.get(id)?.rect,
		addCards: (keys, options) => addCardsRef.current(keys, options),
	});
	// Getting around with the keyboard, and other people's changes said
	// aloud, for screen readers (#61).
	useShapeNavigation({
		nodes,
		selected,
		setSelected,
		sizeOf,
		canvas,
		onNavigate: follow.stop,
	});
	useAnnounceRemoteChanges(liveDoc, synced);

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
			// Rows and lists are drawn at their slot's size: what's measured is
			// each shape's free-form size, for when it's a card again.
			const { slots, sections } = displayRef.current;
			const sizes = changes.filter(
				(change) =>
					change.type === "dimensions" &&
					change.dimensions &&
					!slots.has(change.id) &&
					!sections.has(change.id),
			);
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
			const kept = dropped
				? changes.filter((change) => change.type !== "position" || !dropped.has(change.id))
				: changes;
			// Rows dropped in their list reorder it, and anything dropped on a
			// list joins it where the gap was (#72): one undo step with the move.
			const drop = planDisplayDrop(
				doc,
				displayRef.current,
				kept,
				presence.lastDragPosition,
				boxSize,
			);
			const after = drop.after;
			if (after) {
				const unsorted = transactLocal(doc, () => {
					applyNodeChanges(doc, drop.changes, presence.lastDragPosition, boxSize);
					return after();
				});
				if (unsorted) toasts.show({ message: "Back to ordering by hand" });
			} else {
				applyNodeChanges(doc, drop.changes, presence.lastDragPosition, boxSize);
			}
		},
		[doc, presence, snapping, commands, boxSize, readOnly, matching],
	);

	// Where a dragged shape would land: a list by what it draws, not its
	// free-form box (#72), and not the list a row's only moving within.
	const dropKey = useMemo(() => {
		if (!display.active) return null;
		const out = new Set([...structure.dropTargets].filter((id) => !display.sections.has(id)));
		const hover = display.hover;
		if (hover && hover.ids.some((id) => display.structure.parentOf.get(id) !== hover.section)) {
			out.add(hover.section);
		}
		return [...out].sort().join(" ");
	}, [structure.dropTargets, display]);
	const dropTargets = useMemo(
		() => (dropKey === null ? structure.dropTargets : new Set(dropKey ? dropKey.split(" ") : [])),
		[dropKey, structure.dropTargets],
	);

	const sectionUI = useMemo(
		() => ({
			dropTargets,
			selectionSize: selected.size,
			setResize: structure.setResize,
			snapResize: snapping.snapResize,
			sizeOf: boxSize,
		}),
		[dropTargets, selected.size, structure.setResize, snapping.snapResize, boxSize],
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
		sizeOf: drawnSize,
		toasts,
		onPanel: () => setRulesOpen(false),
		board: name,
	});
	// History has the right of the canvas to itself while it's open.
	const closeComments = comments.closePanel;
	useEffect(() => {
		if (replay.state.open) closeComments();
	}, [replay.state.open, closeComments]);

	// The panels on the right are one group: one open at a time, and Escape
	// from the top bar closes it.
	const sincePanel = useSince().panel;
	const commentsPanel = useCommentUI().panel;
	useExclusivePanels([
		{ id: "since", open: sincePanel, close: () => sinceStore.setPanel(false) },
		{
			id: "history",
			open: replay.state.open,
			close: () => replay.controller?.close(),
		},
		{ id: "rules", open: rulesOpen, close: () => setRulesOpen(false) },
		{ id: "comments", open: commentsPanel, close: closeComments },
		{ id: "changes", open: changesUI.panelOpen, close: () => changesUI.setPanelOpen(false) },
	]);

	// Tool shortcuts, ignored while typing.
	const viewOnlyToldAt = useRef(0);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (isOffBoardTarget(event.target)) return;
			// ⇧F, ⇧T and ⇧S are the Facilitate menu's.
			if (facilitationKey(event)) return;
			if (event.key === "Escape") setTool("select");
			const next = TOOL_KEYS[event.key.toLowerCase()];
			// View only: just the select and hand tools, and comments, no sections (F) or connectors (X).
			// Say why nothing happened, rather than nothing, at most every few seconds.
			if (next && readOnly && !VIEW_TOOLS.has(next)) {
				if (!event.repeat && Date.now() - viewOnlyToldAt.current > VIEW_ONLY_TOAST_MS) {
					viewOnlyToldAt.current = Date.now();
					toasts.show({ message: readOnlyReason });
				}
				return;
			}
			if (next) {
				event.preventDefault();
				setTool(next);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [readOnly, readOnlyReason, toasts]);

	useEffect(() => {
		if (tool !== "sticky") setGhost(null);
	}, [tool]);

	// A word about the last click with a tool, in place of its hint for a moment.
	const [toolNote, setToolNote] = useState<{ text: string; key: number } | null>(null);
	const showToolNote = useCallback(
		(text: string) => setToolNote((note) => ({ text, key: (note?.key ?? 0) + 1 })),
		[],
	);
	useEffect(() => {
		if (!toolNote) return;
		const timer = setTimeout(() => setToolNote(null), 3200);
		return () => clearTimeout(timer);
	}, [toolNote]);
	useEffect(() => setToolNote(null), [tool]);

	// With the stamp tool on, 1–8 pick a stamp, as they pick an emote.
	useEffect(() => {
		if (tool !== "stamp") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			if (isOffBoardTarget(event.target)) return;
			const emoji = /^[1-8]$/.test(event.key) ? STAMPS[Number(event.key) - 1] : undefined;
			if (!emoji) return;
			event.preventDefault();
			setStamp(emoji);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [tool]);

	const placeSticky = useCallback(
		(at: { x: number; y: number }, color: StickyColor) => {
			const id = addSticky(doc, at, { color, author: authorFor(user) });
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
			const id = addDecisionAt(doc, at, authorFor(user));
			focusWhenMounted(id);
			setSelected(new Set([id]));
		} else if (tool === "action") {
			const id = addActionItemAt(doc, at, authorFor(user));
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
	const selectedSection =
		selectedNodes.length === 1 && selectedNodes[0]?.type === "section" ? selectedNodes[0].id : null;

	// Starting silent mode or a vote on a section from the Facilitate menu:
	// click one (or anything in one), or make one in view.
	const picking = useSectionPicker();
	useEffect(() => {
		if (readOnly) sectionPicker.cancel();
	}, [readOnly]);
	const pickSection = useCallback(
		(kind: PickKind, section: string) => {
			sectionPicker.cancel();
			setSelected(new Set([section]));
			if (kind === "silent") startSilent(section, user);
			else voteUI.start(section);
		},
		[user],
	);
	const makeSectionToPick = useCallback(
		(kind: PickKind, title: string) => {
			const bounds = canvas.current?.getBoundingClientRect();
			const zoom = flow.getZoom();
			const w = Math.min(960, ((bounds?.width ?? 1200) * 0.6) / zoom);
			const h = Math.min(640, ((bounds?.height ?? 800) * 0.55) / zoom);
			const middle = flow.screenToFlowPosition({
				x: (bounds?.left ?? 0) + (bounds?.width ?? innerWidth) / 2,
				y: (bounds?.top ?? 0) + (bounds?.height ?? innerHeight) / 2,
			});
			const id = transactLocal(doc, () =>
				addSection(doc, { x: middle.x - w / 2, y: middle.y - h / 2, w, h }, { title }, boxSize),
			);
			pickSection(kind, id);
		},
		[doc, flow, boxSize, pickSection],
	);
	const hasSections = useMemo(() => nodes.some((node) => node.type === "section"), [nodes]);

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

	// Cards added by reference or search (the card tool, pasted links): in
	// free space, a run of them in rows beside the last, and never a second
	// card for an item that's already here unless that's asked for.
	const cardRun = useRef<{ run: CardRun; last: string | null } | null>(null);
	useEffect(() => {
		if (tool !== "card") cardRun.current = null;
	}, [tool]);
	const addCards = useCallback(
		(
			keys: string[],
			options: { at?: Position; copies?: boolean; notify?: boolean } = {},
		): AddOutcome => {
			if (readOnly || keys.length === 0) return { added: [], existing: [] };
			const shapes = shapesMap(doc);
			const boxFor = (id: string) => {
				const shape = shapes.get(id);
				return shape ? boxOf(id, readShape(shape), boxSize) : null;
			};
			const bounds = canvas.current?.getBoundingClientRect();
			const { x, y, zoom } = flow.getViewport();
			const view = {
				x: -x / zoom,
				y: -y / zoom,
				w: (bounds?.width ?? window.innerWidth) / zoom,
				h: (bounds?.height ?? window.innerHeight) / zoom,
			};
			// Carry on from the last card added, while it's still here and in view.
			const previous = cardRun.current;
			const last = previous?.last ? boxFor(previous.last) : null;
			const run =
				!options.at && previous && last && intersects(last, view)
					? previous.run
					: { origin: options.at ?? centre(), count: 0 };
			const result = transactLocal(doc, () =>
				addCardsInRun(doc, keys, run, { sizeOf: boxSize, copies: options.copies }),
			);
			const ids = result.added.map((entry) => entry.id);
			cardRun.current = { run: result.run, last: ids.at(-1) ?? previous?.last ?? null };
			if (ids.length > 0) {
				setSelected(new Set(ids));
				// Slid out of sight to find room: bring it into view.
				const box = boxFor(ids.at(-1) as string);
				const inside =
					box &&
					box.x >= view.x &&
					box.y >= view.y &&
					box.x + box.w <= view.x + view.w &&
					box.y + box.h <= view.y + view.h - 120 / zoom;
				if (box && !inside) {
					follow.stop();
					void flow.setCenter(box.x + box.w / 2, box.y + box.h / 2, {
						zoom,
						duration: scaledDuration(420),
					});
				}
			}
			const existing = result.existing;
			const outcome: AddOutcome = {
				added: result.added.map((entry) => entry.key),
				existing: existing.map((entry) => entry.key),
			};
			if (existing.length === 0) return outcome;
			// Show where they are, and offer a copy rather than making one.
			pulse(existing.map((entry) => entry.id));
			const [first] = existing;
			if (ids.length === 0 && first && existing.length === 1) reveal(first.id);
			outcome.notice =
				ids.length > 0
					? `Added ${ids.length === 1 ? "1 card" : `${ids.length} cards`}; ${existing.length} ${existing.length === 1 ? "was" : "were"} already on the board`
					: existing.length === 1 && first
						? `${shortRef(first.key)} is already on the board`
						: `All ${existing.length} are already on the board`;
			if (options.notify !== false) {
				toasts.show({
					message: outcome.notice,
					action: {
						label: existing.length === 1 ? "Add another copy" : "Add copies",
						run: () => addCards(outcome.existing, { copies: true }),
					},
				});
			}
			return outcome;
		},
		[doc, readOnly, boxSize, flow, centre, follow.stop, pulse, reveal, toasts],
	);
	addCardsRef.current = addCards;
	const onBoard = useCallback((key: string) => cardsOnBoard(doc).has(key.toLowerCase()), [doc]);
	// Where the card tool searches: read while it's open, and again as cards arrive.
	const cardShapes = tool === "card" ? shapeNodes : null;
	const cardScope = useMemo(
		() => (cardShapes ? searchScopeOf(doc) : { host: "", repos: [] }),
		[doc, cardShapes],
	);
	const searchItems = useMemo(
		() =>
			writeServices.searchItems
				? (host: string, q: string) =>
						writeServices.searchItems?.(host, q) ??
						Promise.resolve({ kind: "error", reason: "unsupported", message: "" } as const)
				: undefined,
		[writeServices],
	);

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
		tool !== "comment" &&
		picking === null;
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
						<SkipToBoard onSkip={() => canvas.current?.focus()} />
						<TopBar
							title={
								<>
									{title ?? <span className="board-name">{name}</span>}
									<SyncStatus synced={synced} waiting={waiting} />
								</>
							}
							people={
								<>
									{inbox}
									<People
										user={user}
										selfId={awareness.clientID}
										people={presence.people}
										following={follow.following}
										onFollow={follow.follow}
										onJump={follow.jump}
										self={account && ((label) => account(label, user))}
									/>
								</>
							}
							tools={
								<>
									<SinceButton doc={liveDoc} login={user.login} youId={comments.youId} />
									{replay.controller && (
										<HistoryButton open={replay.state.open} onToggle={toggleHistory} />
									)}
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
									<FacilitateMenu
										doc={doc}
										awareness={awareness}
										user={user}
										readOnly={readOnly}
										toasts={toasts}
										onReveal={reveal}
										selectedSection={selectedSection}
										onStamp={() => setTool("stamp")}
									/>
									<CommentsButton />
								</>
							}
							actions={
								<>
									<ChangesButton />
									{actions}
								</>
							}
						/>
						<main
							ref={canvas}
							id="board"
							className="canvas"
							// The skip link's target, named and summed up for screen readers.
							tabIndex={-1}
							aria-label="Board"
							aria-describedby={SUMMARY_ID}
							data-tool={tool}
							data-picking={picking ?? undefined}
							data-exporting={exporter.drawing || undefined}
							data-history={
								replay.state.open ? (replay.state.position === null ? "now" : "past") : undefined
							}
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
							<BoardSummary id={SUMMARY_ID} nodes={shapeNodes} />
							<Announcer />
							<DisplayMarksContext value={displayMarks}>
								<ReactFlow
									nodes={nodes}
									ariaLabelConfig={ARIA_LABELS}
									nodeTypes={NODE_TYPES}
									onNodesChange={onNodesChange}
									onPaneClick={onPaneClick}
									onMoveStart={follow.onMoveStart}
									onMoveEnd={(_event, viewport) => {
										if (rememberView && fitted.current) saveViewport(rememberView, viewport);
									}}
									proOptions={{ hideAttribution: true }}
									onlyRenderVisibleElements={!exporter.drawing}
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
										// A row or mini card pops its full card out (#72).
										if (node.data.display === "row" || node.data.display === "mini") {
											previewStore.enter(node.id);
										}
									}}
									onNodeMouseLeave={(_event, node) => {
										if (node.type === "card") linkStore.set(null, "card");
										previewStore.leave(node.id);
									}}
									onNodeClick={(event, node) => {
										// Picking a section to start something on.
										if (picking) {
											const section = sectionAt(doc, node.id);
											if (section) pickSection(picking, section);
											return;
										}
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
											// Said in place of the tool's hint, not in a toast above it.
											if (result === "none_left") {
												showToolNote("No dots left: click one of yours to move it");
											} else if (result === "no_vote") {
												showToolNote("That’s not part of a vote");
											}
											return;
										}
										// Clicking one shape in a multi-selection selects just that one.
										if (event.shiftKey || event.metaKey || event.ctrlKey) return;
										if (selected.size > 1 && selected.has(node.id)) setSelected(new Set([node.id]));
									}}
								>
									<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
									<ZoomControls
										onCommand={commands.run}
										onShortcuts={() => setSheetOpen(true)}
										hasSelection={selected.size > 0}
										minimap={shapeNodes.length > 0 ? minimapOn : null}
										onMinimap={setMinimapOn}
										onNavigate={follow.stop}
									/>
									{minimapOn && shapeNodes.length > 0 && (
										<BoardMinimap pannable zoomable nodeClassName={minimapClass} />
									)}
									<ZoomVariable />
									<PanelBoundary name="Connectors">
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
									</PanelBoundary>
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
									<PanelBoundary name="Inboxes">
										<InboxLayer
											doc={doc}
											nodes={nodes}
											readOnly={readOnly}
											user={user}
											toasts={toasts}
											sizeOf={boxSize}
											onPlaced={(id) => setSelected(new Set([id]))}
										/>
									</PanelBoundary>
									{!replay.state.open && (
										<HighlightLayer doc={doc} nodes={nodes} sizeOf={drawnSize} />
									)}
									<PanelBoundary name="Comment pins">
										<CommentLayer
											nodes={nodes}
											sizeOf={drawnSize}
											placing={tool === "comment"}
											user={user}
											toasts={toasts}
										/>
									</PanelBoundary>
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
									<PanelBoundary name="Votes and marks">
										<MarksLayer
											doc={doc}
											nodes={nodes}
											sizeOf={boxSize}
											me={user}
											readOnly={readOnly}
											voting={!readOnly && tool === "vote"}
										/>
									</PanelBoundary>
									{replay.controller && replay.state.open && (
										<HistoryCanvas
											controller={replay.controller}
											state={replay.state}
											live={liveDoc}
											selected={[...selected]}
											readOnly={viewOnly}
											sizeOf={boxSize}
										/>
									)}
									<Cursors people={presence.people} />
									<Emotes awareness={awareness} user={user} people={presence.people} />
									<ViewPublisher awareness={awareness} paused={exporter.drawing} />
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
									<DisplayPreview
										display={display}
										selected={selected}
										suppressed={snapping.dragging || tool !== "select"}
									/>
								</ReactFlow>
							</DisplayMarksContext>
							<EmptyBoard
								empty={
									!readOnly &&
									synced &&
									shapeNodes.length === 0 &&
									tool !== "comment" &&
									!comments.hasThreads
								}
								onTool={setTool}
							/>
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
							{picking && !readOnly && (
								<SectionPickerHint
									kind={picking}
									hasSections={hasSections}
									onMake={(title) => makeSectionToPick(picking, title)}
								/>
							)}
							{voteState.tally && (
								<PanelBoundary name="The vote’s results">
									<TallyPanel
										doc={doc}
										voteId={voteState.tally}
										user={user}
										readOnly={readOnly}
										onClose={() => voteUI.showTally(null)}
										onReveal={reveal}
									/>
								</PanelBoundary>
							)}
							<CursorChat awareness={awareness} user={user} />
							{!replay.state.open && (
								<Toolbar
									tool={tool}
									onTool={setTool}
									stickyColor={stickyColor}
									onStickyColor={setStickyColor}
									onAddCards={(keys, copies) => addCards(keys, { copies, notify: false })}
									cardScope={cardScope}
									searchItems={searchItems}
									onBoard={onBoard}
									onAddWidget={addWidgetAt}
									suggestedRepo={suggestedRepo}
									login={user.login ?? null}
									stamp={stamp}
									onStamp={setStamp}
									viewOnly={readOnly}
									commenting={comments.canComment}
									note={toolNote}
									commentBlocked={
										comments.commentBlocked === "archived"
											? "This board is archived, so it’s read-only"
											: comments.commentBlocked === "signed_out"
												? "Sign in to comment"
												: undefined
									}
								/>
							)}
							<PanelBoundary name="What’s new">
								<SincePanel
									doc={liveDoc}
									login={user.login}
									youId={comments.youId}
									onJump={comments.jumpToShape}
									onOpenThread={comments.jumpToThread}
								/>
							</PanelBoundary>
							<PanelBoundary name="Comments">
								<CommentsPanel doc={liveDoc} login={user.login} onJump={comments.jumpToThread} />
							</PanelBoundary>
							{rulesOpen && (
								<PanelBoundary name="Rules">
									<RulesPanel
										doc={doc}
										user={{ name: user.name, color: user.color }}
										readOnly={readOnly}
										onClose={() => setRulesOpen(false)}
										onReveal={reveal}
										onUndo={() => history.undo()}
										toasts={toasts}
									/>
								</PanelBoundary>
							)}
							{replay.controller && replay.state.open && (
								<>
									<PanelBoundary name="History">
										<HistoryPanel
											controller={replay.controller}
											state={replay.state}
											live={liveDoc}
											readOnly={viewOnly}
											sizeOf={boxSize}
											onClose={() => replay.controller?.close()}
											onFocus={focusArea}
										/>
									</PanelBoundary>
									<HistoryDock
										controller={replay.controller}
										state={replay.state}
										onClose={() => replay.controller?.close()}
									/>
								</>
							)}
							<RowGhost />
							<Toasts store={toasts} />
							<ShortcutSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
							<ExportDialog
								doc={doc}
								exporter={exporter}
								selected={selected}
								toasts={toasts}
								name={name}
							/>
							<PanelBoundary name="Changes">
								<ChangesPanel />
							</PanelBoundary>
							<PanelBoundary name="Pushing">
								<PushSheet />
							</PanelBoundary>
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
	if (type === "action")
		return `minimap-action${node.data.shape.done ? " minimap-action-done" : ""}`;
	return `minimap-${type}`;
}

/** An item as people say it: `emdash#412`. */
function shortRef(key: string): string {
	const ref = parseKey(key);
	return ref ? `${ref.repo.split("/").pop()}${ref.item}` : key;
}
