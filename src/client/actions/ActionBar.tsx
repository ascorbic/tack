import { NodeToolbar, Position, useStore, useStoreApi } from "@xyflow/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type ChildInput,
	boardRepos,
	canWrite,
	issueFromText,
	milestoneInWords,
	pendingIssueFor,
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
import { readShape, shapesMap } from "../../shared/shapes.ts";
import type { ShapeNode } from "../board.ts";
import { installUrl } from "../CardView.tsx";
import { cardStore } from "../cardStore.ts";
import type { User } from "../presence.ts";
import { isApplePlatform, shortcutHint } from "../shortcuts.ts";
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
import {
	BacklinkIcon,
	CloseIssueIcon,
	IssueIcon,
	LabelIcon,
	MilestoneIcon,
	ParentIcon,
	PersonIcon,
	RelatedIcon,
} from "./icons.tsx";
import { type ChildPreview, MakeIssuesPanel, ParentIssuePanel } from "./IssuePanels.tsx";
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
import { undoToast } from "./toast.ts";
import { useChangesUI } from "../changes/context.ts";
import { MARK_DOT_ZOOM } from "../changes/StagedMarks.tsx";
import { useChangeList } from "../changes/store.ts";

// The selection's actions (#32, #33): a small bar under the selection that
// offers what it can become on the forge. Stickies become issues, a section
// or a cluster becomes a parent issue with sub-issues, and cards can be
// triaged or given a backlink. Every action stages changes for the push
// sheet; nothing is written until someone pushes.

const apple = isApplePlatform();

type Size = { width: number; height: number };

/** React Flow lifts selected shapes by 1000; the bar and its panels go above that. */
const TOOLBAR_Z = 3000;

/** Room the bar needs under the selection: itself, and the tool dock. */
const ROOM_BELOW = 150;

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
}

export interface Action {
	id: ActionCommand;
	label: string;
	icon: ReactNode;
	/** Shown beside the icon: the main actions are spelled out. */
	text?: string;
	/** Spelled out because the icon alone isn't obvious, not because it's the main action. */
	quiet?: boolean;
	/** Why it can't be done, if it can't. */
	unavailable?: string;
}

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
	const store = useStoreApi();
	const bar = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState<ActionCommand | null>(null);
	// Out of the way while a sticky's being written: it's for after.
	const typing = useTextEditing();
	/** The button a panel was opened from with the keyboard, to go back to. */
	const returnTo = useRef<HTMLButtonElement | null>(null);
	/** Which button Tab lands on in the bar (a roving tab stop). */
	const [current, setCurrent] = useState(0);

	const keys = useMemo(
		() =>
			selected.flatMap((n) =>
				n.data.shape.type === "card" && n.data.shape.ref ? [n.data.shape.ref] : [],
			),
		[selected],
	);
	const cardData = useCards(keys);
	const kinds = useMemo(() => classify(selected, cardData), [selected, cardData]);
	const { stickies, cards, cardNodes, sections, others } = kinds;

	// Under the selection, unless that's off the bottom of the canvas or under
	// the tool dock: then above it, clear of the toolbars already there.
	const bottom = useMemo(
		() =>
			Math.max(
				...selected.map((n) => n.position.y + (props.sizeOf(n.id)?.height ?? n.height ?? 0)),
			),
		[selected, props.sizeOf],
	);
	const roomBelow = useStore(
		(s) => s.height - (bottom * s.transform[2] + s.transform[1]) > ROOM_BELOW,
	);
	// Above, the bar also keeps clear of the marks on what's staged, which
	// stay legible (and so tall) however far out the board is.
	const changesUI = useChangesUI();
	const staged = useChangeList(changesUI?.store ?? null);
	const marked = useMemo(
		() =>
			staged.length > 0 && selected.some((n) => (changesUI?.store.forShape(n.id).length ?? 0) > 0),
		[staged, selected, changesUI],
	);
	const markZoom = useStore((s) =>
		s.transform[2] < MARK_DOT_ZOOM ? 0 : Math.round(Math.max(0.8, s.transform[2]) * 20) / 20,
	);
	const markRoom = marked ? (markZoom === 0 ? 22 : Math.ceil(40 * markZoom)) : 0;
	const aboveOffset =
		18 +
		markRoom +
		(selected.length >= 2 ? 52 : 0) +
		(stickies.length + others.length > 0 ? 52 : 0) +
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
				unavailable: fresh.length === 0 ? "Already staged as issues" : undefined,
			});
		}
		if (onlyStickies && stickies.every((s) => !s.data.shape.silent)) {
			out.push({
				id: "toActions",
				label: stickies.length === 1 ? "Make an action item" : "Make action items",
				icon: <ActionItemIcon />,
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
				text: "Carry over",
				unavailable: open.length === 0 ? "They’re all done" : undefined,
			});
		}
		if (onlySection || clustered || (onlyStickies && stickies.length >= 2)) {
			out.push({
				id: "parentIssue",
				label: onlySection ? "Make a parent issue from this section" : "Make a parent issue",
				icon: <ParentIcon />,
				text: onlySection || clustered ? "Parent issue" : undefined,
			});
		}
		// Not a change to stage: it lays out what's already linked, so it's
		// there whether or not Tack can write to the repository.
		if (onlyCards && cardNodes.length === 1 && cards.length === 1) {
			out.push({
				id: "expandRelated",
				label: "Expand related items",
				icon: <RelatedIcon />,
				text: "Related",
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
			// With room (one or two cards), the two least obvious say what they are.
			const roomy = cardNodes.length <= 2;
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
					...(roomy
						? { text: closeLabel === "Close or reopen" ? "Close…" : closeLabel, quiet: true }
						: {}),
				},
				{
					id: "backlink",
					label: "Comment with a link to this board",
					icon: <BacklinkIcon />,
					...(roomy ? { text: "Backlink", quiet: true } : {}),
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
			for (const action of triage) {
				if (!supported(action.id)) continue;
				out.push({
					...action,
					unavailable:
						none ??
						(action.id === "closeReopen" ? merged : action.id === "assign" ? nobody : undefined),
				});
			}
			const issues = cards.filter((c) => c.card.kind === "issue");
			if (issues.length >= 2) {
				out.push({ id: "parentIssue", label: "Make a parent issue", icon: <ParentIcon /> });
			}
		}
		return out;
	}, [
		doc,
		selected,
		stickies,
		cards,
		cardNodes,
		sections,
		others,
		targets,
		closable,
		repos,
		metas,
	]);

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

	useEffect(
		() =>
			requests.register((id) => {
				const action = actions.find((a) => a.id === id);
				if (!action || action.unavailable) return false;
				if (id === "toActions") makeActionItems();
				else setOpen((current) => (current === id ? null : id));
				return true;
			}),
		[requests, actions],
	);

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
	if (actions.length === 0) return null;

	/** The selected shape the bar is about, to go back to from the bar. */
	const shapeElement = () =>
		store
			.getState()
			.domNode?.querySelector<HTMLElement>(
				`.react-flow__node[data-id="${CSS.escape(ids[0] ?? "")}"]`,
			) ?? null;

	const onBarKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		// Keys inside an open panel are the panel's.
		if (!target.classList.contains("selection-action")) return;
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
				if (open) return;
				event.preventDefault();
				event.stopPropagation();
				shapeElement()?.focus();
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
						}))}
						staged={staged}
						repos={options}
						host={hostOf(options)}
						initialRepo={recentRepos()[0] ?? options[0]?.repo ?? null}
						onStage={(repo, extras) => {
							const result = stageStickyIssues(
								doc,
								stickies.map((s) => ({ id: s.id, text: s.data.shape.text ?? "" })),
								repo,
								stager,
								extras,
							);
							rememberRepo(repo);
							close();
							const labels = extras.labels?.length ?? 0;
							toast(
								`Staged ${count(result.staged.length, "issue")} for ${repoName(repo)}${labels ? `, with ${count(labels, "label")}` : ""}`,
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
									return { ...e, shape: byKey.get(e.key)?.shape, current };
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
						onPick={(choice) => {
							const items = choice.state === "open" ? closedItems : openItems;
							const reason =
								choice.state === "open" || items.every((t) => t.card.kind === "pull")
									? undefined
									: choice.reason;
							stageTriage(
								doc,
								items.map((t) => ({ key: t.key, shape: t.shape })),
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
		<NodeToolbar
			nodeId={ids}
			isVisible={!dragging && !typing}
			position={roomBelow ? Position.Bottom : Position.Top}
			offset={roomBelow ? 14 : aboveOffset}
			// Above every shape, including selected ones, even for sections,
			// whose own stacking is far below everything else.
			style={{ zIndex: TOOLBAR_Z }}
		>
			<div
				ref={bar}
				className="selection-actions nodrag nopan"
				role="toolbar"
				aria-label="Stage changes"
				aria-orientation="horizontal"
				data-open={open ?? undefined}
				onKeyDown={onBarKey}
			>
				{actions.map((action, i) => (
					<ActionButton
						key={`${action.id}-${i}`}
						action={action}
						pressed={open === action.id}
						tabStop={i === Math.min(current, actions.length - 1)}
						onClick={(event) => {
							setCurrent(i);
							if (action.unavailable) return;
							// From the keyboard (no pointer): come back here when the panel closes.
							returnTo.current = event.detail === 0 ? event.currentTarget : null;
							if (action.id === "toActions") makeActionItems();
							else setOpen((was) => (was === action.id ? null : action.id));
						}}
					/>
				))}
				{allUnwritable && (
					<a className="selection-actions-install" href={installUrl()}>
						Install the app
					</a>
				)}
				{open && (
					<Popover
						prefer={roomBelow ? "below" : "above"}
						label={label}
						onClose={close}
						wide={
							open === "backlink" ||
							open === "parentIssue" ||
							open === "expandRelated" ||
							open === "carryOver"
						}
					>
						{panel()}
					</Popover>
				)}
			</div>
		</NodeToolbar>
	);
}

/** The bar's buttons, in order. Unavailable ones too: their tooltip says why. */
function focusableActions(bar: HTMLElement | null): HTMLButtonElement[] {
	return bar ? [...bar.querySelectorAll<HTMLButtonElement>(":scope > .selection-action")] : [];
}

export function ActionButton({
	action,
	pressed,
	tabStop = true,
	onClick,
}: {
	action: Action;
	pressed: boolean;
	/** Whether Tab lands here: one button in the bar is (a roving tab stop). */
	tabStop?: boolean;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const hint = shortcutHint(action.id, apple);
	return (
		<button
			type="button"
			className="selection-action"
			data-text={action.text ? true : undefined}
			data-quiet={action.quiet || undefined}
			aria-label={action.unavailable ? `${action.label}: ${action.unavailable}` : action.label}
			aria-expanded={action.unavailable ? undefined : pressed}
			aria-haspopup={action.unavailable ? undefined : "dialog"}
			aria-disabled={action.unavailable ? true : undefined}
			data-tooltip={action.unavailable ?? action.label}
			data-shortcut={action.unavailable ? "" : hint}
			tabIndex={tabStop ? 0 : -1}
			onClick={onClick}
		>
			{action.icon}
			{action.text && <span>{action.text}</span>}
		</button>
	);
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
	// A section's contents at any depth, or the selection itself.
	const items = useMemo((): ChildPreview[] => {
		const shapes = shapesMap(doc);
		let ids = selected.map((n) => n.id);
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
	}, [doc, selected, section]);

	// The repository most of the cards are in, or the last one used.
	const cardRepos = items.flatMap((i) => ("card" in i.input ? [repoKeyOf(i.input.card.key)] : []));
	const tally = new Map<string, number>();
	for (const repo of cardRepos) tally.set(repo, (tally.get(repo) ?? 0) + 1);
	const likely = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];

	return (
		<ParentIssuePanel
			title={section ? sectionTitle(doc, section.id) : ""}
			from={section ? "this section" : "the selection"}
			items={items}
			repos={options}
			host={hostOf(options)}
			initialRepo={likely ?? recentRepos()[0] ?? options[0]?.repo ?? null}
			onStage={(repo, title) => {
				const result = stageParentIssue(
					doc,
					{
						repo,
						title,
						shapes: section ? [section.id] : selected.map((n) => n.id),
						// Its card goes above the section, or above its sub-issues.
						near: section ? [section.id] : "children",
					},
					items.map((i) => i.input),
					stagerFor(user),
				);
				rememberRepo(repo);
				onDone(
					`Staged “${title.trim()}” with ${count(result.children, "sub-issue")} for ${repoName(repo)}`,
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
		return { selection, visible, boardCards, publicRepos };
	});
	const region = useMemo(() => snapshotRegionFor(setup.selection, setup.visible), [setup]);

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
				const comments: { key: string; body: string; shape: string }[] = [];
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
						comments.push({ key: item.key, body, shape: item.shape });
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
