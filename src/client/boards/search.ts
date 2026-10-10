import type { BoardInfo, BoardList } from "../../shared/boards.ts";

// Finding a board from the home page: every board you can see, whichever
// tab it's under, matched forgivingly ("emdsh" finds "EmDash planning"),
// best matches first. Archived boards are kept apart, behind a link.

function fold(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase();
}

const WORD_START = /[\s\-_/:.,()[\]#@]/;

/**
 * How well a title matches one search word: higher is better, null for no
 * match. A substring scores best (more at the start of a word, most at the
 * start of the title); otherwise the word's letters in order, in a few
 * runs that start words, as when a vowel or two is left out.
 */
export function wordScore(title: string, word: string): number | null {
	const text = fold(title);
	const q = fold(word);
	if (!q) return 0;
	const at = text.indexOf(q);
	if (at >= 0) {
		const starts = at === 0 || WORD_START.test(text[at - 1] ?? "");
		return 100 - Math.min(at, 40) * 0.5 + (starts ? 30 : 0) + (at === 0 ? 10 : 0);
	}
	// In order, allowing gaps: "emdsh" in "emdash".
	let runs = 0;
	let gaps = 0;
	let last = -2;
	let wordStarts = 0;
	for (const char of q) {
		const found = text.indexOf(char, last + 1);
		if (found < 0) return null;
		if (found !== last + 1) {
			runs += 1;
			if (last >= 0) gaps += found - last - 1;
			if (found === 0 || WORD_START.test(text[found - 1] ?? "")) wordStarts += 1;
		}
		last = found;
	}
	// Too scattered to be what was meant: letters plucked from all over.
	if (q.length < 3 || runs > Math.max(2, Math.ceil(q.length / 3)) || gaps > q.length) return null;
	if (wordStarts === 0) return null;
	return 50 - runs * 6 - gaps * 2 + wordStarts * 4;
}

/** A title's score for a whole search: every word must match. */
export function matchScore(title: string, query: string): number | null {
	const words = query.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	let total = 0;
	for (const word of words) {
		const score = wordScore(title, word);
		if (score === null) return null;
		total += score;
	}
	return total / words.length;
}

export interface SearchResult {
	/** Matching boards, not archived, best first. */
	boards: BoardInfo[];
	/** Matching archived boards, best first. */
	archived: BoardInfo[];
}

/** Search every board on the home page at once, each board once. */
export function searchBoards(list: BoardList, query: string): SearchResult {
	const rank = (boards: BoardInfo[]) => {
		const seen = new Set<string>();
		return boards
			.filter((board) => !seen.has(board.id) && Boolean(seen.add(board.id)))
			.map((board) => ({ board, score: matchScore(board.title, query) }))
			.filter((entry): entry is { board: BoardInfo; score: number } => entry.score !== null)
			.sort((a, b) => b.score - a.score || b.board.updatedAt - a.board.updatedAt)
			.map((entry) => entry.board);
	};
	return {
		boards: rank([...list.recent, ...list.mine, ...list.shared, ...list.open]),
		archived: rank(list.archived),
	};
}
