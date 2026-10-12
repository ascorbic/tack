import type { DiscussionCategory } from "./cards.ts";
import { type SearchTerm, formatTerm, parseSearch, searchKind } from "./search.ts";

// A list's Discussions mode: the controls (repository, category, answered,
// open or closed, labels) read from and written into the search itself, so
// the search stays the one source of truth. Writing touches only the terms
// a control owns, where they are, and leaves everything else as written:
// words, authors, dates, negations, a `sort:`. Reading takes the first of
// each, as GitHub would, so what can't be shown as a control (a comma list
// of labels, `-category:`) stays in the search and is simply left alone.

export type AnsweredFilter = "any" | "answered" | "unanswered";
export type StateFilter = "open" | "closed" | "all";

export interface DiscussionFilters {
	/** `owner/name`, or null for none. */
	repo: string | null;
	/** A category's name, or null for every category. */
	category: string | null;
	answered: AnsweredFilter;
	state: StateFilter;
	/** Labels it must have, all of them. */
	labels: string[];
}

export const NO_FILTERS: DiscussionFilters = {
	repo: null,
	category: null,
	answered: "any",
	state: "all",
	labels: [],
};

type Slot = "repo" | "kind" | "category" | "answered" | "state" | "label";

const lower = (value: string) => value.toLowerCase();

/** Which control owns a term, if any. Negated terms and lists of alternatives are the search's own. */
function slotOf(term: SearchTerm): Slot | null {
	if (term.negated || term.key === null) return null;
	const value = lower(term.value);
	switch (term.key) {
		case "repo":
			return /^[\w.-]+\/[\w.-]+$/.test(term.value) ? "repo" : null;
		case "category":
			return term.value ? "category" : null;
		case "label":
			return term.value && !term.value.includes(",") ? "label" : null;
		case "state":
			return value === "open" || value === "closed" ? "state" : null;
		case "type":
			return value === "discussion" ? "kind" : null;
		case "is":
			if (value === "discussion") return "kind";
			if (value === "answered" || value === "unanswered") return "answered";
			if (value === "open" || value === "closed") return "state";
			return null;
		default:
			return null;
	}
}

/** Whether a search is for discussions (`is:discussion`), so a list shows its Discussions mode. */
export function isDiscussionSearch(q: string): boolean {
	return searchKind(parseSearch(q)) === "discussion";
}

/** What the controls show for a search: the first of each that it has. */
export function readDiscussionFilters(q: string): DiscussionFilters {
	const filters: DiscussionFilters = { ...NO_FILTERS, labels: [] };
	const seen = new Set<Slot>();
	for (const term of parseSearch(q).terms) {
		const slot = slotOf(term);
		if (!slot) continue;
		if (slot === "label") {
			if (!filters.labels.some((label) => lower(label) === lower(term.value))) {
				filters.labels.push(term.value);
			}
			continue;
		}
		if (seen.has(slot)) continue;
		seen.add(slot);
		const value = lower(term.value);
		if (slot === "repo") filters.repo = term.value;
		if (slot === "category") filters.category = term.value;
		if (slot === "answered") filters.answered = value as AnsweredFilter;
		if (slot === "state") filters.state = value as StateFilter;
	}
	return filters;
}

/** The term a control writes, or null when it's set to everything. */
function render(slot: Exclude<Slot, "label">, filters: DiscussionFilters): string | null {
	switch (slot) {
		case "repo":
			return filters.repo ? `repo:${filters.repo}` : null;
		case "kind":
			return "is:discussion";
		case "category":
			return filters.category
				? formatTerm({ key: "category", value: filters.category, negated: false })
				: null;
		case "answered":
			return filters.answered === "any" ? null : `is:${filters.answered}`;
		case "state":
			return filters.state === "all" ? null : `is:${filters.state}`;
	}
}

/** Whether a term already says what a control would write, however it's spelled or quoted. */
function says(term: SearchTerm, slot: Exclude<Slot, "label">, filters: DiscussionFilters): boolean {
	const value = lower(term.value);
	switch (slot) {
		case "repo":
			return filters.repo !== null && value === lower(filters.repo);
		case "kind":
			return true;
		case "category":
			return filters.category !== null && value === lower(filters.category);
		case "answered":
			return value === filters.answered;
		case "state":
			return value === filters.state;
	}
}

/**
 * A search with the controls' values written in: each term a control owns
 * is replaced where it stands (or dropped, set to everything), and new ones
 * join the end, the repository and `is:discussion` at the start. Anything
 * else stays exactly as written.
 */
export function writeDiscussionFilters(q: string, filters: DiscussionFilters): string {
	const out: string[] = [];
	const placed = new Set<Slot>();
	const labels = new Map(filters.labels.map((label) => [lower(label), label]));
	const placedLabels = new Set<string>();
	let repoAt = -1;
	for (const term of parseSearch(q).terms) {
		const slot = slotOf(term);
		if (!slot) {
			out.push(term.raw);
			continue;
		}
		if (slot === "label") {
			const key = lower(term.value);
			if (labels.has(key) && !placedLabels.has(key)) {
				out.push(term.raw);
				placedLabels.add(key);
			}
			continue;
		}
		if (placed.has(slot)) continue;
		placed.add(slot);
		const text = says(term, slot, filters) ? term.raw : render(slot, filters);
		if (!text) continue;
		if (slot === "repo") repoAt = out.length;
		out.push(text);
	}
	// The repository leads, and is:discussion follows it.
	const lead: string[] = [];
	const repo = placed.has("repo") ? null : render("repo", filters);
	if (repo) lead.push(repo);
	if (!placed.has("kind")) {
		if (repoAt >= 0) out.splice(repoAt + 1, 0, "is:discussion");
		else lead.push("is:discussion");
	}
	for (const slot of ["category", "state", "answered"] as const) {
		const text = placed.has(slot) ? null : render(slot, filters);
		if (text) out.push(text);
	}
	for (const [key, label] of labels) {
		if (!placedLabels.has(key))
			out.push(formatTerm({ key: "label", value: label, negated: false }));
	}
	return [...lead, ...out].join(" ");
}

/** Qualifiers only issues and pull requests have, which a discussion search can't use. */
const ISSUE_ONLY = new Set([
	"assignee",
	"milestone",
	"review",
	"review-requested",
	"reviewed-by",
	"team-review-requested",
	"draft",
	"linked",
	"project",
	"reason",
]);
const ISSUE_KINDS = new Set(["issue", "pr", "pull-request", "merged", "unmerged", "draft"]);
const DISCUSSION_ONLY = new Set(["answered", "unanswered", "locked", "unlocked", "discussion"]);

/**
 * The search, switched to discussions: what only issues and pull requests
 * have is taken out, `is:discussion` goes in, and the repository too
 * (`repo`, the board's busiest) when it doesn't name one.
 */
export function toDiscussionSearch(q: string, repo: string | null = null): string {
	const kept = parseSearch(q).terms.filter((term) => {
		if (term.key === null) return true;
		const value = lower(term.value);
		if (ISSUE_ONLY.has(term.key)) return false;
		if ((term.key === "is" || term.key === "type") && ISSUE_KINDS.has(value)) return false;
		if (term.key === "no" && (value === "assignee" || value === "milestone")) return false;
		return true;
	});
	const current = readDiscussionFilters(q);
	return writeDiscussionFilters(kept.map((term) => term.raw).join(" "), {
		...current,
		repo: current.repo ?? repo,
	});
}

/** The search, switched back to issues and pull requests: what only discussions have is taken out. */
export function toIssueSearch(q: string): string {
	return parseSearch(q)
		.terms.filter((term) => {
			if (term.key === "category") return false;
			if ((term.key === "is" || term.key === "type") && DISCUSSION_ONLY.has(lower(term.value))) {
				return false;
			}
			return true;
		})
		.map((term) => term.raw)
		.join(" ");
}

/** A category by name, as the repository has it. */
export function categoryNamed(
	categories: readonly DiscussionCategory[] | null | undefined,
	name: string | null,
): DiscussionCategory | null {
	if (!name || !categories) return null;
	return categories.find((category) => lower(category.name) === lower(name)) ?? null;
}

/**
 * Whether the answered filter means anything here: only categories that
 * take answers have them (GitHub's `is:unanswered` finds nothing in Ideas).
 * With every category, it does if any one takes answers. Unknown categories
 * (not loaded, or not the repository's) may.
 */
export function answersApply(
	categories: readonly DiscussionCategory[] | null | undefined,
	category: string | null,
): boolean {
	if (!categories) return true;
	if (!category) return categories.some((each) => each.answerable);
	return categoryNamed(categories, category)?.answerable ?? true;
}
