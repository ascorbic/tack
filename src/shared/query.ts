import type { Card } from "./cards.ts";
import type { SearchQuery } from "./widgets.ts";

// A local reading of forge searches (GitHub's issue search syntax), for
// deciding whether one card matches a query without asking the forge: rules
// test every webhook's items against their query, and inbox frames use it to
// tell when a card they brought stops matching. It understands the
// qualifiers a card can answer (repository, kind, state, labels, assignees,
// author and words in the title); anything else makes the answer unknown,
// never a guess.

export interface ParsedQuery {
	terms: Term[];
	/** Free words, matched against the title. */
	words: string[];
	/** Qualifiers this reading doesn't understand, e.g. `milestone:v1`. */
	unsupported: string[];
}

interface Term {
	key: string;
	/** Comma-separated values mean any of them (GitHub's OR for labels). */
	values: string[];
	negated: boolean;
}

/** Qualifiers that change nothing about which items match. */
const IGNORED = new Set(["sort", "in"]);
const SUPPORTED = new Set([
	"repo",
	"org",
	"user",
	"is",
	"type",
	"state",
	"label",
	"no",
	"assignee",
	"author",
]);

const TOKEN_RE = /(-?)([a-z]+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/gi;

export function parseQuery(q: string): ParsedQuery {
	const parsed: ParsedQuery = { terms: [], words: [], unsupported: [] };
	for (const match of q.matchAll(TOKEN_RE)) {
		const [whole, negation, rawKey, rawValue, quoted, word] = match;
		if (rawKey && rawValue !== undefined) {
			const key = rawKey.toLowerCase();
			if (IGNORED.has(key)) continue;
			if (!SUPPORTED.has(key)) {
				parsed.unsupported.push(whole);
				continue;
			}
			const value = rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
			parsed.terms.push({
				key,
				values: value
					.split(",")
					.map((v) => v.trim().toLowerCase())
					.filter(Boolean),
				negated: negation === "-",
			});
		} else {
			const text = (quoted ?? word ?? "").trim().toLowerCase();
			if (text) parsed.words.push(text);
		}
	}
	return parsed;
}

/** The repositories a query is limited to, as repository keys (`github.com/owner/repo`). */
export function queryRepos(query: Pick<SearchQuery, "host" | "q">): string[] {
	return parseQuery(query.q)
		.terms.filter((term) => term.key === "repo" && !term.negated)
		.flatMap((term) => term.values.map((repo) => `${query.host.toLowerCase()}/${repo}`));
}

/**
 * Whether a card matches a query: true or false, or null when the query asks
 * something the card can't answer (an unknown qualifier, `@me`).
 */
export function matchesQuery(card: Card, query: Pick<SearchQuery, "host" | "q">): boolean | null {
	if (card.host.toLowerCase() !== query.host.toLowerCase()) return false;
	const parsed = parseQuery(query.q);
	let unknown = parsed.unsupported.length > 0;
	for (const term of parsed.terms) {
		const result = matchesTerm(card, term);
		if (result === null) unknown = true;
		else if (result === term.negated) return false;
	}
	const title = card.title.toLowerCase();
	for (const word of parsed.words) {
		if (word.startsWith("-")) {
			if (title.includes(word.slice(1))) return false;
		} else if (!title.includes(word)) return false;
	}
	return unknown ? null : true;
}

/** Whether the term's condition (before negation) holds, or null if it can't be told. */
function matchesTerm(card: Card, term: Term): boolean | null {
	const any = (test: (value: string) => boolean | null): boolean | null => {
		let unknown = false;
		for (const value of term.values) {
			const result = test(value);
			if (result === true) return true;
			if (result === null) unknown = true;
		}
		return unknown ? null : false;
	};
	switch (term.key) {
		case "repo":
			return any((value) => card.repo.toLowerCase() === value);
		case "org":
		case "user":
			return any((value) => card.repo.toLowerCase().startsWith(`${value}/`));
		case "is":
		case "type":
		case "state":
			return any((value) => isState(card, value));
		case "label": {
			const labels = card.labels.map((label) => label.name.toLowerCase());
			return any((value) => labels.includes(value));
		}
		case "no":
			return any((value) =>
				value === "label"
					? card.labels.length === 0
					: value === "assignee"
						? card.assignees.length === 0
						: null,
			);
		case "assignee":
			return any((value) =>
				value === "@me" ? null : card.assignees.some((a) => a.login.toLowerCase() === value),
			);
		case "author":
			return any((value) =>
				value === "@me" ? null : card.author ? card.author.login.toLowerCase() === value : null,
			);
		default:
			return null;
	}
}

function isState(card: Card, value: string): boolean | null {
	switch (value) {
		case "issue":
			return card.kind === "issue";
		case "pr":
		case "pull-request":
			return card.kind === "pull";
		case "open":
			return card.state === "open" || card.state === "draft";
		case "closed":
			return card.state === "closed" || card.state === "merged";
		case "merged":
			return card.state === "merged";
		case "unmerged":
			return card.kind === "pull" && card.state !== "merged";
		case "draft":
			return card.state === "draft";
		default:
			return null;
	}
}

/**
 * Why a query can't be used where every match must be decided locally (a
 * rule), or null if it can: qualifiers this reading doesn't know, or `@me`,
 * which means nobody in particular to a rule.
 */
export function unsupportedForRules(q: string): string | null {
	const parsed = parseQuery(q);
	if (parsed.unsupported.length > 0) {
		return `Rules can't check ${parsed.unsupported.map((u) => `“${u}”`).join(", ")} yet.`;
	}
	if (parsed.terms.some((term) => term.values.includes("@me"))) {
		return "Rules run for the whole board, so “@me” means nobody in particular.";
	}
	for (const term of parsed.terms) {
		if (
			(term.key === "is" || term.key === "type" || term.key === "state") &&
			term.values.some((v) => isState(STUB, v) === null)
		) {
			return `Rules can't check “${term.key}:${term.values.join(",")}” yet.`;
		}
		if (term.key === "no" && term.values.some((v) => v !== "label" && v !== "assignee")) {
			return `Rules can't check “no:${term.values.join(",")}” yet.`;
		}
	}
	if (queryRepos({ host: "", q }).length === 0) {
		return "Add a repository (repo:owner/name), so the rule knows where to look.";
	}
	return null;
}

const STUB: Card = {
	key: "",
	forge: "fake",
	host: "",
	repo: "",
	item: "",
	kind: "issue",
	title: "",
	state: "open",
	stateReason: null,
	labels: [],
	assignees: [],
	author: null,
	comments: 0,
	reactions: 0,
	url: "",
	updatedAt: "",
};
