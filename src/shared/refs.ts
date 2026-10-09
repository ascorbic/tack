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

const GITHUB_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/i;
const SHORT_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/**
 * Parse anything a person might paste: a canonical key, a forge URL, or a
 * bare `owner/repo#123`, which resolves against the default host.
 */
export function parseRef(input: string): ItemRef | null {
	const text = input.trim();

	const url = GITHUB_URL_RE.exec(text);
	if (url) return { forge: "github", host: "github.com", repo: url[1] ?? "", item: `#${url[2]}` };

	const short = SHORT_RE.exec(text);
	if (short) {
		const forge = forgeForHost(DEFAULT_HOST);
		if (forge) return { forge, host: DEFAULT_HOST, repo: short[1] ?? "", item: `#${short[2]}` };
	}

	return parseKey(text);
}
