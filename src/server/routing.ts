import { parseRepoKey } from "../shared/refs.ts";
import { forge, type MissingReason, type RepoIdentity } from "./forges/index.ts";
import { repos } from "./namespaces.ts";

// Card keys name repositories (`github.com/owner/repo#1`), but names change
// when repositories are renamed or transferred. `Repo` Durable Objects are
// keyed by host and the forge's stable repository id instead, so a rename
// never splits a repository's cache or its subscriptions. See
// docs/github-data.md.

/** The `Repo` Durable Object name for a repository: `{host}/@{id}`. */
export function repoObjectName(repo: Pick<RepoIdentity, "host" | "id">): string {
	return `${repo.host}/@${repo.id}`;
}

export function repoObject(env: Env, repo: Pick<RepoIdentity, "host" | "id">) {
	return repos(env).getByName(repoObjectName(repo));
}

/**
 * Resolve a repository key (`{host}/{path}`) to the repository's identity.
 * Old names of renamed repositories resolve to the same identity, for as
 * long as the forge redirects them.
 */
export async function resolveRepo(
	env: Env,
	repoKey: string,
): Promise<RepoIdentity | MissingReason> {
	const parsed = parseRepoKey(repoKey);
	if (!parsed) return "unsupported";
	const adapter = forge(parsed.forge);
	if (adapter.resolveRepo) return adapter.resolveRepo(parsed.host, parsed.repo, env);
	const name = parsed.repo.toLowerCase();
	// Forges that can't say who may read a repository have no private ones.
	return { forge: parsed.forge, host: parsed.host, id: name, name, private: false };
}
