import type { Card, MissingCard } from "../../shared/cards.ts";
import { repoKeyOf } from "../../shared/refs.ts";

// Whether a board's repositories are ready for a session: live (the app
// is installed, so updates arrive as they happen) and writable (staged
// changes can be pushed). Read from the cards the board already has, so
// the Share dialog can say "lovell/sharp: read-only" before anyone tries.

export type RepoState =
	/** Live, and Tack can push. */
	| "ready"
	/** Checked for while someone's looking, and Tack can't push: the app isn't installed. */
	| "readonly"
	/** Tack can't read it: private, or gone. */
	| "unreadable"
	/** No card from it has loaded yet. */
	| "loading";

export interface BoardRepo {
	/** `github.com/emdash-cms/emdash` */
	key: string;
	/** `emdash-cms/emdash` */
	name: string;
	cards: number;
	state: RepoState;
}

const ORDER: Record<RepoState, number> = { readonly: 0, unreadable: 1, loading: 2, ready: 3 };

/** The board's repositories, the ones that need something first. */
export function boardRepos(
	keys: Iterable<string>,
	get: (key: string) => Card | MissingCard | undefined,
): BoardRepo[] {
	const repos = new Map<string, { cards: number; states: Set<RepoState> }>();
	for (const key of keys) {
		const repo = repoKeyOf(key);
		if (repo === key) continue;
		const entry = repos.get(repo) ?? { cards: 0, states: new Set<RepoState>() };
		entry.cards += 1;
		entry.states.add(stateOf(get(key)));
		repos.set(repo, entry);
	}
	return [...repos]
		.map(([key, { cards, states }]): BoardRepo => {
			// One card that's read tells us about the repository; failures elsewhere are per item.
			const state: RepoState = states.has("ready")
				? "ready"
				: states.has("readonly")
					? "readonly"
					: states.has("unreadable")
						? "unreadable"
						: "loading";
			return { key, name: key.slice(key.indexOf("/") + 1), cards, state };
		})
		.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

function stateOf(card: Card | MissingCard | undefined): RepoState {
	if (!card) return "loading";
	if ("missing" in card) {
		// An item that's gone (or the forge erring) says nothing about the repository.
		return card.reason === "private" || card.reason === "forbidden" ? "unreadable" : "loading";
	}
	// Fixtures and older caches say nothing: assume the best, as cards do.
	return card.live === false || card.writable === false ? "readonly" : "ready";
}
