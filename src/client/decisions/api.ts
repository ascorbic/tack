import type { RepoMeta } from "../../shared/push.ts";

// The repository endpoints a decision's write-back needs (see
// src/shared/push.ts): metadata for Discussion categories, and the files in
// docs/decisions for the next record number. Swappable, as `cardStore.recheck`
// is, so the playground can answer without a server.
//
// TODO: fold into the shared client API (src/client/changes/api.ts) once it
// lands.

export interface RepoApi {
	meta(repo: string, signal?: AbortSignal): Promise<RepoMeta>;
	/** File names in a directory; empty if it doesn't exist yet. */
	files(repo: string, path: string, signal?: AbortSignal): Promise<string[]>;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
	const response = await fetch(url, { signal, headers: { accept: "application/json" } });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
	return (await response.json()) as T;
}

export const defaultRepoApi: RepoApi = {
	async meta(repo, signal) {
		const meta = await getJson<RepoMeta>(
			`/api/repos/meta?${new URLSearchParams({ repo })}`,
			signal,
		);
		if (!meta) throw new Error("Repository not found");
		return meta;
	},
	async files(repo, path, signal) {
		const files = await getJson<string[]>(
			`/api/repos/files?${new URLSearchParams({ repo, path })}`,
			signal,
		);
		return Array.isArray(files) ? files.filter((name) => typeof name === "string") : [];
	},
};

/** The API in use. The playground replaces its methods with fakes. */
export const repoApi: RepoApi = { ...defaultRepoApi };
