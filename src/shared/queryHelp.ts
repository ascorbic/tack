import { type SearchTerm, formatTerm, parseSearch, searchScope } from "./search.ts";

// Help for people writing searches who don't speak GitHub's search syntax
// (#38, #40, #44). "bugs in imagekit" is a search for those three words
// everywhere you can see: on github.com, random results from all of GitHub;
// on a board, nothing, ever. Read with what the board knows (its busiest
// repository and that repository's labels), most such searches have an
// obvious meaning, which is offered as a suggestion, never applied unasked.

export interface QueryContext {
	/** The board's busiest repository, `owner/name`. */
	repo?: string | null;
	/** Label names in it. */
	labels?: readonly string[];
}

export interface QueryRescue {
	/** The search as it was probably meant. */
	q: string;
	/** What changed, as phrases: "“bugs” as the bug label", "only in acme/imagekit". */
	changes: string[];
	/** Whether the only change is limiting it to the repository. */
	scopeOnly: boolean;
}

/** Words that say what kind of item, and what state, as qualifiers. */
const WORDS: Record<string, string> = {
	open: "is:open",
	closed: "is:closed",
	merged: "is:merged",
	draft: "is:draft",
	drafts: "is:draft",
	issue: "is:issue",
	issues: "is:issue",
	pr: "is:pr",
	prs: "is:pr",
	unassigned: "no:assignee",
	unlabelled: "no:label",
	unlabeled: "no:label",
};

/** Words that join others in a sentence but mean nothing to a search. */
const FILLER = new Set(["in", "on", "from", "for", "the", "a", "an", "all", "any", "with", "of"]);

const normal = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, " ");

/** The label a run of words names, trying it as written and in the singular. */
function labelFor(words: string, labels: readonly string[]): string | null {
	const wanted = normal(words);
	const forms = [
		wanted,
		wanted.replace(/ies$/, "y"),
		wanted.replace(/s$/, ""),
		wanted.replace(/es$/, ""),
	];
	for (const form of forms) {
		const found = labels.find((label) => normal(label) === form);
		if (found) return found;
	}
	return null;
}

/**
 * What a search probably means, if it reads as words or could match anything
 * anywhere and the board can say better: words that name a label, a kind or a
 * state become qualifiers, the repository's name scopes it, and a search with
 * no scope is limited to the board's repository. Null when there's nothing to
 * suggest.
 */
export function rescueQuery(q: string, context: QueryContext = {}): QueryRescue | null {
	const trimmed = q.trim();
	if (!trimmed) return null;
	const { terms } = parseSearch(trimmed);
	const repo = context.repo?.trim() || null;
	const repoName = repo?.split("/").at(-1)?.toLowerCase() ?? null;
	const labels = context.labels ?? [];
	const scoped = (() => {
		const scope = searchScope({ terms });
		return scope.repos.length > 0 || scope.owners.length > 0;
	})();

	// What the search becomes; filler words go if anything else was understood.
	const out: { text: string; filler?: boolean }[] = [];
	const changes: string[] = [];
	let named = false;
	const isWord = (term: SearchTerm | undefined) => term?.key === null && !term.negated;

	for (let i = 0; i < terms.length;) {
		const term = terms[i] as SearchTerm;
		if (!isWord(term)) {
			out.push({ text: term.raw });
			i++;
			continue;
		}
		// The longest run of words (up to three) that names a label.
		let matched = 0;
		for (let n = Math.min(3, terms.length - i); n >= 1 && !matched; n--) {
			const run = terms.slice(i, i + n);
			if (!run.every(isWord)) continue;
			const label = labelFor(run.map((t) => t.value).join(" "), labels);
			if (!label) continue;
			out.push({ text: formatTerm({ key: "label", value: label, negated: false }) });
			changes.push(`“${run.map((t) => t.value).join(" ")}” as the ${label} label`);
			matched = n;
		}
		if (matched) {
			i += matched;
			continue;
		}
		const word = term.value.toLowerCase();
		const qualifier = WORDS[word];
		if (qualifier) {
			out.push({ text: qualifier });
			changes.push(`“${term.value}” as ${qualifier}`);
		} else if (repo && !scoped && (word === repoName || word === repo.toLowerCase())) {
			named = true;
		} else if (FILLER.has(word) && (labels.length > 0 || repo)) {
			// Dropped, if anything else in the search was understood (below).
			out.push({ text: term.raw, filler: true });
		} else {
			out.push({ text: term.raw });
		}
		i++;
	}

	const understood = changes.length > 0 || named;
	const kept = out.filter((part) => !part.filler || !understood).map((part) => part.text);
	// Each qualifier once.
	const unique = kept.filter((part, i) => !part.includes(":") || kept.indexOf(part) === i);
	let scopeAdded = false;
	if (repo && !scoped) {
		unique.unshift(`repo:${repo}`);
		scopeAdded = true;
		changes.push(`only in ${repo}`);
	}
	const next = unique.join(" ");
	if (!scopeAdded && !understood) return null;
	if (next === trimmed) return null;
	return { q: next, changes, scopeOnly: scopeAdded && !understood };
}

/**
 * Whether a search may well find nothing for a reason worth checking: it
 * searches for words, or it could match anything anywhere. An empty result
 * for one of these says "check the search", not "nothing yet".
 */
export function mightMiss(q: string): boolean {
	const parsed = parseSearch(q);
	const scope = searchScope(parsed);
	return (
		parsed.terms.some((term) => term.key === null && !term.negated) ||
		(scope.repos.length === 0 && scope.owners.length === 0)
	);
}
