import type { Card, MissingCard } from "../../shared/cards.ts";
import { forgeForHost, repoKeyOf } from "../../shared/refs.ts";

// Whether a board's repositories are ready for a session: live (the app
// is installed, so updates arrive as they happen) and writable (staged
// changes can be pushed). Read from the cards the board already has, so
// the Share dialog can say "pixelmill/pixelmill: read-only" before anyone tries.

export type RepoState =
	/** Live, and Tack can push. */
	| "ready"
	/** Checked for while someone's looking, and Tack can't push: the app isn't installed. */
	| "readonly"
	/**
	 * Checked for while someone's looking, but Tack can push: a forge without
	 * an app (GitLab, Forgejo) whose webhooks haven't arrived lately (#65).
	 */
	| "checked"
	/** Tack can't read it: private, or gone. */
	| "unreadable"
	/** No card from it has loaded yet. */
	| "loading";

export interface BoardRepo {
	/** `github.com/emdash-cms/emdash` */
	key: string;
	/** `emdash-cms/emdash`; on forges besides GitHub, with their host: `gitlab.com/group/app` */
	name: string;
	cards: number;
	state: RepoState;
}

const ORDER: Record<RepoState, number> = {
	readonly: 0,
	unreadable: 1,
	loading: 2,
	checked: 3,
	ready: 4,
};

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
				: states.has("checked")
					? "checked"
					: states.has("readonly")
						? "readonly"
						: states.has("unreadable")
							? "unreadable"
							: "loading";
			return { key, name: displayName(key), cards, state };
		})
		.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

/** GitHub's repositories (and the test forge's) by their path; others with their host. */
function displayName(key: string): string {
	const host = key.slice(0, key.indexOf("/"));
	const forge = forgeForHost(host);
	return forge === "github" || forge === "fake" ? key.slice(key.indexOf("/") + 1) : key;
}

function stateOf(card: Card | MissingCard | undefined): RepoState {
	if (!card) return "loading";
	if ("missing" in card) {
		// An item that's gone (or the forge erring) says nothing about the repository.
		return card.reason === "private" || card.reason === "forbidden" ? "unreadable" : "loading";
	}
	// Fixtures and older caches say nothing: assume the best, as cards do.
	if (card.writable === false) return "readonly";
	if (card.live === false)
		return card.writable === true && card.forge !== "github" ? "checked" : "readonly";
	return "ready";
}
