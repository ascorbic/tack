import { useContext, useMemo } from "react";
import { canWrite, stageComments, stageTriage } from "../../shared/actions.ts";
import type { Card } from "../../shared/cards.ts";
import { type OperationKind, unstageChanges } from "../../shared/changes.ts";
import { milestoneWidget } from "../../shared/milestone.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { reviewTitle, reviewWidget } from "../../shared/review.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { pingComment, staleTitle, staleWidget } from "../../shared/stale.ts";
import { stagerFor, useRepoMeta, useRepoMetas } from "../actions/services.ts";
import { undoToast } from "../actions/toast.ts";
import { useChangesUI } from "../changes/context.ts";
import { useChangeList } from "../changes/store.ts";
import { HistoryContext } from "../DocContext.ts";
import { transactLocal } from "../undo.ts";
import { ConfigToolbar, suggestedRepo, useCompact, useRows, useWidgetHost } from "./host.tsx";
import { MilestoneConfigPanel, ReviewConfigPanel, StaleConfigPanel } from "./KindPanels.tsx";
import { MilestoneView } from "./MilestoneView.tsx";
import { ReviewView } from "./ReviewView.tsx";
import { type StagedMark, type StaleAction, StaleView } from "./StaleView.tsx";
import { useBoardCards } from "./store.ts";
import { useResizeGrips } from "./WidgetNode.tsx";

// The review queue, milestone and stale finder on the board (#43): each
// kind's view, fed by the widget runner, with its panel beside it.

interface KindProps {
	id: string;
	shape: ShapeProps;
	selected: boolean;
}

export function ReviewWidget({ id, shape, selected }: KindProps) {
	const host = useWidgetHost(id, shape, reviewWidget);
	const rows = useRows(id);
	const compact = useCompact();
	const suggested = suggestedRepo(host.doc);
	return (
		<div className="widget-frame">
			<ReviewView
				{...rows}
				title={reviewTitle(host.config)}
				config={host.config}
				status={host.status}
				selected={selected}
				enter={host.enter}
				refreshing={host.refreshing}
				compact={compact}
				suggestedRepo={suggested?.repo ?? null}
				onChange={(changes) =>
					host.change(
						changes.scope === "repo" && suggested ? { host: suggested.host, ...changes } : changes,
					)
				}
				onRefresh={host.refresh}
				onConfigure={host.toggleConfig}
			/>
			{useResizeGrips(id, shape, selected)}
			<ConfigToolbar id={id} open={host.configOpen && !host.readOnly}>
				<ReviewConfigPanel
					config={host.config}
					suggestedRepo={suggested?.repo ?? null}
					onChange={host.change}
					onClose={() => host.setConfigOpen(false)}
				/>
			</ConfigToolbar>
		</div>
	);
}

export function MilestoneWidget({ id, shape, selected }: KindProps) {
	const host = useWidgetHost(id, shape, milestoneWidget);
	const rows = useRows(id);
	const compact = useCompact();
	const { config } = host;
	const suggested = suggestedRepo(host.doc);
	// Its own repository, or while it has none, the board's busiest, to offer its milestones.
	const repoHost = config.repo ? config.host : (suggested?.host ?? config.host);
	const repo = config.repo || suggested?.repo || "";
	const meta = useRepoMeta(repo ? `${repoHost}/${repo}`.toLowerCase() : null);
	const milestones = meta.status === "ready" ? meta.meta.milestones : null;
	// The due date: from its items, which say, or else the repository's list.
	const dueOn = useMemo(() => {
		if (host.status.kind === "ready") {
			for (const result of Object.values(host.status.results)) {
				const found = result.items.find((card) => card.milestone?.title === config.milestone);
				if (found?.milestone) return found.milestone.dueOn;
			}
		}
		return milestones?.find((m) => m.title === config.milestone)?.dueOn ?? null;
	}, [host.status, milestones, config.milestone]);
	return (
		<div className="widget-frame">
			<MilestoneView
				{...rows}
				title={config.title.trim() || config.milestone || "Milestone"}
				config={config}
				status={host.status}
				dueOn={dueOn}
				selected={selected}
				enter={host.enter}
				refreshing={host.refreshing}
				compact={compact}
				milestones={repo ? (meta.status === "unknown" ? [] : milestones) : []}
				onPick={(milestone) => host.change({ host: repoHost, repo, milestone: milestone.title })}
				onRefresh={host.refresh}
				onConfigure={host.toggleConfig}
			/>
			{useResizeGrips(id, shape, selected)}
			<ConfigToolbar id={id} open={host.configOpen && !host.readOnly}>
				<MilestoneConfigPanel
					config={config}
					meta={meta}
					suggestedRepo={suggested?.repo ?? null}
					onChange={(changes) =>
						host.change(
							changes.repo && !config.repo && suggested
								? { host: suggested.host, ...changes }
								: changes,
						)
					}
					onClose={() => host.setConfigOpen(false)}
				/>
			</ConfigToolbar>
		</div>
	);
}

const ACTION_KINDS: Record<StaleAction, OperationKind> = {
	close: "item.state",
	label: "item.labels",
	ping: "item.comment",
};

/** Ready-made searches for a stale finder, around the board's busiest repository. */
export function stalePresets(
	repo: string | null,
	login: string | null = null,
): { label: string; q: string }[] {
	const short = repo?.split("/").at(-1);
	return [
		...(repo
			? [
					{ label: `Open issues in ${short}`, q: `repo:${repo} is:issue is:open` },
					{ label: `Open pull requests in ${short}`, q: `repo:${repo} is:pr is:open` },
				]
			: []),
		// Named, so it's the same list for everyone (see `listPresets`).
		{ label: "Assigned to me", q: `is:open assignee:${login ?? "@me"}` },
	];
}

export function StaleWidget({ id, shape, selected }: KindProps) {
	const host = useWidgetHost(id, shape, staleWidget);
	const rows = useRows(id);
	const compact = useCompact();
	const history = useContext(HistoryContext);
	const changesUI = useChangesUI();
	const changes = useChangeList(changesUI?.store ?? null);
	const { config, doc, board } = host;
	const suggested = suggestedRepo(host.doc);
	const items = host.status.kind === "ready" ? (host.status.results.items?.items ?? []) : [];
	const repos = useMemo(() => [...new Set(items.map((card) => repoKeyOf(card.key)))], [items]);
	const metas = useRepoMetas(repos);
	const login = board.user?.login ?? null;
	const presets = useMemo(
		() => stalePresets(suggested?.repo ?? null, login),
		[suggested?.repo, login],
	);

	// What's staged on each item, as its row shows it.
	const staged = useMemo(() => {
		const marks = new Map<string, StagedMark[]>();
		const label = config.label.trim().toLowerCase();
		for (const change of changes) {
			if (change.status !== "staged") continue;
			const op = change.op;
			if (!("target" in op) || !("key" in op.target)) continue;
			const action: StaleAction | null =
				op.kind === "item.state" && op.state === "closed"
					? "close"
					: op.kind === "item.labels" && op.add?.some((name) => name.toLowerCase() === label)
						? "label"
						: op.kind === "item.comment"
							? "ping"
							: null;
			if (!action) continue;
			const list = marks.get(op.target.key) ?? [];
			list.push({
				id: change.id,
				action,
				...(op.kind === "item.comment" && typeof op.body === "string" ? { detail: op.body } : {}),
			});
			marks.set(op.target.key, list);
		}
		return marks;
	}, [changes, config.label]);

	const boardShapes = useBoardCards(doc);
	const stager = board.user ? stagerFor(board.user) : { name: "Someone" };
	const act = (action: StaleAction, cards: Card[]) => {
		if (!doc || cards.length === 0) return;
		const targets = cards.map((card) => ({
			key: card.key,
			// The change marks the item's card, if it has one on the board, not the finder.
			shape: boardShapes?.shapesFor(card.key)[0],
			current: action === "label" ? card.labels.map((l) => l.name) : undefined,
		}));
		const ids =
			action === "close"
				? stageTriage(
						doc,
						targets,
						{ kind: "item.state", state: "closed", reason: "not_planned" },
						stager,
					)
				: action === "label"
					? stageTriage(doc, targets, { kind: "item.labels", add: [config.label.trim()] }, stager)
					: stageComments(
							doc,
							cards.map((card) => ({
								key: card.key,
								body: pingComment(card, Date.now()),
								shape: boardShapes?.shapesFor(card.key)[0],
							})),
							stager,
						);
		const what = cards.length === 1 ? (cards[0]?.item ?? "it") : `${cards.length} items`;
		const message =
			action === "close"
				? `Staged closing ${what} as not planned`
				: action === "label"
					? `Staged labelling ${what} “${config.label.trim()}”`
					: `Staged a comment asking about ${what}`;
		if (ids.length === 0) return;
		if (board.toasts && history) undoToast(board.toasts, history, message);
		else board.toasts?.show({ message });
	};

	return (
		<div className="widget-frame">
			<StaleView
				{...rows}
				title={staleTitle(config)}
				config={config}
				status={host.status}
				selected={selected}
				enter={host.enter}
				refreshing={host.refreshing}
				compact={compact}
				staged={staged}
				canAct={(card, action) => {
					if (host.readOnly) return false;
					const meta = metas.get(repoKeyOf(card.key));
					if (meta?.status === "ready" && !canWrite(meta.meta, ACTION_KINDS[action])) return false;
					if (action === "close") return card.state === "open" || card.state === "draft";
					return true;
				}}
				onAction={act}
				onUnstage={(change) => {
					if (doc) transactLocal(doc, () => unstageChanges(doc, [change]));
				}}
				presets={presets}
				onPreset={(q) => host.change(suggested && !config.q ? { q, host: suggested.host } : { q })}
				onRefresh={host.refresh}
				onConfigure={host.toggleConfig}
			/>
			{useResizeGrips(id, shape, selected)}
			<ConfigToolbar id={id} open={host.configOpen && !host.readOnly}>
				<StaleConfigPanel
					config={config}
					presets={presets}
					login={login}
					labels={[...metas.values()].flatMap((meta) =>
						meta.status === "ready" ? meta.meta.labels.map((label) => label.name) : [],
					)}
					onChange={(changes) =>
						host.change(
							changes.q && !config.q && suggested ? { host: suggested.host, ...changes } : changes,
						)
					}
					onClose={() => host.setConfigOpen(false)}
				/>
			</ConfigToolbar>
		</div>
	);
}
