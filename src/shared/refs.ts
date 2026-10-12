// Forge-neutral references to issues, pull requests and their equivalents.
//
// Keys are `{host}/{repo path}{item}`, where `item` uses the forge's own
// reference syntax: `#100` on GitHub and Forgejo (issues and pull requests
// share numbers), `!12` for a GitLab merge request or a Tangled pull
// (Tangled numbers issues and pulls separately). Examples:
//   github.com/ascorbic/unpic#100
//   gitlab.com/group/subgroup/project!12
//   codeberg.org/ascorbic/emdash#7
//   tangled.org/mk.gg/tack#775

export type ForgeId = "github" | "fake" | "gitlab" | "forgejo" | "tangled";

/** The forges an instance can be configured with, besides GitHub and the test forge. */
export const CONFIGURABLE_FORGES = ["gitlab", "forgejo", "tangled"] as const;
export type ConfigurableForge = (typeof CONFIGURABLE_FORGES)[number];

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

/**
 * A repository path a forge could have: segments of letters, digits, `.`,
 * `-` and `_`, none of them `.` or `..`. Repository names end up in forge
 * API paths (`/repos/{owner}/{repo}/…`), and keys come from documents any
 * editor can write, so nothing else may get that far (#60: a `..` or `?` in
 * a name would point a request with someone's token somewhere else).
 */
export function isRepoPath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 200 &&
		path.split("/").every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")
	);
}

/** A forge host: which adapter serves it, and what copy calls it. */
export interface ForgeHost {
	/** Lowercase, e.g. `gitlab.com` or a self-hosted `git.example.com`. */
	host: string;
	forge: ForgeId;
	/** What copy calls it: `GitLab`, `Codeberg`. Absent: its host. */
	name?: string;
}

/** Always there, whatever the instance's configuration says. */
const CORE_HOSTS: readonly ForgeHost[] = [
	{ host: "github.com", forge: "github", name: "GitHub" },
	{ host: "fake.tack", forge: "fake", name: "the test forge" },
];

/**
 * Public forges every instance knows out of the box (reading public
 * repositories anonymously), unless its configuration turns them off.
 * Self-hosted ones are added by the configuration (`TACK_FORGES`, see
 * src/server/forges/config.ts).
 */
export const DEFAULT_FORGE_HOSTS: readonly ForgeHost[] = [
	{ host: "gitlab.com", forge: "gitlab", name: "GitLab" },
	{ host: "codeberg.org", forge: "forgejo", name: "Codeberg" },
	{ host: "tangled.org", forge: "tangled", name: "Tangled" },
];

/** A host name, with a port if it needs one: nothing that could be a path or a scheme. */
export const HOST_RE =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/** Old hosts whose links still work, read as the host they moved to. */
const HOST_ALIASES: Record<string, string> = { "tangled.sh": "tangled.org" };

/** Hosts served by each forge adapter: the core ones, then the defaults or the configured list. */
let HOSTS = new Map<string, ForgeHost>();

/**
 * Which hosts this instance serves besides GitHub and the test forge: the
 * server sets them from its configuration, the client from `/api/me`. They
 * replace the defaults (a configuration lists those itself, unless it turns
 * them off). GitHub and the test forge can't be replaced.
 */
export function setForgeHosts(hosts: readonly ForgeHost[]): void {
	const next = new Map<string, ForgeHost>();
	for (const entry of CORE_HOSTS) next.set(entry.host, entry);
	for (const entry of hosts) {
		const host = entry.host.toLowerCase();
		if (HOST_RE.test(host) && !CORE_HOSTS.some((core) => core.host === host)) {
			next.set(host, { ...entry, host });
		}
	}
	HOSTS = next;
}

setForgeHosts(DEFAULT_FORGE_HOSTS);

/** Every host this instance serves, GitHub first. */
export function forgeHosts(): ForgeHost[] {
	return [...HOSTS.values()];
}

/** The forge used for bare `owner/repo#123` references. */
export const DEFAULT_HOST = "github.com";

export function forgeForHost(host: string): ForgeId | null {
	return HOSTS.get(host.toLowerCase())?.forge ?? null;
}

/** Names a page gives forges' hosts in copy, over what the hosts are called (`nameForge`). */
const NAMED = new Map<string, string>();

/** Who copy names when nothing says which forge: GitHub, unless a page says otherwise. */
let namedByDefault = DEFAULT_HOST;

/**
 * Call a forge's hosts something else in copy, for this page, and with
 * `byDefault`, name it when nothing says which forge: the public demo's
 * pretend forge is `the demo forge` (#75), and it's the only one there.
 */
export function nameForge(host: string, name: string, { byDefault = false } = {}): void {
	NAMED.set(host.toLowerCase(), name);
	if (byDefault) namedByDefault = host.toLowerCase();
}

/**
 * What to call a forge in copy, by its host: `GitHub`, `GitLab`, `the test
 * forge`, or a self-hosted instance's name or host. Mid-sentence; see
 * `sentenceCase`.
 */
export function forgeName(host: string): string {
	const lower = host.toLowerCase();
	return NAMED.get(lower) ?? HOSTS.get(lower)?.name ?? lower;
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
	if (names.length === 0) return forgeName(namedByDefault);
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

/**
 * Whether a repository path suits its forge: GitLab nests projects in
 * groups, Forgejo and Tangled are always `owner/name` (so a key can't name
 * another of their API paths with more segments).
 */
function fitsForge(forge: ForgeId, repo: string): boolean {
	return forge === "forgejo" || forge === "tangled" ? repo.split("/").length === 2 : true;
}

/** Parse a repository key, `{host}/{repo path}`, on a known forge. */
export function parseRepoKey(
	repoKey: string,
): { forge: ForgeId; host: string; repo: string } | null {
	const slash = repoKey.indexOf("/");
	if (slash < 1 || slash === repoKey.length - 1) return null;
	const host = repoKey.slice(0, slash);
	const forge = forgeForHost(host);
	const repo = repoKey.slice(slash + 1);
	return forge && isRepoPath(repo) && fitsForge(forge, repo) ? { forge, host, repo } : null;
}

/** Parse a canonical item key back into a reference. */
export function parseKey(key: string): ItemRef | null {
	const match = KEY_RE.exec(key);
	if (!match) return null;
	const [, host = "", repo = "", item = ""] = match;
	const forge = forgeForHost(host);
	return forge && isRepoPath(repo) && fitsForge(forge, repo) ? { forge, host, repo, item } : null;
}

/** A link: its host, and its path without the leading slash, query or fragment. */
const LINK_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+(?::\d{1,5})?)\/([^?#\s]+)(?:[?#]\S*)?$/i;

/**
 * An item's page on each forge, as a path (after the host). Each gives the
 * repository and the forge-native item reference. GitHub's pages always say
 * which kind (a bare number is a repository's subpath); the test forge's
 * own shape (`fake.tack/o/r/1`) works as well as GitHub's, so it demos the same.
 * GitHub's discussions share their repository's numbers with its issues and
 * pull requests, so `/discussions/12` is `#12` like the rest; no other forge
 * has them, so their paths leave `/discussions/` alone.
 */
const PAGE_PATHS: Record<ForgeId, (path: string) => { repo: string; item: string } | null> = {
	github: (path) => {
		const m = /^([\w.-]+\/[\w.-]+)\/(?:issues|pulls?|discussions)\/(\d+)(?:\/.*)?$/i.exec(path);
		return m ? { repo: m[1] ?? "", item: `#${m[2]}` } : null;
	},
	fake: (path) => {
		const m = /^([\w.-]+\/[\w.-]+)\/(?:(?:issues|pulls?|discussions)\/)?(\d+)(?:\/.*)?$/i.exec(
			path,
		);
		return m ? { repo: m[1] ?? "", item: `#${m[2]}` } : null;
	},
	// Forgejo and Gitea: `/owner/repo/issues/7`, `/owner/repo/pulls/7/files`.
	forgejo: (path) => {
		const m = /^([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/(\d+)(?:\/.*)?$/i.exec(path);
		return m ? { repo: m[1] ?? "", item: `#${m[2]}` } : null;
	},
	// GitLab: `/group/sub/project/-/issues/12`, `/-/merge_requests/12/diffs`,
	// `/-/work_items/12`, and the older paths without `-/`.
	gitlab: (path) => {
		const m =
			/^((?:[\w.-]+\/)+?[\w.-]+)\/(?:-\/)?(issues|work_items|merge_requests)\/(\d+)(?:\/.*)?$/i.exec(
				path,
			);
		if (!m) return null;
		return {
			repo: m[1] ?? "",
			item: `${m[2]?.toLowerCase() === "merge_requests" ? "!" : "#"}${m[3]}`,
		};
	},
	// Tangled: `/handle/repo/issues/12` (once `/@handle/…`), and pulls, numbered separately.
	tangled: (path) => {
		const m = /^@?([\w.-]+\/[\w.-]+)\/(issues|pulls)\/(\d+)(?:\/.*)?$/i.exec(path);
		if (!m) return null;
		return { repo: m[1] ?? "", item: `${m[2]?.toLowerCase() === "pulls" ? "!" : "#"}${m[3]}` };
	},
};

const SHORT_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/**
 * Parse anything a person might paste: a canonical key, a forge URL, or a
 * bare `owner/repo#123`, which resolves against the default host.
 */
export function parseRef(input: string): ItemRef | null {
	const text = input.trim();

	const link = LINK_RE.exec(text);
	if (link) {
		const given = link[1]?.toLowerCase() ?? "";
		const host = HOST_ALIASES[given] ?? given;
		const forge = forgeForHost(host);
		const page = forge ? PAGE_PATHS[forge](link[2] ?? "") : null;
		if (forge && page && isRepoPath(page.repo)) {
			return { forge, host, repo: page.repo, item: page.item };
		}
	}

	const short = SHORT_RE.exec(text);
	if (short) {
		const forge = forgeForHost(DEFAULT_HOST);
		if (forge) return { forge, host: DEFAULT_HOST, repo: short[1] ?? "", item: `#${short[2]}` };
	}

	return parseKey(text);
}
