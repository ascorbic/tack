import { type ForgeHostConfig, hostConfig } from "./config.ts";
import type { RestApi } from "./rest.ts";

// GitLab's REST API (v4), as the GitLab adapter (`gitlab.ts`) and its writes
// (`gitlab-write.ts`) call it. Projects are addressed by id where it's known
// (it survives renames and transfers), else by their URL-encoded path.

export interface GitLabUser {
	id?: number;
	username: string;
	avatar_url?: string | null;
}

export interface GitLabLabel {
	name: string;
	color?: string;
	description?: string | null;
}

/** An issue, or a merge request: the fields they share, and a merge request's own. */
export interface GitLabItem {
	id?: number;
	iid: number;
	project_id?: number;
	title: string;
	description?: string | null;
	state: "opened" | "closed" | "merged" | "locked";
	web_url: string;
	created_at?: string;
	updated_at: string;
	closed_at?: string | null;
	/** Names, or details with `with_labels_details=true`. */
	labels?: (string | GitLabLabel)[];
	assignees?: GitLabUser[] | null;
	author?: GitLabUser | null;
	user_notes_count?: number;
	upvotes?: number;
	downvotes?: number;
	milestone?: { id?: number; title: string; due_date?: string | null } | null;
	/** Issues only to the project's members: never shown on a board. */
	confidential?: boolean;
	// Merge requests.
	draft?: boolean;
	work_in_progress?: boolean;
	merged_at?: string | null;
	sha?: string | null;
	has_conflicts?: boolean;
	detailed_merge_status?: string;
	head_pipeline?: GitLabPipeline | null;
	reviewers?: GitLabUser[] | null;
	changes_count?: string | null;
	source_branch?: string;
}

export interface GitLabPipeline {
	id: number;
	status: string;
	web_url?: string;
}

export interface GitLabProject {
	id: number;
	path_with_namespace: string;
	visibility?: "public" | "internal" | "private";
	web_url?: string;
	default_branch?: string | null;
	permissions?: {
		project_access?: { access_level: number } | null;
		group_access?: { access_level: number } | null;
	} | null;
}

/** Reporter: may manage issues, labels and assignees (merge requests need Developer, 30). */
export const REPORTER = 20;

/** The API for a host, with the instance's token for it if it has one. */
export function gitlabApi(config: ForgeHostConfig): RestApi {
	return {
		name: config.name,
		base: `https://${config.host}/api/v4`,
		headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
	};
}

/** The API for a host this instance serves with GitLab, or null. */
export function gitlabApiFor(env: Env, host: string): RestApi | null {
	const config = hostConfig(env, host);
	return config?.forge === "gitlab" ? gitlabApi(config) : null;
}

/** A project in an API path: its id, or failing that its path, encoded as one segment. */
export function projectRef(repo: { id?: string; name: string } | string): string {
	if (typeof repo !== "string" && repo.id && /^\d+$/.test(repo.id)) return repo.id;
	return encodeURIComponent(typeof repo === "string" ? repo : repo.name);
}

/** The highest access the token's account has to a project. */
export function accessLevel(project: GitLabProject): number {
	return Math.max(
		project.permissions?.project_access?.access_level ?? 0,
		project.permissions?.group_access?.access_level ?? 0,
	);
}
