import { createContext, useContext, useEffect, useState } from "react";
import type { Stager } from "../../shared/changes.ts";
import type { RepoMeta } from "../../shared/push.ts";
import type { QueryError, RelatedResult } from "../../shared/widgets.ts";
import { repoApi } from "../changes/api.ts";
import type { User } from "../presence.ts";

// What the built-in actions need from outside the board document: the
// repository metadata behind the pickers, somewhere to upload snapshots, and
// the board's own address for backlinks. The live board talks to the Worker;
// the playground and gallery pass in their own.

export interface WriteServices {
	/** The board's id, for remembering choices made on it. */
	boardId: string;
	/** The board's shareable address, for backlinks. */
	boardUrl(): string;
	boardTitle(): string | null;
	/** Labels, milestones, people and access for a repository (`github.com/o/r`), or null if unknown. */
	repoMeta(repo: string): Promise<RepoMeta | null>;
	/** Upload a PNG snapshot; resolves to its public URL. Throws with a message people can read. */
	uploadSnapshot(png: Blob): Promise<string>;
	/** What's related to an item, as this viewer may see it (Expand related). Never throws. */
	related(key: string): Promise<RelatedResult | QueryError>;
}

const SNAPSHOT_ERRORS: Record<string, string> = {
	too_large: "The snapshot is too big to upload.",
	quota: "This board has run out of room for snapshots.",
	forbidden: "Only editors can add snapshots.",
	sign_in_required: "Sign in to add snapshots.",
};

/** Services for a live board, through the Worker's API. */
export function liveServices(boardId: string): WriteServices {
	return {
		boardId,
		boardUrl: () => location.origin + location.pathname,
		boardTitle: () => document.title.replace(/ · Tack$/, "") || null,
		// The shared repository endpoint (src/client/changes/api.ts).
		repoMeta: (repo) => repoApi.meta(repo).catch(() => null),
		async uploadSnapshot(png) {
			let response: Response;
			try {
				response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/snapshots`, {
					method: "POST",
					headers: { "content-type": "image/png", accept: "application/json" },
					body: png,
				});
			} catch {
				throw new Error("Couldn’t reach the server to upload the snapshot.");
			}
			const body = (await response.json().catch(() => null)) as {
				url?: string;
				error?: string;
			} | null;
			if (response.ok && body?.url) return body.url;
			throw new Error(SNAPSHOT_ERRORS[body?.error ?? ""] ?? "The snapshot couldn’t be uploaded.");
		},
		async related(key) {
			try {
				const response = await fetch(
					`/api/boards/${encodeURIComponent(boardId)}/related?key=${encodeURIComponent(key)}`,
					{ headers: { accept: "application/json" } },
				);
				const body = (await response.json().catch(() => null)) as RelatedResult | QueryError | null;
				if (body?.kind === "related" || body?.kind === "error") return body;
				return { kind: "error", reason: "error", message: "Something went wrong. Try again?" };
			} catch {
				return { kind: "error", reason: "error", message: "Couldn’t reach the server." };
			}
		},
	};
}

export const ServicesContext = createContext<WriteServices | null>(null);

export function useServices(): WriteServices {
	const services = useContext(ServicesContext);
	if (!services) throw new Error("No WriteServices: wrap the board in ServicesContext");
	return services;
}

// Repository metadata, fetched once per repository and shared by every picker.
const metaCache = new WeakMap<WriteServices, Map<string, Promise<RepoMeta | null>>>();

export function loadRepoMeta(services: WriteServices, repo: string): Promise<RepoMeta | null> {
	let cache = metaCache.get(services);
	if (!cache) metaCache.set(services, (cache = new Map()));
	let pending = cache.get(repo);
	if (!pending) {
		pending = services.repoMeta(repo);
		cache.set(repo, pending);
		// Don't keep a failure: try again next time.
		void pending.then((meta) => {
			if (!meta) cache.delete(repo);
		});
	}
	return pending;
}

export type MetaState =
	| { status: "idle" | "loading"; meta: null }
	| { status: "ready"; meta: RepoMeta }
	/** Couldn't find out: the pickers say so, and staging still works. */
	| { status: "unknown"; meta: null };

/** Repository metadata for each of `repos`, loading as needed. */
export function useRepoMetas(repos: readonly string[]): Map<string, MetaState> {
	const services = useServices();
	const [states, setStates] = useState<Map<string, MetaState>>(() => new Map());
	const key = repos.join("\n");
	useEffect(() => {
		let live = true;
		const list = key ? key.split("\n") : [];
		setStates((current) => {
			const next = new Map<string, MetaState>();
			for (const repo of list)
				next.set(repo, current.get(repo) ?? { status: "loading", meta: null });
			return next;
		});
		for (const repo of list) {
			void loadRepoMeta(services, repo).then((meta) => {
				if (!live) return;
				setStates((current) =>
					new Map(current).set(
						repo,
						meta ? { status: "ready", meta } : { status: "unknown", meta: null },
					),
				);
			});
		}
		return () => {
			live = false;
		};
	}, [services, key]);
	return states;
}

export function useRepoMeta(repo: string | null): MetaState {
	const states = useRepoMetas(repo ? [repo] : []);
	return (repo && states.get(repo)) || { status: repo ? "loading" : "idle", meta: null };
}

/** Who's staging, as the change records it. */
export function stagerFor(user: User): Stager {
	return {
		name: user.name,
		color: user.color,
		...(user.login ? { login: user.login } : {}),
	};
}

// Repositories you've made issues in lately, offered first next time.
const RECENT_KEY = "tack.recentRepos";
const RECENT_MAX = 6;

export function recentRepos(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
		return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
	} catch {
		return [];
	}
}

export function rememberRepo(repo: string): void {
	try {
		const next = [repo, ...recentRepos().filter((r) => r !== repo)].slice(0, RECENT_MAX);
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Private windows: no memory, no harm.
	}
}
