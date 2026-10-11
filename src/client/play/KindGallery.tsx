import { type CSSProperties, type ReactNode, useState } from "react";
import type { Card } from "../../shared/cards.ts";
import { type MilestoneConfig, milestoneWidget } from "../../shared/milestone.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { type ReviewConfig, reviewTitle, reviewWidget } from "../../shared/review.ts";
import { type StaleConfig, staleTitle, staleWidget } from "../../shared/stale.ts";
import type { QueryError, SearchResult } from "../../shared/widgets.ts";
import type { MetaState } from "../actions/services.ts";
import type { SearchStatus } from "../widgets/host.tsx";
import {
	MilestoneConfigPanel,
	ReviewConfigPanel,
	StaleConfigPanel,
} from "../widgets/KindPanels.tsx";
import { stalePresets } from "../widgets/KindNodes.tsx";
import { MilestoneView } from "../widgets/MilestoneView.tsx";
import { ReviewView } from "../widgets/ReviewView.tsx";
import { type StagedMark, StaleView } from "../widgets/StaleView.tsx";
import { MILESTONE, TEAM, milestoneCards, reviewCards, staleCards } from "./kindFixtures.ts";
import { REPO } from "./widgets.ts";
import { fakeMeta } from "./writes.ts";

// Every state of the review queue, milestone and stale finder (#43), for
// /play/widgets: loading, not set up, live, refreshing, stale, empty, every
// kind of error, zoomed out, and their panels.

const NOW = Date.UTC(2026, 9, 9, 14, 30);
const MIN = 60_000;
const DAY = 86_400_000;
const host = "fake.tack";

const search = (items: Card[], total = items.length): SearchResult => ({
	kind: "search",
	total,
	items,
});
const ready = (
	results: Record<string, SearchResult>,
	at = NOW - MIN,
	stale = false,
): SearchStatus => ({
	kind: "ready",
	results,
	at,
	stale,
});
const failed = (reason: QueryError["reason"], message: string, retryAt?: number): SearchStatus => ({
	kind: "error",
	error: { kind: "error", reason, message, ...(retryAt ? { retryAt } : {}) },
});

// The review queue: what's waiting on you is what's asked of “you”.
const PULLS = reviewCards(NOW);
const MINE = PULLS.filter((card) =>
	card.pull?.reviewers.some((r) => r.login === "you" && r.state === "requested"),
);
const review = (changes: Partial<ReviewConfig> = {}): ReviewConfig => ({
	...reviewWidget.defaults,
	host,
	...changes,
});

// The milestone.
const ITEMS = milestoneCards(NOW);
const OPEN = ITEMS.filter((card) => card.state === "open" || card.state === "draft");
const CLOSED = ITEMS.filter((card) => card.state === "closed");
const DUE = new Date(NOW + 18 * DAY).toISOString();
const milestone = (changes: Partial<MilestoneConfig> = {}): MilestoneConfig => ({
	...milestoneWidget.defaults,
	host,
	repo: REPO,
	milestone: MILESTONE,
	...changes,
});
const halves = (open: Card[], closed: Card[], at?: number, stale?: boolean) =>
	ready({ open: search(open), closed: search(closed) }, at, stale);
/** Late: due in four days, and the last fortnight's pace won't make it. */
const LATE_OPEN = OPEN.map((card) => ({
	...card,
	milestone: { title: MILESTONE, dueOn: new Date(NOW + 4 * DAY).toISOString() },
}));

// The stale finder.
const QUIET = staleCards(NOW);
const stale = (changes: Partial<StaleConfig> = {}): StaleConfig => ({
	...staleWidget.defaults,
	host,
	q: `repo:${REPO} is:open`,
	...changes,
});
const STAGED = new Map<string, StagedMark[]>([
	[QUIET[0]?.key ?? "", [{ id: "s1", action: "close" }]],
	[
		QUIET[3]?.key ?? "",
		[
			{ id: "s2", action: "label" },
			{ id: "s3", action: "ping" },
		],
	],
]);

const META: MetaState = { status: "ready", meta: fakeMeta(`${host}/${REPO}`) as RepoMeta };

function Sample({
	state,
	label,
	h = 480,
	w,
	children,
}: {
	state: string;
	label: string;
	h?: number;
	w?: number;
	children: ReactNode;
}) {
	return (
		<figure data-state={state}>
			<div
				className="widget-sample"
				style={{ height: h, ...(w ? { width: w } : {}) } as CSSProperties}
			>
				{children}
			</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

/** Zoomed out, as the board draws widgets below cards' compact zoom: big, then scaled down. */
function Far({ state, label, children }: { state: string; label: string; children: ReactNode }) {
	return (
		<figure data-state={state}>
			<div className="widget-sample kind-far-sample">
				<div className="kind-far-scale">{children}</div>
			</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

export function KindGallery() {
	const [reviewConfig, setReviewConfig] = useState(review({ scope: "team", team: TEAM }));
	const [milestoneConfig, setMilestoneConfig] = useState(milestone());
	const [staleConfig, setStaleConfig] = useState(stale());
	const [marks, setMarks] = useState(STAGED);
	const rows = { onBoard: (key: string) => key === OPEN[2]?.key };
	return (
		<>
			<section>
				<h2>Review queue</h2>
				<div className="gallery-grid widget-samples">
					<Sample state="review-live" label="Waiting on you, oldest first">
						<ReviewView
							{...rows}
							title={reviewTitle(review())}
							config={review()}
							status={ready({ pulls: search(MINE) })}
							now={NOW}
							onRefresh={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="review-repo" label="A repository: everything not yet approved">
						<ReviewView
							title={reviewTitle(review({ scope: "repo", repo: REPO }))}
							config={review({ scope: "repo", repo: REPO })}
							status={ready(
								{
									pulls: search(
										PULLS.filter((card) => card.pull?.review !== "approved"),
										34,
									),
								},
								NOW - 3 * MIN,
							)}
							refreshing
							now={NOW}
							onRefresh={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="review-loading" label="Loading" h={360}>
						<ReviewView
							title="Waiting on your review"
							config={review()}
							status={{ kind: "loading" }}
							now={NOW}
						/>
					</Sample>
					<Sample state="review-unconfigured" label="Not set up: whose reviews?" h={360}>
						<ReviewView
							title={reviewTitle(review({ scope: "team" }))}
							config={review({ scope: "team" })}
							status={{ kind: "unconfigured" }}
							suggestedRepo={REPO}
							selected
							now={NOW}
							onChange={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="review-clear" label="All caught up" h={360}>
						<ReviewView
							title="Waiting on your review"
							config={review()}
							status={ready({ pulls: search([]) })}
							now={NOW}
							onRefresh={() => {}}
						/>
					</Sample>
					<Sample state="review-stale" label="Stale: a refresh failed" h={420}>
						<ReviewView
							title="Waiting on @acme/maintainers"
							config={review({ scope: "team", team: TEAM })}
							status={ready(
								{
									pulls: search(
										PULLS.filter((card) =>
											card.pull?.reviewers.some((r) => r.login === "maintainers"),
										),
									),
								},
								NOW - 16 * MIN,
								true,
							)}
							now={NOW}
							onRefresh={() => {}}
						/>
					</Sample>
					<Sample state="review-signed-out" label="Signed out, about @me" h={320}>
						<ReviewView
							title="Waiting on your review"
							config={review()}
							status={failed("signed_out", "Sign in to see what “@me” means for you.")}
							now={NOW}
						/>
					</Sample>
					<Sample state="review-rate-limited" label="Rate limited" h={320}>
						<ReviewView
							title="Waiting on your review"
							config={review()}
							status={failed("rate_limited", "API rate limit exceeded.", NOW + 4 * MIN)}
							now={NOW}
						/>
					</Sample>
					<Far state="review-far" label="Zoomed out">
						<ReviewView
							title="Waiting on your review"
							config={review()}
							status={ready({ pulls: search(MINE) })}
							compact
							now={NOW}
						/>
					</Far>
				</div>
			</section>

			<section>
				<h2>Milestone</h2>
				<div className="gallery-grid widget-samples">
					<Sample state="milestone-live" label="Progress, pace and what's at risk" h={600} w={420}>
						<MilestoneView
							{...rows}
							title={MILESTONE}
							config={milestone()}
							status={halves(OPEN, CLOSED)}
							dueOn={DUE}
							now={NOW}
							onRefresh={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="milestone-late" label="Due in four days, and behind" h={600} w={420}>
						<MilestoneView
							title={MILESTONE}
							config={milestone()}
							status={halves(LATE_OPEN, CLOSED.slice(0, 5))}
							dueOn={new Date(NOW + 4 * DAY).toISOString()}
							now={NOW}
							onRefresh={() => {}}
						/>
					</Sample>
					<Sample state="milestone-overdue" label="Overdue, nothing closing" h={460} w={420}>
						<MilestoneView
							title="4.2"
							config={milestone({ milestone: "4.2" })}
							status={halves(
								OPEN.slice(0, 2),
								CLOSED.slice(6, 9).map((card) => ({
									...card,
									closedAt: new Date(NOW - 22 * DAY).toISOString(),
								})),
							)}
							dueOn={new Date(NOW - 3 * DAY).toISOString()}
							now={NOW}
						/>
					</Sample>
					<Sample state="milestone-done" label="Everything closed" h={420} w={420}>
						<MilestoneView
							title="4.1"
							config={milestone({ milestone: "4.1" })}
							status={halves([], CLOSED)}
							dueOn={new Date(NOW - 6 * DAY).toISOString()}
							now={NOW}
						/>
					</Sample>
					<Sample state="milestone-loading" label="Loading" h={420} w={420}>
						<MilestoneView
							title={MILESTONE}
							config={milestone()}
							status={{ kind: "loading" }}
							dueOn={DUE}
							now={NOW}
						/>
					</Sample>
					<Sample state="milestone-unconfigured" label="Not set up: pick one here" h={420} w={420}>
						<MilestoneView
							title="Milestone"
							config={milestone({ repo: "", milestone: "" })}
							status={{ kind: "unconfigured" }}
							milestones={META.status === "ready" ? META.meta.milestones : []}
							selected
							now={NOW}
							onPick={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="milestone-empty" label="Nothing in it yet" h={320} w={420}>
						<MilestoneView
							title="6.0"
							config={milestone({ milestone: "6.0" })}
							status={halves([], [])}
							dueOn={null}
							now={NOW}
						/>
					</Sample>
					<Sample state="milestone-error" label="Forge unreachable" h={320} w={420}>
						<MilestoneView
							title={MILESTONE}
							config={milestone()}
							status={failed("error", "GitHub answered 502.")}
							now={NOW}
							onRefresh={() => {}}
						/>
					</Sample>
					<Far state="milestone-far" label="Zoomed out">
						<MilestoneView
							title={MILESTONE}
							config={milestone()}
							status={halves(OPEN, CLOSED)}
							dueOn={DUE}
							compact
							now={NOW}
						/>
					</Far>
				</div>
			</section>

			<section>
				<h2>Stale finder</h2>
				<div className="gallery-grid widget-samples">
					<Sample state="stale-live" label="Quiet for 30 days or more, by age" h={560}>
						<StaleView
							{...rows}
							title={staleTitle(stale())}
							config={stale()}
							status={ready({ items: search(QUIET) })}
							staged={marks}
							canAct={() => true}
							onAction={(action, cards) =>
								setMarks((current) => {
									const next = new Map(current);
									for (const card of cards) {
										next.set(card.key, [
											...(next.get(card.key) ?? []),
											{ id: crypto.randomUUID(), action },
										]);
									}
									return next;
								})
							}
							onUnstage={(id) =>
								setMarks(
									(current) =>
										new Map(
											[...current].map(([key, list]) => [key, list.filter((m) => m.id !== id)]),
										),
								)
							}
							now={NOW}
							onRefresh={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="stale-view-only" label="View only: no quick actions" h={420}>
						<StaleView
							title="Gone quiet"
							config={stale({ title: "Gone quiet", days: 60 })}
							status={ready({ items: search(QUIET) }, NOW - 20 * MIN, true)}
							readOnly
							now={NOW}
							onRefresh={() => {}}
						/>
					</Sample>
					<Sample state="stale-loading" label="Loading" h={360}>
						<StaleView
							title={staleTitle(stale())}
							config={stale()}
							status={{ kind: "loading" }}
							now={NOW}
						/>
					</Sample>
					<Sample state="stale-unconfigured" label="Not set up: ready-made searches" h={360}>
						<StaleView
							title={staleTitle(stale({ q: "" }))}
							config={stale({ q: "" })}
							status={{ kind: "unconfigured" }}
							presets={stalePresets(REPO)}
							selected
							now={NOW}
							onPreset={() => {}}
							onConfigure={() => {}}
						/>
					</Sample>
					<Sample state="stale-clear" label="Nothing's gone quiet" h={360}>
						<StaleView
							title={staleTitle(stale())}
							config={stale()}
							status={ready({ items: search([]) })}
							now={NOW}
						/>
					</Sample>
					<Sample state="stale-invalid" label="A search GitHub can't read" h={360}>
						<StaleView
							title={staleTitle(stale())}
							config={stale({ q: "repo:acme/unpic is:open label:" })}
							status={failed("invalid", "The search is missing a label after “label:”.")}
							now={NOW}
							onConfigure={() => {}}
						/>
					</Sample>
					<Far state="stale-far" label="Zoomed out">
						<StaleView
							title={staleTitle(stale())}
							config={stale()}
							status={ready({ items: search(QUIET) })}
							compact
							now={NOW}
						/>
					</Far>
				</div>
			</section>

			<section>
				<h2>Setting them up</h2>
				<div className="gallery-grid widget-panels">
					<figure data-state="review-config">
						<ReviewConfigPanel
							config={reviewConfig}
							suggestedRepo={REPO}
							onChange={(changes) => setReviewConfig((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The review queue's panel</figcaption>
					</figure>
					<figure data-state="milestone-config">
						<MilestoneConfigPanel
							config={milestoneConfig}
							meta={META}
							suggestedRepo={REPO}
							now={NOW}
							onChange={(changes) => setMilestoneConfig((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The milestone's panel: its repository's milestones</figcaption>
					</figure>
					<figure data-state="milestone-config-loading">
						<MilestoneConfigPanel
							config={milestone({ milestone: "" })}
							meta={{ status: "loading", meta: null }}
							suggestedRepo={REPO}
							now={NOW}
							onChange={() => {}}
							onClose={() => {}}
						/>
						<figcaption>Loading its milestones</figcaption>
					</figure>
					<figure data-state="stale-config">
						<StaleConfigPanel
							config={staleConfig}
							presets={stalePresets(REPO)}
							labels={META.status === "ready" ? META.meta.labels.map((l) => l.name) : []}
							onChange={(changes) => setStaleConfig((c) => ({ ...c, ...changes }))}
							onClose={() => {}}
						/>
						<figcaption>The stale finder's panel</figcaption>
					</figure>
				</div>
			</section>
		</>
	);
}
