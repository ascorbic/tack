import { itemKey } from "./refs.ts";

// References to other items in an item's text (a pull request's title and
// description), as GitHub reads them: `#12`, `owner/repo#12`, and links to
// issues and pull requests. A reference right after a closing keyword
// ("Fixes #12") closes it when the pull request merges.

export interface ItemMention {
	/** The item's key, e.g. `github.com/acme/widgets#12`. */
	key: string;
	/** After a closing keyword: merging closes it. */
	closes: boolean;
}

const KEYWORDS = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";

// A keyword (optionally with a colon), then a reference; or a bare reference.
const REF =
	"(?:https?:\\/\\/github\\.com\\/([\\w.-]+\\/[\\w.-]+)\\/(?:issues|pull)\\/(\\d+)|(?<![\\w/#])(?:([\\w.-]+\\/[\\w.-]+))?#(\\d+)\\b)";
const MENTION_RE = new RegExp(`(?:\\b(${KEYWORDS}):?\\s+)?${REF}`, "gi");

/**
 * Items an item's text refers to, each once (closing wins over mentioning),
 * in the order they first appear. `host` and `repo` are the item's own, for
 * bare `#12` references; `self` is left out.
 */
export function mentionsIn(
	text: string,
	{ host, repo, self }: { host: string; repo: string; self?: string },
): ItemMention[] {
	const found = new Map<string, ItemMention>();
	// Code says nothing about what a pull request is for.
	const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
	for (const match of prose.matchAll(MENTION_RE)) {
		const [, keyword, urlRepo, urlNumber, refRepo, refNumber] = match;
		const number = urlNumber ?? refNumber;
		if (!number) continue;
		const inRepo = urlRepo ?? refRepo ?? repo;
		// Links only count on the forge they point at.
		if (urlRepo && host.toLowerCase() !== "github.com") continue;
		const key = itemKey({ host, repo: inRepo, item: `#${number}` });
		if (key === self) continue;
		const closes = Boolean(keyword);
		const existing = found.get(key);
		if (existing) existing.closes ||= closes;
		else found.set(key, { key, closes });
	}
	return [...found.values()];
}
