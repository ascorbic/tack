// A fake GitHub for integration tests, served to the Worker through
// Miniflare's `outboundService` (`startWorker({ outboundService: github.fetch })`).
//
// - The app: manifest conversion, the OAuth web flow (with PKCE and
//   refresh-token rotation), users and org membership, installation tokens
//   minted against app JWTs that it really verifies, and the app's webhook
//   delivery log, with redelivery.
// - Repository data: repositories (with ids, and renames that keep
//   redirecting), issues and pull requests with CI and reviews, over REST and
//   the GraphQL queries Tack makes (see src/server/forges/github*.ts).
//
// Every request is recorded twice: as `METHOD url` lines in `log`, and as
// structured `requests` (with GraphQL operation names and variables) so
// tests can count fetches.

import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { type Request, Response } from "miniflare";

export interface FakeUser {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
}

interface Grant {
	user: FakeUser;
	challenge: string;
	redirectUri: string;
}

interface UserToken {
	user: FakeUser;
	expiresAt: number;
}

function token(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function base64url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

export interface FakeCheck {
	name: string;
	/** A CheckRun state or conclusion: SUCCESS, FAILURE, IN_PROGRESS, SKIPPED… */
	state: string;
}

export interface FakeItem {
	number: number;
	kind: "issue" | "pull";
	title: string;
	state?: "open" | "closed" | "merged";
	draft?: boolean;
	updatedAt: string;
	head?: string;
	checks?: FakeCheck[];
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	reviews?: { login: string; state: string }[];
	mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	closes?: number[];
	labels?: { name: string; color: string }[];
}

export interface FakeRequest {
	method: string;
	path: string;
	/** GraphQL operation name. */
	operation?: string;
	variables?: Record<string, unknown>;
	/** Aliased items in a GraphQL query, e.g. `i7`. */
	aliases?: string[];
	authorized: boolean;
}

interface FakeRepo {
	id: number;
	name: string;
	private: boolean;
	/** Logins who can read it, if it's private. */
	collaborators: Set<string>;
}

/** A delivery in the app's webhook delivery log. */
export interface FakeHookDelivery {
	id: number;
	guid: string;
	delivered_at: string;
	redelivery: boolean;
	status_code: number;
	event: string;
}

export class FakeGitHub {
	readonly keys = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		// GitHub hands out PKCS#1 keys, so the Worker has to convert them.
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	});

	readonly app = {
		id: 4242,
		slug: "tack-test",
		name: "Tack (test)",
		client_id: "Iv1.testclient",
		client_secret: "test-client-secret",
		webhook_secret: "stored-webhook-secret",
		html_url: "https://github.com/apps/tack-test",
		owner: { login: "acme", id: 1, type: "Organization" },
	};

	/** The code GitHub would send to `/setup/callback` after creating the app. */
	readonly manifestCode = "manifest-code-1";

	/** Seconds a user token lasts; tests shorten it to exercise refreshes. */
	userTokenTtl = 8 * 60 * 60;

	/** Org login → member logins. */
	readonly orgMembers = new Map<string, Set<string>>();
	/** Installation id → account and repositories (`owner/name`). */
	readonly installations = new Map<number, { account: string; repos: string[] }>();
	/** Private repos' issues, by `owner/name#number`. */
	readonly issues = new Map<string, { title: string }>();

	/** Every request, as `METHOD url`, for assertions. */
	readonly log: string[] = [];
	readonly minted: { installation: number; token: string }[] = [];

	/** Structured requests, for counting fetches. */
	requests: FakeRequest[] = [];
	/** The app's webhook delivery log, newest first. */
	hookDeliveries: FakeHookDelivery[] = [];
	/** Delivery ids GitHub was asked to redeliver. */
	readonly redelivered: number[] = [];

	private repos = new Map<number, FakeRepo>();
	/** Current and old names, lowercased, to repository ids. */
	private names = new Map<string, number>();
	private items = new Map<string, FakeItem>();

	private grants = new Map<string, Grant>();
	private userTokens = new Map<string, UserToken>();
	private refreshTokens = new Map<string, FakeUser>();
	private installationTokens = new Map<string, number>();

	/**
	 * Play GitHub's authorize page: take the URL the Worker redirected to and
	 * return the callback URL GitHub would send `user` back to.
	 */
	authorize(authorizeUrl: string, user: FakeUser): string {
		const url = new URL(authorizeUrl);
		if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") {
			throw new Error(`Not an authorize URL: ${authorizeUrl}`);
		}
		if (url.searchParams.get("client_id") !== this.app.client_id)
			throw new Error("Wrong client id");
		if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("No PKCE");
		const code = token("code");
		const redirectUri = url.searchParams.get("redirect_uri") ?? "";
		this.grants.set(code, {
			user,
			challenge: url.searchParams.get("code_challenge") ?? "",
			redirectUri,
		});
		const callback = new URL(redirectUri);
		callback.searchParams.set("code", code);
		callback.searchParams.set("state", url.searchParams.get("state") ?? "");
		return callback.toString();
	}

	/**
	 * A repository. Private ones are readable with a token for an
	 * installation that includes them, a personal token (`personalTokens`),
	 * or a user token whose user is a collaborator, where the app is installed
	 * (GitHub App user tokens only reach installed repositories).
	 */
	addRepo(
		id: number,
		name: string,
		options: { private?: boolean; collaborators?: string[] } = {},
	): void {
		this.repos.set(id, {
			id,
			name,
			private: options.private ?? false,
			collaborators: new Set(options.collaborators ?? []),
		});
		this.names.set(name.toLowerCase(), id);
	}

	/** Give someone read access to a private repository. */
	addCollaborator(id: number, login: string): void {
		this.repos.get(id)?.collaborators.add(login);
	}

	removeCollaborator(id: number, login: string): void {
		this.repos.get(id)?.collaborators.delete(login);
	}

	setPrivate(id: number, isPrivate: boolean): void {
		const repo = this.repos.get(id);
		if (repo) repo.private = isPrivate;
	}

	/** Tokens that read everything, like a personal access token in `GITHUB_TOKEN`. */
	readonly personalTokens = new Set<string>();

	/** Install the app on repositories, as GitHub would before sending its webhook. */
	install(id: number, account: string, repos: string[]): void {
		this.installations.set(id, { account, repos: repos.map((repo) => repo.toLowerCase()) });
	}

	/** Rename or transfer: the old name keeps redirecting, as on GitHub. */
	rename(id: number, name: string): void {
		const repo = this.repos.get(id);
		if (!repo) throw new Error(`no repo ${id}`);
		repo.name = name;
		this.names.set(name.toLowerCase(), id);
	}

	setItem(repoId: number, item: FakeItem): void {
		this.items.set(`${repoId}#${item.number}`, item);
	}

	updateItem(repoId: number, number: number, change: Partial<FakeItem>): void {
		const item = this.items.get(`${repoId}#${number}`);
		if (!item) throw new Error(`no item ${repoId}#${number}`);
		Object.assign(item, change);
	}

	count(filter: (request: FakeRequest) => boolean): number {
		return this.requests.filter(filter).length;
	}

	/** Forget every refresh token, as when people revoke the app. */
	revokeRefreshTokens(): void {
		this.refreshTokens.clear();
	}

	readonly fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		this.log.push(`${request.method} ${url.origin}${url.pathname}`);
		const record: FakeRequest = {
			method: request.method,
			path: url.pathname,
			authorized: Boolean(request.headers.get("authorization")),
		};
		this.requests.push(record);
		try {
			if (url.origin === "https://api.github.com" && url.pathname === "/graphql") {
				return await this.graphqlRequest(request, record);
			}
			return (await this.route(request, url)) ?? json({ message: "Not Found" }, 404);
		} catch (error) {
			return json({ message: String(error) }, 500);
		}
	};

	private async route(request: Request, url: URL): Promise<Response | undefined> {
		const path = url.pathname;
		const auth = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;

		if (url.origin === "https://github.com" && path === "/login/oauth/access_token") {
			return this.accessToken(new URLSearchParams(await request.text()));
		}
		if (url.origin !== "https://api.github.com") return undefined;

		let match: RegExpExecArray | null;
		if ((match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))) {
			if (request.method !== "POST" || match[1] !== this.manifestCode) return undefined;
			return json({ ...this.app, pem: this.keys.privateKey }, 201);
		}

		if (path === "/user") {
			const user = auth ? this.userFor(auth) : null;
			return user ? json(user) : json({ message: "Bad credentials" }, 401);
		}

		if ((match = /^\/orgs\/([^/]+)\/(members|public_members)\/([^/]+)$/.exec(path))) {
			const [, org = "", kind, login = ""] = match;
			const member = this.orgMembers.get(org)?.has(login) ?? false;
			// Only an authenticated org member (or the app) sees private membership.
			if (kind === "members" && !auth) return new Response(null, { status: 302 });
			return new Response(null, { status: member ? 204 : 404 });
		}

		if ((match = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path))) {
			this.verifyJwt(auth);
			const found = this.installationForRepo(match[1] ?? "");
			if (!found) return undefined;
			return json({
				id: found.id,
				account: { login: found.account },
				repository_selection: "selected",
			});
		}

		if ((match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
			this.verifyJwt(auth);
			const id = Number(match[1]);
			if (!this.installations.has(id)) return undefined;
			const minted = token("ghs");
			this.installationTokens.set(minted, id);
			this.minted.push({ installation: id, token: minted });
			return json(
				{ token: minted, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
				201,
			);
		}

		if ((match = /^\/app\/installations\/(\d+)$/.exec(path))) {
			this.verifyJwt(auth);
			const id = Number(match[1]);
			const installation = this.installations.get(id);
			if (!installation) return undefined;
			return json({
				id,
				account: { login: installation.account },
				repository_selection: "selected",
			});
		}

		if (path === "/installation/repositories") {
			const id = auth ? this.installationTokens.get(auth) : undefined;
			const installation = id === undefined ? undefined : this.installations.get(id);
			if (!installation) return json({ message: "Bad credentials" }, 401);
			return json({
				total_count: installation.repos.length,
				repositories: installation.repos.map((full_name) => ({ full_name })),
			});
		}

		if (path === "/app/hook/deliveries" && request.method === "GET") {
			this.verifyJwt(auth);
			return json(this.hookDeliveries);
		}

		if ((match = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(path))) {
			this.verifyJwt(auth);
			if (request.method !== "POST") return undefined;
			this.redelivered.push(Number(match[1]));
			return json({}, 202);
		}

		if ((match = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path))) {
			const repo = match[1] ?? "";
			if (this.issues.has(`${repo.toLowerCase()}#${match[2]}`)) {
				const issue = this.privateIssue(repo, Number(match[2]), auth);
				return issue ? json(issue) : undefined;
			}
		}

		if ((match = /^\/repositories\/(\d+)$/.exec(path))) {
			const repo = this.repos.get(Number(match[1]));
			if (!repo || !this.canSee(repo, auth)) return undefined;
			return json(this.restRepo(repo));
		}

		return this.repositoryData(url, auth, request.headers.get("if-none-match"));
	}

	/** Whether a token (or none) can read a repository. */
	canSee(repo: FakeRepo, auth: string | null): boolean {
		if (!repo.private) return true;
		if (!auth) return false;
		if (this.personalTokens.has(auth)) return true;
		const installation = this.installationForRepo(repo.name);
		if (!installation) return false;
		if (this.installationTokens.get(auth) === installation.id) return true;
		const user = this.userFor(auth);
		return Boolean(user && repo.collaborators.has(user.login));
	}

	private restRepo(repo: FakeRepo) {
		return {
			id: repo.id,
			node_id: `R_${repo.id}`,
			full_name: repo.name,
			private: repo.private,
			visibility: repo.private ? "private" : "public",
		};
	}

	/** Responses to conditional list requests that came back 304. */
	notModified = 0;

	/** Private issues are only readable with a token for their installation. */
	private privateIssue(repo: string, number: number, auth: string | null) {
		const issue = this.issues.get(`${repo.toLowerCase()}#${number}`);
		const installation = this.installationForRepo(repo);
		const tokenInstallation = auth ? this.installationTokens.get(auth) : undefined;
		if (!issue || !installation || tokenInstallation !== installation.id) return null;
		return {
			number,
			title: issue.title,
			state: "open",
			html_url: `https://github.com/${repo}/issues/${number}`,
			updated_at: "2026-10-01T00:00:00Z",
		};
	}

	/** REST reads of repositories, issues and pull requests in the model. */
	private repositoryData(
		url: URL,
		auth: string | null,
		ifNoneMatch: string | null,
	): Response | undefined {
		const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
		const repo = repoMatch ? this.repoByName(repoMatch[1] ?? "") : undefined;
		// Private repositories 404 for anyone who can't see them, as on GitHub.
		if (!repo || !this.canSee(repo, auth)) return undefined;
		const rest = repoMatch?.[2] ?? "";
		if (rest === "") return json(this.restRepo(repo));

		const issue = /^\/issues\/(\d+)$/.exec(rest);
		if (issue) {
			const item = this.items.get(`${repo.id}#${issue[1]}`);
			return item ? json(this.restIssue(repo, item)) : undefined;
		}
		const pull = /^\/pulls\/(\d+)$/.exec(rest);
		if (pull) {
			const item = this.items.get(`${repo.id}#${pull[1]}`);
			return item?.kind === "pull" ? json(this.restPull(repo, item)) : undefined;
		}
		if (rest === "/issues") {
			const since = url.searchParams.get("since") ?? "";
			const list = [...this.items.entries()]
				.filter(([key, item]) => key.startsWith(`${repo.id}#`) && item.updatedAt >= since)
				.map(([, item]) => item)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
				.slice(0, Number(url.searchParams.get("per_page") ?? 30))
				.map((item) => this.restIssue(repo, item));
			const body = JSON.stringify(list);
			const etag = `W/"${createHash("sha1").update(body).digest("hex")}"`;
			if (ifNoneMatch === etag) {
				this.notModified++;
				return new Response(null, { status: 304, headers: { etag } });
			}
			return new Response(body, {
				status: 200,
				headers: { "content-type": "application/json", etag },
			});
		}
		return undefined;
	}

	private async graphqlRequest(request: Request, record: FakeRequest): Promise<Response> {
		if (request.method !== "POST") return json({ message: "Not Found" }, 404);
		const auth = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
		if (!auth) return json({ message: "Requires authentication" }, 401);
		const body = (await request.json()) as {
			query: string;
			variables: Record<string, unknown>;
			operationName: string;
		};
		record.operation = body.operationName;
		record.variables = body.variables;
		record.aliases = [...body.query.matchAll(/(i\d+): issueOrPullRequest/g)].map((m) => m[1] ?? "");
		return json({ data: this.graphql(body.operationName, body.query, body.variables, auth) });
	}

	private repoByName(name: string): FakeRepo | undefined {
		const id = this.names.get(name.toLowerCase());
		return id === undefined ? undefined : this.repos.get(id);
	}

	private byNodeId(nodeId: string): { repo: FakeRepo; item: FakeItem } | null {
		const match = /^(?:I|PR)_(\d+)_(\d+)$/.exec(nodeId);
		const repo = match && this.repos.get(Number(match[1]));
		const item = match && this.items.get(`${match[1]}#${match[2]}`);
		return repo && item ? { repo, item } : null;
	}

	private graphql(
		operation: string,
		query: string,
		variables: Record<string, unknown>,
		auth: string,
	) {
		const ids = (variables.ids as string[] | undefined) ?? [];
		if (operation === "TackFreshness") {
			return {
				nodes: ids.map((id) => {
					const found = this.byNodeId(id);
					return found && this.canSee(found.repo, auth)
						? this.freshness(found.repo, found.item)
						: null;
				}),
			};
		}
		const data: Record<string, unknown> = {};
		if (variables.ids) {
			data.nodes = ids.map((id) => {
				const found = this.byNodeId(id);
				return found && this.canSee(found.repo, auth) ? this.gqlItem(found.repo, found.item) : null;
			});
		}
		if (/repo: (node|repository)\(/.test(query)) {
			const found =
				typeof variables.repo === "string"
					? this.repos.get(Number(variables.repo.replace(/^R_/, "")))
					: this.repoByName(`${String(variables.owner)}/${String(variables.name)}`);
			const repo = found && this.canSee(found, auth) ? found : undefined;
			const name = `${String(variables.owner)}/${String(variables.name)}`;
			if (!repo && typeof variables.owner === "string") {
				data.repo = this.privateRepoFields(name, query, auth);
			} else if (!repo) {
				data.repo = null;
			} else {
				const fields: Record<string, unknown> = {};
				for (const [, alias, number] of query.matchAll(
					/(i\d+): issueOrPullRequest\(number: (\d+)\)/g,
				)) {
					const item = this.items.get(`${repo.id}#${number}`);
					fields[alias!] = item ? this.gqlItem(repo, item) : null;
				}
				data.repo = fields;
			}
		}
		return data;
	}

	private rollup(item: FakeItem) {
		const checks = item.checks ?? [];
		if (checks.length === 0) return null;
		const counts = new Map<string, number>();
		for (const check of checks) counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
		const failing = checks.some((c) => c.state === "FAILURE");
		const pending = checks.some((c) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes(c.state));
		return {
			state: failing ? "FAILURE" : pending ? "PENDING" : "SUCCESS",
			contexts: {
				checkRunCountsByState: [...counts].map(([state, count]) => ({ state, count })),
				statusContextCountsByState: [],
				nodes: checks.map((check) => ({
					__typename: "CheckRun",
					name: check.name,
					status: ["IN_PROGRESS", "QUEUED"].includes(check.state) ? check.state : "COMPLETED",
					conclusion: ["IN_PROGRESS", "QUEUED"].includes(check.state) ? null : check.state,
					detailsUrl: `https://github.com/checks/${encodeURIComponent(check.name)}`,
				})),
			},
		};
	}

	private freshness(repo: FakeRepo, item: FakeItem) {
		const id = `${item.kind === "pull" ? "PR" : "I"}_${repo.id}_${item.number}`;
		if (item.kind === "issue") return { __typename: "Issue", id, updatedAt: item.updatedAt };
		return {
			__typename: "PullRequest",
			id,
			updatedAt: item.updatedAt,
			headRefOid: item.head ?? "",
			mergeable: item.mergeable ?? "MERGEABLE",
			commits: { nodes: [{ commit: { statusCheckRollup: this.rollup(item) } }] },
		};
	}

	private gqlItem(repo: FakeRepo, item: FakeItem) {
		const common = {
			__typename: item.kind === "pull" ? "PullRequest" : "Issue",
			id: `${item.kind === "pull" ? "PR" : "I"}_${repo.id}_${item.number}`,
			number: item.number,
			title: item.title,
			url: `https://github.com/${repo.name}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`,
			updatedAt: item.updatedAt,
			repository: { nameWithOwner: repo.name },
			author: { login: "octocat", avatarUrl: "https://avatars.example/octocat" },
			labels: { nodes: item.labels ?? [] },
			assignees: { nodes: [] },
			comments: { totalCount: 0 },
			reactions: { totalCount: 0 },
		};
		if (item.kind === "issue") {
			return {
				...common,
				issueState: item.state === "closed" ? "CLOSED" : "OPEN",
				stateReason: item.state === "closed" ? "COMPLETED" : null,
			};
		}
		return {
			...common,
			pullState: item.state === "merged" ? "MERGED" : item.state === "closed" ? "CLOSED" : "OPEN",
			isDraft: item.draft ?? false,
			mergeable: item.mergeable ?? "MERGEABLE",
			reviewDecision: item.reviewDecision ?? null,
			headRefOid: item.head ?? "",
			latestReviews: {
				nodes: (item.reviews ?? []).map((review) => ({
					state: review.state,
					author: { login: review.login, avatarUrl: `https://avatars.example/${review.login}` },
				})),
			},
			reviewRequests: { nodes: [] },
			closingIssuesReferences: {
				nodes: (item.closes ?? []).map((number) => ({
					number,
					title: this.items.get(`${repo.id}#${number}`)?.title ?? "",
					url: `https://github.com/${repo.name}/issues/${number}`,
					issueState: "OPEN",
					repository: { nameWithOwner: repo.name, isPrivate: repo.private },
				})),
			},
			commits: { nodes: [{ commit: { statusCheckRollup: this.rollup(item) } }] },
		};
	}

	private restIssue(repo: FakeRepo, item: FakeItem) {
		return {
			number: item.number,
			title: item.title,
			state: item.state === "open" || !item.state ? "open" : "closed",
			html_url: `https://github.com/${repo.name}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`,
			repository_url: `https://api.github.com/repos/${repo.name}`,
			updated_at: item.updatedAt,
			node_id: `${item.kind === "pull" ? "PR" : "I"}_${repo.id}_${item.number}`,
			comments: 0,
			labels: item.labels ?? [],
			assignees: [],
			user: null,
			...(item.kind === "pull"
				? { pull_request: { merged_at: item.state === "merged" ? item.updatedAt : null } }
				: {}),
		};
	}

	private restPull(repo: FakeRepo, item: FakeItem) {
		return {
			...this.restIssue(repo, item),
			draft: item.draft ?? false,
			head: { sha: item.head ?? "" },
			mergeable: { MERGEABLE: true, CONFLICTING: false, UNKNOWN: null }[
				item.mergeable ?? "MERGEABLE"
			],
			requested_reviewers: [],
		};
	}
	/** GraphQL for private issues, gated like REST. */
	private privateRepoFields(repo: string, query: string, auth: string) {
		const fields: Record<string, unknown> = {};
		let found = false;
		for (const [, alias, number] of query.matchAll(
			/(i\d+): issueOrPullRequest\(number: (\d+)\)/g,
		)) {
			const issue = this.privateIssue(repo, Number(number), auth);
			found ||= Boolean(issue);
			fields[alias ?? ""] = issue
				? this.gqlItem(
						{ id: 0, name: repo, private: true, collaborators: new Set() },
						{
							number: issue.number,
							kind: "issue",
							title: issue.title,
							updatedAt: issue.updated_at,
						},
					)
				: null;
		}
		return found ? fields : null;
	}

	private accessToken(params: URLSearchParams): Response {
		if (
			params.get("client_id") !== this.app.client_id ||
			params.get("client_secret") !== this.app.client_secret
		) {
			return json({ error: "incorrect_client_credentials" });
		}

		let user: FakeUser | undefined;
		if (params.get("grant_type") === "refresh_token") {
			const refresh = params.get("refresh_token") ?? "";
			user = this.refreshTokens.get(refresh);
			// Refresh tokens are single use: GitHub rotates them.
			this.refreshTokens.delete(refresh);
			if (!user) return json({ error: "bad_refresh_token" });
		} else {
			const grant = this.grants.get(params.get("code") ?? "");
			this.grants.delete(params.get("code") ?? "");
			if (!grant) return json({ error: "bad_verification_code" });
			const challenge = base64url(
				createHash("sha256")
					.update(params.get("code_verifier") ?? "")
					.digest(),
			);
			if (challenge !== grant.challenge) return json({ error: "invalid_grant" });
			if (params.get("redirect_uri") !== grant.redirectUri) {
				return json({ error: "redirect_uri_mismatch" });
			}
			user = grant.user;
		}

		const access = token("ghu");
		const refresh = token("ghr");
		this.userTokens.set(access, { user, expiresAt: Date.now() + this.userTokenTtl * 1000 });
		this.refreshTokens.set(refresh, user);
		return json({
			access_token: access,
			expires_in: this.userTokenTtl,
			refresh_token: refresh,
			refresh_token_expires_in: 15_811_200,
			token_type: "bearer",
			scope: "",
		});
	}

	private userFor(accessToken: string): FakeUser | null {
		const entry = this.userTokens.get(accessToken);
		return entry && entry.expiresAt > Date.now() ? entry.user : null;
	}

	private installationForRepo(repo: string): { id: number; account: string } | null {
		for (const [id, installation] of this.installations) {
			if (installation.repos.includes(repo.toLowerCase())) {
				return { id, account: installation.account };
			}
		}
		return null;
	}

	/** Check an app JWT the way GitHub does: RS256, signed by the app's key, unexpired. */
	private verifyJwt(jwt: string | null): void {
		const [header, payload, signature] = jwt?.split(".") ?? [];
		if (!header || !payload || !signature) throw new Error("No JWT");
		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${header}.${payload}`);
		if (!verifier.verify(this.keys.publicKey, Buffer.from(signature, "base64url"))) {
			throw new Error("Bad JWT signature");
		}
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
			iss: string;
			exp: number;
			iat: number;
		};
		const now = Date.now() / 1000;
		if (claims.iss !== this.app.client_id) throw new Error("Wrong JWT issuer");
		if (claims.exp <= now || claims.iat > now || claims.exp - claims.iat > 600) {
			throw new Error("JWT expired or too long-lived");
		}
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
