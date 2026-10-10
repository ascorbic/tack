import type { NodeProps } from "@xyflow/react";
import {
	memo,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type * as Y from "yjs";
import { boardRepos } from "../../shared/actions.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import type { QueryError, SearchResult } from "../../shared/widgets.ts";
import {
	type ListConfig,
	WIDGET_MIN,
	listConfig,
	listPresets,
	listWidget,
	readConfig,
	updateWidgetConfig,
	widgetDefinition,
	widgetSize,
} from "../../shared/widgetRegistry.ts";
import { resizeWidget } from "../../shared/structure.ts";
import { stagerFor } from "../actions/services.ts";
import { isFresh, type ShapeNode, takeFocus } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { DocContext, HistoryContext, ReadOnlyContext, SectionContext } from "../DocContext.ts";
import { RESIZE_HANDLES, ResizeGrip } from "../sections.tsx";
import { transactLocal } from "../undo.ts";
import { ListConfigPanel, SchemaConfigPanel } from "./ConfigPanel.tsx";
import { WidgetContext } from "./context.ts";
import { listTitle } from "./describe.ts";
import { DropConfirm } from "./DropConfirm.tsx";
import { MilestoneWidget, ReviewWidget, StaleWidget } from "./KindNodes.tsx";
import { UnknownIcon } from "./icons.tsx";
import { DependencyWidget, type KindProps, ReleaseWidget, TimelineWidget } from "./kinds.tsx";
import { type ListStatus, ListView } from "./ListView.tsx";
import { planDrop, previewOf } from "./match.ts";
import { useRowDrag } from "./RowDrag.tsx";
import { linkStore, useBoardCards, useRefreshing, useWidgetData, widgetStore } from "./store.ts";
import { WidgetPanel } from "./WidgetPanel.tsx";
import "./widgets.css";

/** Results older than this many refresh periods are stale: a refresh must have failed. */
const STALE_PERIODS = 2;

/**
 * A widget on the board (#37): its kind's view, sized by the shape, picked
 * up by its header, resized from its handles when selected, configured from
 * the panel its header opens.
 */
export const WidgetNode = memo(function WidgetNode({ id, data, selected }: NodeProps<ShapeNode>) {
	const shape = data.shape;
	const definition = widgetDefinition(shape.widget);
	if (definition?.kind === listWidget.kind) {
		return <ListWidget id={id} shape={shape} selected={!!selected} />;
	}
	const Kind = definition ? KINDS[definition.kind] : undefined;
	if (Kind) return <Kind id={id} shape={shape} selected={!!selected} />;
	return <OtherWidget id={id} shape={shape} selected={!!selected} known={definition !== null} />;
});

/** Views for kinds with their own (#43). */
const KINDS: Record<string, (props: KindProps) => React.ReactNode> = {
	timeline: TimelineWidget,
	release: ReleaseWidget,
	dependencies: DependencyWidget,
	review: ReviewWidget,
	milestone: MilestoneWidget,
	stale: StaleWidget,
};

export function useResizeGrips(id: string, shape: ShapeProps, selected: boolean) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const ui = useContext(SectionContext);
	if (!selected || !doc || readOnly) return null;
	return RESIZE_HANDLES.map((handle) => (
		<ResizeGrip
			key={handle}
			id={id}
			handle={handle}
			min={WIDGET_MIN}
			start={() => ({ x: shape.x, y: shape.y, ...widgetSize(shape) })}
			ui={ui}
			onCommit={(rect) => transactLocal(doc, () => resizeWidget(doc, id, rect, ui.sizeOf))}
		/>
	));
}

function ListWidget({ id, shape, selected }: { id: string; shape: ShapeProps; selected: boolean }) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const board = useContext(WidgetContext);
	const history = useContext(HistoryContext);
	const config = useMemo(() => listConfig(shape), [shape]);
	const title = listTitle(config);
	const configured = config.q.trim() !== "";
	const data = useWidgetData(id);
	const refreshing = useRefreshing(id);
	const cards = useBoardCards(doc);
	const [enter] = useState(() => isFresh(id));
	// A list this person just added, with nothing in it yet, opens its panel.
	const [configOpen, setConfigOpen] = useState(() => takeFocus(id) && !readOnly);
	const linked = useSyncExternalStore(linkStore.subscribe, () => {
		const { key, source } = linkStore.get();
		return source === "card" ? key : null;
	});

	// After the search changes, the results on hand are for the old one.
	const queryKey = `${config.host}\n${config.q}\n${config.sort}\n${config.limit}`;
	const [awaiting, setAwaiting] = useState(false);
	const lastQuery = useRef(queryKey);
	const lastData = useRef(data);
	useEffect(() => {
		if (lastQuery.current !== queryKey) setAwaiting(true);
		lastQuery.current = queryKey;
	}, [queryKey]);
	useEffect(() => {
		if (lastData.current !== data) setAwaiting(false);
		lastData.current = data;
	}, [data]);

	const status = listStatus(config, data, Date.now());
	const rowDrag = useRowDrag({
		widget: id,
		doc,
		enabled: !readOnly,
		onPlaced: (shape) => board.select([shape]),
		seedCard: board.seedCard,
	});

	// Cards being dragged over: what dropping them would do.
	const hovering = board.hovering?.widget === id ? board.hovering.shapes : null;
	const drop = useMemo(() => {
		if (!hovering || !doc || !configured) return null;
		return previewOf(
			planDrop(doc, hovering, config, board.user?.login, (key) => cardStore.get(key)),
		);
	}, [hovering, doc, config, configured, board.user?.login]);

	const repo = doc ? suggestedRepo(doc) : null;
	const login = board.user?.login ?? null;
	const presets = useMemo(() => listPresets(repo, login), [repo, login]);
	const change = (changes: Partial<ListConfig>) => {
		if (doc) transactLocal(doc, () => updateWidgetConfig(doc, id, changes));
	};

	return (
		<div className="widget-frame">
			<ListView
				title={title}
				q={config.q}
				status={status}
				selected={selected}
				readOnly={readOnly}
				enter={enter}
				refreshing={refreshing || (awaiting && status.kind === "ready")}
				onBoard={(key) => (cards?.shapesFor(key).length ?? 0) > 0}
				linked={linked}
				drop={drop}
				lifted={rowDrag.lifted}
				presets={presets}
				onPreset={(preset) => change({ q: preset.q, title: config.title || preset.title })}
				onRefresh={configured ? () => widgetStore.refresh(id) : undefined}
				onConfigure={readOnly ? undefined : () => setConfigOpen((open) => !open)}
				onRowHover={(key) => linkStore.set(key, "row")}
				onRowPointerDown={rowDrag.onPointerDown}
				onReveal={(key) => board.reveal(cards?.shapesFor(key) ?? [])}
			/>
			{useResizeGrips(id, shape, selected)}
			<WidgetPanel nodeId={id} open={configOpen && !readOnly}>
				<ListConfigPanel
					config={config}
					suggestedRepo={repo}
					login={login}
					showPresets={false}
					onChange={change}
					onClose={() => setConfigOpen(false)}
				/>
			</WidgetPanel>
			{board.dropped?.widget === id && doc && (
				<WidgetPanel nodeId={id} open>
					<DropConfirm
						doc={doc}
						title={title}
						plans={planDrop(doc, board.dropped.shapes, config, board.user?.login, (key) =>
							cardStore.get(key),
						)}
						stager={board.user ? stagerFor(board.user) : { name: "Someone" }}
						toasts={board.toasts}
						history={history}
						onClose={board.closeDrop}
					/>
				</WidgetPanel>
			)}
		</div>
	);
}

/** What a list shows, from its config and the latest data. */
export function listStatus(
	config: ListConfig,
	data: { results: Record<string, unknown>; at: number } | undefined,
	now: number,
): ListStatus {
	if (!config.q.trim()) return { kind: "unconfigured" };
	const result = data?.results.items as SearchResult | QueryError | undefined;
	if (!data || !result) return { kind: "loading" };
	if (result.kind === "error") return { kind: "error", error: result };
	if (result.kind !== "search") return { kind: "loading" };
	const period = (listWidget.refresh ?? 300) * 1000;
	return { kind: "ready", result, at: data.at, stale: now - data.at > period * STALE_PERIODS };
}

/** The board's busiest repository, for ready-made searches: `owner/name`. */
function suggestedRepo(doc: Y.Doc): string | null {
	const busiest = boardRepos(doc)[0]?.repo;
	return busiest ? busiest.split("/").slice(1).join("/") : null;
}

/** A widget this version can't show (or has no view for yet): it keeps its place and config. */
function OtherWidget({
	id,
	shape,
	selected,
	known,
}: {
	id: string;
	shape: ShapeProps;
	selected: boolean;
	known: boolean;
}) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const definition = widgetDefinition(shape.widget);
	const [configOpen, setConfigOpen] = useState(false);
	const config = definition
		? (readConfig(definition, shape.config) as Record<string, unknown>)
		: {};
	return (
		<div className="widget-frame">
			<section className="widget" data-selected={selected || undefined} data-status="unknown">
				<header className="widget-head widget-handle">
					<span className="widget-kind" aria-hidden="true">
						<UnknownIcon />
					</span>
					<div className="widget-heading">
						<h3 className="widget-title">
							{definition?.title ?? `A ${String(shape.widget ?? "")} widget`}
						</h3>
					</div>
					{known && !readOnly && (
						<div className="widget-tools nodrag nopan">
							<button
								type="button"
								className="widget-tool"
								aria-label="Edit widget"
								data-config-toggle
								onClick={() => setConfigOpen((open) => !open)}
							>
								⋯
							</button>
						</div>
					)}
				</header>
				<div className="widget-body">
					<div className="widget-empty">
						<span className="widget-empty-icon">
							<UnknownIcon size={20} />
						</span>
						<p className="widget-empty-title">
							{known ? "Nothing to show here yet" : "This widget needs a newer Tack"}
						</p>
						<p className="widget-empty-detail">
							{known
								? definition?.description
								: "Someone added it with a newer version. It keeps its place and settings."}
						</p>
					</div>
				</div>
			</section>
			{useResizeGrips(id, shape, selected)}
			{definition && doc && (
				<WidgetPanel nodeId={id} open={configOpen}>
					<SchemaConfigPanel
						title={definition.title}
						schema={definition.schema}
						config={config}
						onChange={(changes) => transactLocal(doc, () => updateWidgetConfig(doc, id, changes))}
						onClose={() => setConfigOpen(false)}
					/>
				</WidgetPanel>
			)}
		</div>
	);
}
