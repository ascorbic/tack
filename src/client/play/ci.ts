import {
	type Checks,
	checksState,
	type PullDetails,
	type ReviewDecision,
	type Reviewer,
	type ReviewState,
} from "../../shared/cards.ts";

// Simulated CI and reviews for pull request fixtures, shared by the gallery
// and the playground's forge events.

const CHECK_NAMES = [
	"build",
	"lint",
	"typecheck",
	"test (node 20, ubuntu)",
	"test (node 22, windows)",
	"e2e (webkit)",
	"bundle size",
	"docs / links",
	"coverage/patch",
	"preview/deploy",
	"test (node 22, ubuntu)",
	"e2e (chromium)",
];

/** A monogram avatar, so the playground needs no network. */
export function avatar(name: string, color: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${color}"/><text x="16" y="21.5" font-family="system-ui,sans-serif" font-size="15" font-weight="650" fill="#fff" text-anchor="middle">${name[0]?.toUpperCase()}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const PEOPLE = {
	priya: { login: "priya", avatarUrl: avatar("priya", "#b4467a") },
	kai: { login: "kai", avatarUrl: avatar("kai", "#1f7a6b") },
	tom: { login: "tom", avatarUrl: avatar("tom", "#a35a12") },
	jo: { login: "jo", avatarUrl: avatar("jo", "#5b5fc7") },
};

export type Person = keyof typeof PEOPLE;

export function reviewer(person: Person, state: ReviewState): Reviewer {
	return { ...PEOPLE[person], state };
}

function checkRun(name: string) {
	return { name, url: `https://fake.tack/checks/${encodeURIComponent(name)}` };
}

export function makeChecks({
	passed = 0,
	failed = 0,
	pending = 0,
	skipped = 0,
	failing = CHECK_NAMES.slice(3, 3 + failed),
}: Partial<Omit<Checks, "state" | "failing">> & { failing?: string[] }): Checks {
	const counts = { passed, failed, pending, skipped };
	return { ...counts, state: checksState(counts), failing: failing.map(checkRun) };
}

export function pullDetails(overrides: Partial<PullDetails> = {}): PullDetails {
	return {
		detail: "full",
		head: "4f2a9c1",
		checks: makeChecks({ passed: 12 }),
		review: "review_required",
		reviewers: [],
		mergeable: "mergeable",
		linked: [],
		...overrides,
	};
}

function total(checks: Checks | null): number {
	return checks ? checks.passed + checks.failed + checks.pending + checks.skipped : 12;
}

/** A new push: every check starts again. */
export function ciStarted(pull: PullDetails): PullDetails {
	const skipped = pull.checks?.skipped ?? 0;
	return {
		...pull,
		head: Math.random().toString(16).slice(2, 9),
		checks: makeChecks({ passed: 1, pending: total(pull.checks) - skipped - 1, skipped }),
	};
}

/** Some running checks finish green. */
export function ciProgressed(pull: PullDetails): PullDetails {
	const checks = pull.checks ?? makeChecks({ pending: 12 });
	const done = Math.min(checks.pending, 1 + Math.floor(Math.random() * 3));
	return {
		...pull,
		checks: makeChecks({
			...checks,
			passed: checks.passed + done,
			pending: checks.pending - done,
			failing: checks.failing.map((check) => check.name),
		}),
	};
}

/** A check goes red: a running one if there is one, else a passing one. */
export function checkFailed(pull: PullDetails): PullDetails {
	const checks = pull.checks ?? makeChecks({ passed: 12 });
	const failing = checks.failing.map((check) => check.name);
	const name = CHECK_NAMES.find((n) => !failing.includes(n)) ?? `check ${failing.length + 1}`;
	const fromPending = checks.pending > 0;
	return {
		...pull,
		checks: makeChecks({
			...checks,
			pending: checks.pending - (fromPending ? 1 : 0),
			passed: checks.passed - (fromPending || checks.passed === 0 ? 0 : 1),
			failed: checks.failed + 1,
			failing: [...failing, name],
		}),
	};
}

/** Everything finishes green. */
export function checksPassed(pull: PullDetails): PullDetails {
	const skipped = pull.checks?.skipped ?? 0;
	return { ...pull, checks: makeChecks({ passed: total(pull.checks) - skipped, skipped }) };
}

function decision(reviewers: Reviewer[]): ReviewDecision {
	if (reviewers.some((r) => r.state === "changes_requested")) return "changes_requested";
	if (reviewers.some((r) => r.state === "approved")) return "approved";
	return "review_required";
}

/** Someone reviews, replacing their earlier review or request. */
export function reviewed(pull: PullDetails, person: Person, state: ReviewState): PullDetails {
	const reviewers = [...pull.reviewers.filter((r) => r.login !== person), reviewer(person, state)];
	return { ...pull, reviewers, review: decision(reviewers) };
}

/** The base branch moves on, or the conflict is fixed. */
export function conflictToggled(pull: PullDetails): PullDetails {
	return { ...pull, mergeable: pull.mergeable === "conflicting" ? "mergeable" : "conflicting" };
}
