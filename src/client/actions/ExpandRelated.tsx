import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { type Card, kindNoun } from "../../shared/cards.ts";
import {
	type ExpandPlan,
	GROUP_LABEL,
	RELATED_GROUPS,
	type RelatedGroup,
	applyExpand,
	boardContext,
	planExpand,
	relatedGroups,
} from "../../shared/related.ts";
import type { QueryError, RelatedResult } from "../../shared/widgets.ts";
import { StateIcon } from "../CardView.tsx";
import { cardStore } from "../cardStore.ts";
import { type Entrance, stageEntrances } from "../entering.ts";
import { useReveal } from "../reveal.ts";
import { transactLocal } from "../undo.ts";
import { RelatedIcon } from "./icons.tsx";
import { Notice, PopoverHead, SUBMIT_HINT } from "./Popover.tsx";
import { count, isCard } from "./selection.ts";
import "./related.css";
import type { WriteServices } from "./services.ts";

// Expand related (#42): fetch what's related to a card (with the viewer's
// permissions, see src/server/related.ts), choose which groups to bring in,
// and lay them out around it in one undoable step. The cards fly out from
// the one they're related to, in turn, and their connectors draw in after.

type Size = { width: number; height: number };

export type RelatedState =
	| { status: "loading" }
	| { status: "error"; error: QueryError }
	| { status: "ready"; result: RelatedResult };

/** Answers stay fresh this long, so opening the panel again is instant. */
const FRESH_MS = 15_000;
const answers = new WeakMap<
	WriteServices,
	Map<string, { at: number; answer: Promise<RelatedResult | QueryError> }>
>();

function ask(services: WriteServices, key: string, fresh = false) {
	let cache = answers.get(services);
	if (!cache) answers.set(services, (cache = new Map()));
	const known = cache.get(key);
	if (!fresh && known && performance.now() - known.at < FRESH_MS) return known.answer;
	const answer = services.related(key);
	cache.set(key, { at: performance.now(), answer });
	// Don't keep failures.
	void answer.then((result) => {
		if (result.kind === "error") cache.delete(key);
	});
	return answer;
}

export function useRelated(services: WriteServices, key: string) {
	const [state, setState] = useState<RelatedState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		setState({ status: "loading" });
		void ask(services, key, attempt > 0).then((answer) => {
			if (!live) return;
			setState(
				answer.kind === "error"
					? { status: "error", error: answer }
					: { status: "ready", result: answer },
			);
		});
		return () => {
			live = false;
		};
	}, [services, key, attempt]);
	return { state, retry: () => setAttempt((n) => n + 1) };
}

export interface RelatedItem {
	key: string;
	card: Card | null;
	/** Already on the board: it's connected where it is. */
	onBoard: boolean;
}

export interface RelatedGroupView {
	group: RelatedGroup;
	items: RelatedItem[];
}

/** The groups that have anything in them, with what's already on the board. */
export function groupViews(
	result: RelatedResult,
	onBoard: (key: string) => boolean,
): RelatedGroupView[] {
	const groups = relatedGroups(result);
	const cards = new Map(result.cards.map((card) => [card.key, card]));
	return RELATED_GROUPS.flatMap((group) => {
		const items = groups[group].map((key) => {
			const card = cards.get(key) ?? cardStore.get(key);
			return { key, card: isCard(card) ? card : null, onBoard: onBoard(key) };
		});
		return items.length > 0 ? [{ group, items }] : [];
	});
}

export interface ExpandSummary {
	/** New cards. */
	add: number;
	/** Items already on the board that get connected. */
	connect: number;
	/** Connectors in all. */
	links: number;
}

export function summarise(plan: ExpandPlan): ExpandSummary {
	const joined = new Set(
		plan.connectors
			.flatMap((c) => [c.from, c.to])
			.flatMap((end) => ("shape" in end ? [end.shape] : [])),
	);
	return {
		add: plan.cards.length,
		connect: plan.existing.filter((e) => joined.has(e.shape)).length,
		links: plan.connectors.length,
	};
}

const ARROW: Record<RelatedGroup, string> = {
	parent: "↑",
	closes: "↑",
	subIssues: "↓",
	blockedBy: "←",
	blocking: "→",
	linkedPulls: "↗",
};

/** Where each group will go, as a tiny map: the card in the middle, its groups around it. */
function Compass({
	present,
	enabled,
	hovered,
}: {
	present: ReadonlySet<RelatedGroup>;
	enabled: ReadonlySet<RelatedGroup>;
	hovered: RelatedGroup | null;
}) {
	const state = (group: RelatedGroup) =>
		!present.has(group)
			? "absent"
			: hovered === group
				? "hovered"
				: enabled.has(group)
					? "on"
					: "off";
	const up = present.has("parent") ? "parent" : "closes";
	return (
		<svg className="related-compass" viewBox="0 0 96 72" aria-hidden="true">
			<g className="related-compass-links">
				<path data-group={up} data-state={state(up)} d="M48 18v10" />
				<path
					data-group="subIssues"
					data-state={state("subIssues")}
					d="M48 44v7M30 51h36M30 51v3M48 51v3M66 51v3"
				/>
				<path data-group="blockedBy" data-state={state("blockedBy")} d="M24 36h10" />
				<path data-group="blocking" data-state={state("blocking")} d="M62 38h10" />
				<path data-group="linkedPulls" data-state={state("linkedPulls")} d="M62 32 72 22" />
			</g>
			<rect className="related-compass-card" x="34" y="28" width="28" height="16" rx="3.5" />
			<rect data-group={up} data-state={state(up)} x="38" y="5" width="20" height="12" rx="3" />
			{[20, 38, 56].map((x) => (
				<rect
					key={x}
					data-group="subIssues"
					data-state={state("subIssues")}
					x={x}
					y="55"
					width="20"
					height="12"
					rx="3"
				/>
			))}
			<rect
				data-group="blockedBy"
				data-state={state("blockedBy")}
				x="2"
				y="30"
				width="20"
				height="12"
				rx="3"
			/>
			<rect
				data-group="blocking"
				data-state={state("blocking")}
				x="74"
				y="32"
				width="20"
				height="12"
				rx="3"
			/>
			<rect
				data-group="linkedPulls"
				data-state={state("linkedPulls")}
				x="74"
				y="11"
				width="20"
				height="12"
				rx="3"
			/>
		</svg>
	);
}

const MAX_SHOWN = 3;

/**
 * The panel itself, without fetching or a board: what's related, grouped,
 * with a switch for each group, and what laying it out will do.
 */
export function RelatedPanelView({
	source,
	state,
	groups,
	enabled,
	summary,
	onToggle,
	onLayOut,
	onRetry,
}: {
	source: Card;
	state: RelatedState;
	groups: RelatedGroupView[];
	enabled: ReadonlySet<RelatedGroup>;
	summary: ExpandSummary;
	onToggle: (group: RelatedGroup) => void;
	onLayOut: () => void;
	onRetry?: () => void;
}) {
	const [hovered, setHovered] = useState<RelatedGroup | null>(null);
	// The panel opens before the answer arrives: once it has, keys go to it.
	const form = useRef<HTMLFormElement>(null);
	const ready = state.status === "ready" && groups.length > 0;
	useEffect(() => {
		if (ready)
			form.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
	}, [ready]);
	const present = new Set(groups.map((g) => g.group));
	const nothing = summary.add + summary.links === 0;
	const head = (
		<div className="related-head">
			<PopoverHead
				title="Expand related"
				detail={
					<>
						<span className="mono">{source.item}</span> {source.title}
					</>
				}
			/>
			<Compass present={present} enabled={enabled} hovered={hovered} />
		</div>
	);

	if (state.status === "loading") {
		return (
			<div className="related-panel" aria-busy="true">
				{head}
				<div className="related-loading">
					<span className="action-skeleton" />
					<span className="action-skeleton" />
					<span className="action-skeleton short" />
				</div>
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="related-panel">
				{head}
				<Notice tone={state.error.reason === "rate_limited" ? "warn" : "error"}>
					{state.error.message}
				</Notice>
				{onRetry && state.error.reason !== "no_access" && state.error.reason !== "invalid" && (
					<footer className="action-foot">
						<span className="action-summary">Nothing was changed.</span>
						<button type="button" className="action-secondary" data-autofocus onClick={onRetry}>
							Try again
						</button>
					</footer>
				)}
			</div>
		);
	}
	if (groups.length === 0) {
		return (
			<div className="related-panel">
				{head}
				<p className="related-empty">
					Nothing’s linked to this {kindNoun(source.kind)} yet: no parent, sub-issues, dependencies
					or pull requests.
				</p>
			</div>
		);
	}

	return (
		<form
			ref={form}
			className="related-panel"
			onSubmit={(event) => {
				event.preventDefault();
				if (!nothing) onLayOut();
			}}
			onKeyDown={(event) => {
				// Enter lays out from anywhere in the panel, switches included
				// (Space flips the one with focus).
				if (event.key !== "Enter" || event.target instanceof HTMLButtonElement) return;
				event.preventDefault();
				if (!nothing) onLayOut();
			}}
		>
			{head}
			<ul className="related-groups" aria-label="Related items">
				{groups.map(({ group, items }, i) => {
					const on = enabled.has(group);
					const label = items.length === 1 ? GROUP_LABEL[group].one : GROUP_LABEL[group].many;
					return (
						<li
							key={group}
							className="related-group"
							data-on={on}
							data-group={group}
							style={{ "--i": i } as React.CSSProperties}
							onPointerEnter={() => setHovered(group)}
							onPointerLeave={() => setHovered((h) => (h === group ? null : h))}
						>
							<label className="related-group-head">
								<input
									type="checkbox"
									checked={on}
									onChange={() => onToggle(group)}
									onFocus={() => setHovered(group)}
									onBlur={() => setHovered((h) => (h === group ? null : h))}
									{...(i === 0 ? { "data-autofocus": true } : {})}
								/>
								<span className="related-switch" aria-hidden="true" />
								<span className="related-arrow" aria-hidden="true">
									{ARROW[group]}
								</span>
								<span className="related-group-name">{label}</span>
								<span className="related-count">{items.length}</span>
							</label>
							<ol className="related-items">
								{items.slice(0, MAX_SHOWN).map((item) => (
									<li key={item.key} data-on-board={item.onBoard || undefined}>
										{item.card ? (
											<span className="state-icon related-state" data-state={item.card.state}>
												<StateIcon card={item.card} size={13} />
											</span>
										) : (
											<span className="related-dot" />
										)}
										<span className="mono related-ref">{refOf(item.key)}</span>
										<span className="related-title">{item.card?.title ?? ""}</span>
										{item.onBoard && <span className="related-here">On the board</span>}
									</li>
								))}
								{items.length > MAX_SHOWN && (
									<li className="related-more">and {items.length - MAX_SHOWN} more</li>
								)}
							</ol>
						</li>
					);
				})}
			</ul>
			<footer className="action-foot">
				<span className="action-summary">{describe(summary)}</span>
				<button type="submit" className="action-primary" disabled={nothing}>
					<RelatedIcon />
					Lay out
					<kbd>{SUBMIT_HINT}</kbd>
				</button>
			</footer>
		</form>
	);
}

/** `#12`, or `other/repo#12` for another repository. */
function refOf(key: string): string {
	const match = /^[^/]+\/(.+?)([#!]\d+)$/.exec(key);
	return match ? (match[2] ?? key) : key;
}

export function describe({ add, connect, links }: ExpandSummary): string {
	if (add + links === 0) return "Everything’s here and connected.";
	const parts: string[] = [];
	if (add > 0) parts.push(`Adds ${count(add, "card")}`);
	if (connect > 0) parts.push(`${add > 0 ? "connects" : "Connects"} ${connect} already here`);
	if (parts.length === 0) parts.push(`Adds ${count(links, "connector")}`);
	return parts.join(", ");
}

/** How long each card waits after the one before it, and how long connectors wait after the last. */
const STAGGER_MS = 55;
const LINKS_AFTER_MS = 240;

/**
 * Expand related for one card on the board: fetch, choose, lay out. The
 * layout is worked out afresh as the board changes, so it never lands on
 * something that moved there meanwhile.
 */
export function ExpandRelated({
	doc,
	services,
	shape,
	card,
	sizeOf,
	onDone,
}: {
	doc: Y.Doc;
	services: WriteServices;
	/** The card's shape id. */
	shape: string;
	card: Card;
	sizeOf: (id: string) => Size | undefined;
	onDone: (message: string) => void;
}) {
	const { state, retry } = useRelated(services, card.key);
	const reveal = useReveal();
	const [disabled, setDisabled] = useState<ReadonlySet<RelatedGroup>>(new Set());
	const boxSize = useMemo(
		() => (id: string) => {
			const size = sizeOf(id);
			return size ? { w: size.width, h: size.height } : undefined;
		},
		[sizeOf],
	);

	const result = state.status === "ready" ? state.result : null;
	const context = useMemo(() => boardContext(doc, shape, boxSize), [doc, shape, boxSize, result]);
	const groups = useMemo(
		() =>
			result
				? groupViews(result, (key) => {
						const at = context.onBoard.get(key);
						return !!at && at !== shape;
					})
				: [],
		[result, context, shape],
	);
	const enabled = useMemo(
		() => new Set(groups.map((g) => g.group).filter((g) => !disabled.has(g))),
		[groups, disabled],
	);
	const plan = useMemo(
		() =>
			result && context.box
				? planExpand({
						source: { id: shape, key: card.key, box: context.box },
						result,
						groups: enabled,
						...context,
					})
				: null,
		[result, context, enabled, shape, card.key],
	);
	const summary = plan ? summarise(plan) : { add: 0, connect: 0, links: 0 };

	const layOut = () => {
		if (!result || !context.box) return;
		// Plan again against the board as it is now.
		const fresh = boardContext(doc, shape, boxSize);
		if (!fresh.box) return;
		const final = planExpand({
			source: { id: shape, key: card.key, box: fresh.box },
			result,
			groups: enabled,
			...fresh,
		});
		// Show the cards straight away, rather than loading.
		for (const related of result.cards) if (!cardStore.get(related.key)) cardStore.set(related);
		const added = transactLocal(doc, () => applyExpand(doc, final, boxSize));
		const from = fresh.box;
		const centre = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
		const entrances: [string, Entrance][] = final.cards.flatMap((planned) => {
			const id = added.cards.get(planned.key);
			if (!id) return [];
			return [
				[
					id,
					{
						dx: centre.x - (planned.box.x + planned.box.w / 2),
						dy: centre.y - (planned.box.y + planned.box.h / 2),
						delay: planned.order * STAGGER_MS,
					},
				],
			];
		});
		const linksAt = final.cards.length * STAGGER_MS + LINKS_AFTER_MS;
		stageEntrances([
			...entrances,
			...added.connectors.map((id, i): [string, Entrance] => [
				id,
				{ dx: 0, dy: 0, delay: linksAt + i * 30 },
			]),
		]);
		reveal([from, ...final.cards.map((c) => c.box)]);
		onDone(message(summarise(final)));
	};

	return (
		<RelatedPanelView
			source={card}
			state={state}
			groups={groups}
			enabled={enabled}
			summary={summary}
			onToggle={(group) =>
				setDisabled((current) => {
					const next = new Set(current);
					if (next.has(group)) next.delete(group);
					else next.add(group);
					return next;
				})
			}
			onLayOut={layOut}
			onRetry={retry}
		/>
	);
}

function message({ add, connect, links }: ExpandSummary): string {
	if (add > 0 && connect > 0) {
		return `Laid out ${count(add, "related item")}, and connected ${connect} already here`;
	}
	if (add > 0) return `Laid out ${count(add, "related item")}`;
	if (connect > 0) return `Connected ${count(connect, "related item")} already on the board`;
	return `Added ${count(links, "connector")}`;
}
