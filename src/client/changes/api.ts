import { useEffect, useSyncExternalStore } from "react";
import type { AuditEntry, PushRequest, PushResponse, RepoMeta } from "../../shared/push.ts";

// The push API (src/shared/push.ts), for the pending-changes panel, the push
// sheet and anything else that writes to GitHub. Change statuses don't come
// from here: they arrive through the board document, so nothing polls.
//
//   const client = pushApi(boardId);
//   const response = await client.push({ ids, as: "user" });
//
// The playground swaps in a simulated client with the same shape.

/** A push the server refused, or one that never reached it. */
export type PushRefusal =
	| Extract<PushResponse, { ok: false }>
	| { ok: false; reason: "offline"; message: string };

export type PushResult = Extract<PushResponse, { ok: true }> | PushRefusal;

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

/** Everything that talks to the push API, so the playground can fake it. */
export interface PushClient {
	push(request: PushRequest): Promise<PushResult>;
	/** The board's past pushes, newest first. */
	pushes(): Promise<Loaded<AuditEntry[]>>;
	/** A repository's labels, milestones, assignees and watcher count. */
	repoMeta(repo: string): Promise<Loaded<RepoMeta>>;
}

async function getJson<T>(path: string): Promise<Loaded<T>> {
	try {
		const response = await fetch(path, { headers: { accept: "application/json" } });
		const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
		if (response.ok && body) return { ok: true, value: body };
		return { ok: false, error: body?.error ?? `http_${response.status}` };
	} catch {
		return { ok: false, error: "offline" };
	}
}

/** The real push API for a board. */
export function pushApi(boardId: string): PushClient {
	const board = `/api/boards/${encodeURIComponent(boardId)}`;
	return {
		async push(request) {
			try {
				const response = await fetch(`${board}/push`, {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify(request),
				});
				const body = (await response.json().catch(() => null)) as PushResponse | null;
				if (body && typeof body === "object" && "ok" in body) return body;
				if (response.status === 401) {
					return { ok: false, reason: "signed_out", message: "Sign in to push." };
				}
				return { ok: false, reason: "offline", message: `The server answered ${response.status}.` };
			} catch {
				return { ok: false, reason: "offline", message: "Couldn’t reach Tack." };
			}
		},
		pushes: () => getJson<AuditEntry[]>(`${board}/pushes`),
		async repoMeta(repo) {
			try {
				return { ok: true, value: await repoApi.meta(repo) };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : "offline" };
			}
		},
	};
}

// --- Repository endpoints ----------------------------------------------------
//
// Metadata (labels, milestones, assignees, Discussion categories, watchers)
// and the files in a directory, e.g. docs/decisions for a decision record's
// next number. Swappable, as `cardStore.recheck` is, so the playground can
// answer without a server.

export interface RepoApi {
	meta(repo: string, signal?: AbortSignal): Promise<RepoMeta>;
	/** File names in a directory; empty if it doesn't exist yet. */
	files(repo: string, path: string, signal?: AbortSignal): Promise<string[]>;
}

async function getOrNull<T>(url: string, signal?: AbortSignal): Promise<T | null> {
	const response = await fetch(url, { signal, headers: { accept: "application/json" } });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
	return (await response.json()) as T;
}

export const defaultRepoApi: RepoApi = {
	async meta(repo, signal) {
		const meta = await getOrNull<RepoMeta>(
			`/api/repos/meta?${new URLSearchParams({ repo })}`,
			signal,
		);
		if (!meta) throw new Error("Repository not found");
		return meta;
	},
	async files(repo, path, signal) {
		const files = await getOrNull<string[]>(
			`/api/repos/files?${new URLSearchParams({ repo, path })}`,
			signal,
		);
		return Array.isArray(files) ? files.filter((name) => typeof name === "string") : [];
	},
};

/** The repository API in use. The playground replaces its methods with fakes. */
export const repoApi: RepoApi = { ...defaultRepoApi };

type MetaEntry = { status: "loading" } | { status: "ready"; meta: RepoMeta } | { status: "error" };

/**
 * Repository metadata, fetched once per repository per client and shared by
 * everything that shows labels or watcher counts.
 */
export class RepoMetaCache {
	private entries = new Map<string, MetaEntry>();
	private listeners = new Set<() => void>();
	private version = 0;

	constructor(private client: PushClient) {}

	get(repo: string): MetaEntry | undefined {
		return this.entries.get(repo);
	}

	meta(repo: string): RepoMeta | undefined {
		const entry = this.entries.get(repo);
		return entry?.status === "ready" ? entry.meta : undefined;
	}

	/** Start loading these repositories, unless they're loaded or loading. */
	load(repos: Iterable<string>): void {
		for (const repo of repos) {
			if (!repo || this.entries.has(repo)) continue;
			this.entries.set(repo, { status: "loading" });
			void this.client.repoMeta(repo).then((result) => {
				this.entries.set(
					repo,
					result.ok ? { status: "ready", meta: result.value } : { status: "error" },
				);
				this.emit();
			});
		}
	}

	/** Forget a repository, e.g. after installing the app there. */
	refresh(repos: Iterable<string>): void {
		for (const repo of repos) this.entries.delete(repo);
		this.load(repos);
		this.emit();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private emit(): void {
		this.version++;
		for (const listener of this.listeners) listener();
	}
}

/**
 * Load metadata for these repositories, and re-render when it arrives.
 * Returns a lookup.
 */
export function useRepoMeta(
	cache: RepoMetaCache | null,
	repos: readonly string[],
): (repo: string) => RepoMeta | undefined {
	const key = repos.join("\n");
	useEffect(() => {
		cache?.load(key ? key.split("\n") : []);
	}, [cache, key]);
	useSyncExternalStore(cache?.subscribe ?? noopSubscribe, cache?.getVersion ?? zero);
	return (repo) => cache?.meta(repo);
}

const noopSubscribe = () => () => {};
const zero = () => 0;

/** A label's colour from the repository, as a CSS colour; grey when unknown. */
export function labelColor(meta: RepoMeta | undefined, name: string): string {
	const color = meta?.labels.find(
		(label) => label.name.toLowerCase() === name.toLowerCase(),
	)?.color;
	return color ? `#${color.replace(/^#/, "")}` : "#8b9098";
}
