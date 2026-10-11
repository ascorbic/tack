// A thin wrapper over fetch for GitHub's REST API and OAuth endpoints.

import { forgeFetch } from "../forges/rateLimit.ts";

export const API = "https://api.github.com";
export const WEB = "https://github.com";

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

/** Call the REST API, at a path like `/repos/owner/name`. */
export function gh(path: string, init: GitHubInit = {}): Promise<Response> {
	const { auth, ...rest } = init;
	return forgeFetch(`${API}${path}`, {
		...rest,
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "tack",
			"x-github-api-version": "2022-11-28",
			...(auth ? { authorization: auth } : {}),
		},
	});
}

type GitHubInit = Omit<RequestInit, "headers"> & {
	/** A full Authorization value, e.g. `Bearer …`. */
	auth?: string;
};

/** Call the REST API and parse JSON, throwing `GitHubError` on failure. */
export async function ghJson<T>(path: string, init: GitHubInit = {}): Promise<T> {
	const response = await gh(path, init);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new GitHubError(
			response.status,
			`GitHub ${response.status} for ${path}: ${body.slice(0, 200)}`,
		);
	}
	return response.json<T>();
}
