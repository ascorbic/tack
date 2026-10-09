import { useEffect, useRef, useState } from "react";
import type { Checks, PullDetails, Reviewer, ReviewState } from "../shared/cards.ts";

// The pull request part of a card: a CI bar with the failing checks, who's
// reviewing and how, mergeability, and the issues it closes. Changes animate
// as they land: a check turning red shakes the bar and slides its name in, a
// green run sweeps the bar, and a reviewer's new verdict pops their badge.

/** Failing check names shown before "+N more". */
const SHOWN_FAILURES = 3;
const SHOWN_REVIEWERS = 5;
const SHOWN_LINKS = 2;

type Tone = "fail" | "pass" | null;

interface PullChanges {
	/** Bumps when the CI outcome changes, to replay its animation. */
	ci: number;
	tone: Tone;
	/** Check names that just started failing. */
	newFailures: Set<string>;
	/** Reviewers whose state just changed, by login. */
	reviewers: Set<string>;
	review: number;
	mergeable: number;
}

function usePullChanges(pull: PullDetails): PullChanges {
	const previous = useRef(pull);
	const [changes, setChanges] = useState<PullChanges>({
		ci: 0,
		tone: null,
		newFailures: new Set(),
		reviewers: new Set(),
		review: 0,
		mergeable: 0,
	});

	useEffect(() => {
		const before = previous.current;
		previous.current = pull;
		if (before === pull) return;

		const was = before.checks;
		const now = pull.checks;
		const oldFailures = new Set(was?.failing.map((check) => check.name));
		const newFailures = new Set(
			(now?.failing ?? []).map((check) => check.name).filter((name) => !oldFailures.has(name)),
		);
		const failedMore = (now?.failed ?? 0) > (was?.failed ?? 0) || newFailures.size > 0;
		const nowPassing = now?.state === "passing" && was?.state !== "passing";
		const ciChanged =
			failedMore ||
			nowPassing ||
			now?.state !== was?.state ||
			now?.passed !== was?.passed ||
			now?.pending !== was?.pending;

		const oldStates = new Map(before.reviewers.map((r) => [r.login, r.state]));
		const reviewers = new Set(
			pull.reviewers.filter((r) => oldStates.get(r.login) !== r.state).map((r) => r.login),
		);

		setChanges((current) => ({
			ci: ciChanged ? current.ci + 1 : current.ci,
			tone: ciChanged ? (failedMore ? "fail" : nowPassing ? "pass" : null) : current.tone,
			newFailures: ciChanged ? newFailures : current.newFailures,
			reviewers: reviewers.size > 0 ? reviewers : current.reviewers,
			review: before.review !== pull.review ? current.review + 1 : current.review,
			mergeable: before.mergeable !== pull.mergeable ? current.mergeable + 1 : current.mergeable,
		}));
	}, [pull]);

	return changes;
}

export function PullStatus({ pull }: { pull: PullDetails }) {
	const changes = usePullChanges(pull);
	const { checks } = pull;
	const reviewers = pull.reviewers.slice(0, SHOWN_REVIEWERS);
	const hasReviews = reviewers.length > 0 || pull.review !== null;
	const conflicting = pull.mergeable === "conflicting";

	return (
		<div className="pull">
			{changes.tone && (
				<span key={changes.ci} className="card-pulse" data-tone={changes.tone} aria-hidden="true" />
			)}

			{checks === null && pull.detail === "basic" ? (
				<p className="ci-unavailable">
					<PlugIcon />
					Checks and reviews need the GitHub App
				</p>
			) : checks && checks.state !== "none" ? (
				<CiSummary checks={checks} changes={changes} />
			) : null}

			{(hasReviews || conflicting) && (
				<div className="review-row">
					{reviewers.length > 0 && (
						<span className="reviewers">
							{reviewers.map((reviewer) => (
								<ReviewerAvatar
									key={reviewer.login}
									reviewer={reviewer}
									changed={changes.reviewers.has(reviewer.login)}
								/>
							))}
						</span>
					)}
					{pull.review && (
						<span
							key={`r${changes.review}`}
							className="chip review"
							data-review={pull.review}
							data-pop={changes.review > 0}
						>
							{REVIEW_LABEL[pull.review]}
						</span>
					)}
					{conflicting && (
						<span
							key={`m${changes.mergeable}`}
							className="chip conflict"
							data-pop={changes.mergeable > 0}
							title="This branch has conflicts that must be resolved"
						>
							<ConflictIcon />
							Conflicts
						</span>
					)}
				</div>
			)}

			{pull.linked.length > 0 && (
				<ul className="linked">
					{pull.linked.slice(0, SHOWN_LINKS).map((issue) => (
						<li key={issue.key} data-state={issue.state} data-key={issue.key}>
							<IssueIcon closed={issue.state !== "open"} />
							<span className="linked-verb">Closes</span>
							<a href={issue.url} target="_blank" rel="noreferrer" draggable={false}>
								<span className="mono">{issue.item}</span>{" "}
								{issue.title || (
									// A private repository's title, kept from viewers who may not see it.
									<span className="linked-private">in a private repository</span>
								)}
							</a>
						</li>
					))}
					{pull.linked.length > SHOWN_LINKS && (
						<li className="more">+{pull.linked.length - SHOWN_LINKS} more</li>
					)}
				</ul>
			)}
		</div>
	);
}

const REVIEW_LABEL: Record<NonNullable<PullDetails["review"]>, string> = {
	approved: "Approved",
	changes_requested: "Changes requested",
	review_required: "Review required",
};

const REVIEWER_LABEL: Record<ReviewState, string> = {
	approved: "approved",
	changes_requested: "requested changes",
	commented: "commented",
	dismissed: "review dismissed",
	requested: "review requested",
};

function describeChecks(checks: Checks): string {
	const parts = [
		checks.failed && `${checks.failed} failing`,
		checks.pending && `${checks.pending} running`,
		checks.passed && `${checks.passed} passed`,
		checks.skipped && `${checks.skipped} skipped`,
	];
	return parts.filter(Boolean).join(", ");
}

function CiSummary({ checks, changes }: { checks: Checks; changes: PullChanges }) {
	const total = checks.passed + checks.failed + checks.pending + checks.skipped;
	const hidden = checks.failed - Math.min(checks.failing.length, SHOWN_FAILURES);
	// Skipped and neutral checks are part of the total, so say so, or the
	// counts don't add up ("1 of 46 running · 38 passed").
	const skipped = checks.skipped > 0 ? ` · ${checks.skipped} skipped` : "";
	return (
		<div className="ci" data-ci={checks.state}>
			<CiBar checks={checks} replay={changes.ci} tone={changes.tone} />
			<p className="ci-summary">
				<span className="ci-icon" key={`i${changes.ci}`} data-pop={changes.ci > 0}>
					<CiIcon state={checks.state} />
				</span>
				{checks.state === "failing" ? (
					<>
						<strong>{checks.failed} failing</strong>
						<span className="ci-rest">
							{checks.pending > 0 && ` · ${checks.pending} running`} · {checks.passed} passed
							{skipped}
						</span>
					</>
				) : checks.state === "pending" ? (
					<>
						<strong>
							{checks.pending} of {total} running
						</strong>
						<span className="ci-rest">
							{checks.passed > 0 && ` · ${checks.passed} passed`}
							{skipped}
						</span>
					</>
				) : checks.skipped > 0 && checks.passed === 0 ? (
					<strong>{total} skipped</strong>
				) : (
					<>
						<strong>All {checks.passed} checks passed</strong>
						<span className="ci-rest">{skipped}</span>
					</>
				)}
			</p>
			{checks.failing.length > 0 && (
				<ul className="ci-failures">
					{checks.failing.slice(0, SHOWN_FAILURES).map((check, i) => (
						<li key={`${check.name}${i}`} data-new={changes.newFailures.has(check.name)}>
							<CrossIcon />
							{check.url ? (
								<a href={check.url} target="_blank" rel="noreferrer" draggable={false}>
									{check.name}
								</a>
							) : (
								<span>{check.name}</span>
							)}
						</li>
					))}
					{hidden > 0 && <li className="more">+{hidden} more</li>}
				</ul>
			)}
		</div>
	);
}

/** The CI bar on its own, also used by compact cards. */
export function CiBar({
	checks,
	replay = 0,
	tone = null,
}: {
	checks: Checks;
	replay?: number;
	tone?: Tone;
}) {
	// Segments grow and shrink with their counts (flex-grow animates), so a
	// check finishing visibly moves the bar along. The bar stays mounted for
	// that, so its own animation replays by alternating between two
	// identical keyframes, and the sheen is a keyed overlay.
	return (
		<div
			className="ci-bar"
			role="img"
			aria-label={`Checks: ${describeChecks(checks)}`}
			data-tone={tone}
			data-replay={replay % 2}
		>
			<span className="ci-seg" data-bucket="failed" style={{ flexGrow: checks.failed }} />
			<span className="ci-seg" data-bucket="pending" style={{ flexGrow: checks.pending }} />
			<span className="ci-seg" data-bucket="passed" style={{ flexGrow: checks.passed }} />
			<span className="ci-seg" data-bucket="skipped" style={{ flexGrow: checks.skipped }} />
			{tone && <span key={replay} className="ci-sheen" data-tone={tone} />}
		</div>
	);
}

function ReviewerAvatar({ reviewer, changed }: { reviewer: Reviewer; changed: boolean }) {
	const label = `${reviewer.login}: ${REVIEWER_LABEL[reviewer.state]}`;
	return (
		<span className="reviewer" data-review={reviewer.state} title={label}>
			{reviewer.avatarUrl ? (
				<img src={reviewer.avatarUrl} alt={label} draggable={false} />
			) : (
				<span className="reviewer-initial" role="img" aria-label={label}>
					{reviewer.login.slice(0, 1).toUpperCase()}
				</span>
			)}
			<span className="reviewer-badge" key={reviewer.state} data-pop={changed} aria-hidden="true">
				<ReviewIcon state={reviewer.state} />
			</span>
		</span>
	);
}

// --- Icons ---------------------------------------------------------------------

function CiIcon({ state }: { state: Checks["state"] }) {
	if (state === "failing") return <CrossIcon />;
	if (state === "pending") {
		return (
			<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="spinner">
				<circle cx="8" cy="8" r="5.5" opacity="0.3" />
				<path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
			</svg>
		);
	}
	return <CheckIcon />;
}

function CheckIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3.5 8.5l3 3 6-7" />
		</svg>
	);
}

function CrossIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
		</svg>
	);
}

function ReviewIcon({ state }: { state: ReviewState }) {
	switch (state) {
		case "approved":
			return (
				<svg viewBox="0 0 16 16">
					<path d="M4 8.5l2.5 2.5L12 5.5" />
				</svg>
			);
		case "changes_requested":
			return (
				<svg viewBox="0 0 16 16">
					<path d="M8 4v8M4 8h8" />
				</svg>
			);
		case "commented":
			return (
				<svg viewBox="0 0 16 16">
					<path d="M4 5h8v5H7.5L5 12v-2H4z" />
				</svg>
			);
		case "requested":
			return (
				<svg viewBox="0 0 16 16">
					<circle cx="8" cy="8" r="2.25" className="fill" />
				</svg>
			);
		case "dismissed":
			return (
				<svg viewBox="0 0 16 16">
					<path d="M5 8h6" />
				</svg>
			);
	}
}

function ConflictIcon() {
	return (
		<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M8 2.5l6 11H2z" />
			<path d="M8 6.5v3" />
			<circle cx="8" cy="11.6" r="0.6" className="fill" />
		</svg>
	);
}

function IssueIcon({ closed }: { closed: boolean }) {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6.25" />
			{closed ? <path d="M5.5 8l2 2 3-3.5" /> : <circle cx="8" cy="8" r="1.6" className="fill" />}
		</svg>
	);
}

function PlugIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2" />
		</svg>
	);
}
