import { useStore, useStoreApi } from "@xyflow/react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type ChildInput,
	boardRepos,
	canWrite,
	connectorBetween,
	issueFromText,
	milestoneInWords,
	pendingIssueFor,
	readHierarchy,
	sectionTitle,
	setEditsInWords,
	stageComments,
	stageParentIssue,
	stageSetEdits,
	stageStickyIssues,
	stageTriage,
	stateInWords,
	withStaged,
} from "../../shared/actions.ts";
import { stickiesToActions } from "../../shared/actionItems.ts";
import { backlinkBody } from "../../shared/backlinks.ts";
import { type OperationKind, listChanges } from "../../shared/changes.ts";
import { isPending } from "../changes/describe.ts";
import type { Rect } from "../snapping.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { DEFAULT_HOST, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import { descendantsOf, readStructure } from "../../shared/sections.ts";
import { readShape, shapesMap, updateShapes } from "../../shared/shapes.ts";
import { SECTION_COLORS, type SectionColor } from "../../shared/sections.ts";
import { type ShapeNode, setStickyText } from "../board.ts";
import { textFromIssue } from "../../shared/issueText.ts";
import { installUrl } from "../CardView.tsx";
import { cardStore } from "../cardStore.ts";
import { type User, authorFor } from "../presence.ts";
import { DraftPanel } from "../ai/DraftPanel.tsx";
import { DraftDecisionIcon, SummariseIcon } from "../ai/icons.tsx";
import { useAi } from "../ai/service.ts";
import { useReveal } from "../reveal.ts";
import { countWords } from "../../shared/a11y.ts";
import type { ShapeType } from "../../shared/shapes.ts";
import { unionRect } from "../snapping.ts";
import type { ToastStore } from "../Toasts.tsx";
import type { History } from "../undo.ts";
import { useTextEditing } from "../useEditing.ts";
import { CarryPanel, openActionItems } from "../actionItems/CarryPanel.tsx";
import { ActionItemIcon, CarryIcon } from "../actionItems/icons.tsx";
import { boardPath } from "../../shared/boards.ts";
import { transactLocal } from "../undo.ts";
import { type BoardCard, BacklinkPanel } from "./BacklinkPanel.tsx";
import { ExpandRelated } from "./ExpandRelated.tsx";
import { BlockedByPanel } from "./BlockedBy.tsx";
import {
	BacklinkIcon,
	BlockedIcon,
	CloseIssueIcon,
	FitIcon,
	IssueIcon,
	LabelIcon,
	MilestoneIcon,
	ParentIcon,
	PersonIcon,
	RelatedIcon,
} from "./icons.tsx";
import { type ChildPreview, MakeIssuesPanel, ParentIssuePanel } from "./IssuePanels.tsx";
import { useKnownParents } from "./parents.ts";
import {
	LabelOption,
	MilestonePicker,
	avatarFor,
	PersonOption,
	type RepoOption,
	type SetOption,
	SetPicker,
	StateMenu,
} from "./pickers.tsx";
import { Notice, Popover, PopoverHead } from "./Popover.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { BAR_MARGIN } from "./popoverPlacement.ts";
import { type BarSource, BarItems, SectionColour, barEntries, useOverflow } from "./BarParts.tsx";
import { DisplaySwitch } from "../display/DisplaySwitch.tsx";
import { startSilent } from "../facilitation/Silent.tsx";
import { useVoteOpen, voteUI } from "../facilitation/Votes.tsx";
import { DotsIcon, HushIcon } from "../facilitation/icons.tsx";
import { TrayIcon } from "../inbox/icons.tsx";
import { inboxUI } from "../inbox/useTray.ts";
import {
	type ActionCommand,
	type ActionRequests,
	type SelectedCard,
	classify,
	count,
	isCard,
	reposOf,
	repoName,
	useCards,
	useSectionItems,
} from "./selection.ts";
import {
	type MetaState,
	recentRepos,
	rememberRepo,
	stagerFor,
	useRepoMetas,
	useServices,
} from "./services.ts";
import { snapshotRegion as snapshotRegionFor } from "./snapshot.ts";
import type { SizeOf } from "../../shared/sections.ts";
import { spreadStack, stackSelection } from "../../shared/stackEdits.ts";
import { GROUP_LIMIT } from "../../shared/stackNaming.ts";
import { countMembers, membersOf, nameState, stackName } from "../../shared/stacks.ts";
import { fitSection, readShapes } from "../../shared/structure.ts";
import { GroupThese } from "../stacks/GroupThese.tsx";
import { SparkIcon, SpreadIcon, StackIcon } from "../stacks/StackNode.tsx";
import { stackStore, useStacks } from "../stacks/store.ts";
import { undoToast } from "./toast.ts";
import { useChangesUI } from "../changes/context.ts";
import { MARK_DOT_ZOOM } from "../changes/StagedMarks.tsx";
import { useChangeList } from "../changes/store.ts";
import {
	canAssign,
	leftOutInWords,
	planFor,
	shownVolunteers,
	stagePlan,
} from "../volunteers/assign.ts";
import { useVolunteers } from "../volunteers/store.ts";
import { HandIcon } from "../volunteers/Volunteers.tsx";

// The selection's actions (#32, #33): a small bar under the selection that
// offers what it can become on the forge. Stickies become issues, a section
// or a cluster becomes a parent issue with sub-issues, and cards can be
// triaged or given a backlink. Every action stages changes for the push
// sheet; nothing is written until someone pushes.

type Size = { width: number; height: number };

/** React Flow lifts selected shapes by 1000; the bar and its panels go above that. */
const TOOLBAR_Z = 3000;

interface ActionBarProps {
	doc: Y.Doc;
	/** The selected nodes (connectors have their own toolbar). */
	selected: ShapeNode[];
	/** Every node, for what's around a backlink snapshot. */
	nodes: ShapeNode[];
	dragging: boolean;
	user: User;
	toasts: ToastStore;
	history: History;
	requests: ActionRequests;
	sizeOf: (id: string) => Size | undefined;
	/** Shapes' boxes, for placing what the bar makes (stacks). */
	boxSize?: SizeOf;
}

export interface Action {
	id: ActionCommand;
	label: string;
	icon: ReactNode;
	/**
	 * Its word beside the icon, when it isn't the usual one (barLayout.ts's
	 * `WORDS`): a count, or a state. Settings have none.
	 */
	text?: string;
	/** Not the bar's main action: set as it's laid out (barLayout.ts). */
	quiet?: boolean;
	/** Why it can't be done, if it can't. */
	unavailable?: string;
	/** What its tooltip says, when that's more than its name. */
	tooltip?: string;
}

/** What the AI can read in a selection (#64). */
const AI_READS = new Set<ShapeType>([
	"sticky",
	"card",
	"text",
	"section",
	"decision",
	"action",
	"link",
	"image",
]);

const KIND: Partial<Record<ActionCommand, OperationKind>> = {
	labels: "item.labels",
	milestone: "item.milestone",
	assign: "item.assignees",
	closeReopen: "item.state",
	backlink: "item.comment",
};

/** Names every repository has, in the first one's order. */
function common<T>(lists: T[][], name: (item: T) => string): T[] {
	const [first, ...rest] = lists;
	if (!first) return [];
	const sets = rest.map((list) => new Set(list.map(name)));
	return first.filter((item) => sets.every((set) => set.has(name(item))));
}

export function ActionBar(props: ActionBarProps) {
	const { doc, selected, dragging, user, toasts, history, requests } = props;
	const services = useServices();
	const boardAi = useAi();
	const reveal = useReveal();
	const store = useStoreApi();
	const bar = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState<ActionCommand | null>(null);
	// Out of the way while a sticky's being written: it's for after.
	const typing = useTextEditing();
	/** The button a panel was opened from with the keyboard, to go back to. */
	const returnTo = useRef<HTMLButtonElement | null>(null);
	/** Which button Tab lands on in the bar (a roving tab stop). */
	const [current, setCurrent] = useState(0);

	// A section on its own can be auto-stacked (#73): what's loose in it, and
	// those cards' titles to show.
	const autoSection =
		selected.length === 1 && selected[0]?.data.shape.type === "section" ? selected[0].id : null;
	const sectionItems = useSectionItems(doc, autoSection);
	const keys = useMemo(
		() => [
			...selected.flatMap((n) =>
				n.data.shape.type === "card" && n.data.shape.ref ? [n.data.shape.ref] : [],
			),
			...sectionItems.flatMap((item) => (item.kind === "card" ? [item.ref] : [])),
		],
		[selected, sectionItems],
	);
	const cardData = useCards(keys);
	const kinds = useMemo(() => classify(selected, cardData), [selected, cardData]);
	const { stickies, cards, cardNodes, sections, stacks, others } = kinds;
	// Whether the board's AI suggestions are on, for Auto-stack (#73).
	const { ai } = useStacks();
	// The connector between two selected issues (or stickies), for blocked-by.
	const pairKey =
		selected.length === 2 && stickies.length + cardNodes.length === 2
			? selected.map((n) => n.id).join(",")
			: "";
	const linking = useMemo(() => {
		const [a, b] = pairKey.split(",");
		return a && b ? connectorBetween(doc, a, b) : null;
	}, [doc, pairKey]);

	// A section on its own, drawn as one (not a group in a list): one bar for
	// its own tools (colour, display, facilitation) and what it can become,
	// over its title, above every shape.
	const lone =
		selected.length === 1 &&
		selected[0]?.data.shape.type === "section" &&
		selected[0].data.display !== "group"
			? selected[0]
			: undefined;
	const voteOpen = useVoteOpen(lone?.id ?? null);

	// Under the selection, unless that's off the bottom of the canvas or under
	// the tool dock: then above it, clear of the toolbars already there; and
	// always on screen (SelectionBar.tsx). Above, the bar also keeps clear of
	// the marks on what's staged, which stay legible (and so tall) however far
	// out the board is.
	const changesUI = useChangesUI();
	const staged = useChangeList(changesUI?.store ?? null);
	const marked = useMemo(
		() =>
			// Marks show what's still to land; landed changes have none.
			staged.length > 0 &&
			selected.some((n) =>
				(changesUI?.store.forShape(n.id) ?? []).some((change) => change.status !== "applied"),
			),
		[staged, selected, changesUI],
	);
	const markZoom = useStore((s) =>
		s.transform[2] < MARK_DOT_ZOOM ? 0 : Math.round(Math.max(0.8, s.transform[2]) * 20) / 20,
	);
	const markRoom = marked ? (markZoom === 0 ? 22 : Math.ceil(40 * markZoom)) : 0;
	// A section's title stays the same size on screen when zoomed out, and
	// grows with the board when zoomed in (sections.css, --unzoom).
	const titleZoom = useStore((s) => {
		const zoom = s.transform[2];
		return Math.round(zoom * Math.min(10, Math.max(1, 1 / zoom)) * 20) / 20;
	});
	const aboveOffset = lone
		? 10 + Math.ceil(SECTION_TITLE * titleZoom) + markRoom
		: 18 +
			markRoom +
			(selected.length >= 2 ? 52 : 0) +
			(stickies.length + stacks.length + others.length > 0 ? 52 : 0) +
			// A section's title row, and the row of its tools that can wrap above it.
			(sections.length === 1 && selected.length === 1 ? 82 : 0);

	// Cards in repositories Tack can't write to (no app) can't be changed.
	// Merged pull requests can still be labelled, assigned and commented on,
	// but not closed or reopened.
	const targets = cards.filter((c) => c.card.writable !== false);
	const closable = targets.filter((c) => c.card.state !== "merged");
	const repos = useMemo(() => reposOf(targets), [targets]);
	const metas = useRepoMetas(repos);

	// Close whatever's open when the selection changes.
	const selectionKey = selected.map((n) => n.id).join(",");
	useEffect(() => setOpen(null), [selectionKey]);

	const actions = useMemo((): Action[] => {
		const out: Action[] = [];
		const onlySection =
			sections.length === 1 && stickies.length + cardNodes.length + others.length === 0;
		const onlyStickies = stickies.length > 0 && cardNodes.length + sections.length === 0;
		const onlyCards = cardNodes.length > 0 && stickies.length + sections.length === 0;
		const clustered =
			sections.length === 0 && stickies.length + cardNodes.length >= 2 && !onlyCards;
		const actionItems = others.filter((n) => n.data.shape.type === "action");
		const onlyActions = actionItems.length >= 2 && actionItems.length === selected.length;

		// Silent mode's face-down stickies have no text here yet (#49).
		const faceDown = stickies.some((s) => s.data.shape.silent)
			? "Face down until the reveal: reveal first to make an issue"
			: undefined;
		if (onlyStickies) {
			const fresh = stickies.filter((s) => !pendingIssueFor(doc, s.id));
			out.push({
				id: "makeIssues",
				label: "Make issues from stickies",
				icon: <IssueIcon />,
				text:
					fresh.length === 0
						? "Staged"
						: fresh.length === 1
							? "Make issue"
							: `Make ${fresh.length} issues`,
				unavailable: faceDown ?? (fresh.length === 0 ? "Already staged as issues" : undefined),
			});
		}
		if (onlyStickies && stickies.every((s) => !s.data.shape.silent)) {
			out.push({
				id: "toActions",
				label: stickies.length === 1 ? "Make an action item" : "Make action items",
				icon: <ActionItemIcon />,
				text: stickies.length === 1 ? "Action item" : "Action items",
			});
		}
		if (onlyActions) {
			const open = openActionItems(
				doc,
				actionItems.map((n) => n.id),
			);
			out.push({
				id: "carryOver",
				label: "Carry the open ones over to another board",
				icon: <CarryIcon />,
				unavailable: open.length === 0 ? "They’re all done" : undefined,
			});
		}
		if (onlySection || clustered || (onlyStickies && stickies.length >= 2)) {
			out.push({
				id: "parentIssue",
				label: onlySection ? "Make a parent issue from this section" : "Make a parent issue",
				icon: <ParentIcon />,
				unavailable: onlySection ? undefined : faceDown,
			});
		}
		// A section on its own: its loose stickies and cards, all of them.
		if (ai === true && autoSection) {
			out.push({
				id: "groupThese",
				label: "Auto-stack: sort this section into named stacks",
				icon: <SparkIcon />,
				unavailable:
					sectionItems.length >= 3
						? undefined
						: "Auto-stack needs three or more stickies, issues or pull requests in this section that aren’t in a stack yet",
			});
		}
		// A free-form section on its own fits to what's in it (lists and grids
		// are as big as what's in them already).
		const loneSection = onlySection && selected.length === 1 ? sections[0] : undefined;
		if (loneSection && !loneSection.data.shape.display && !loneSection.data.display) {
			out.push({
				id: "fitSection",
				label: "Fit to contents",
				icon: <FitIcon />,
			});
		}
		// Stacks (#73): stickies and cards into one, a selection into themed ones
		// by AI, and a stack back out, or up as a parent issue.
		const onlyStack = stacks.length === 1 && selected.length === 1 ? stacks[0] : undefined;
		if (
			stickies.length + cardNodes.length + stacks.length >= 2 &&
			sections.length + others.length === 0 &&
			[...stickies, ...cardNodes, ...stacks].every((n) => n.data.display === undefined)
		) {
			out.push({ id: "stackThese", label: "Stack these", icon: <StackIcon /> });
		}
		// Stickies and cards, and nothing else (no rows in a list): with stickies,
		// cards join in if asked to (the panel's choice); on their own, they're
		// what's grouped. Whether a card's title may be shared is the server's to
		// say, so here every card counts.
		if (
			ai === true &&
			stickies.length + cardNodes.length >= 3 &&
			selected.length === stickies.length + cardNodes.length &&
			[...stickies, ...cardNodes].every((n) => n.data.display === undefined)
		) {
			const readable = stickies.filter(
				(s) => !s.data.shape.silent && (s.data.shape.text ?? "").trim() !== "",
			);
			out.push({
				id: "groupThese",
				label: "Auto-stack: sort these into named stacks",
				icon: <SparkIcon />,
				unavailable:
					readable.length + cardNodes.length >= 3
						? undefined
						: cardNodes.length === 0
							? "Select at least three stickies with something written on them"
							: "Select at least three issues, pull requests or stickies with something written on them",
			});
		}
		if (onlyStack) {
			const shapes = readShapes(doc);
			const members = membersOf(shapes, onlyStack.id);
			out.push({
				id: "parentIssue",
				label: "Make a parent issue from this stack, what’s in it as sub-issues",
				icon: <ParentIcon />,
				unavailable: members.some((id) => shapes.get(id)?.silent)
					? "Face down until the reveal: reveal first to make issues"
					: undefined,
			});
			out.push({
				id: "unstack",
				label: "Unstack: lay what’s in it out where it is",
				icon: <SpreadIcon />,
			});
		}
		// Not a change to stage: it lays out what's already linked, so it's
		// there whether or not Tack can write to the repository.
		// Discussions aren't linked to anything GitHub can say.
		if (
			onlyCards &&
			cardNodes.length === 1 &&
			cards.length === 1 &&
			cards[0]?.card.kind !== "discussion"
		) {
			out.push({
				id: "expandRelated",
				label: "Expand related items",
				icon: <RelatedIcon />,
			});
		}
		if (onlyCards && cards.length > 0) {
			const none =
				targets.length === 0 ? "Tack can’t write to these yet: install the app" : undefined;
			const supported = (id: ActionCommand) => {
				const kind = KIND[id];
				return !kind || repos.every((repo) => canWrite(metas.get(repo)?.meta, kind));
			};
			const anyOpen = closable.some((c) => c.card.state !== "closed");
			const anyClosed = closable.some((c) => c.card.state === "closed");
			const closeLabel =
				anyOpen && !anyClosed ? "Close" : !anyOpen && anyClosed ? "Reopen" : "Close or reopen";
			const triage: Action[] = [
				{ id: "labels", label: "Labels", icon: <LabelIcon /> },
				{ id: "milestone", label: "Milestone", icon: <MilestoneIcon /> },
				{ id: "assign", label: "Assign", icon: <PersonIcon /> },
				{
					id: "closeReopen",
					label: closeLabel,
					icon: <CloseIssueIcon />,
					text: closeLabel === "Close or reopen" ? "Close…" : closeLabel,
				},
				{
					id: "backlink",
					label: "Comment with a link to this board",
					icon: <BacklinkIcon />,
				},
			];
			const merged =
				!none && closable.length === 0
					? "Merged pull requests can’t be closed or reopened"
					: undefined;
			// Nobody to assign, and nobody to unassign: say so on the button,
			// rather than opening a panel that can only say so.
			const loaded = repos.length > 0 && repos.every((r) => metas.get(r)?.status === "ready");
			const assignable = common(
				repos.map((r) => metas.get(r)?.meta?.assignees ?? []),
				(login) => login,
			);
			const nobody =
				loaded && assignable.length === 0 && targets.every((c) => c.card.assignees.length === 0)
					? `Nobody can be assigned in ${repos.length === 1 ? repoName(repos[0] ?? "") : "these repositories"}`
					: undefined;
			// Discussions have labels and close, but no milestones or assignees.
			const discussions = cards.filter((c) => c.card.kind === "discussion").length;
			const notForDiscussions = (id: ActionCommand) => id === "milestone" || id === "assign";
			for (const action of triage) {
				if (!supported(action.id)) continue;
				if (discussions === cards.length && notForDiscussions(action.id)) continue;
				out.push({
					...action,
					unavailable:
						none ??
						(discussions > 0 && notForDiscussions(action.id)
							? `Discussions have no ${action.id === "assign" ? "assignees" : "milestones"}: select only issues and pull requests`
							: action.id === "closeReopen"
								? merged
								: action.id === "assign"
									? nobody
									: undefined),
				});
			}
			const issues = cards.filter((c) => c.card.kind === "issue");
			if (issues.length >= 2) {
				out.push({ id: "parentIssue", label: "Make a parent issue", icon: <ParentIcon /> });
			}
		}
		// AI (#64): a summary or a decision drafted from what's selected, to
		// read and place. Nothing's staged: what it drafts goes on the board.
		const readable = selected.filter((n) => AI_READS.has(n.data.shape.type));
		const sectionAlone = readable.length === 1 && readable[0]?.data.shape.type === "section";
		if (boardAi && (readable.length >= 2 || sectionAlone)) {
			const allFaceDown = readable.every(
				(n) => n.data.shape.type === "sticky" && n.data.shape.silent,
			);
			const unavailable = allFaceDown ? "Face down until the reveal" : undefined;
			out.push(
				{ id: "summarise", label: "Summarise with AI", icon: <SummariseIcon />, unavailable },
				{
					id: "draftDecision",
					label: "Draft a decision with AI",
					icon: <DraftDecisionIcon />,
					unavailable,
				},
			);
		}
		// Two connected items: the arrow between them can become blocked-by,
		// which otherwise only shows when the arrow itself is selected.
		if (linking) {
			out.push({
				id: "blockedBy",
				label: "Blocked by: the arrow between these",
				icon: <BlockedIcon />,
			});
		}
		return out;
	}, [
		boardAi,
		linking,
		doc,
		selected,
		stickies,
		cards,
		cardNodes,
		sections,
		stacks,
		others,
		targets,
		closable,
		repos,
		metas,
		ai,
		autoSection,
		sectionItems,
	]);

	// Volunteers on the selected cards (volunteers/): "Assign volunteers"
	// stages them as assignees, where the cards' items can take them.
	const allVolunteers = useVolunteers(doc);
	const volunteering = useMemo(() => {
		const items = cards.flatMap((c) => {
			const volunteers = allVolunteers.get(c.shape) ?? [];
			const shown = shownVolunteers(doc, c.card, volunteers);
			return shown.length > 0 ? [{ shape: c.shape, card: c.card, volunteers, shown }] : [];
		});
		const assignable = items.filter((item) =>
			canAssign(item.card, metas.get(repoKeyOf(item.card.key))?.meta),
		);
		// Volunteers only on discussions (or forges whose people aren't
		// GitHub's): nothing to assign, so nothing offered.
		if (assignable.length === 0) return null;
		const plan = planFor(doc, assignable, (repo) => metas.get(repo)?.meta);
		const open = assignable.some((item) => item.shown.some((v) => !v.staged));
		const action: Omit<Action, "id"> & { id: string } = {
			id: "assignVolunteers",
			label: "Assign volunteers: stage them as assignees",
			icon: <HandIcon size={16} />,
			...(!open
				? { text: "Staged", unavailable: "Their volunteers are staged to be assigned" }
				: plan.edits.length === 0
					? { unavailable: leftOutInWords(plan) || "Every volunteer is assigned already" }
					: {}),
		};
		return { action, plan };
		// `staged` (every change) is here so it's worked out again as changes are staged.
	}, [cards, allVolunteers, metas, doc, staged]);

	/** Stickies to action items, in place: no panel, one undo step. */
	const makeActionItems = () => {
		const made = transactLocal(doc, () =>
			stickiesToActions(
				doc,
				stickies.map((s) => s.id),
			),
		);
		if (made.length === 0) return;
		store.getState().resetSelectedElements();
		requestAnimationFrame(() => store.getState().addSelectedNodes(made));
		toast(
			`Made ${count(made.length, "action item")}: give ${made.length === 1 ? "it" : "them"} an owner and a due date`,
		);
	};

	/** Stickies, cards and stacks into one stack where the first of them is: one undo step. */
	const stackThese = () => {
		const stack = transactLocal(doc, () =>
			stackSelection(
				doc,
				selected.map((n) => n.id),
				props.boxSize,
			),
		);
		if (!stack) return;
		store.getState().resetSelectedElements();
		requestAnimationFrame(() => store.getState().addSelectedNodes([stack]));
	};

	/** A stack's stickies and cards laid out where it is, for good: one undo step. */
	const unstack = () => {
		const stack = stacks[0];
		if (!stack) return;
		stackStore.setOpen(null);
		const spread = transactLocal(doc, () => spreadStack(doc, stack.id, props.boxSize));
		if (spread.length === 0) return;
		store.getState().resetSelectedElements();
		requestAnimationFrame(() => store.getState().addSelectedNodes(spread));
		const types = readShapes(doc);
		toast(`Unstacked ${countMembers(spread.map((id) => types.get(id)?.type))}`);
	};

	/** A section snapped to its contents, larger or smaller: one undo step. */
	const fit = () => {
		const section = sections[0];
		if (!section) return;
		const done = transactLocal(doc, () => fitSection(doc, section.id, props.boxSize));
		if (!done) toasts.show({ message: "It already fits what’s in it" });
	};

	/** What the bar does at once, without a panel. */
	const immediate: Partial<Record<ActionCommand, () => void>> = {
		toActions: makeActionItems,
		stackThese,
		unstack,
		fitSection: fit,
	};

	useEffect(
		() =>
			requests.register((id) => {
				const action = actions.find((a) => a.id === id);
				if (!action || action.unavailable) return false;
				const run = immediate[id];
				if (run) run();
				else setOpen((current) => (current === id ? null : id));
				return true;
			}),
		[requests, actions],
	);

	/** An action from the bar, or from its "…" menu (`from`: its button, to come back to). */
	function runAction(
		action: Action,
		event: React.MouseEvent<HTMLElement>,
		from: HTMLElement | null = null,
	) {
		if (action.unavailable) return;
		// From the keyboard (no pointer): come back here when the panel closes.
		returnTo.current =
			from instanceof HTMLButtonElement
				? from
				: event.detail === 0 && event.currentTarget instanceof HTMLButtonElement
					? event.currentTarget
					: null;
		const run = immediate[action.id];
		if (run) run();
		else setOpen((was) => (was === action.id ? null : action.id));
	}

	const close = () => {
		setOpen(null);
		// Opened from the keyboard: back to the button it came from.
		const from = returnTo.current;
		returnTo.current = null;
		if (from?.isConnected) {
			from.focus();
			return;
		}
		// Back to the board, so its shortcuts work again.
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	};
	const stager = stagerFor(user);
	const toast = (message: string) => undoToast(toasts, history, message);

	const ids = selected.map((n) => n.id);
	const idsKey = ids.join(",");

	// The bar is a toolbar the keyboard can reach: Tab from a selected shape
	// (or F6 from anywhere on the board) lands on it, arrow keys move along
	// it, and Escape or Shift-Tab goes back to the shape.
	useEffect(() => {
		if (!idsKey || dragging) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const node = target?.closest(".react-flow__node");
			const fromShape =
				event.key === "Tab" &&
				!event.shiftKey &&
				node === target &&
				!!node &&
				idsKey.split(",").includes(node.getAttribute("data-id") ?? "");
			const f6 = event.key === "F6" && !event.shiftKey && !bar.current?.contains(target);
			if (!fromShape && !f6) return;
			const button = focusableActions(bar.current)[current] ?? focusableActions(bar.current)[0];
			if (!button) return;
			event.preventDefault();
			button.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [idsKey, dragging, current]);
	useEffect(() => setCurrent(0), [idsKey]);
	// One tab stop in the bar, wherever the keyboard last was in it.
	useLayoutEffect(() => {
		const items = focusableActions(bar.current);
		const stop = Math.min(current, items.length - 1);
		items.forEach((item, i) => {
			item.tabIndex = i === stop ? 0 : -1;
		});
	});

	// Every bar: its settings, then what it does, each with its word, in
	// groups (barLayout.ts); as many as fit across the canvas, and the rest
	// in a "…" menu at its end. A lone section's facilitation goes in too.
	const more = useRef<HTMLButtonElement>(null);
	const loneShape = lone?.data.shape;
	const sources: BarSource[] = [];
	if (lone && loneShape) {
		if (!loneShape.silent) {
			sources.push({
				action: {
					id: "startSilent",
					label: "Silent mode",
					tooltip: "Silent mode: everyone writes face down until the reveal",
					icon: <HushIcon size={16} />,
				},
				pressed: false,
				run: () => startSilent(lone.id, user),
			});
		}
		if (!voteOpen) {
			sources.push({
				action: {
					id: "startVote",
					label: "Vote",
					tooltip: "Dot vote on what’s in it",
					icon: <DotsIcon size={16} />,
				},
				pressed: false,
				run: () => voteUI.start(lone.id),
			});
		}
		if (!loneShape.inbox) {
			sources.push({
				action: {
					id: "makeInbox",
					label: "Make inbox",
					tooltip: "Make inbox: collect new matches for a search here",
					icon: <TrayIcon size={16} />,
				},
				pressed: false,
				run: () => inboxUI.edit(lone.id),
			});
		}
	}
	// Cards people have volunteered for: their volunteers as assignees, at
	// once, as one undo step. First of the actions after the main one.
	if (volunteering) {
		sources.push({
			action: volunteering.action,
			pressed: false,
			run: () => {
				if (volunteering.action.unavailable) return;
				const { staged: done, message } = stagePlan(doc, volunteering.plan, stager);
				if (done > 0) toast(message);
				else toasts.show({ message });
			},
		});
	}
	for (const action of actions) {
		sources.push({
			action,
			pressed: open === action.id,
			run: (event, from) => runAction(action, event, from),
		});
	}
	const entries = barEntries(sources);
	// As wide as the canvas allows, inside the margins placeBar keeps.
	const paneWidth = useStore((s) => s.width);
	const hidden = useOverflow(
		bar,
		entries,
		[
			...entries.map((e) => `${e.key}:${e.action.text ?? ""}:${e.action.unavailable ? 1 : 0}`),
			loneShape?.display ?? "",
			loneShape ? JSON.stringify(loneShape.sort ?? null) : "",
			cards.length > 0 && targets.length === 0 ? "install" : "",
		].join("|"),
		paneWidth > 0 ? paneWidth - 2 * BAR_MARGIN : null,
	);
	if (actions.length === 0 && !lone && !volunteering) return null;

	/** The selected shape the bar is about, to go back to from the bar. */
	const shapeElement = () =>
		store
			.getState()
			.domNode?.querySelector<HTMLElement>(
				`.react-flow__node[data-id="${CSS.escape(ids[0] ?? "")}"]`,
			) ?? null;

	const onBarKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		// Keys inside an open panel or menu are its own.
		if (!target.hasAttribute("data-bar-item") || target.closest(".action-popover, .bar-menu")) {
			return;
		}
		const buttons = focusableActions(bar.current);
		const at = buttons.indexOf(target as HTMLButtonElement);
		const move = (to: number) => {
			event.preventDefault();
			const next = buttons[(to + buttons.length) % buttons.length];
			next?.focus();
			setCurrent(Math.max(0, buttons.indexOf(next as HTMLButtonElement)));
		};
		switch (event.key) {
			case "Enter":
			case " ":
				// The button's own: not the board's shortcut for the selection.
				event.stopPropagation();
				return;
			case "ArrowRight":
			case "ArrowDown":
				return move(at + 1);
			case "ArrowLeft":
			case "ArrowUp":
				return move(at - 1);
			case "Home":
				return move(0);
			case "End":
				return move(buttons.length - 1);
			case "Escape":
				event.preventDefault();
				event.stopPropagation();
				// A panel still opening (focus not in it yet) closes; otherwise back to the shape.
				if (open) close();
				else shapeElement()?.focus();
				return;
			case "Tab": {
				if (open) return;
				event.preventDefault();
				const shape = shapeElement();
				if (event.shiftKey) shape?.focus();
				else
					(shape?.querySelector<HTMLElement>("a[href], button, [tabindex='0']") ?? shape)?.focus();
				return;
			}
		}
	};
	const hasCards = targets.length > 0;
	const allUnwritable = cards.length > 0 && !hasCards;

	// Repositories to offer: the board's first, then recent ones.
	const repoOptions = (): RepoOption[] => {
		const onBoard = boardRepos(doc);
		const seen = new Set(onBoard.map((r) => r.repo));
		return [
			...onBoard.map((r) => ({ repo: r.repo, cards: r.cards })),
			...recentRepos()
				.filter((r) => !seen.has(r))
				.map((repo) => ({ repo, recent: true })),
		];
	};
	const hostOf = (options: RepoOption[]) =>
		parseRepoKey(options[0]?.repo ?? "")?.host ?? DEFAULT_HOST;

	const panel = (): ReactNode => {
		switch (open) {
			case "makeIssues": {
				const options = repoOptions();
				const staged = new Set(stickies.filter((s) => pendingIssueFor(doc, s.id)).map((s) => s.id));
				return (
					<MakeIssuesPanel
						stickies={stickies.map((s) => ({
							id: s.id,
							text: s.data.shape.text ?? "",
							color: s.data.shape.color,
							volunteers: allVolunteers.get(s.id),
						}))}
						staged={staged}
						repos={options}
						host={hostOf(options)}
						initialRepo={recentRepos()[0] ?? options[0]?.repo ?? null}
						onTitle={(id, title) => {
							const sticky = stickies.find((s) => s.id === id);
							const issue = issueFromText(sticky?.data.shape.text ?? "");
							transactLocal(doc, () =>
								setStickyText(doc, id, textFromIssue({ title, body: issue?.body })),
							);
						}}
						onStage={(repo, extras, assignable) => {
							// The stickies' volunteers become their issues' assignees, as
							// far as the repository lets them.
							const result = stageStickyIssues(
								doc,
								stickies.map((s) => ({ id: s.id, text: s.data.shape.text ?? "" })),
								repo,
								stager,
								extras,
								{ assignable },
							);
							rememberRepo(repo);
							close();
							const labels = extras.labels?.length ?? 0;
							const picked = extras.assignees?.length ?? 0;
							const volunteered = listChanges(doc)
								.filter((change) => result.staged.includes(change.id))
								.reduce(
									(n, change) =>
										n +
										Math.max(
											0,
											(change.op.kind === "issue.create" ? (change.op.assignees?.length ?? 0) : 0) -
												picked,
										),
									0,
								);
							toast(
								`Staged ${count(result.staged.length, "issue")} for ${repoName(repo)}${labels ? `, with ${count(labels, "label")}` : ""}${volunteered ? `, assigned to ${volunteered === 1 ? "its volunteer" : `${volunteered} volunteers`}` : ""}`,
							);
						}}
					/>
				);
			}
			case "parentIssue":
				return (
					<ParentPanel
						{...props}
						kinds={kinds}
						options={repoOptions()}
						hostOf={hostOf}
						onDone={(message) => {
							close();
							toast(message);
						}}
					/>
				);
			case "labels":
			case "assign":
				return (
					<SetPanel
						doc={doc}
						kind={open === "labels" ? "item.labels" : "item.assignees"}
						targets={targets}
						repos={repos}
						metas={metas}
						onStage={(edits) => {
							const labels = open === "labels";
							const kind = labels ? "item.labels" : "item.assignees";
							const byKey = new Map(targets.map((t) => [t.key, t]));
							stageSetEdits(
								doc,
								kind,
								edits.map((e) => {
									const card = byKey.get(e.key)?.card;
									const current = labels
										? card?.labels.map((l) => l.name)
										: card?.assignees.map((a) => a.login);
									return {
										...e,
										shape: byKey.get(e.key)?.shape,
										current,
										discussion: card?.kind === "discussion",
									};
								}),

								stager,
							);
							close();
							toast(setEditsInWords(kind, edits));
						}}
					/>
				);
			case "milestone":
				return (
					<>
						<PopoverHead
							title="Milestone"
							detail={targets.length > 1 ? `For ${count(targets.length, "item")}` : undefined}
						/>
						<MetaGate repos={repos} metas={metas} what="milestones">
							{(list) => (
								<MilestonePicker
									milestones={common(
										list.map((m) => m.milestones),
										(m) => m.title,
									)}
									chosen={currentMilestone(doc, targets)}
									onPick={(milestone) => {
										stageTriage(
											doc,
											targets.map((t) => ({ key: t.key, shape: t.shape })),
											{ kind: "item.milestone", milestone },
											stager,
										);
										close();
										toast(
											milestoneInWords(
												milestone,
												targets.map((t) => t.key),
											),
										);
									}}
								/>
							)}
						</MetaGate>
					</>
				);
			case "closeReopen": {
				const openItems = closable.filter((t) => t.card.state !== "closed");
				const closedItems = closable.filter((t) => t.card.state === "closed");
				return (
					<StateMenu
						open={openItems.length}
						closed={closedItems.length}
						pulls={openItems.length > 0 && openItems.every((t) => t.card.kind === "pull")}
						discussions={
							openItems.length > 0 && openItems.every((t) => t.card.kind === "discussion")
						}
						onPick={(choice) => {
							const items = choice.state === "open" ? closedItems : openItems;
							const reason =
								choice.state === "open" || items.every((t) => t.card.kind === "pull")
									? undefined
									: choice.reason;
							stageTriage(
								doc,
								items.map((t) => ({
									key: t.key,
									shape: t.shape,
									discussion: t.card.kind === "discussion",
								})),
								choice.state === "open"
									? { kind: "item.state", state: "open" }
									: { kind: "item.state", state: "closed", reason },
								stager,
							);
							close();
							toast(
								stateInWords(
									choice.state,
									reason,
									items.map((t) => t.key),
								),
							);
						}}
					/>
				);
			}
			case "blockedBy":
				return linking ? (
					<BlockedByPanel
						doc={doc}
						connector={linking}
						user={user}
						toasts={toasts}
						history={history}
						onDone={close}
					/>
				) : null;
			case "groupThese": {
				if (autoSection) {
					// The first GROUP_LIMIT, in reading order: the rest stay where they are.
					const asked = sectionItems.slice(0, GROUP_LIMIT);
					const title = sectionTitle(doc, autoSection);
					return (
						<GroupThese
							doc={doc}
							stickies={asked.flatMap((item) =>
								item.kind === "sticky" ? [{ id: item.id, text: item.text, color: item.color }] : [],
							)}
							cards={asked.flatMap((item) => {
								if (item.kind !== "card") return [];
								const card = cardData.get(item.ref);
								return [
									{
										id: item.id,
										text: isCard(card) ? card.title : "",
										ref: isCard(card) ? card.item : undefined,
										state: isCard(card) ? card.state : undefined,
									},
								];
							})}
							section={{ id: autoSection, title, total: sectionItems.length }}
							sizeOf={props.boxSize}
							onClose={close}
							onMade={(made, grouped) => {
								setOpen(null);
								store.getState().resetSelectedElements();
								requestAnimationFrame(() => store.getState().addSelectedNodes(made));
								toast(
									`Made ${count(made.length, "stack")} of ${grouped} in ${title ? `“${title}”` : "the section"}`,
								);
							}}
						/>
					);
				}
				return (
					<GroupThese
						doc={doc}
						stickies={stickies.map((s) => ({
							id: s.id,
							text: s.data.shape.text ?? "",
							color: s.data.shape.color,
						}))}
						cards={cardNodes.map((n) => {
							const card = cardData.get(n.data.shape.ref ?? "");
							return {
								id: n.id,
								text: isCard(card) ? card.title : "",
								ref: isCard(card) ? card.item : undefined,
								state: isCard(card) ? card.state : undefined,
							};
						})}
						sizeOf={props.boxSize}
						onClose={close}
						onMade={(made, grouped) => {
							setOpen(null);
							store.getState().resetSelectedElements();
							requestAnimationFrame(() => store.getState().addSelectedNodes(made));
							toast(`Made ${count(made.length, "stack")} of ${grouped}`);
						}}
					/>
				);
			}
			case "carryOver": {
				const items = openActionItems(
					doc,
					others.map((n) => n.id),
				);
				return (
					<CarryPanel
						items={items}
						services={services}
						onCarried={(result) => {
							close();
							carriedToast(toasts, result);
						}}
					/>
				);
			}
			case "expandRelated": {
				const target = cards[0];
				return target ? (
					<ExpandRelated
						doc={doc}
						services={services}
						shape={target.shape}
						card={target.card}
						sizeOf={props.sizeOf}
						onDone={(message) => {
							close();
							toast(message);
						}}
					/>
				) : null;
			}
			case "summarise":
			case "draftDecision": {
				if (!boardAi) return null;
				const only = selected.length === 1 ? selected[0]?.data.shape : undefined;
				const what =
					only?.type === "section"
						? only.title?.trim()
							? `the “${only.title.trim()}” section`
							: "this section"
						: countWords(selected.map((n) => n.data.shape.type));
				return (
					<DraftPanel
						key={open}
						mode={open === "summarise" ? "summary" : "decision"}
						ai={boardAi}
						doc={doc}
						shapes={ids}
						what={what}
						author={authorFor(user)}
						sizeOf={(id) => {
							const size = props.sizeOf(id);
							return size ? { w: size.width, h: size.height } : undefined;
						}}
						onPlaced={(placed, box, message) => {
							close();
							store.getState().resetSelectedElements();
							requestAnimationFrame(() => store.getState().addSelectedNodes(placed));
							reveal([box]);
							toast(message);
						}}
					/>
				);
			}
			case "backlink":
				return (
					<BacklinkFor
						{...props}
						targets={cards.filter((c) => c.card.writable !== false)}
						onDone={(message) => {
							close();
							toast(message);
						}}
						services={services}
						store={store}
						bar={bar}
					/>
				);
			default:
				return null;
		}
	};

	const label = actions.find((a) => a.id === open)?.label ?? "";
	return (
		<SelectionBar
			ids={ids}
			visible={!dragging && !typing}
			below={14}
			above={aboveOffset}
			prefer={lone ? "above" : "below"}
			// Above every shape, including selected ones, even for sections,
			// whose own stacking is far below everything else.
			zIndex={TOOLBAR_Z}
			bar={bar}
		>
			<div
				ref={bar}
				className="selection-actions nodrag nopan"
				role="toolbar"
				aria-label="Stage changes"
				aria-orientation="horizontal"
				data-open={open ?? undefined}
				data-section={lone ? true : undefined}
				onKeyDown={onBarKey}
				// Tab comes back to whichever item the keyboard or pointer was last on.
				onFocus={(event) => {
					const at = focusableActions(bar.current).findIndex(
						(item) => item === (event.target as Element),
					);
					if (at >= 0) setCurrent(at);
				}}
			>
				<BarItems
					leading={lone && loneShape ? sectionSettings(lone.id, loneShape, doc) : []}
					entries={entries}
					hidden={hidden}
					more={more}
					menuLabel={lone ? "More for this section" : "More for the selection"}
				/>
				{allUnwritable && (
					<a className="selection-actions-install" href={installUrl()}>
						Install the app
					</a>
				)}
				{open && (
					<Popover
						label={label}
						onClose={close}
						wide={
							open === "backlink" ||
							open === "parentIssue" ||
							open === "expandRelated" ||
							open === "carryOver" ||
							open === "groupThese" ||
							open === "summarise" ||
							open === "draftDecision"
						}
					>
						{panel()}
					</Popover>
				)}
			</div>
		</SelectionBar>
	);
}

/** The bar's buttons, in order. Unavailable ones too: their tooltip says why. */
function focusableActions(bar: HTMLElement | null): HTMLButtonElement[] {
	return bar
		? [...bar.querySelectorAll<HTMLButtonElement>("[data-bar-item]")].filter(
				(item) => !item.closest(".action-popover, .bar-menu"),
			)
		: [];
}

/** How tall a section's title is over it, on screen at 100% (sections.css). */
const SECTION_TITLE = 32;

/**
 * A lone section's settings, leading its bar: Colour | Display, before its
 * Facilitate, Actions and AI groups.
 */
function sectionSettings(id: string, shape: ShapeNode["data"]["shape"], doc: Y.Doc): ReactNode[] {
	const color = (SECTION_COLORS as readonly string[]).includes(shape.color ?? "")
		? (shape.color as SectionColor)
		: "grey";
	return [
		<SectionColour
			key="colour"
			color={color}
			onColor={(next) => updateShapes(doc, [id], { color: next })}
		/>,
		<DisplaySwitch key="display" id={id} shape={shape} />,
	];
}

/**
 * The milestone these items share now, counting one that's staged: null for
 * none, undefined when they differ or it isn't known.
 */
function currentMilestone(doc: Y.Doc, targets: SelectedCard[]): string | null | undefined {
	const staged = new Map<string, string | null>();
	for (const change of listChanges(doc)) {
		if (change.op.kind !== "item.milestone" || !isPending(change)) continue;
		if ("key" in change.op.target) staged.set(change.op.target.key, change.op.milestone);
	}
	const values = targets.map((t) =>
		staged.has(t.key)
			? staged.get(t.key)
			: t.card.milestone === undefined
				? undefined
				: (t.card.milestone?.title ?? null),
	);
	const [first] = values;
	return values.every((v) => v === first) ? first : undefined;
}

/** Wait for repository metadata, then show what needs it. */
function MetaGate({
	repos,
	metas,
	what,
	children,
}: {
	repos: string[];
	metas: Map<string, MetaState>;
	what: string;
	children: (metas: RepoMeta[]) => ReactNode;
}) {
	const states = repos.map((repo) => metas.get(repo) ?? { status: "loading" as const, meta: null });
	if (states.some((s) => s.status === "loading" || s.status === "idle")) {
		return (
			<div className="action-loading" aria-busy="true">
				<span className="action-skeleton" />
				<span className="action-skeleton" />
				<span className="action-skeleton short" />
			</div>
		);
	}
	const missing = repos.filter((repo) => metas.get(repo)?.status !== "ready");
	if (missing.length > 0) {
		return (
			<Notice tone="warn">
				Couldn’t load {what} for {missing.map(repoName).join(", ")}. Try again in a moment.
			</Notice>
		);
	}
	return (
		<>
			{repos.length > 1 && (
				<Notice>
					Showing {what} every one of {repos.length} repositories has.
				</Notice>
			)}
			{children(states.flatMap((s) => (s.meta ? [s.meta] : [])))}
		</>
	);
}

function SetPanel({
	doc,
	kind,
	targets,
	repos,
	metas,
	onStage,
}: {
	doc: Y.Doc;
	kind: "item.labels" | "item.assignees";
	targets: SelectedCard[];
	repos: string[];
	metas: Map<string, MetaState>;
	onStage: (edits: { key: string; add: string[]; remove: string[] }[]) => void;
}) {
	const labels = kind === "item.labels";
	const items = targets.map((t) => ({
		key: t.key,
		names: withStaged(
			doc,
			t.key,
			kind,
			labels ? t.card.labels.map((l) => l.name) : t.card.assignees.map((a) => a.login),
		),
	}));
	return (
		<>
			<PopoverHead
				title={labels ? "Labels" : "Assignees"}
				detail={targets.length > 1 ? `On ${count(targets.length, "item")}` : undefined}
			/>
			<MetaGate repos={repos} metas={metas} what={labels ? "labels" : "people"}>
				{(list) => {
					const options: SetOption[] = labels
						? common(
								list.map((m) => m.labels),
								(l) => l.name,
							)
						: common(
								list.map((m) => m.assignees.map((login) => ({ login }))),
								(a) => a.login,
							).map(({ login }) => ({ name: login, avatar: avatarFor(repos[0] ?? "", login) }));
					return (
						<SetPicker
							key={kind}
							noun={labels ? "label" : "assignee"}
							options={options}
							items={items}
							onStage={onStage}
							placeholder={labels ? "Filter labels" : "Filter people"}
							empty={labels ? "This repository has no labels" : "Nobody can be assigned here"}
							render={(option) =>
								labels ? <LabelOption option={option} /> : <PersonOption option={option} />
							}
						/>
					);
				}}
			</MetaGate>
		</>
	);
}

function ParentPanel({
	doc,
	selected,
	user,
	kinds,
	options,
	hostOf,
	onDone,
}: ActionBarProps & {
	kinds: ReturnType<typeof classify>;
	options: RepoOption[];
	hostOf: (options: RepoOption[]) => string;
	onDone: (message: string) => void;
}) {
	const section = kinds.sections.length === 1 && selected.length === 1 ? kinds.sections[0] : null;
	// A stack (#73): its stickies are the sub-issues, and its name the title.
	const stack = kinds.stacks.length === 1 && selected.length === 1 ? kinds.stacks[0] : null;
	// A section's contents at any depth, a stack's stickies, or the selection itself.
	const items = useMemo((): ChildPreview[] => {
		const shapes = shapesMap(doc);
		let ids = selected.map((n) => n.id);
		if (stack) ids = membersOf(readShapes(doc), stack.id);
		if (section) {
			const links = new Map(
				[...shapes].map(([id, s]) => [
					id,
					{ type: readShape(s).type, parent: readShape(s).parent },
				]),
			);
			const structure = readStructure(links);
			const inside = descendantsOf(structure, section.id);
			// Top to bottom, then left to right, as people read a column.
			ids = inside.sort((a, b) => {
				const sa = readShape(shapes.get(a) as Y.Map<unknown>);
				const sb = readShape(shapes.get(b) as Y.Map<unknown>);
				return sa.y - sb.y || sa.x - sb.x;
			});
		}
		return ids.flatMap((id): ChildPreview[] => {
			const raw = shapes.get(id);
			if (!raw) return [];
			const shape = readShape(raw);
			if (shape.type === "sticky") {
				const input: ChildInput = { shape: id, sticky: shape.text ?? "" };
				const title = issueFromText(shape.text ?? "")?.title;
				return title ? [{ input, label: title, color: shape.color }] : [];
			}
			if (shape.type === "card" && shape.ref) {
				const card = cardStore.get(shape.ref);
				if (!isCard(card)) return [];
				return [
					{
						input: { shape: id, card: { key: shape.ref, kind: card.kind } },
						label: card.title,
						ref: card.item,
					},
				];
			}
			return [];
		});
	}, [doc, selected, section, stack]);

	// The repository most of the cards are in, or the last one used.
	const cardRepos = items.flatMap((i) => ("card" in i.input ? [repoKeyOf(i.input.card.key)] : []));
	const tally = new Map<string, number>();
	for (const repo of cardRepos) tally.set(repo, (tally.get(repo) ?? 0) + 1);
	const likely = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];

	// What's already above them: never a second parent, never a refused write.
	const services = useServices();
	const issueKeys = useMemo(
		() =>
			items.flatMap((i) =>
				"card" in i.input && i.input.card.kind === "issue" ? [i.input.card.key] : [],
			),
		[items],
	);
	const { known, checking } = useKnownParents(issueKeys, services);
	const from = useMemo(
		() => ({
			...(section ? { section: section.id } : {}),
			shapes: selected.map((n) => n.id),
		}),
		[section, selected],
	);
	const hierarchy = useMemo(
		() =>
			readHierarchy(
				doc,
				from,
				items.map((i) => i.input),
				known,
			),
		[doc, from, items, known],
	);
	const existing = hierarchy.existing;
	const previews = useMemo(
		() =>
			items.map((item): ChildPreview => {
				const has = hierarchy.parents.get(item.input.shape);
				if (!has) return item;
				const same =
					!!existing &&
					("key" in has.target && "key" in existing.target
						? has.target.key.toLowerCase() === existing.target.key.toLowerCase()
						: JSON.stringify(has.target) === JSON.stringify(existing.target));
				return { ...item, parent: { label: has.label, same } };
			}),
		[items, hierarchy, existing],
	);

	return (
		<ParentIssuePanel
			title={
				section
					? sectionTitle(doc, section.id)
					: stack && nameState(stack.data.shape) !== "none"
						? (stackName(stack.data.shape) ?? "")
						: ""
			}
			from={section ? "this section" : stack ? "this stack" : "the selection"}
			items={previews}
			repos={options}
			host={hostOf(options)}
			initialRepo={likely ?? recentRepos()[0] ?? options[0]?.repo ?? null}
			existing={existing ? { label: existing.label, title: existing.title } : null}
			checking={checking}
			onStage={(repo, title, mode, assignable) => {
				// New sub-issues from stickies are assigned to their volunteers.
				const result = stageParentIssue(
					doc,
					{
						repo,
						title,
						shapes: section
							? [section.id]
							: stack
								? [stack.id, ...items.map((i) => i.input.shape)]
								: selected.map((n) => n.id),
						// Its card goes above the section, or above its sub-issues
						// (a stack spreads out as its stickies become cards).
						near: section ? [section.id] : "children",
					},
					items.map((i) => i.input),
					stagerFor(user),
					{ hierarchy, mode, assignable },
				);
				rememberRepo(repo);
				const moved = result.moved > 0 ? `, moving ${result.moved}` : "";
				onDone(
					result.into && existing
						? `Staged ${count(result.children, "sub-issue")} for ${existing.label}${existing.title ? ` ${existing.title}` : ""}`
						: `Staged “${title.trim()}” with ${count(result.children, "sub-issue")}${moved} for ${repoName(repo)}`,
				);
			}}
		/>
	);
}

function BacklinkFor({
	doc,
	nodes,
	targets,
	sizeOf,
	user,
	services,
	store,
	bar,
	onDone,
}: ActionBarProps & {
	targets: SelectedCard[];
	services: ReturnType<typeof useServices>;
	store: ReturnType<typeof useStoreApi>;
	bar: React.RefObject<HTMLDivElement | null>;
	onDone: (message: string) => void;
}) {
	// Worked out once, when the panel opens: the snapshot is of this moment.
	const [setup] = useState(() => {
		const boxOf = (node: ShapeNode): Rect => ({
			...node.position,
			...(sizeOf(node.id) ?? { width: 240, height: 120 }),
		});
		const byShape = new Map(nodes.map((n) => [n.id, n]));
		const selection = unionRect(
			targets.flatMap((t) =>
				byShape.get(t.shape) ? [boxOf(byShape.get(t.shape) as ShapeNode)] : [],
			),
		) ?? { x: 0, y: 0, width: 1, height: 1 };
		const { transform, width, height } = store.getState();
		const [tx, ty, zoom] = transform;
		const visible = { x: -tx / zoom, y: -ty / zoom, width: width / zoom, height: height / zoom };
		const boardCards: BoardCard[] = nodes.flatMap((node) => {
			const ref = node.data.shape.ref;
			if (node.data.shape.type !== "card" || !ref) return [];
			const card = cardStore.get(ref);
			return [
				{
					shape: node.id,
					key: ref,
					public: isCard(card) && card.visibility === "public",
					box: boxOf(node),
				},
			];
		});
		const publicRepos = new Set(boardCards.filter((c) => c.public).map((c) => repoKeyOf(c.key)));
		// What's around it, so the frame takes neighbours in whole. Sections are
		// backdrops, but their titles above them aren't cut either.
		const shapes = nodes.map((node) => {
			const box = boxOf(node);
			return node.type === "section" ? { ...box, y: box.y - 36, width: 220, height: 32 } : box;
		});
		return { selection, visible, boardCards, publicRepos, shapes };
	});
	const region = useMemo(
		() => snapshotRegionFor(setup.selection, setup.visible, setup.shapes),
		[setup],
	);

	return (
		<BacklinkPanel
			cards={targets}
			boardCards={setup.boardCards}
			region={region}
			flow={() => bar.current?.closest<HTMLElement>(".react-flow") ?? null}
			sizeOf={sizeOf}
			isPublicItem={(key) => {
				const card = cardStore.get(key);
				if (isCard(card)) return card.visibility === "public";
				return setup.publicRepos.has(repoKeyOf(key));
			}}
			boardId={services.boardId}
			onStage={async (groups, note) => {
				const byShape = new Map(nodes.map((n) => [n.id, n]));
				// The section a card sits in, by name, if it has one.
				const sectionOf = (shape: string) => {
					const parent = byShape.get(shape)?.data.shape.parent;
					const section = parent ? byShape.get(parent)?.data.shape : undefined;
					return section?.type === "section" ? section.title?.trim() || null : null;
				};
				const comments: { key: string; body: string; shape: string; discussion?: boolean }[] = [];
				const discussions = new Set(
					targets.filter((t) => t.card.kind === "discussion").map((t) => t.key),
				);
				for (const group of groups) {
					// Only uploaded when one was asked for and drawn.
					const snapshotUrl = group.snapshot ? await services.uploadSnapshot(group.snapshot) : null;
					for (const item of group.items) {
						const body = backlinkBody({
							boardUrl: services.boardUrl(),
							boardTitle: services.boardTitle(),
							section: sectionOf(item.shape),
							snapshotUrl,
							note,
						});
						comments.push({
							key: item.key,
							body,
							shape: item.shape,
							discussion: discussions.has(item.key),
						});
					}
				}
				stageComments(doc, comments, stagerFor(user));
				onDone(`Staged ${count(comments.length, "backlink comment")}`);
			}}
		/>
	);
}

/** What a carry over did, with a way to go and look. */
export function carriedToast(
	toasts: ToastStore,
	result: { carried: number; skipped: number; board: { id: string; slug: string; title: string } },
): void {
	const { carried, skipped, board } = result;
	toasts.show({
		message:
			carried === 0
				? `They’re on “${board.title}” already`
				: `Carried ${count(carried, "action item")} over to “${board.title}”${skipped ? ` (${skipped} already there)` : ""}`,
		action: { label: "Open", run: () => location.assign(boardPath(board)) },
	});
}
