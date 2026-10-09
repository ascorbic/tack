// Tokens for reading GitHub data: installation tokens for repos where the
// app is installed. Everything that reads GitHub goes through here rather
// than reading env directly. The Instance object mints and caches tokens;
// each isolate also keeps them briefly to save a round trip per fetch.

import { instance } from "../namespaces.ts";

/** Use tokens until this long before they expire. */
const REFRESH_MARGIN = 5 * 60_000;
/** How long an isolate remembers that a repo has no installation. */
const MISS_TTL = 60_000;

const cache = new Map<string, { token: string | null; freshUntil: number }>();

/** `github.com/Owner/Repo` → `owner/repo`, or null for other forges. */
function githubRepo(repoKey: string): string | null {
	const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(repoKey);
	return match?.[1]?.toLowerCase() ?? null;
}

/**
 * A token for reading a repository, keyed like `github.com/owner/repo`, or
 * null to read it unauthenticated (public repos only). Falls back to
 * `GITHUB_TOKEN`, if set, where the app isn't installed.
 */
export async function repoToken(env: Env, repoKey: string): Promise<string | null> {
	const repo = githubRepo(repoKey);
	if (repo && env.TACK_SECRET) {
		const now = Date.now();
		let entry = cache.get(repo);
		if (!entry || entry.freshUntil <= now) {
			const minted = await instance(env).repoToken(repo);
			entry = minted
				? { token: minted.token, freshUntil: minted.expiresAt - REFRESH_MARGIN }
				: { token: null, freshUntil: now + MISS_TTL };
			cache.set(repo, entry);
		}
		if (entry.token) return entry.token;
	}
	return env.GITHUB_TOKEN || null;
}

/** Whether the GitHub App is installed on a repository (#9). */
export async function isInstalled(env: Env, repoKey: string): Promise<boolean> {
	const repo = githubRepo(repoKey);
	if (!repo || !env.TACK_SECRET) return false;
	const cached = cache.get(repo);
	if (cached?.token && cached.freshUntil > Date.now()) return true;
	return instance(env).isInstalled(repo);
}

/**
 * Forget this isolate's cached token (or lack of one) for a repository, when
 * the app was just installed on it or removed from it (#9).
 */
export function forgetRepoToken(repoKey: string): void {
	const repo = githubRepo(repoKey);
	if (repo) cache.delete(repo);
}

/**
 * Ask to hear when the app is installed on (or removed from) a repository,
 * keyed like `github.com/owner/repo`: the `Repo` object holding its cards
 * (`installationChanged`), or a board that couldn't read it at all
 * (`repoInstallChanged`). See `Instance.watchInstallation`.
 */
export async function watchInstallation(
	env: Env,
	repoKey: string,
	watcher: { kind: "repo" | "board"; name: string },
): Promise<void> {
	const repo = githubRepo(repoKey);
	if (!repo || !env.TACK_SECRET) return;
	await instance(env).watchInstallation(repo, watcher.kind, watcher.name);
}
/**
 * A JWT for calling GitHub as the app itself (e.g. listing and redelivering
 * failed webhook deliveries, #13), or null if no app is configured.
 */
export async function appJwt(env: Env): Promise<string | null> {
	if (!env.TACK_SECRET) return null;
	return instance(env).appJwt();
}
