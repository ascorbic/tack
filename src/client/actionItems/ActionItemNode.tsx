import { type NodeProps, NodeToolbar, Position, useStore, useStoreApi } from "@xyflow/react";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type ActionOwner,
	actionState,
	linkActionItem,
	localDate,
	setActionDone,
	stageActionIssue,
	stageActionState,
	stagedIssueOf,
	stagedStateOf,
	unlinkActionItem,
	updateActionItem,
} from "../../shared/actionItems.ts";
import { boardRepos } from "../../shared/actions.ts";
import { DEFAULT_HOST, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import { shapesMap } from "../../shared/shapes.ts";
import type { RepoOption } from "../actions/pickers.tsx";
import { Popover } from "../actions/Popover.tsx";
import { repoName } from "../actions/selection.ts";
import { recentRepos, rememberRepo, stagerFor, useServices } from "../actions/services.ts";
import { undoToast } from "../actions/toast.ts";
import { isFresh, type ShapeNode, takeFocus } from "../board.ts";
import { useCard } from "../cardStore.ts";
import { clock } from "../clock.ts";
import { useMentionable } from "../comments/people.ts";
import { DecisionContext } from "../decisions/context.ts";
import { useDocValue } from "../decisions/useDocValue.ts";
import { DocContext, HistoryContext, ReadOnlyContext } from "../DocContext.ts";
import { scaledDuration } from "../motion.ts";
import { transactLocal } from "../undo.ts";
import { useEditing } from "../useEditing.ts";
import { WidgetContext } from "../widgets/context.ts";
import {
	type ActionLinkView,
	type ActionPicker,
	ActionItemView,
	type StagedIssueView,
} from "./ActionItemView.tsx";
import { DuePicker, LinkPicker, OwnerPicker, linkLabel } from "./pickers.tsx";

/** Below this zoom, action items show just their box and words. */
const COMPACT_ZOOM = 0.45;
/** How long the tick's burst plays. */
const CELEBRATE_MS = 700;
/** React Flow lifts selected shapes by 1000; pickers go above that. */
const TOOLBAR_Z = 3000;

/**
 * The repository `#12` means on this board: the one most of its cards and
 * linked action items are from, else the last one used.
 */
function usualRepo(doc: Y.Doc): string | null {
	const counts = new Map(boardRepos(doc).map((r) => [r.repo, r.cards] as const));
	for (const shape of shapesMap(doc).values()) {
		const ref = shape.get("ref");
		if (shape.get("type") !== "action" || typeof ref !== "string") continue;
		const repo = repoKeyOf(ref);
		counts.set(repo, (counts.get(repo) ?? 0) + 1);
	}
	const [busiest] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return busiest?.[0] ?? recentRepos()[0] ?? null;
}

export const ActionItemNode = memo(function ActionItemNode({
	data,
	selected,
}: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const history = useContext(HistoryContext);
	const { user } = useContext(DecisionContext);
	const { toasts } = useContext(WidgetContext);
	const services = useServices();
	const people = useMentionable();
	const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM);
	const id = data.id;
	const shape = data.shape;
	const text = typeof shape.text === "string" ? shape.text : "";
	const ref = shape.ref ?? "";

	const [enter] = useState(() => isFresh(id));
	const [startEditing] = useState(() => takeFocus(id));
	const [open, setOpen] = useState<ActionPicker | null>(null);
	const [celebrate, setCelebrate] = useState(false);
	const latest = useRef(text);
	latest.current = text;

	const setText = (value: string) =>
		doc && transactLocal(doc, () => updateActionItem(doc, id, { text: value }));
	const { editing, setEditing, field, handlers } = useEditing({
		selected: !!selected,
		startEditing,
		onType: (char) => setText(latest.current + char),
	});

	const card = useCard(ref);
	const state = actionState(shape, card);
	const staged = useDocValue(doc, (d) => stagedIssueOf(d, shape), shape.issue ?? "");
	const stagedState = useDocValue(doc, (d) => (ref ? stagedStateOf(d, ref) : null), ref);
	const usual = useMemo(() => (doc ? usualRepo(doc) : null), [doc, open]);

	const loaded = card && !("missing" in card) ? card : null;
	const link: ActionLinkView | null = ref
		? {
				key: ref,
				label: linkLabel(ref, usual),
				state: loaded ? loaded.state : "unknown",
				...(loaded ? { title: loaded.title, url: loaded.url } : {}),
				...(stagedState
					? {
							staged: (stagedState.op as { state: string }).state === "closed" ? "close" : "reopen",
						}
					: {}),
			}
		: null;
	const stagedIssue: StagedIssueView | null =
		staged && !ref && staged.op.kind === "issue.create"
			? {
					repo: repoName(staged.op.repo),
					status: staged.status,
					...(staged.error ? { error: staged.error } : {}),
				}
			: null;

	const tick = !ref
		? ({ can: true } as const)
		: !loaded
			? ({ can: false, why: `Its status comes from ${link?.label}, once it loads` } as const)
			: loaded.writable === false
				? ({
						can: false,
						why: `Its status comes from ${link?.label}. Tack can’t close it until the app is installed on ${repoName(repoKeyOf(ref))}.`,
					} as const)
				: loaded.kind === "pull"
					? ({ can: false, why: `Done when ${link?.label} is merged or closed` } as const)
					: ({ can: true } as const);

	// A tick that lands while you watch (yours, or the issue closing) gets a burst.
	const done = (link?.staged ? link.staged === "close" : state.status === "done") === true;
	const wasDone = useRef(done);
	useEffect(() => {
		if (done && !wasDone.current) {
			setCelebrate(true);
			const timer = setTimeout(() => setCelebrate(false), scaledDuration(CELEBRATE_MS));
			wasDone.current = done;
			return () => clearTimeout(timer);
		}
		wasDone.current = done;
	}, [done]);

	// Pickers close when the item stops being selected.
	const wasSelected = useRef(selected);
	useEffect(() => {
		if (wasSelected.current && !selected) setOpen(null);
		wasSelected.current = selected;
	}, [selected]);
	const flowStore = useStoreApi();

	const stager = user ? stagerFor(user) : { name: "Someone" };
	const toast = (message: string) => {
		if (toasts && history) undoToast(toasts, history, message);
	};

	const onToggle = () => {
		if (!doc || readOnly) return;
		if (!ref) {
			transactLocal(doc, () => setActionDone(doc, id, state.status !== "done"));
			return;
		}
		if (!tick.can) return;
		const result = stageActionState(doc, id, !done, stager);
		if (result) {
			toast(
				`Staged ${result.state === "closed" ? "closing" : "reopening"} ${link?.label}: it’s ${result.state === "closed" ? "done" : "open"} once you push`,
			);
		} else {
			toast(`Took back the change to ${link?.label}`);
		}
	};

	const me: ActionOwner | null = user?.login
		? {
				login: user.login,
				name: user.name,
				...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
			}
		: null;

	const repoOptions = (): RepoOption[] => {
		if (!doc) return [];
		const onBoard = boardRepos(doc);
		const seen = new Set(onBoard.map((r) => r.repo));
		return [
			...onBoard.map((r) => ({ repo: r.repo, cards: r.cards })),
			...recentRepos()
				.filter((r) => !seen.has(r))
				.map((repo) => ({ repo, recent: true })),
		];
	};

	// Clicking the chip whose picker is open closes it: the picker closes on
	// the press, so the click mustn't open it again.
	const closed = useRef<{ picker: ActionPicker; at: number } | null>(null);
	const close = () => {
		if (open) closed.current = { picker: open, at: performance.now() };
		setOpen(null);
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	};
	const onPicker = (next: ActionPicker) => {
		const last = closed.current;
		if (last?.picker === next && performance.now() - last.at < 400) return;
		// Opening a picker selects the item, as clicking it would.
		if (!selected) {
			const state = flowStore.getState();
			state.resetSelectedElements();
			state.addSelectedNodes([id]);
		}
		setOpen((current) => (current === next ? null : next));
	};

	const picker = () => {
		if (!doc) return null;
		switch (open) {
			case "owner":
				return (
					<OwnerPicker
						current={shape.owner}
						me={me}
						people={people}
						onPick={(owner) => {
							transactLocal(doc, () => updateActionItem(doc, id, { owner }));
							close();
						}}
					/>
				);
			case "due":
				return (
					<DuePicker
						value={shape.due}
						today={localDate(clock.now())}
						onPick={(due) => {
							transactLocal(doc, () => updateActionItem(doc, id, { due }));
							close();
						}}
					/>
				);
			case "link": {
				const options = repoOptions();
				return (
					<LinkPicker
						current={link}
						staged={stagedIssue}
						repos={options}
						host={parseRepoKey(options[0]?.repo ?? "")?.host ?? DEFAULT_HOST}
						usualRepo={usual}
						owner={shape.owner}
						canCreate={text.trim() !== ""}
						onLink={(key) => {
							transactLocal(doc, () => linkActionItem(doc, id, key));
							close();
							toast(`Linked to ${linkLabel(key, usual)}: its status follows the issue now`);
						}}
						onCreate={(repo) => {
							const change = stageActionIssue(doc, id, repo, stager, {
								boardUrl: services.boardUrl(),
								boardTitle: services.boardTitle() ?? undefined,
							});
							rememberRepo(repo);
							close();
							if (change) {
								toast(
									`Staged a new issue in ${repoName(repo)}${shape.owner ? `, assigned to @${shape.owner.login}` : ""}`,
								);
							}
						}}
						onUnlink={() => {
							transactLocal(doc, () =>
								unlinkActionItem(doc, id, ref ? state.status === "done" : false),
							);
							close();
						}}
					/>
				);
			}
			default:
				return null;
		}
	};

	const labels: Record<ActionPicker, string> = { owner: "Owner", due: "Due date", link: "Issue" };
	return (
		<>
			<ActionItemView
				text={text}
				owner={shape.owner}
				due={shape.due}
				today={localDate(clock.now())}
				state={state}
				link={link}
				stagedIssue={stagedIssue}
				carried={shape.carried}
				selected={selected}
				editing={editing}
				enter={enter}
				celebrate={celebrate}
				compact={compact && !editing}
				readOnly={readOnly}
				tick={tick}
				open={open}
				field={field}
				onText={setText}
				onStopEditing={() => setEditing(false)}
				onToggle={onToggle}
				onPicker={onPicker}
				{...handlers}
			/>
			{open && !readOnly && (
				<NodeToolbar
					nodeId={id}
					isVisible
					position={Position.Bottom}
					offset={10}
					style={{ zIndex: TOOLBAR_Z }}
				>
					<div className="action-item-toolbar nodrag nopan">
						<Popover
							label={labels[open]}
							onClose={close}
							prefer="below"
							wide={open === "link"}
							className="action-item-popover"
						>
							{picker()}
						</Popover>
					</div>
				</NodeToolbar>
			)}
		</>
	);
});
