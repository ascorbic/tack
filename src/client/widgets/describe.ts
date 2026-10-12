import type { Card } from "../../shared/cards.ts";
import {
	type ParsedSearch,
	type SearchTerm,
	alternatives,
	parseSearch,
	searchKind,
	searchScope,
} from "../../shared/search.ts";
import type { ListConfig } from "../../shared/widgetRegistry.ts";

// Words for list widgets: a title from the search when the list has none,
// the search as chips, and what drop to match can do with it.

const lower = (s: string) => s.toLowerCase();
const short = (repo: string) => repo.split("/").at(-1) ?? repo;

/** A title for a search, like “Open issues labelled bug in widgets”. */
export function describeSearch(q: string): string {
	const parsed = parseSearch(q);
	const has = (key: string, value?: string) =>
		parsed.terms.some(
			(term) =>
				!term.negated && term.key === key && (value === undefined || lower(term.value) === value),
		);
	const discussions = has("is", "discussion") || has("type", "discussion");
	const kind = discussions
		? "discussions"
		: has("is", "pr") || has("type", "pr")
			? "pull requests"
			: has("is", "issue") || has("type", "issue")
				? "issues"
				: "items";
	const state = has("is", "merged")
		? "Merged"
		: has("is", "draft")
			? "Draft"
			: has("is", "unanswered")
				? "Unanswered"
				: has("is", "answered")
					? "Answered"
					: has("is", "open") || has("state", "open")
						? "Open"
						: has("is", "closed") || has("state", "closed")
							? "Closed"
							: "";
	const parts: string[] = [state ? `${state} ${kind}` : capitalise(kind)];
	const category = parsed.terms.find((term) => term.key === "category" && !term.negated);
	if (category) parts.push(`in ${category.value}`);
	const labels = parsed.terms
		.filter((term) => term.key === "label" && !term.negated)
		.flatMap((term) => alternatives(term));
	if (labels.length > 0) parts.push(`labelled ${labels.join(" or ")}`);
	if (has("no", "label")) parts.push("without labels");
	if (has("no", "assignee")) parts.push("unassigned");
	for (const term of parsed.terms) {
		if (term.negated) continue;
		const me = lower(term.value) === "@me";
		if (term.key === "assignee") parts.push(me ? "assigned to me" : `assigned to ${term.value}`);
		if (term.key === "review-requested")
			parts.push(me ? "waiting on my review" : `waiting on ${term.value}`);
		if (term.key === "author") parts.push(me ? "opened by me" : `by ${term.value}`);
		if (term.key === "milestone") parts.push(`in ${term.value}`);
	}
	const words = parsed.terms.filter((term) => term.key === null && !term.negated);
	if (words.length > 0) parts.push(`mentioning “${words.map((term) => term.value).join(" ")}”`);
	const { repos, owners } = searchScope(parsed);
	if (repos.length === 1) parts.push(`in ${short(repos[0] ?? "")}`);
	else if (repos.length > 1) parts.push(`in ${repos.length} repositories`);
	else if (owners.length === 1) parts.push(`across ${owners[0]}`);
	return parts.join(" ");
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The list's title: its own, or one from its search. */
export function listTitle(config: Pick<ListConfig, "title" | "q">): string {
	return config.title.trim() || (config.q.trim() ? describeSearch(config.q) : "New list");
}

/** How a chip for a term looks: scope (where), filter (what), words, or ordering. */
export type ChipTone = "scope" | "filter" | "words" | "order";

export interface QueryChip {
	text: string;
	tone: ChipTone;
	negated: boolean;
}

export function queryChips(parsed: ParsedSearch): QueryChip[] {
	return parsed.terms.map((term: SearchTerm) => ({
		text: term.raw,
		negated: term.negated,
		tone:
			term.key === null
				? "words"
				: term.key === "sort" || term.key === "in"
					? "order"
					: ["repo", "org", "user", "owner"].includes(term.key)
						? "scope"
						: "filter",
	}));
}

/** How a list refreshes, for the config panel. */
export function refreshNote(q: string): string {
	const { repos, owners } = searchScope(parseSearch(q));
	if (repos.length > 0) {
		return `Live: refreshes when ${repos.length === 1 ? short(repos[0] ?? "") : `any of ${repos.length} repositories`} change${repos.length === 1 ? "s" : ""}.`;
	}
	if (owners.length > 0) return `Refreshes as items in it change, and every few minutes.`;
	return "Searches everywhere you can see: refreshes every few minutes.";
}

/** Whether cards can be dropped on a list to match it, and if not, why. */
export function dropNote(q: string): { ok: boolean; text: string } {
	const parsed = parseSearch(q);
	const words = parsed.terms.filter((term) => term.key === null);
	if (words.length > 0) {
		return {
			ok: false,
			text: `It searches for words (${words.map((w) => `“${w.value}”`).join(", ")}), so dropping cards on it can't make them match.`,
		};
	}
	// Discussions have no assignees or milestones.
	if (searchKind(parsed) === "discussion") {
		return {
			ok: true,
			text: "Drop discussions on it to stage the labels and state that make them match.",
		};
	}
	return {
		ok: true,
		text: "Drop cards on it to stage the labels, assignees and state that make them match.",
	};
}

/** “2 min ago”, “just now”, “3 h ago”. */
export function ago(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

/** “14:05” */
export function clock(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The item part of a row: `#412`. */
export function rowRef(card: Card): string {
	return card.item;
}
