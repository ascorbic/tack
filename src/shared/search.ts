import type { Triage } from "./actions.ts";
import type { Card } from "./cards.ts";
import type { CloseReason } from "./changes.ts";

// Forge searches, in GitHub's issue search syntax (which the fake forge and
// the playground speak too): parsing a query into its qualifiers, saying
// which repositories it can match (so a board knows which webhooks should
// refresh it), evaluating it against a card where that's possible, and
// working out what would make a card match it (drop to match, #39).
//
// Parsing is forgiving, like GitHub's: anything that isn't a qualifier is
// words to search for.

export interface SearchTerm {
	/** The qualifier, lowercased, e.g. `label`; null for words. */
	key: string | null;
	/** Its value, unquoted. Comma-separated values (`label:a,b`) mean any of them. */
	value: string;
	negated: boolean;
	/** As written. */
	raw: string;
}

export interface ParsedSearch {
	terms: SearchTerm[];
}

/** Qualifiers whose values are lists of alternatives. */
const LISTS = new Set(["label", "repo", "org", "user", "assignee", "author", "milestone"]);

const TOKEN_RE = /(-?)(?:([a-z][\w-]*):)?("(?:[^"\\]|\\.)*"?|\S+)/gi;

export function parseSearch(q: string): ParsedSearch {
	const terms: SearchTerm[] = [];
	for (const match of q.matchAll(TOKEN_RE)) {
		const [raw, minus = "", key, value = ""] = match;
		const unquoted = unquote(value);
		if (key === undefined) {
			// A bare `-word` excludes it, as on GitHub.
			terms.push({ key: null, value: unquoted, negated: minus === "-", raw });
			continue;
		}
		terms.push({ key: key.toLowerCase(), value: unquoted, negated: minus === "-", raw });
	}
	return { terms };
}

function unquote(value: string): string {
	if (!value.startsWith('"')) return value;
	return value
		.slice(1, value.endsWith('"') && value.length > 1 ? -1 : undefined)
		.replace(/\\(.)/g, "$1");
}

/** A term written back out, quoting values with spaces. */
export function formatTerm(term: Pick<SearchTerm, "key" | "value" | "negated">): string {
	const value = /[\s"]/.test(term.value) ? `"${term.value.replace(/"/g, '\\"')}"` : term.value;
	return `${term.negated ? "-" : ""}${term.key ? `${term.key}:` : ""}${value}`;
}

/** Alternatives in a term's value: `label:bug,docs` is bug or docs. */
export function alternatives(term: SearchTerm): string[] {
	if (!term.key || !LISTS.has(term.key)) return [term.value];
	return term.value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * The repositories (`owner/name`, lowercased) and owners a search is limited
 * to. A search with neither could match anything, anywhere.
 */
export function searchScope(parsed: ParsedSearch): { repos: string[]; owners: string[] } {
	const repos = new Set<string>();
	const owners = new Set<string>();
	for (const term of parsed.terms) {
		if (term.negated) continue;
		if (term.key === "repo") {
			for (const repo of alternatives(term)) {
				if (/^[\w.-]+\/[\w.-]+$/.test(repo)) repos.add(repo.toLowerCase());
			}
		} else if (term.key === "org" || term.key === "user" || term.key === "owner") {
			for (const owner of alternatives(term)) owners.add(owner.toLowerCase());
		}
	}
	return { repos: [...repos], owners: [...owners] };
}

/** Whether a search mentions `@me`, so means something different to each person. */
export function mentionsMe(q: string): boolean {
	return /(^|[\s:,])@me\b/i.test(q);
}

// --- Evaluating --------------------------------------------------------------

/** What a matcher needs beyond the card. */
export interface MatchContext {
	/** The login `@me` stands for. Without one, `@me` matches nothing. */
	viewer?: string | null;
	/** An item's milestone, where known (cards don't carry it). */
	milestoneOf?: (card: Card) => string | null | undefined;
}

/** Yes, no, or can't tell from what's known about the card. */
export type Verdict = "yes" | "no" | "unknown";

const lower = (value: string) => value.toLowerCase();

function me(value: string, context: MatchContext): string | null {
	if (lower(value) !== "@me") return lower(value);
	return context.viewer ? lower(context.viewer) : null;
}

/** Whether a card satisfies one term, before negation. */
function termVerdict(card: Card, term: SearchTerm, context: MatchContext): Verdict {
	const values = alternatives(term).map(lower);
	const labels = card.labels.map((label) => lower(label.name));
	const assignees = card.assignees.map((a) => lower(a.login));
	const owner = lower(card.repo.split("/")[0] ?? "");
	const isPull = card.kind === "pull";
	const open = card.state === "open" || card.state === "draft";
	switch (term.key) {
		case null: {
			const word = lower(term.value);
			// A word in the title is a match; one that isn't may be in the body.
			return lower(card.title).includes(word) ? "yes" : "unknown";
		}
		case "repo":
			return values.includes(lower(card.repo)) ? "yes" : "no";
		case "org":
		case "user":
		case "owner":
			return values.includes(owner) ? "yes" : "no";
		case "type":
			if (values.includes("pr") || values.includes("pull-request")) return isPull ? "yes" : "no";
			if (values.includes("issue")) return isPull ? "no" : "yes";
			return "unknown";
		case "state":
			if (values.includes("open")) return open ? "yes" : "no";
			if (values.includes("closed")) return open ? "no" : "yes";
			return "unknown";
		case "is":
			switch (values[0]) {
				case "open":
					return open ? "yes" : "no";
				case "closed":
					return open ? "no" : "yes";
				case "issue":
					return isPull ? "no" : "yes";
				case "pr":
				case "pull-request":
					return isPull ? "yes" : "no";
				case "merged":
					return card.state === "merged" ? "yes" : "no";
				case "unmerged":
					return isPull && card.state !== "merged" ? "yes" : "no";
				case "draft":
					return card.state === "draft" ? "yes" : "no";
				case "public":
				case "private":
					if (card.visibility === undefined) return card.forge === "fake" ? "yes" : "unknown";
					return card.visibility === values[0] ? "yes" : "no";
				default:
					return "unknown";
			}
		case "draft":
			return (card.state === "draft") === (values[0] === "true") ? "yes" : "no";
		case "label":
			return values.some((value) => labels.includes(value)) ? "yes" : "no";
		case "assignee": {
			const people = values.map((value) => me(value, context));
			return people.some((person) => person !== null && assignees.includes(person)) ? "yes" : "no";
		}
		case "author": {
			if (!card.author) return "unknown";
			const people = values.map((value) => me(value, context));
			return people.includes(lower(card.author.login)) ? "yes" : "no";
		}
		case "milestone": {
			const milestone = context.milestoneOf?.(card);
			if (milestone === undefined) return "unknown";
			return milestone !== null && values.includes(lower(milestone)) ? "yes" : "no";
		}
		case "no":
			switch (values[0]) {
				case "label":
					return labels.length === 0 ? "yes" : "no";
				case "assignee":
					return assignees.length === 0 ? "yes" : "no";
				case "milestone": {
					const milestone = context.milestoneOf?.(card);
					return milestone === undefined ? "unknown" : milestone === null ? "yes" : "no";
				}
				default:
					return "unknown";
			}
		case "reason": {
			if (open) return "no";
			const reason = lower(card.stateReason ?? "completed").replace(/_/g, " ");
			return values.some((value) => value.replace(/_/g, " ") === reason) ? "yes" : "no";
		}
		case "comments":
			return compare(card.comments, term.value);
		case "reactions":
			return compare(card.reactions, term.value);
		// These order results or narrow the words; they never rule a card out.
		case "sort":
		case "in":
			return "yes";
		default:
			return "unknown";
	}
}

/** Numeric qualifiers: `5`, `>5`, `>=5`, `<5`, `<=5`, `1..5`. */
function compare(actual: number, spec: string): Verdict {
	const range = /^(\d+)\.\.(\d+)$/.exec(spec);
	if (range) return actual >= Number(range[1]) && actual <= Number(range[2]) ? "yes" : "no";
	const match = /^(>=|<=|>|<)?(\d+)$/.exec(spec);
	if (!match) return "unknown";
	const n = Number(match[2]);
	const ok =
		match[1] === ">="
			? actual >= n
			: match[1] === "<="
				? actual <= n
				: match[1] === ">"
					? actual > n
					: match[1] === "<"
						? actual < n
						: actual === n;
	return ok ? "yes" : "no";
}

function verdict(card: Card, term: SearchTerm, context: MatchContext): Verdict {
	const result = termVerdict(card, term, context);
	if (!term.negated || result === "unknown") return result;
	// `-sort:` and the like don't exclude anything.
	if (term.key === "sort" || term.key === "in") return "yes";
	return result === "yes" ? "no" : "yes";
}

/**
 * Whether a card matches a search, as far as can be told without the
 * forge. Words only match titles here, so a card whose title lacks one is
 * `unknown` (the word may be in its body), never a match.
 */
export function matchSearch(card: Card, parsed: ParsedSearch, context: MatchContext = {}): Verdict {
	let unknown = false;
	for (const term of parsed.terms) {
		const result = verdict(card, term, context);
		if (result === "no") return "no";
		if (result === "unknown") unknown = true;
	}
	return unknown ? "unknown" : "yes";
}

// --- Drop to match (#39) ----------------------------------------------------------

/** A change that would make a card match, described for the preview. */
export interface MatchStep {
	triage: Triage;
	/** Short, for a chip: `+ bug`, `Assign @kai`, `Milestone v1`, `Close`. */
	label: string;
	/** What it does: `add-label`, `remove-label`, `assign`, `unassign`, `milestone`, `open`, `close`. */
	kind: "add-label" | "remove-label" | "assign" | "unassign" | "milestone" | "open" | "close";
}

export type MatchPlan =
	/** It already matches: nothing to do. */
	| { status: "matches" }
	/** These changes would make it match. */
	| { status: "changes"; steps: MatchStep[]; edits: Triage[] }
	/** It can't be made to match, or it isn't clear how: `reasons` say why, one per problem. */
	| { status: "impossible"; reasons: string[] };

function quoted(text: string): string {
	return `“${text}”`;
}

/** Why a term that a card doesn't satisfy can't be changed to match. */
function cannot(card: Card, term: SearchTerm, context: MatchContext): string {
	const value = term.value;
	const name = `${card.repo}${card.item}`;
	switch (term.key) {
		case null:
			return term.negated
				? `This list leaves out items mentioning ${quoted(value)}, and Tack doesn't edit what an item says.`
				: `This list searches for the words ${quoted(value)}, and Tack doesn't edit what an item says.`;
		case "repo":
			return term.negated
				? `This list leaves out ${value}, where ${name} is.`
				: `This list only shows ${alternatives(term).join(" or ")}; ${name} is in ${card.repo}.`;
		case "org":
		case "user":
		case "owner":
			return `This list only shows items owned by ${alternatives(term).join(" or ")}.`;
		case "type":
		case "is":
			if (["issue", "pr", "pull-request"].includes(lower(value))) {
				const wants = lower(value) === "issue" ? "issues" : "pull requests";
				return term.negated
					? `This list leaves out ${wants}.`
					: `This list only shows ${wants}, and ${name} is ${card.kind === "pull" ? "a pull request" : "an issue"}.`;
			}
			if (lower(value) === "merged" || lower(value) === "unmerged") {
				return `Tack can't merge pull requests, or unmerge them.`;
			}
			if (lower(value) === "draft") return `Tack can't change whether a pull request is a draft.`;
			if (lower(value) === "public" || lower(value) === "private") {
				return `This list depends on whether repositories are public, which Tack can't change.`;
			}
			if (lower(value) === "open" && card.state === "merged") {
				return `${name} is merged, so it can't be reopened.`;
			}
			return `Tack can't change whether an item is ${quoted(term.raw)}.`;
		case "author":
			return term.negated || !card.author
				? `This list depends on who opened each item, which Tack can't change.`
				: `This list only shows items opened by ${alternatives(term).join(" or ")}; ${card.author.login} opened ${name}.`;
		case "assignee":
			return lower(value) === "@me" && !context.viewer
				? `This list shows items assigned to whoever's looking: sign in to be assigned.`
				: `Tack can't tell who to assign.`;
		case "milestone":
			return `Tack can't tell which milestone ${name} is in now.`;
		case "reason":
			return `Tack can't change why ${name} was closed without reopening it.`;
		case "no":
			return `Tack can't change ${quoted(term.raw)}.`;
		default:
			return `This list filters on ${quoted(term.raw)}, which isn't something Tack can change.`;
	}
}

/**
 * What would make `card` match a search: label, assignee, milestone and
 * open/closed changes, which are what Tack can stage. Anything else the
 * card doesn't already satisfy (words, authors, other repositories, kinds
 * of item) makes it impossible, with a reason for each.
 */
export function planMatch(
	card: Card,
	parsed: ParsedSearch,
	context: MatchContext & { host?: string } = {},
): MatchPlan {
	const reasons: string[] = [];
	const addLabels: string[] = [];
	const removeLabels: string[] = [];
	const assign: string[] = [];
	const unassign: string[] = [];
	let milestone: string | null | undefined;
	let state: { state: "open" | "closed"; reason?: CloseReason } | undefined;
	const labels = card.labels.map((label) => label.name);
	const has = (name: string) => labels.some((label) => lower(label) === lower(name));
	const assigned = (login: string) => card.assignees.some((a) => lower(a.login) === lower(login));

	if (context.host && lower(context.host) !== lower(card.host)) {
		return {
			status: "impossible",
			reasons: [`This list searches ${context.host}, and ${card.repo}${card.item} isn't there.`],
		};
	}

	// Why it should be closed, from `reason:`, if it says.
	const reasonTerm = parsed.terms.find((term) => term.key === "reason" && !term.negated);
	const reasonValue = reasonTerm
		? lower(alternatives(reasonTerm)[0] ?? "").replace(/[ -]/g, "_")
		: "";
	const closeReason: CloseReason | undefined =
		reasonValue === "completed" || reasonValue === "not_planned" || reasonValue === "duplicate"
			? reasonValue
			: undefined;
	const close = () => {
		state = { state: "closed", ...(closeReason ? { reason: closeReason } : {}) };
	};

	for (const term of parsed.terms) {
		const result = verdict(card, term, context);
		const key = term.key;
		const value = lower(term.value);
		const stateTerm = key === "is" || key === "state";

		// The card doesn't say which milestone it's in, so set it whatever it is now.
		if (key === "milestone" && !term.negated && result !== "yes") {
			milestone = alternatives(term)[0] ?? term.value;
			continue;
		}
		if (key === "no" && value === "milestone" && !term.negated && result !== "yes") {
			milestone = null;
			continue;
		}
		if (result === "yes") continue;

		if (key === "reason" && term === reasonTerm && closeReason && card.state !== "merged") {
			close();
			continue;
		}
		const wantsOpen =
			stateTerm && ((!term.negated && value === "open") || (term.negated && value === "closed"));
		const wantsClosed =
			stateTerm && ((!term.negated && value === "closed") || (term.negated && value === "open"));
		if (result === "no" && wantsOpen && card.state !== "merged") {
			state = { state: "open" };
			continue;
		}
		if (result === "no" && wantsClosed) {
			close();
			continue;
		}
		if (key === "label" && result === "no") {
			if (term.negated)
				removeLabels.push(
					...labels.filter((label) => alternatives(term).map(lower).includes(lower(label))),
				);
			else addLabels.push(alternatives(term)[0] ?? term.value);
			continue;
		}
		if (key === "no" && value === "label" && !term.negated) {
			removeLabels.push(...labels);
			continue;
		}
		if (key === "no" && value === "assignee" && !term.negated) {
			unassign.push(...card.assignees.map((a) => a.login));
			continue;
		}
		if (key === "assignee" && result === "no") {
			if (term.negated) {
				for (const alternative of alternatives(term)) {
					const person = me(alternative, context);
					const login = card.assignees.find((a) => lower(a.login) === person)?.login;
					if (login) unassign.push(login);
				}
				continue;
			}
			const first = alternatives(term)[0] ?? "";
			const person = me(first, context);
			if (person) {
				assign.push(lower(first) === "@me" ? (context.viewer ?? person) : first);
				continue;
			}
		}
		reasons.push(cannot(card, term, context));
	}

	if (reasons.length > 0) return { status: "impossible", reasons: [...new Set(reasons)] };

	const steps: MatchStep[] = [];
	const edits: Triage[] = [];
	const add = [...new Set(addLabels)].filter((name) => !has(name));
	const remove = [...new Set(removeLabels)];
	if (add.length || remove.length) {
		edits.push({
			kind: "item.labels",
			...(add.length ? { add } : {}),
			...(remove.length ? { remove } : {}),
		});
		for (const name of add)
			steps.push({ triage: edits.at(-1) as Triage, label: name, kind: "add-label" });
		for (const name of remove)
			steps.push({ triage: edits.at(-1) as Triage, label: name, kind: "remove-label" });
	}
	const toAssign = [...new Set(assign)].filter((login) => !assigned(login));
	const toUnassign = [...new Set(unassign)];
	if (toAssign.length || toUnassign.length) {
		edits.push({
			kind: "item.assignees",
			...(toAssign.length ? { add: toAssign } : {}),
			...(toUnassign.length ? { remove: toUnassign } : {}),
		});
		for (const login of toAssign)
			steps.push({ triage: edits.at(-1) as Triage, label: `@${login}`, kind: "assign" });
		for (const login of toUnassign)
			steps.push({ triage: edits.at(-1) as Triage, label: `@${login}`, kind: "unassign" });
	}
	if (milestone !== undefined) {
		edits.push({ kind: "item.milestone", milestone });
		steps.push({
			triage: edits.at(-1) as Triage,
			label: milestone ?? "No milestone",
			kind: "milestone",
		});
	}
	if (state) {
		edits.push({ kind: "item.state", ...state });
		steps.push({
			triage: edits.at(-1) as Triage,
			label:
				state.state === "open"
					? "Reopen"
					: state.reason === "not_planned"
						? "Close as not planned"
						: state.reason === "duplicate"
							? "Close as duplicate"
							: "Close",
			kind: state.state === "open" ? "open" : "close",
		});
	}
	return edits.length === 0 ? { status: "matches" } : { status: "changes", steps, edits };
}
