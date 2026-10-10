import { type ReactNode, useContext, useMemo, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { boardRepos } from "../../shared/actions.ts";
import {
	type DependencyConfig,
	type DependencyLayout,
	boardSize,
	buildDependencyGraph,
	dependencyMembers,
	dependencyTitle,
	dependencyWidget,
	layoutDependencies,
	planDependencyBoard,
} from "../../shared/dependencyMap.ts";
import { spotBeside } from "../../shared/placement.ts";
import { type ReleaseConfig, releaseTitle, releaseWidget } from "../../shared/releaseDraft.ts";
import { CARD_WIDTH, applyExpand, boardContext } from "../../shared/related.ts";
import { type ShapeProps, shapesMap } from "../../shared/shapes.ts";
import { readShapes } from "../../shared/structure.ts";
import { type TimelineConfig, timelineTitle, timelineWidget } from "../../shared/timeline.ts";
import { cardsIn } from "../../shared/widgetContext.ts";
import { readConfig, updateWidgetConfig } from "../../shared/widgetRegistry.ts";
import type { QueryError, QueryResult, SearchResult } from "../../shared/widgets.ts";
import { isFresh, takeFocus } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { DocContext, ReadOnlyContext, SectionContext } from "../DocContext.ts";
import { type Entrance, stageEntrances } from "../entering.ts";
import { transactLocal } from "../undo.ts";
import { type WidgetState, resultState, useNow } from "./chrome.tsx";
import { WidgetContext } from "./context.ts";
import { type DependencyData, DependencyView } from "./DependencyView.tsx";
import { DependencyConfigPanel, ReleaseConfigPanel, TimelineConfigPanel } from "./panels.tsx";
import { ReleaseView } from "./ReleaseView.tsx";
import { useRowDrag } from "./RowDrag.tsx";
import { linkStore, useBoardCards, useRefreshing, useWidgetData, widgetStore } from "./store.ts";
import { TimelineView } from "./TimelineView.tsx";
import { useResizeGrips } from "./WidgetNode.tsx";
import { WidgetPanel } from "./WidgetPanel.tsx";

// The timeline, release draft and dependency map on the board (#43): each
// kind's view, fed by the widget store, with its config panel beside it,
// items that drag out as cards (with provenance `list`, like a list's
// rows), and linked highlighting with the cards already on the board.

export interface KindProps {
	id: string;
	shape: ShapeProps;
	selected: boolean;
}

/** What every one of these widgets needs from the board around it. */
function useWidgetBoard(id: string) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const board = useContext(WidgetContext);
	const data = useWidgetData(id);
	const refreshing = useRefreshing(id);
	const cards = useBoardCards(doc);
	const [enter] = useState(() => isFresh(id));
	const [configOpen, setConfigOpen] = useState(() => takeFocus(id) && !readOnly);
	const linked = useSyncExternalStore(linkStore.subscribe, () => {
		const { key, source } = linkStore.get();
		return source === "card" ? key : null;
	});
	const drag = useRowDrag({
		widget: id,
		doc,
		enabled: !readOnly,
		onPlaced: (shape) => board.select([shape]),
		seedCard: board.seedCard,
	});
	const change = (changes: Record<string, unknown>) => {
		if (doc) transactLocal(doc, () => updateWidgetConfig(doc, id, changes));
	};
	return {
		doc,
		readOnly,
		board,
		data,
		refreshing,
		enter,
		configOpen,
		setConfigOpen,
		change,
		common: {
			readOnly,
			enter,
			refreshing,
			linked,
			lifted: drag.lifted,
			onBoard: (key: string) => (cards?.shapesFor(key).length ?? 0) > 0,
			onRefresh: () => widgetStore.refresh(id),
			onConfigure: readOnly ? undefined : () => setConfigOpen((open) => !open),
			onItemPointerDown: drag.onPointerDown,
			onItemHover: (key: string | null) => linkStore.set(key, "row"),
			onReveal: (key: string) => board.reveal(cards?.shapesFor(key) ?? []),
		},
	};
}

/** The panel beside a widget. */
function Panel({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
	return (
		<WidgetPanel nodeId={id} open={open}>
			{children}
		</WidgetPanel>
	);
}

/** The board's busiest repository, `owner/name`, for suggestions. */
function suggestedRepo(doc: Y.Doc | null): string | null {
	const busiest = doc ? boardRepos(doc)[0]?.repo : undefined;
	return busiest ? busiest.split("/").slice(1).join("/") : null;
}

function busiestHost(doc: Y.Doc | null): string | null {
	return (doc ? boardRepos(doc)[0]?.repo.split("/")[0] : null) ?? null;
}

// --- Timeline -----------------------------------------------------------------------------

export function TimelineWidget({ id, shape, selected }: KindProps) {
	const ui = useWidgetBoard(id);
	const config = useMemo(() => readConfig(timelineWidget, shape.config), [shape.config]);
	const now = useNow(undefined, 60_000);
	const state: WidgetState<SearchResult> = config.q.trim()
		? resultState(ui.data, "items", "search", timelineWidget.refresh ?? 300, now)
		: { kind: "unconfigured" };
	const repo = suggestedRepo(ui.doc);
	const host = busiestHost(ui.doc);
	const change = (changes: Partial<TimelineConfig>) => ui.change(changes);
	return (
		<div className="widget-frame">
			<TimelineView
				{...ui.common}
				title={timelineTitle(config, now)}
				config={config}
				state={state}
				selected={selected}
				suggestions={
					repo ? [{ label: `Opened in ${repo.split("/").at(-1)}`, q: `repo:${repo}` }] : []
				}
				onSuggest={(q) => change({ q, ...(host ? { host } : {}) })}
			/>
			{useResizeGrips(id, shape, selected)}
			<Panel id={id} open={ui.configOpen && !ui.readOnly}>
				<TimelineConfigPanel
					config={config}
					suggestedRepo={repo}
					onChange={change}
					onClose={() => ui.setConfigOpen(false)}
				/>
			</Panel>
		</div>
	);
}

// --- Release draft ---------------------------------------------------------------------------

export function ReleaseWidget({ id, shape, selected }: KindProps) {
	const ui = useWidgetBoard(id);
	const config = useMemo(() => readConfig(releaseWidget, shape.config), [shape.config]);
	const now = useNow();
	const configured =
		Object.keys(releaseWidget.queries(config, { now, cardsIn: () => [] })).length > 0;
	const state = configured
		? resultState(ui.data, "release", "release", releaseWidget.refresh ?? 600, now)
		: ({ kind: "unconfigured" } as const);
	const repo = suggestedRepo(ui.doc);
	const host = busiestHost(ui.doc);
	const change = (changes: Partial<ReleaseConfig>) => ui.change(changes);
	return (
		<div className="widget-frame">
			<ReleaseView
				{...ui.common}
				title={releaseTitle(config)}
				config={config}
				state={state}
				selected={selected}
				suggestions={repo ? [{ label: repo, repo }] : []}
				onSuggest={(next) => change({ repo: next, ...(host ? { host } : {}) })}
				onCopied={(draft) =>
					ui.board.toasts?.show({
						message: draft.next
							? `Copied the notes for ${draft.next}: ${draft.count} pull request${draft.count === 1 ? "" : "s"}`
							: "Copied the release notes",
					})
				}
			/>
			{useResizeGrips(id, shape, selected)}
			<Panel id={id} open={ui.configOpen && !ui.readOnly}>
				<ReleaseConfigPanel
					config={config}
					suggestedRepo={repo}
					onChange={change}
					onClose={() => ui.setConfigOpen(false)}
				/>
			</Panel>
		</div>
	);
}

// --- Dependency map -------------------------------------------------------------------------------

/** How long between cards flying out, and before their connectors draw in. */
const STAGGER_MS = 70;
const LINKS_AFTER_MS = 260;

export function DependencyWidget({ id, shape, selected }: KindProps) {
	const ui = useWidgetBoard(id);
	const { doc } = ui;
	const ctx = useContext(SectionContext);
	const config = useMemo(() => readConfig(dependencyWidget, shape.config), [shape.config]);
	const now = useNow();
	// What's in the section, read again as cards come and go.
	const cardsVersion = useBoardCards(doc)?.getVersion() ?? 0;
	const inSection = useMemo(
		() =>
			doc && config.source === "section" && config.section
				? cardsIn(readShapes(doc), config.section)
				: [],
		[doc, config.source, config.section, cardsVersion, ui.data],
	);
	const sectionTitle =
		config.source === "section" && config.section && doc
			? ((shapesMap(doc).get(config.section)?.get("title") as string | undefined) ?? null)
			: null;
	const state = useDependencyState(config, ui.data, inSection, now);
	const repo = suggestedRepo(doc);
	const change = (changes: Partial<DependencyConfig>) => ui.change(changes);

	const sections = useMemo(() => {
		if (!doc || !ui.configOpen) return [];
		const shapes = readShapes(doc);
		return [...shapes]
			.filter(([, s]) => s.type === "section")
			.map(([sid, s]) => ({
				id: sid,
				title: typeof s.title === "string" ? s.title : "",
				cards: cardsIn(shapes, sid).length,
			}));
	}, [doc, ui.configOpen]);

	const expand = (keys: string[] | "all") => {
		if (!doc || state.kind !== "ready") return;
		const layout = state.value.layout;
		const shapes = readShapes(doc);
		const self = shapes.get(id);
		if (!self) return;
		const context = boardContext(doc, id, ctx.sizeOf);
		const only = keys === "all" ? undefined : keys;
		const size = only ? { w: CARD_WIDTH, h: 150 * only.length } : boardSize(layout);
		const at = spotBeside(shapes, id, size, ctx.sizeOf) ?? { x: self.x + 40, y: self.y + 40 };
		const plan = planDependencyBoard(layout, {
			at,
			onBoard: context.onBoard,
			connected: context.connected ?? (() => false),
			only,
		});
		if (plan.cards.length === 0 && plan.connectors.length === 0) {
			const existing = plan.existing.map((e) => e.shape);
			ui.board.reveal(existing);
			return;
		}
		for (const node of state.value.graph.nodes.values()) {
			if (node.card && !cardStore.get(node.key)) cardStore.set(node.card);
		}
		const added = transactLocal(doc, () => applyExpand(doc, plan, ctx.sizeOf));
		// Each card flies out from where it sits in the map.
		const origin = { x: self.x + 24, y: self.y + 96 };
		const placed = new Map(layout.nodes.map((node) => [node.key, node]));
		const entrances: [string, Entrance][] = plan.cards.flatMap((planned) => {
			const card = added.cards.get(planned.key);
			const node = placed.get(planned.key);
			if (!card) return [];
			return [
				[
					card,
					{
						dx: origin.x + (node?.x ?? 0) - planned.box.x,
						dy: origin.y + (node?.y ?? 0) - planned.box.y,
						delay: planned.order * STAGGER_MS,
					},
				],
			];
		});
		const linksAt = plan.cards.length * STAGGER_MS + LINKS_AFTER_MS;
		stageEntrances([
			...entrances,
			...added.connectors.map((cid, i): [string, Entrance] => [
				cid,
				{ dx: 0, dy: 0, delay: linksAt + i * 30 },
			]),
		]);
		const newCards = [...added.cards.values()];
		ui.board.toasts?.show({
			message:
				newCards.length > 0
					? `Put ${newCards.length} card${newCards.length === 1 ? "" : "s"} on the board${added.connectors.length > 0 ? `, connected by what blocks what` : ""}`
					: `Connected ${added.connectors.length} on the board`,
		});
		// Once they've mounted, bring them into view.
		requestAnimationFrame(() =>
			requestAnimationFrame(() =>
				ui.board.reveal([id, ...newCards, ...plan.existing.map((e) => e.shape)]),
			),
		);
	};

	return (
		<div className="widget-frame">
			<DependencyView
				{...ui.common}
				title={dependencyTitle(config, sectionTitle)}
				source={
					config.source === "section"
						? sectionTitle
							? `Cards in “${sectionTitle}”`
							: config.section
								? "A section that's gone"
								: "A section's cards"
						: config.q.trim() || "A search"
				}
				state={state}
				selected={selected}
				onExpand={ui.readOnly ? undefined : expand}
				suggestions={[
					...(repo
						? [
								{
									label: `Open issues in ${repo.split("/").at(-1)}`,
									run: () =>
										change({
											source: "search",
											q: `repo:${repo} is:issue is:open`,
											host: busiestHost(doc) ?? config.host,
										}),
								},
							]
						: []),
					...firstSections(doc).map((section) => ({
						label: `Cards in ${section.title || "a section"}`,
						run: () => change({ source: "section", section: section.id }),
					})),
				]}
			/>
			{useResizeGrips(id, shape, selected)}
			<Panel id={id} open={ui.configOpen && !ui.readOnly}>
				<DependencyConfigPanel
					config={config}
					sections={sections}
					suggestedRepo={repo}
					onChange={change}
					onClose={() => ui.setConfigOpen(false)}
				/>
			</Panel>
		</div>
	);
}

/** A couple of the board's sections with cards in, to suggest mapping. */
function firstSections(doc: Y.Doc | null): { id: string; title: string }[] {
	if (!doc) return [];
	const shapes = readShapes(doc);
	return [...shapes]
		.filter(([sid, s]) => s.type === "section" && cardsIn(shapes, sid).length > 1)
		.slice(0, 2)
		.map(([sid, s]) => ({ id: sid, title: typeof s.title === "string" ? s.title : "" }));
}

/** A dependency map's graph and layout, from its results. */
export function useDependencyState(
	config: DependencyConfig,
	data: { results: Record<string, QueryResult | QueryError>; at: number } | undefined,
	inSection: string[],
	now: number,
): WidgetState<DependencyData> {
	return useMemo(
		() => dependencyState(config, data, inSection, now),
		[config, data, inSection, now],
	);
}

export function dependencyState(
	config: DependencyConfig,
	data: { results: Record<string, QueryResult | QueryError>; at: number } | undefined,
	inSection: string[],
	now: number,
): WidgetState<DependencyData> {
	const unconfigured = config.source === "search" ? !config.q.trim() : !config.section;
	if (unconfigured) return { kind: "unconfigured" };
	if (!data) return { kind: "loading" };
	if (config.source === "search") {
		const items = resultState(data, "items", "search", dependencyWidget.refresh ?? 600, now);
		if (items.kind !== "ready") return items;
	}
	const members = dependencyMembers(config, data.results, inSection);
	const graph = buildDependencyGraph(members, data.results, (key) => cardStore.get(key));
	// Nothing could be read at all: say why, rather than drawing nothing.
	if (members.length > 0 && graph.unreadable.length === members.length) {
		const first = data.results[`related:${members[0]}`];
		if (first?.kind === "error") return { kind: "error", error: first };
	}
	const layout: DependencyLayout = layoutDependencies(graph);
	return {
		kind: "ready",
		value: { graph, layout },
		at: data.at,
		stale: now - data.at > (dependencyWidget.refresh ?? 600) * 2000,
	};
}
