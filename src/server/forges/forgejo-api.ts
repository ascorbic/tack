import { type ForgeHostConfig, hostConfig } from "./config.ts";
import type { RestApi } from "./rest.ts";

// Forgejo's API (Codeberg, and Gitea, which shares it), as the Forgejo
// adapter (`forgejo.ts`) and its writes (`forgejo-write.ts`) call it.

export interface ForgejoUser {
	login: string;
	avatar_url?: string;
}

export interface ForgejoLabel {
	id?: number;
	name: string;
	color?: string;
}

export interface ForgejoIssue {
	number: number;
	title: string;
	body?: string | null;
	state: "open" | "closed";
	html_url: string;
	created_at?: string;
	updated_at: string;
	closed_at?: string | null;
	labels?: ForgejoLabel[] | null;
	assignees?: ForgejoUser[] | null;
	user?: ForgejoUser | null;
	comments?: number;
	milestone?: { title: string; due_on?: string | null } | null;
	/** Set on pull requests' issues. */
	pull_request?: { merged?: boolean; merged_at?: string | null; draft?: boolean } | null;
	repository?: { full_name?: string } | null;
	// Pull requests (the pulls endpoint, and `pull_request` deliveries).
	draft?: boolean;
	merged?: boolean;
	merged_at?: string | null;
	mergeable?: boolean | null;
	head?: { sha?: string; ref?: string } | null;
	requested_reviewers?: ForgejoUser[] | null;
	additions?: number;
	deletions?: number;
	changed_files?: number;
}

export interface ForgejoRepository {
	id: number;
	full_name: string;
	private?: boolean;
	internal?: boolean;
	html_url?: string;
	default_branch?: string;
	watchers_count?: number;
	permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

/** The API for a host, with the instance's token for it if it has one. */
export function forgejoApi(config: ForgeHostConfig): RestApi {
	return {
		name: config.name,
		base: `https://${config.host}/api/v1`,
		headers: config.token ? { authorization: `token ${config.token}` } : {},
	};
}

/** The API for a host this instance serves with Forgejo, or null. */
export function forgejoApiFor(env: Env, host: string): RestApi | null {
	const config = hostConfig(env, host);
	return config?.forge === "forgejo" ? forgejoApi(config) : null;
}
