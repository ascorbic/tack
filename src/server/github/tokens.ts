// Tokens for reading GitHub data. Implemented by the GitHub App work (#3):
// installation tokens for repos where the app is installed. Everything that
// reads GitHub goes through here rather than reading env directly.

/**
 * A token for reading a repository, keyed like `github.com/owner/repo`, or
 * null to read it unauthenticated (public repos only).
 */
export async function repoToken(env: Env, _repoKey: string): Promise<string | null> {
	return env.GITHUB_TOKEN || null;
}

/** Whether the GitHub App is installed on a repository (#9). */
export async function isInstalled(_env: Env, _repoKey: string): Promise<boolean> {
	return false;
}
