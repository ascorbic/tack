import { type Card, isMissing, type MissingCard } from "../shared/cards.ts";

// What each viewer of a board may see of a card (#10). `Repo` caches are
// shared, so boards filter per connection with these.

type Entry = Card | MissingCard;

/**
 * Cards anyone may see: from a public repository. Anything else (private,
 * or visibility unknown) only goes to viewers who can read the repository.
 * Missing entries carry no data, so they're public too.
 */
export function isPublic(entry: Entry): boolean {
	return isMissing(entry) || entry.visibility === "public";
}

/** What a viewer who can't read the repository gets: the key, which the board already has. */
export function privatePlaceholder(key: string): MissingCard {
	return { key, missing: true, reason: "private" };
}

/**
 * Pull requests can close issues in other repositories, and the card
 * carries their titles. Unless the forge said that repository is public,
 * drop the title: being able to read this card's repository says nothing
 * about another one.
 */
export function withoutPrivateLinks(card: Card): Card {
	const linked = card.pull?.linked;
	const hidden = (link: { repo: string; private?: boolean }) =>
		link.repo !== card.repo && link.private !== false;
	if (!card.pull || !linked?.some(hidden)) return card;
	return {
		...card,
		pull: {
			...card.pull,
			linked: linked.map((link) => (hidden(link) ? { ...link, title: "", private: true } : link)),
		},
	};
}

/** A card as a viewer sees it, given whether they can read its repository. */
export function visibleCard(entry: Entry, canRead: boolean): Entry {
	if (isMissing(entry)) return entry;
	if (!isPublic(entry) && !canRead) return privatePlaceholder(entry.key);
	return withoutPrivateLinks(entry);
}
