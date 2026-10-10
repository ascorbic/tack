import { type CSSProperties, type PointerEvent, useMemo, useState } from "react";
import type { Card } from "../../shared/cards.ts";
import {
	type BurnUp,
	type MilestoneConfig,
	RISK_LABELS,
	atRisk,
	burnUp,
	dueOf,
	late,
	progress,
} from "../../shared/milestone.ts";
import type { Milestone } from "../../shared/push.ts";
import { Empty, LiveFooter, QueryErrorState, useTick } from "./chrome.tsx";
import type { RowProps, SearchStatus } from "./host.tsx";
import { MilestoneIcon, RefreshIcon, SettingsIcon } from "./icons.tsx";
import "./kinds.css";
import { ItemRow, useRowMotion } from "./rows.tsx";

// The milestone widget (#43), drawn without the board around it: progress
// as a ring, the due date and a forecast from the recent pace, a burn-up of
// scope against done (scrub it to read any day), and the open items most at
// risk, which come out as cards like any row. Zoomed out, just the ring.

const DAY = 86_400_000;

export interface MilestoneViewProps extends RowProps {
	title: string;
	config: MilestoneConfig;
	status: SearchStatus;
	/** The milestone's due date, from its items or the repository. */
	dueOn?: string | null;
	selected?: boolean;
	enter?: boolean;
	refreshing?: boolean;
	compact?: boolean;
	now?: number;
	/** While it isn't set up: the suggested repository's milestones (null while loading). */
	milestones?: Milestone[] | null;
	onPick?: (milestone: Milestone) => void;
	onRefresh?: () => void;
	onConfigure?: () => void;
}

const dateText = (at: number) =>
	new Date(at).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });

export function MilestoneView(props: MilestoneViewProps) {
	const { status, title, config, selected, enter, refreshing, compact, readOnly } = props;
	const now = useTick(props.now);
	const open = status.kind === "ready" ? status.results.open : undefined;
	const closed = status.kind === "ready" ? status.results.closed : undefined;
	const stats = open && closed ? progress(open.total, closed.total) : null;
	const due = dueOf(props.dueOn, now, stats !== null && stats.total > 0 && stats.open === 0);
	const stale = status.kind === "ready" && status.stale;
	return (
		<section
			className="widget widget-milestone"
			data-kind="milestone"
			data-selected={selected || undefined}
			data-enter={enter || undefined}
			data-status={status.kind}
			data-stale={stale || undefined}
			data-compact={compact || undefined}
			aria-label={title}
		>
			<header className="widget-head widget-handle">
				<span className="widget-kind" aria-hidden="true">
					<MilestoneIcon />
				</span>
				<div className="widget-heading">
					<h3 className="widget-title" title={title}>
						{title}
					</h3>
					{config.repo && config.milestone && (
						<p className="widget-query">
							<span className="widget-chip mono" data-tone="scope">
								{config.repo}
							</span>
							{(props.dueOn || stats) && (
								<span className="widget-chip milestone-due" data-due={due.tone}>
									{due.text}
								</span>
							)}
						</p>
					)}
				</div>
				<div className="widget-tools nodrag nopan">
					{status.kind !== "unconfigured" && props.onRefresh && (
						<button
							type="button"
							className="widget-tool"
							aria-label="Refresh"
							data-tooltip="Refresh"
							data-spinning={refreshing || undefined}
							onClick={props.onRefresh}
						>
							<RefreshIcon />
						</button>
					)}
					{!readOnly && props.onConfigure && (
						<button
							type="button"
							className="widget-tool"
							aria-label="Edit milestone"
							data-tooltip="Edit milestone"
							data-config-toggle
							onClick={props.onConfigure}
						>
							<SettingsIcon />
						</button>
					)}
				</div>
			</header>
			<div className="widget-main">
				{compact && stats ? (
					<div className="kind-far milestone-far" data-due={due.tone}>
						<Ring ratio={stats.ratio} size={200} complete={stats.total > 0 && stats.open === 0} />
						<span className="kind-far-label">
							{stats.closed} of {stats.total} done
						</span>
						<span className="kind-far-detail">{due.text}</span>
					</div>
				) : (
					<div className="widget-body nowheel">
						<Body {...props} now={now} />
					</div>
				)}
			</div>
			{status.kind === "ready" && stats && !compact && (
				<LiveFooter
					at={status.at}
					stale={status.stale}
					refreshing={refreshing}
					now={now}
					onRefresh={props.onRefresh}
				>
					{stats.open} open · {stats.closed} closed
				</LiveFooter>
			)}
		</section>
	);
}

function Body(props: MilestoneViewProps & { now: number }) {
	const { status, now } = props;
	switch (status.kind) {
		case "unconfigured":
			return <Choose {...props} />;
		case "loading":
			return <Loading />;
		case "error":
			return (
				<QueryErrorState
					error={status.error}
					noun="milestone"
					editLabel="Pick another milestone"
					readOnly={props.readOnly}
					now={now}
					onConfigure={props.onConfigure}
					onRefresh={props.onRefresh}
				/>
			);
		case "ready": {
			const open = status.results.open;
			const closed = status.results.closed;
			if (!open || !closed || open.total + closed.total === 0) {
				return (
					<Empty
						icon={<MilestoneIcon size={20} />}
						title="Nothing in this milestone yet"
						detail="Its issues and pull requests show up here, with how it's going, as they're added."
					/>
				);
			}
			return (
				<Report
					{...props}
					// Results newer than the last tick count up to when they came.
					now={Math.max(now, status.at)}
					open={open.items}
					closed={closed.items}
					totals={{ open: open.total, closed: closed.total }}
				/>
			);
		}
	}
}

/** Not set up: pick one of the repository's milestones right here. */
function Choose(props: MilestoneViewProps) {
	const { milestones, now = Date.now() } = props;
	return (
		<Empty
			icon={<MilestoneIcon size={20} />}
			title="Which milestone?"
			detail={
				milestones && milestones.length > 0
					? "Pick one to follow its progress, pace and risks."
					: "Pick a repository and one of its milestones to follow how it's going."
			}
		>
			{milestones === null && !props.readOnly && (
				<div className="milestone-choices" aria-busy="true">
					<span className="skeleton" />
					<span className="skeleton" />
				</div>
			)}
			{milestones && milestones.length > 0 && !props.readOnly && (
				<div className="milestone-choices nodrag nopan" role="list">
					{milestones.slice(0, 4).map((milestone, i) => {
						const due = dueOf(milestone.dueOn, now);
						return (
							<button
								key={milestone.title}
								type="button"
								role="listitem"
								className="milestone-choice"
								style={{ "--i": i } as CSSProperties}
								onClick={() => props.onPick?.(milestone)}
							>
								<MilestoneIcon size={14} />
								<strong>{milestone.title}</strong>
								<span data-due={due.tone}>{due.text}</span>
							</button>
						);
					})}
				</div>
			)}
			{!props.readOnly && props.onConfigure && (
				<button type="button" className="widget-action" onClick={props.onConfigure}>
					{milestones && milestones.length > 0 ? "Another repository…" : "Set it up"}
				</button>
			)}
		</Empty>
	);
}

function Loading() {
	return (
		<div className="milestone-report" aria-busy="true" aria-label="Loading">
			<div className="milestone-hero">
				<span className="skeleton milestone-ring-skeleton" />
				<span className="milestone-hero-text">
					<span className="skeleton" style={{ width: "70%" }} />
					<span className="skeleton short" />
				</span>
			</div>
			<span className="skeleton milestone-chart-skeleton" />
		</div>
	);
}

function Report(
	props: MilestoneViewProps & {
		now: number;
		open: Card[];
		closed: Card[];
		totals: { open: number; closed: number };
	},
) {
	const { now, open, closed, totals, dueOn, config } = props;
	const stats = progress(totals.open, totals.closed);
	const burn = useMemo(
		() => burnUp(open, closed, { now, totals }),
		[open, closed, now, totals.open, totals.closed],
	);
	const due = dueOf(dueOn, now, stats.open === 0);
	const behind = late(burn.forecast, dueOn);
	const risks = useMemo(
		() => atRisk(open, { now, dueOn, staleDays: config.staleDays }),
		[open, now, dueOn, config.staleDays],
	);
	const riskCards = useMemo(() => risks.map((risk) => risk.card), [risks]);
	const shown = useRowMotion(riskCards);
	const reasons = new Map(risks.map((risk) => [risk.card.key, risk]));
	let entering = 0;
	return (
		<div className="milestone-report">
			<div className="milestone-hero">
				<Ring ratio={stats.ratio} complete={stats.total > 0 && stats.open === 0} />
				<div className="milestone-hero-text">
					<p className="milestone-done">
						<strong>{stats.closed}</strong> of {stats.total} done
					</p>
					<p className="milestone-due-line" data-due={due.tone}>
						{due.text}
						{due.days !== null && dueOn && due.tone !== "done" && (
							<span className="milestone-date"> · {dateText(Date.parse(dueOn))}</span>
						)}
					</p>
					<p className="milestone-forecast" data-late={behind ?? undefined}>
						{forecastText(burn, behind, stats.open)}
					</p>
				</div>
			</div>
			<BurnChart burn={burn} dueOn={dueOn ?? null} now={now} />
			<div className="milestone-risks" hidden={stats.open === 0}>
				<h4 className="milestone-risks-title">
					{risks.length > 0 ? (
						<>
							At risk <span className="widget-count">{risks.length}</span>
						</>
					) : (
						"Nothing at risk"
					)}
				</h4>
				{risks.length === 0 ? (
					<p className="milestone-calm">
						Everything open has moved in the last {config.staleDays} days, and nothing's blocked.
					</p>
				) : (
					<ul className="widget-rows" aria-label="At risk">
						{shown.map(({ card, motion }) => {
							const risk = reasons.get(card.key);
							return (
								<ItemRow
									key={motion === "leave" ? `leave:${card.key}` : card.key}
									card={card}
									motion={motion}
									order={motion === "enter" ? entering++ : 0}
									rows={props}
									meta={risk?.reasons.map((reason) => (
										<span key={reason} className="milestone-risk" data-reason={reason}>
											{reason === "stale" ? `Quiet ${risk.idle}d` : RISK_LABELS[reason]}
										</span>
									))}
								/>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}

function forecastText(burn: BurnUp, behind: boolean | null, open: number): string {
	if (open === 0) return "Everything's closed.";
	if (burn.forecast === null) return "Nothing's closed lately, so there's no pace to go by.";
	const pace = Math.round(burn.pace * 10) / 10;
	const at = `At ${pace} a week, done ${dateText(burn.forecast)}`;
	return behind === true
		? `${at}: later than it's due.`
		: behind === false
			? `${at}: on track.`
			: `${at}.`;
}

/** Progress as a ring that fills when it arrives. */
function Ring({
	ratio,
	size = 84,
	complete = false,
}: {
	ratio: number;
	size?: number;
	complete?: boolean;
}) {
	const r = 42;
	const length = 2 * Math.PI * r;
	const percent = Math.round(ratio * 100);
	return (
		<span
			className="milestone-ring"
			data-complete={complete || undefined}
			style={{ "--ring": `${size}px` } as CSSProperties}
			role="img"
			aria-label={`${percent}% done`}
		>
			<svg viewBox="0 0 100 100" aria-hidden="true">
				<circle className="milestone-ring-track" cx="50" cy="50" r={r} />
				<circle
					className="milestone-ring-fill"
					cx="50"
					cy="50"
					r={r}
					strokeDasharray={length}
					style={{ "--offset": length * (1 - ratio), "--length": length } as CSSProperties}
				/>
			</svg>
			<span className="milestone-ring-value">
				{percent}
				<small>%</small>
			</span>
		</span>
	);
}

/**
 * The burn-up: scope (dashed) and done (filled), from the first item to
 * today, carried on to the due date when it's near enough to draw, with the
 * pace projected forward. Scrub it to read any day.
 */
function BurnChart({ burn, dueOn, now }: { burn: BurnUp; dueOn: string | null; now: number }) {
	const [hover, setHover] = useState<number | null>(null);
	const due = Date.parse(dueOn ?? "");
	const span = burn.end - burn.start;
	// Draw on to the due date if it's not too far off to squash the history.
	const end = !Number.isNaN(due) && due > now && due - now < span * 1.2 ? due : burn.end;
	const last = burn.points.at(-1) ?? { at: now, scope: 0, done: 0 };
	const top = Math.max(1, ...burn.points.map((p) => p.scope));
	const W = 100;
	const H = 100;
	const x = (at: number) => ((at - burn.start) / (end - burn.start)) * W;
	const y = (n: number) => H - (n / top) * H;
	const path = (key: "scope" | "done") =>
		burn.points
			.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at).toFixed(2)},${y(p[key]).toFixed(2)}`)
			.join(" ");
	const done = path("done");
	const area = `${done} L${x(last.at).toFixed(2)},${H} L${x(burn.start).toFixed(2)},${H} Z`;
	const projected =
		end > now && burn.pace > 0
			? Math.min(last.scope, last.done + (burn.pace * (end - now)) / (7 * DAY))
			: null;
	const point = hover === null ? null : burn.points[hover];
	const onMove = (event: PointerEvent<HTMLDivElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		const at = burn.start + ((event.clientX - box.left) / box.width) * (end - burn.start);
		let best = 0;
		burn.points.forEach((p, i) => {
			if (Math.abs(p.at - at) < Math.abs((burn.points[best]?.at ?? 0) - at)) best = i;
		});
		setHover(at > now + (end - now) / 2 && end > now ? null : best);
	};
	const pct = (value: number) => `${value}%`;
	return (
		<figure className="milestone-chart">
			<figcaption className="milestone-legend">
				<span className="milestone-key" data-series="done">
					Done
				</span>
				<span className="milestone-key" data-series="scope">
					Scope
				</span>
				{burn.sampled && <span className="milestone-sampled">from the latest 100 of each</span>}
			</figcaption>
			<div
				className="milestone-plot nodrag nopan"
				onPointerMove={onMove}
				onPointerLeave={() => setHover(null)}
			>
				<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
					<line className="milestone-grid" x1="0" x2={W} y1={y(top)} y2={y(top)} />
					<line className="milestone-grid" x1="0" x2={W} y1={H} y2={H} />
					<path className="milestone-area" d={area} />
					<path className="milestone-scope" d={path("scope")} />
					<path className="milestone-line" d={done} />
					{projected !== null && (
						<path
							className="milestone-projection"
							d={`M${x(now)},${y(last.done)} L${x(end)},${y(projected)}`}
						/>
					)}
					{end > now && <line className="milestone-today" x1={x(now)} x2={x(now)} y1="0" y2={H} />}
					{!Number.isNaN(due) && due >= burn.start && due <= end && (
						<line className="milestone-due-mark" x1={x(due)} x2={x(due)} y1="0" y2={H} />
					)}
					{point && (
						<line className="milestone-cursor" x1={x(point.at)} x2={x(point.at)} y1="0" y2={H} />
					)}
				</svg>
				{/* Direct labels and the scrubber, in HTML so text isn't stretched. */}
				<span
					className="milestone-end"
					data-series="scope"
					style={{ left: pct(x(last.at)), top: pct(y(last.scope)) }}
				>
					{last.scope}
				</span>
				<span
					className="milestone-end"
					data-series="done"
					style={{ left: pct(x(last.at)), top: pct(y(last.done)) }}
				>
					{last.done}
				</span>
				{point && (
					<>
						<span
							className="milestone-dot"
							data-series="scope"
							style={{ left: pct(x(point.at)), top: pct(y(point.scope)) }}
						/>
						<span
							className="milestone-dot"
							data-series="done"
							style={{ left: pct(x(point.at)), top: pct(y(point.done)) }}
						/>
						<span
							className="milestone-tip"
							style={{ left: pct(Math.min(78, Math.max(22, x(point.at)))) }}
							role="status"
						>
							<strong>{dateText(point.at)}</strong> {point.done} of {point.scope} done
						</span>
					</>
				)}
			</div>
			<div className="milestone-axis" aria-hidden="true">
				<span>{dateText(burn.start)}</span>
				{/* Today, unless it'd run into the dates at the ends. */}
				{end > now && x(now) > 18 && x(now) < 80 ? (
					<span style={{ left: pct(x(now)) }} className="milestone-axis-today">
						Today
					</span>
				) : null}
				<span>{end > now ? dateText(end) : "Today"}</span>
			</div>
			<table className="visually-hidden">
				<caption>Burn-up: items in the milestone and items done, by date</caption>
				<thead>
					<tr>
						<th>Date</th>
						<th>Scope</th>
						<th>Done</th>
					</tr>
				</thead>
				<tbody>
					{burn.points
						.filter((_, i) => i % 4 === 0 || i === burn.points.length - 1)
						.map((p) => (
							<tr key={p.at}>
								<td>{dateText(p.at)}</td>
								<td>{p.scope}</td>
								<td>{p.done}</td>
							</tr>
						))}
				</tbody>
			</table>
		</figure>
	);
}
