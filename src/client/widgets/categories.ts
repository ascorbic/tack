import { useContext, useEffect, useState } from "react";
import type { Label, RepoDiscussionCategory } from "../../shared/push.ts";
import { ServicesContext, type WriteServices, loadRepoMeta } from "../actions/services.ts";

// A repository's discussion categories and labels, for a list's Discussions
// mode and the ready-made lists that fit them: asked for once per
// repository and shared by every panel on the page (the server keeps them
// too, in the repository's own object). Forges without discussions have none.

/** Hosts whose repositories can have GitHub-style discussions. */
export const DISCUSSION_HOSTS = new Set(["github.com", "fake.tack"]);

export type Loaded<T> =
	| { status: "idle" | "loading"; value: null }
	| { status: "ready"; value: T }
	/** Couldn't find out: the controls still work, without the choices. */
	| { status: "unknown"; value: null };

const categoryCache = new WeakMap<
	WriteServices,
	Map<string, Promise<RepoDiscussionCategory[] | null>>
>();

export function loadDiscussionCategories(
	services: WriteServices,
	repo: string,
): Promise<RepoDiscussionCategory[] | null> {
	if (!services.discussionCategories) return Promise.resolve(null);
	let cache = categoryCache.get(services);
	if (!cache) categoryCache.set(services, (cache = new Map()));
	let pending = cache.get(repo);
	if (!pending) {
		pending = services.discussionCategories(repo).catch(() => null);
		cache.set(repo, pending);
		// Don't keep a failure: try again next time.
		void pending.then((categories) => {
			if (!categories) cache.delete(repo);
		});
	}
	return pending;
}

/** `owner/name`, when it looks like one. */
function repoKey(host: string, repo: string | null): string | null {
	if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
	return `${host}/${repo}`.toLowerCase();
}

/** A repository's discussion categories, as they load. Idle without a repository. */
export function useDiscussionCategories(
	host: string,
	repo: string | null,
	enabled = true,
): Loaded<RepoDiscussionCategory[]> {
	const services = useContext(ServicesContext);
	const key = enabled && DISCUSSION_HOSTS.has(host) ? repoKey(host, repo) : null;
	const [state, setState] = useState<{
		key: string | null;
		loaded: Loaded<RepoDiscussionCategory[]>;
	}>({ key: null, loaded: { status: "idle", value: null } });
	useEffect(() => {
		if (!key || !services) return;
		let live = true;
		setState({ key, loaded: { status: "loading", value: null } });
		void loadDiscussionCategories(services, key).then((categories) => {
			if (!live) return;
			setState({
				key,
				loaded: categories
					? { status: "ready", value: categories }
					: { status: "unknown", value: null },
			});
		});
		return () => {
			live = false;
		};
	}, [services, key]);
	if (!key) return { status: "idle", value: null };
	if (!services) return { status: "unknown", value: null };
	return state.key === key ? state.loaded : { status: "loading", value: null };
}

/** A repository's labels, as they load. Idle without a repository. */
export function useRepoLabels(host: string, repo: string | null, enabled = true): Loaded<Label[]> {
	const services = useContext(ServicesContext);
	const key = enabled ? repoKey(host, repo) : null;
	const [state, setState] = useState<{ key: string | null; loaded: Loaded<Label[]> }>({
		key: null,
		loaded: { status: "idle", value: null },
	});
	useEffect(() => {
		if (!key || !services) return;
		let live = true;
		setState({ key, loaded: { status: "loading", value: null } });
		void loadRepoMeta(services, key).then((meta) => {
			if (!live) return;
			setState({
				key,
				loaded: meta ? { status: "ready", value: meta.labels } : { status: "unknown", value: null },
			});
		});
		return () => {
			live = false;
		};
	}, [services, key]);
	if (!key) return { status: "idle", value: null };
	if (!services) return { status: "unknown", value: null };
	return state.key === key ? state.loaded : { status: "loading", value: null };
}
