import { useMemo } from "react";
import type { Card } from "../../shared/cards.ts";
import {
	type ReviewConfig,
	type ReviewStanding,
	ageTone,
	longAge,
	oldestFirst,
	pullSize,
	queueSummary,
	reviewStanding,
	shortAge,
	waitingFor,
} from "../../shared/review.ts";
import {
	Count,
	QueryErrorEmpty,
	SkeletonRows,
	WidgetEmpty,
	WidgetFoot,
	useNow,
} from "./chrome.tsx";
import type { RowProps, SearchStatus } from "./host.tsx";
import { CheckIcon, RefreshIcon, ReviewIcon, SettingsIcon } from "./icons.tsx";
import "./kinds.css";
import { ItemRow, useRowMotion } from "./rows.tsx";

// The review queue (#43), drawn without the board around it so the gallery
// can show every state. Oldest first; each row says how long it's waited
// (warming from green to red), its size, CI and where its review stands. The
// strip above sums the queue up; zoomed out, it's one big number.

export interface ReviewViewProps extends RowProps {
	title: string;
	config: ReviewConfig;
	status: SearchStatus;
	selected?: boolean;
	enter?: boolean;
	refreshing?: boolean;
	/** Zoomed out: the big number. */
	compact?: boolean;
	/** For the gallery: a fixed "now". */
	now?: number;
	/** The board's busiest repository (`owner/name`), offered while it isn't set up. */
	suggestedRepo?: string | null;
	onChange?: (changes: Partial<ReviewConfig>) => void;
	onRefresh?: () => void;
	onConfigure?: () => void;
}

/** What the queue is of, as a chip. */
function scopeChip(config: ReviewConfig): string | null {
	switch (config.scope) {
		case "me":
			return "@me";
		case "team":
			return config.team.trim() ? `@${config.team.trim().replace(/^@/, "")}` : null;
		case "repo":
			return config.repo.trim() || null;
	}
}

export function ReviewView(props: ReviewViewProps) {
	const { status, title, config, selected, enter, refreshing, compact, readOnly } = props;
	const now = useNow(props.now);
	const result = status.kind === "ready" ? status.results.pulls : undefined;
	const stale = status.kind === "ready" && status.stale;
	const chip = scopeChip(config);
	return (
		<section
			className="widget widget-review"
			data-kind="review"
			data-selected={selected || undefined}
			data-enter={enter || undefined}
			data-status={status.kind}
			data-stale={stale || undefined}
			data-compact={compact || undefined}
			aria-label={title}
		>
			<header className="widget-head widget-handle">
				<span className="widget-kind" aria-hidden="true">
					<ReviewIcon />
				</span>
				<div className="widget-heading">
					<h3 className="widget-title" title={title}>
						{title}
					</h3>
					{chip && (
						<p className="widget-query">
							<span className="widget-chip mono" data-tone="scope">
								{chip}
							</span>
							{config.drafts && <span className="widget-chip mono">drafts too</span>}
							<span className="widget-chip mono" data-tone="order">
								oldest first
							</span>
						</p>
					)}
				</div>
				{result && <Count value={result.total} one="pull request" many="pull requests" />}
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
							aria-label="Edit review queue"
							data-tooltip="Edit queue"
							data-config-toggle
							onClick={props.onConfigure}
						>
							<SettingsIcon />
						</button>
					)}
				</div>
			</header>
			<div className="widget-main">
				{compact && result ? (
					<FarQueue items={result.items} total={result.total} now={now} />
				) : (
					<div className="widget-body nowheel">
						<Body {...props} now={now} />
					</div>
				)}
			</div>
			{status.kind === "ready" && result && !compact && (
				<WidgetFoot
					at={status.at}
					stale={status.stale}
					refreshing={refreshing}
					now={now}
					onRefresh={props.onRefresh}
				>
					{result.total > result.items.length
						? `${result.items.length} of ${result.total}`
						: result.total === 0
							? "nothing waiting"
							: `${result.total} waiting`}
				</WidgetFoot>
			)}
		</section>
	);
}

function Body(props: ReviewViewProps & { now: number }) {
	const { status, config } = props;
	switch (status.kind) {
		case "unconfigured":
			return (
				<WidgetEmpty
					icon={<ReviewIcon size={20} />}
					title="Whose reviews?"
					detail="Pull requests waiting on you, a team, or everything in a repository, oldest first."
				>
					{!props.readOnly && (
						<div className="widget-presets nodrag nopan">
							<button
								type="button"
								className="widget-preset"
								onClick={() => props.onChange?.({ scope: "me" })}
							>
								Waiting on me
							</button>
							{props.suggestedRepo && (
								<button
									type="button"
									className="widget-preset"
									onClick={() =>
										props.onChange?.({ scope: "repo", repo: props.suggestedRepo ?? "" })
									}
								>
									Everything in {props.suggestedRepo.split("/").at(-1)}
								</button>
							)}
							{props.onConfigure && (
								<button type="button" className="widget-preset" onClick={props.onConfigure}>
									{config.scope === "team" ? "Pick a team…" : "A team…"}
								</button>
							)}
						</div>
					)}
				</WidgetEmpty>
			);
		case "loading":
			return <SkeletonRows widths={[0.78, 0.6, 0.86, 0.5, 0.7]} />;
		case "error":
			return (
				<QueryErrorEmpty
					what="this search"
					error={status.error}
					noun="this queue"
					editLabel="Change what it shows"
					readOnly={props.readOnly}
					now={props.now}
					onConfigure={props.onConfigure}
					onRefresh={props.onRefresh}
				/>
			);
		case "ready": {
			const result = status.results.pulls;
			if (!result || result.items.length === 0) {
				return (
					<div className="review-clear">
						<WidgetEmpty
							icon={<CheckIcon size={22} />}
							title="All caught up"
							detail={
								config.scope === "me"
									? "Nothing's waiting on your review. New requests land here as they're made."
									: "Nothing's waiting for review. New requests land here as they're made."
							}
						/>
					</div>
				);
			}
			return <Queue {...props} items={result.items} total={result.total} />;
		}
	}
}

function Queue(props: ReviewViewProps & { now: number; items: Card[]; total: number }) {
	const { now } = props;
	const sorted = useMemo(() => oldestFirst(props.items), [props.items]);
	const shown = useRowMotion(sorted);
	const summary = queueSummary(sorted, now, props.total);
	let entering = 0;
	return (
		<>
			<div className="review-summary" aria-label="The queue at a glance">
				<span className="review-stat" data-tone={ageTone(summary.oldest)}>
					Oldest <strong>{shortAge(summary.oldest)}</strong>
				</span>
				{summary.long > 0 && (
					<span className="review-stat" data-tone="long">
						<strong>{summary.long}</strong> waiting 4d+
					</span>
				)}
				{summary.failing > 0 && (
					<span className="review-stat" data-tone="fail">
						<strong>{summary.failing}</strong> failing CI
					</span>
				)}
				{summary.withAuthor > 0 && (
					<span className="review-stat" data-tone="author">
						<strong>{summary.withAuthor}</strong> with author
					</span>
				)}
			</div>
			<ul className="widget-rows" aria-label="Waiting for review">
				{shown.map(({ card, motion }) => (
					<PullRow
						key={motion === "leave" ? `leave:${card.key}` : card.key}
						card={card}
						motion={motion}
						order={motion === "enter" ? entering++ : 0}
						now={now}
						rows={props}
					/>
				))}
			</ul>
		</>
	);
}

const STANDING: Record<ReviewStanding, string> = {
	waiting: "No reviews yet",
	commented: "Reviewed, no decision yet",
	changes: "Changes requested: with the author",
	approved: "Approved",
	unknown: "Review state unknown",
};

const CI: Record<string, string> = {
	passing: "CI passing",
	failing: "CI failing",
	pending: "CI running",
	none: "No CI",
};

function PullRow({
	card,
	motion,
	order,
	now,
	rows,
}: {
	card: Card;
	motion?: ReturnType<typeof useRowMotion>[number]["motion"];
	order: number;
	now: number;
	rows: RowProps;
}) {
	const waited = waitingFor(card, now);
	const tone = ageTone(waited);
	const size = pullSize(card);
	const ci = card.pull?.checks?.state ?? null;
	const standing = reviewStanding(card);
	const failing = card.pull?.checks?.failing.map((check) => check.name) ?? [];
	return (
		<ItemRow
			card={card}
			motion={motion}
			order={order}
			rows={rows}
			className="review-row"
			data={{ standing, tone }}
			meta={
				<>
					{card.author && <span className="review-author">{card.author.login}</span>}
					{size && (
						<span
							className="review-size"
							data-size={size.bucket}
							title={`+${size.additions} −${size.deletions}${size.files !== null ? ` in ${size.files} ${size.files === 1 ? "file" : "files"}` : ""}`}
						>
							{size.bucket.toUpperCase()}
						</span>
					)}
					{ci && ci !== "none" && (
						<span
							className="review-ci"
							data-ci={ci}
							title={ci === "failing" && failing.length ? `Failing: ${failing.join(", ")}` : CI[ci]}
						>
							<span className="review-ci-dot" aria-hidden="true" />
							{ci === "failing" ? "failing" : ci === "pending" ? "running" : "passing"}
						</span>
					)}
				</>
			}
			side={
				<>
					<span className="review-standing" data-standing={standing} title={STANDING[standing]}>
						<StandingGlyph standing={standing} />
					</span>
					<span className="review-age" data-tone={tone} title={`Waiting ${longAge(waited)}`}>
						{shortAge(waited)}
					</span>
				</>
			}
		/>
	);
}

function StandingGlyph({ standing }: { standing: ReviewStanding }) {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{standing === "approved" ? (
				<>
					<circle cx="8" cy="8" r="6" />
					<path d="m5.5 8.2 1.7 1.7 3.3-3.6" />
				</>
			) : standing === "changes" ? (
				<>
					<circle cx="8" cy="8" r="6" />
					<path d="M9.5 5.5 6.75 8l2.75 2.5" />
				</>
			) : standing === "commented" ? (
				<path d="M4 3.5h8c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5H8.5L5.5 13v-2H4c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5z" />
			) : (
				<circle cx="8" cy="8" r="6" strokeDasharray="2.4 2.2" />
			)}
		</svg>
	);
}

/** Zoomed out: how many wait, and for how long the oldest has. */
function FarQueue({ items, total, now }: { items: Card[]; total: number; now: number }) {
	const summary = queueSummary(items, now, total);
	return (
		<div className="kind-far" data-tone={total === 0 ? "clear" : ageTone(summary.oldest)}>
			<span className="kind-far-number">{total}</span>
			<span className="kind-far-label">waiting for review</span>
			{total > 0 && (
				<span className="kind-far-detail">
					oldest <strong>{longAge(summary.oldest)}</strong>
					{summary.failing > 0 && ` · ${summary.failing} failing CI`}
				</span>
			)}
		</div>
	);
}
