import { itemKey, parseRef } from "../shared/refs.ts";

// Reading what's typed into the card tool (C): a reference to add, or a
// search of the board's repositories. Pure, so it's unit-tested.

/** Where searches look: the board's repositories (`owner/name`), busiest first, on one forge. */
export interface CardScope {
	host: string;
	repos: string[];
}

/** What adding did: keys added, and keys already on the board (shown there instead). */
export interface AddOutcome {
	added: string[];
	existing: string[];
	/** What to say about the ones already there: "emdash#412 is already on the board". */
	notice?: string;
}

/** At most this many of the board's repositories are searched at once. */
const SEARCH_REPOS = 5;

/** What's typed into the card tool. */
export type CardInput =
	| { kind: "empty" }
	| { kind: "ref"; key: string }
	| { kind: "search"; host: string; q: string; where: string }
	| { kind: "invalid"; message: string };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Read what's typed: a reference to add (a link, `owner/repo#123`, or just
 * `#123` in the board's busiest repository), a search (words, searched in
 * the board's repositories, or `owner/repo` then words), or neither.
 */
export function readCardInput(text: string, scope: CardScope): CardInput {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	const ref = parseRef(trimmed);
	if (ref) return { kind: "ref", key: itemKey(ref) };
	const [main] = scope.repos;
	const number = /^#?(\d+)$/.exec(trimmed);
	if (number && main) {
		return { kind: "ref", key: itemKey({ host: scope.host, repo: main, item: `#${number[1]}` }) };
	}
	if (/^(https?:\/\/|www\.)/i.test(trimmed) || trimmed.includes("\n")) {
		return {
			kind: "invalid",
			message: "That’s not a link to an issue or pull request: try owner/repo#123, or search.",
		};
	}
	const [first = "", ...rest] = trimmed.split(/\s+/);
	if (REPO_RE.test(first)) {
		const words = rest.join(" ");
		return {
			kind: "search",
			host: scope.host,
			q: `repo:${first} ${words}`.trim(),
			where: first,
		};
	}
	if (trimmed.length < 2) return { kind: "empty" };
	if (!main) {
		return {
			kind: "invalid",
			message: "Paste a link to an issue or pull request, or start with owner/repo to search it.",
		};
	}
	const repos = scope.repos.slice(0, SEARCH_REPOS);
	return {
		kind: "search",
		host: scope.host,
		q: `${repos.map((repo) => `repo:${repo}`).join(" ")} ${trimmed}`,
		where: repos.length === 1 ? main : `${repos.length} repositories on this board`,
	};
}
