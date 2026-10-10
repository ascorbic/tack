// Forge-neutral references to issues, pull requests and their equivalents.
//
// Keys are `{host}/{repo path}{item}`, where `item` uses the forge's own
// reference syntax: `#100` on GitHub (issues and PRs share numbers),
// `!12` for a GitLab merge request. Examples:
//   github.com/ascorbic/unpic#100
//   gitlab.com/group/subgroup/project!12

export type ForgeId = "github" | "fake";

export interface ItemRef {
	forge: ForgeId;
	/** Forge host, e.g. `github.com` or a self-hosted instance. */
	host: string;
	/** Repository path on that host, e.g. `ascorbic/unpic`. */
	repo: string;
	/** Forge-native item reference, e.g. `#100` or `!12`. */
	item: string;
}

const KEY_RE = /^([^/]+)\/(.+?)([#!]\d+)$/;

/** Hosts served by each forge adapter. Self-hosted instances get added here. */
const HOSTS: Record<string, ForgeId> = {
	"github.com": "github",
	"fake.tack": "fake",
};

/** The forge used for bare `owner/repo#123` references. */
export const DEFAULT_HOST = "github.com";

export function forgeForHost(host: string): ForgeId | null {
	return HOSTS[host.toLowerCase()] ?? null;
}

/** What copy calls each forge's hosts. Others go by their host. */
const FORGE_NAMES: Record<string, string> = {
	"github.com": "GitHub",
	"fake.tack": "the test forge",
};

/**
 * What to call a forge in copy, by its host: `GitHub`, `the test forge`,
 * or a self-hosted instance's host. Mid-sentence; see `sentenceCase`.
 */
export function forgeName(host: string): string {
	return FORGE_NAMES[host.toLowerCase()] ?? host.toLowerCase();
}

/**
 * What to call the forge these repositories or items are on (keys of
 * either): its name if they share one, both names for two, "their forges"
 * for more. With none known, the default forge.
 */
export function forgeNameOf(keys: Iterable<string>): string {
	const hosts = new Set<string>();
	for (const key of keys) {
		const host = key.slice(0, key.indexOf("/")).toLowerCase();
		if (host) hosts.add(host);
	}
	const names = [...hosts].map(forgeName).sort();
	if (names.length === 0) return forgeName(DEFAULT_HOST);
	if (names.length <= 2) return names.join(" and ");
	return "their forges";
}

/** Copy that starts with a forge's name: `The test forge says…`. */
export function sentenceCase(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function itemKey(ref: Pick<ItemRef, "host" | "repo" | "item">): string {
	return `${ref.host}/${ref.repo}${ref.item}`.toLowerCase();
}

/** The repository part of an item key: `github.com/ascorbic/unpic`. */
export function repoKeyOf(key: string): string {
	const match = KEY_RE.exec(key);
	return match ? `${match[1]}/${match[2]}` : key;
}

/** The forge-native item part of a key: `#100` for `github.com/a/b#100`. */
export function itemOf(key: string): string | null {
	return KEY_RE.exec(key)?.[3] ?? null;
}

/** Parse a repository key, `{host}/{repo path}`, on a known forge. */
export function parseRepoKey(
	repoKey: string,
): { forge: ForgeId; host: string; repo: string } | null {
	const slash = repoKey.indexOf("/");
	if (slash < 1 || slash === repoKey.length - 1) return null;
	const host = repoKey.slice(0, slash);
	const forge = forgeForHost(host);
	return forge ? { forge, host, repo: repoKey.slice(slash + 1) } : null;
}

/** Parse a canonical item key back into a reference. */
export function parseKey(key: string): ItemRef | null {
	const match = KEY_RE.exec(key);
	if (!match) return null;
	const [, host = "", repo = "", item = ""] = match;
	const forge = forgeForHost(host);
	return forge ? { forge, host, repo, item } : null;
}

/**
 * An item's page on a forge we know: `https://github.com/o/r/issues/1` or
 * `/pull/1/files`, with or without `www.` or TLS, and the test forge's own
 * shape (`https://fake.tack/o/r/1`) as well as GitHub's, so it demos the same.
 */
const URL_RE =
	/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+)\/([\w.-]+\/[\w.-]+)\/(?:(?:issues|pulls?)\/)?(\d+)(?:[/?#].*)?$/i;
const SHORT_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/**
 * Parse anything a person might paste: a canonical key, a forge URL, or a
 * bare `owner/repo#123`, which resolves against the default host.
 */
export function parseRef(input: string): ItemRef | null {
	const text = input.trim();

	const url = URL_RE.exec(text);
	const urlHost = url?.[1]?.toLowerCase() ?? "";
	const urlForge = forgeForHost(urlHost);
	// GitHub's pages for an item always say which kind: a bare number is a repository's subpath.
	if (url && urlForge && (urlForge !== "github" || /\/(issues|pulls?)\/\d/i.test(text))) {
		return { forge: urlForge, host: urlHost, repo: url[2] ?? "", item: `#${url[3]}` };
	}

	const short = SHORT_RE.exec(text);
	if (short) {
		const forge = forgeForHost(DEFAULT_HOST);
		if (forge) return { forge, host: DEFAULT_HOST, repo: short[1] ?? "", item: `#${short[2]}` };
	}

	return parseKey(text);
}
