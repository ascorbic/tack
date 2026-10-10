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
// - Writes (M2): creating issues, labels, milestones, assignees, state,
//   sub-issues, dependencies, comments, branches with commits (the git data
//   API) and pull requests, and discussions over GraphQL. Writing needs an
//   installation token, or a user token for someone in the repository's
//   `writers` where the app is installed. `failWrites` makes the next writes
//   fail (rate limits, outages), and `dropWrites` accepts writes without
//   doing them. `mergePull` merges a pull request as someone on GitHub
//   would, and `event` gives the webhook payload for an item as it is now.
// - Comment commands (#58): `comment` is someone commenting on an item (the
//   `issue_comment` payload to deliver), and the app can react to comments
//   (`reactions`, `reactionsOn`) and reply (`botComments`).
//
// Every request is recorded twice: as `METHOD url` lines in `log`, and as
// structured `requests` (with GraphQL operation names and variables) so
// tests can count fetches.

import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { type Request, Response } from "miniflare";
import type { Card } from "../src/shared/cards.ts";
import { matchSearch, parseSearch } from "../src/shared/search.ts";

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
	assignees?: string[];
	milestone?: string | null;
	stateReason?: string | null;
	body?: string;
	createdAt?: string;
	/** Pull requests: the branch they're from. */
	headRef?: string;
	/** Pull requests: the branch they go into (`main` by default). */
	base?: string;
	/** Pull requests: when they were merged, ISO 8601 (`updatedAt` by default). */
	mergedAt?: string;
	/** Pull requests: issues they mention without closing (cross-references). */
	mentions?: number[];
	/** Logins who reacted 👍. */
	thumbsUp?: string[];
	/** Pull requests: their size. */
	additions?: number;
	deletions?: number;
	changedFiles?: number;
}

/** A published release. */
export interface FakeRelease {
	tagName: string;
	name: string | null;
	publishedAt: string;
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
	/** Logins with push access. */
	writers: Set<string>;
	labels: { name: string; color: string; description?: string }[];
	milestones: { number: number; title: string; due_on: string | null }[];
	/** Logins that can be assigned. */
	assignable: Set<string>;
	discussionCategories: string[];
	watchers: number;
}

/** A canned failure for the next write (see `failWrites`). */
export interface FakeFailure {
	status: number;
	headers?: Record<string, string>;
	message?: string;
	/** Only for a write whose path (or GraphQL operation) includes this. */
	match?: string;
	/** Do the write first, then fail: as when GitHub did it but the answer was lost. */
	after?: boolean;
}

function failed(failure: FakeFailure): Response {
	return new Response(JSON.stringify({ message: failure.message ?? "Failed" }), {
		status: failure.status,
		headers: { "content-type": "application/json", ...failure.headers },
	});
}

interface FakeComment {
	id: number;
	repoId: number;
	number: number;
	body: string;
	login: string;
	createdAt: string;
}

interface FakeDiscussion {
	repoId: number;
	number: number;
	title: string;
	body: string;
	category: string;
	createdAt: string;
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

	/**
	 * What time it is on GitHub, epoch ms: real time, unless a test moves the
	 * Worker's clock (`setClock` in harness.ts) and this along with it.
	 */
	now: () => number = () => Date.now();

	/** Org login → member logins. */
	readonly orgMembers = new Map<string, Set<string>>();
	/** Installation id → account and repositories (`owner/name`). */
	readonly installations = new Map<
		number,
		{
			account: string;
			repos: string[];
			/** What the account granted; the full set Tack asks for by default. */
			permissions?: Record<string, string>;
			suspended?: boolean;
		}
	>();
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

	/** Everyone on GitHub, by lowercase login (`GET /users/:login`): people signed in, and `addUser`. */
	private accounts = new Map<string, FakeUser & { type: "User" | "Organization" }>();

	/** Someone (or an organisation) on GitHub, whether or not they ever sign in. */
	addUser(user: FakeUser, type: "User" | "Organization" = "User"): void {
		this.accounts.set(user.login.toLowerCase(), { ...user, type });
	}

	private grants = new Map<string, Grant>();
	private userTokens = new Map<string, UserToken>();
	private refreshTokens = new Map<string, FakeUser>();
	private installationTokens = new Map<string, number>();

	/**
	 * Play GitHub's authorize page: take the URL the Worker redirected to and
	 * return the callback URL GitHub would send `user` back to.
	 */
	authorize(authorizeUrl: string, user: FakeUser): string {
		this.addUser(user);
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
		options: {
			private?: boolean;
			collaborators?: string[];
			writers?: string[];
			labels?: { name: string; color: string; description?: string }[];
			milestones?: string[];
			assignable?: string[];
			discussionCategories?: string[];
			watchers?: number;
			/** Files on the default branch, `main`. */
			files?: Record<string, string>;
		} = {},
	): void {
		this.repos.set(id, {
			id,
			name,
			private: options.private ?? false,
			collaborators: new Set(options.collaborators ?? []),
			writers: new Set(options.writers ?? []),
			labels: options.labels ?? [],
			milestones: (options.milestones ?? []).map((title, i) => ({
				number: i + 1,
				title,
				due_on: null,
			})),
			assignable: new Set(options.assignable ?? options.writers ?? []),
			discussionCategories: options.discussionCategories ?? [],
			watchers: options.watchers ?? 0,
		});
		this.names.set(name.toLowerCase(), id);
		const tree = this.storeTree(new Map(Object.entries(options.files ?? {})));
		this.refs.set(`${id}:main`, this.storeCommit(tree, [], "Initial commit"));
	}

	// --- Writes (M2) ---------------------------------------------------------

	/** The next writes fail like this, in order (rate limits, outages). */
	failWrites(...failures: FakeFailure[]): void {
		this.writeFailures.push(...failures);
	}

	/** Answer writes as if they worked, without doing them (a write that never shows up). */
	dropWrites = false;

	/** Comments, oldest first. */
	readonly comments: FakeComment[] = [];
	readonly discussions: FakeDiscussion[] = [];
	/** Sub-issue links: parent `repoId#number` → child database ids. */
	readonly subIssues = new Map<string, number[]>();
	/** Dependencies: blocked `repoId#number` → blocking database ids. */
	readonly blockedBy = new Map<string, number[]>();
	/** Releases by repository id, oldest first. */
	readonly releases = new Map<number, FakeRelease[]>();
	/** Branches, `repoId:name` → commit sha. */
	readonly refs = new Map<string, string>();
	readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();
	readonly trees = new Map<string, Map<string, string>>();

	private writeFailures: FakeFailure[] = [];

	private takeFailure(path: string): FakeFailure | undefined {
		const index = this.writeFailures.findIndex((f) => !f.match || path.includes(f.match));
		return index < 0 ? undefined : this.writeFailures.splice(index, 1)[0];
	}

	/** A user token for someone, without the OAuth flow, for calling the API directly. */
	userTokenFor(user: FakeUser): string {
		this.addUser(user);
		const access = token("ghu");
		this.userTokens.set(access, { user, expiresAt: this.now() + this.userTokenTtl * 1000 });
		return access;
	}

	/** An installation token, without an app JWT, for calling the API directly. */
	installationTokenFor(installation: number): string {
		const minted = token("ghs");
		this.installationTokens.set(minted, installation);
		return minted;
	}

	/** An item, for assertions. */
	item(repoId: number, number: number): FakeItem | undefined {
		return this.items.get(`${repoId}#${number}`);
	}

	/** Items in a repository, by number. */
	itemsIn(repoId: number): FakeItem[] {
		return [...this.items.entries()]
			.filter(([key]) => key.startsWith(`${repoId}#`))
			.map(([, item]) => item)
			.sort((a, b) => a.number - b.number);
	}

	/** Database ids, which sub-issues and dependencies use instead of numbers. */
	databaseId(repoId: number, number: number): number {
		return repoId * 1_000_000 + number;
	}

	/** Files on a branch, for assertions. */
	filesOn(repoId: number, branch: string): Map<string, string> | null {
		const sha = this.refs.get(`${repoId}:${branch}`);
		const commit = sha ? this.commits.get(sha) : undefined;
		return commit ? (this.trees.get(commit.tree) ?? null) : null;
	}

	private storeTree(files: Map<string, string>): string {
		// Content-addressed, as in git: the same files make the same tree.
		const sha = createHash("sha1")
			.update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))))
			.digest("hex");
		this.trees.set(sha, files);
		return sha;
	}

	private storeCommit(tree: string, parents: string[], message: string): string {
		const sha = createHash("sha1")
			.update(JSON.stringify({ tree, parents, message, salt: randomBytes(4).toString("hex") }))
			.digest("hex");
		this.commits.set(sha, { tree, parents, message });
		return sha;
	}

	/**
	 * Merge a pull request, as someone would on GitHub: its branch's files
	 * land on `main` in a merge commit, and it's merged. Returns the
	 * `pull_request` webhook's payload, for the test to deliver.
	 */
	mergePull(repoId: number, number: number): Record<string, unknown> {
		const repo = this.repos.get(repoId);
		const item = this.item(repoId, number);
		if (!repo || item?.kind !== "pull" || !item.headRef) throw new Error(`no pull ${number}`);
		if (item.state === "merged" || item.state === "closed") throw new Error(`${number} is closed`);
		const main = this.refs.get(`${repoId}:main`) ?? "";
		const head = this.refs.get(`${repoId}:${item.headRef}`) ?? "";
		const files = new Map([
			...(this.filesOn(repoId, "main") ?? []),
			...(this.filesOn(repoId, item.headRef) ?? []),
		]);
		const message = `Merge pull request #${number} from ${item.headRef}`;
		this.refs.set(`${repoId}:main`, this.storeCommit(this.storeTree(files), [main, head], message));
		item.state = "merged";
		item.updatedAt = new Date(Math.max(this.now(), Date.parse(item.updatedAt) + 1)).toISOString();
		return this.event(repoId, number, "closed");
	}

	/**
	 * The webhook payload GitHub sends for an item as it is now: an `issues`
	 * event's for issues, a `pull_request` event's for pull requests.
	 */
	event(repoId: number, number: number, action: string): Record<string, unknown> {
		const repo = this.repos.get(repoId);
		const item = this.item(repoId, number);
		if (!repo || !item) throw new Error(`no item ${repoId}#${number}`);
		const repository = {
			id: repo.id,
			node_id: `R_${repo.id}`,
			full_name: repo.name,
			private: repo.private,
		};
		if (item.kind === "issue") return { action, repository, issue: this.restIssue(repo, item) };
		const merged = item.state === "merged";
		return {
			action,
			number,
			repository,
			pull_request: {
				...this.restPull(repo, item),
				merged,
				merged_at: merged ? item.updatedAt : null,
			},
		};
	}

	/**
	 * Someone comments on an item (#58), as on GitHub: the comment is kept
	 * (so the app can react to it), and the `issue_comment` webhook's payload
	 * is returned for the test to deliver. `edit` makes it an `edited`
	 * delivery of the comment `edit.id`, whose body was `edit.from`.
	 */
	comment(
		repoId: number,
		number: number,
		user: { id: number; login: string; type?: "User" | "Bot" },
		body: string,
		edit?: { id: number; from: string },
	): Record<string, unknown> & { comment: { id: number; [key: string]: unknown } } {
		const repo = this.repos.get(repoId);
		const item = this.item(repoId, number);
		if (!repo || !item) throw new Error(`no item ${repoId}#${number}`);
		let comment = edit ? this.comments.find((c) => c.id === edit.id) : undefined;
		if (comment) comment.body = body;
		else {
			comment = {
				id: this.comments.length + 1,
				repoId,
				number,
				body,
				login: user.login,
				createdAt: new Date(this.now()).toISOString(),
			};
			this.comments.push(comment);
		}
		const restComment = this.restComment(repo, comment);
		return {
			action: edit ? "edited" : "created",
			repository: {
				id: repo.id,
				node_id: `R_${repo.id}`,
				full_name: repo.name,
				private: repo.private,
			},
			issue: item.kind === "pull" ? this.restPull(repo, item) : this.restIssue(repo, item),
			comment: {
				...restComment,
				user: { login: user.login, id: user.id, type: user.type ?? "User" },
			},
			...(edit ? { changes: { body: { from: edit.from } } } : {}),
		};
	}

	/** Reactions on comments, as `{ comment, content, login }`, oldest first. */
	readonly reactions: { id: number; comment: number; content: string; login: string }[] = [];
	private reactionIds = 0;

	/** Comments the app's bot left on an item. */
	botComments(repoId: number, number: number): string[] {
		return this.comments
			.filter(
				(c) => c.repoId === repoId && c.number === number && c.login === `${this.app.slug}[bot]`,
			)
			.map((c) => c.body);
	}

	/** The reactions on a comment, by content. */
	reactionsOn(comment: number): string[] {
		return this.reactions.filter((r) => r.comment === comment).map((r) => r.content);
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
	install(
		id: number,
		account: string,
		repos: string[],
		options: { permissions?: Record<string, string>; suspended?: boolean } = {},
	): void {
		this.installations.set(id, {
			account,
			repos: repos.map((repo) => repo.toLowerCase()),
			...options,
		});
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

		if ((match = /^\/users\/([^/]+)$/.exec(path))) {
			const account = this.accounts.get(decodeURIComponent(match[1] ?? "").toLowerCase());
			return account ? json(account) : undefined;
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
				{ token: minted, expires_at: new Date(this.now() + 3_600_000).toISOString() },
				201,
			);
		}

		if (path === "/app/installations" && request.method === "GET") {
			this.verifyJwt(auth);
			return json(
				[...this.installations].map(([id, installation]) => ({
					id,
					account: { login: installation.account, type: "Organization" },
					repository_selection: "selected",
					suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
					html_url: `https://github.com/organizations/${installation.account}/settings/installations/${id}`,
					permissions: installation.permissions ?? {
						issues: "write",
						pull_requests: "write",
						contents: "write",
						metadata: "read",
					},
				})),
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
				repositories: installation.repos.map((full_name) => ({
					full_name,
					private: this.repoByName(full_name)?.private ?? false,
				})),
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

		if (path === "/search/issues" && request.method === "GET") {
			const failure = this.searchFailures.shift();
			if (failure) return failed(failure);
			const q = url.searchParams.get("q") ?? "";
			const found = this.search(q, auth, Number(url.searchParams.get("per_page") ?? 30));
			return json({
				total_count: found.total,
				incomplete_results: false,
				items: found.items.map(({ repo, item }) => this.restIssue(repo, item)),
			});
		}

		if ((match = /^\/repositories\/(\d+)$/.exec(path))) {
			const repo = this.repos.get(Number(match[1]));
			if (!repo || !this.canSee(repo, auth)) return undefined;
			return json(this.restRepo(repo, auth));
		}

		return (
			(await this.repositoryWrites(request, url, auth)) ??
			this.repositoryData(url, auth, request.headers.get("if-none-match"))
		);
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

	private restRepo(repo: FakeRepo, auth: string | null = null) {
		const user = auth ? this.userFor(auth) : null;
		return {
			id: repo.id,
			node_id: `R_${repo.id}`,
			full_name: repo.name,
			private: repo.private,
			visibility: repo.private ? "private" : "public",
			default_branch: "main",
			subscribers_count: repo.watchers,
			has_discussions: repo.discussionCategories.length > 0,
			// What the token's holder may do, as GitHub reports it for user tokens.
			...(user
				? {
						permissions: {
							pull: true,
							push: repo.writers.has(user.login),
							admin: false,
						},
					}
				: {}),
		};
	}

	/**
	 * Who a token writes as, if it may write to a repository: an installation
	 * token for an installation that includes it, or a user token for a writer
	 * where the app is installed (GitHub App user tokens are bounded by the
	 * installation).
	 */
	private writer(repo: FakeRepo, auth: string | null): string | null {
		if (!auth) return null;
		if (this.personalTokens.has(auth)) return "personal";
		const installation = this.installationForRepo(repo.name);
		if (!installation) return null;
		if (this.installationTokens.get(auth) === installation.id) return `${this.app.slug}[bot]`;
		const user = this.userFor(auth);
		return user && repo.writers.has(user.login) ? user.login : null;
	}

	/** Write endpoints, and the reads only writes need. */
	private async repositoryWrites(
		request: Request,
		url: URL,
		auth: string | null,
	): Promise<Response | undefined> {
		const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(url.pathname);
		const repo = repoMatch ? this.repoByName(repoMatch[1] ?? "") : undefined;
		if (!repo || !this.canSee(repo, auth)) return undefined;
		const rest = repoMatch?.[2] ?? "";
		const method = request.method;
		const now = new Date(this.now()).toISOString();
		let match: RegExpExecArray | null;

		// Reads.
		if (method === "GET") {
			if (rest === "/labels") return json(repo.labels);
			if (rest === "/milestones") return json(repo.milestones);
			if (rest === "/assignees") return json([...repo.assignable].map((login) => ({ login })));
			if ((match = /^\/contents\/?(.*)$/.exec(rest))) {
				const dir = decodeURIComponent(match[1] ?? "").replace(/\/$/, "");
				const prefix = dir ? `${dir}/` : "";
				const names = new Set<string>();
				for (const path of this.filesOn(repo.id, "main")?.keys() ?? []) {
					if (!path.startsWith(prefix)) continue;
					const [name = "", ...more] = path.slice(prefix.length).split("/");
					names.add(more.length > 0 ? `${name}/` : name);
				}
				if (names.size === 0) return undefined;
				return json(
					[...names].map((name) =>
						name.endsWith("/") ? { name: name.slice(0, -1), type: "dir" } : { name, type: "file" },
					),
				);
			}
			if ((match = /^\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)$/.exec(rest))) {
				const links = (match[2] === "sub_issues" ? this.subIssues : this.blockedBy).get(
					`${repo.id}#${match[1]}`,
				);
				return json((links ?? []).flatMap((id) => this.issueByDatabaseId(id) ?? []));
			}
			if ((match = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
				const since = url.searchParams.get("since") ?? "";
				return json(
					this.comments
						.filter((c) => c.repoId === repo.id && c.number === Number(match?.[1]))
						.filter((c) => c.createdAt >= since)
						.map((c) => this.restComment(repo, c)),
				);
			}
			if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
				const sha = this.refs.get(`${repo.id}:${decodeURIComponent(match[1] ?? "")}`);
				return sha ? json({ object: { sha, type: "commit" } }) : undefined;
			}
			if ((match = /^\/git\/commits\/(\w+)$/.exec(rest))) {
				const commit = this.commits.get(match[1] ?? "");
				return commit ? json({ sha: match[1], tree: { sha: commit.tree } }) : undefined;
			}
			if (rest === "/pulls") {
				const head = url.searchParams.get("head")?.split(":")[1];
				return json(
					this.itemsIn(repo.id)
						.filter((item) => item.kind === "pull" && (!head || item.headRef === head))
						.map((item) => this.restPull(repo, item)),
				);
			}
			return undefined;
		}

		// Writes.
		const login = this.writer(repo, auth);
		if (!login) {
			return auth
				? json({ message: "Resource not accessible by integration" }, 403)
				: json({ message: "Requires authentication" }, 401);
		}
		const failure = this.takeFailure(url.pathname);
		if (failure && !failure.after) return failed(failure);
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const response = this.write(repo, rest, method, body, login, now);
		// The write happened, but the answer was lost.
		return failure && response ? failed(failure) : response;
	}

	private write(
		repo: FakeRepo,
		rest: string,
		method: string,
		body: Record<string, unknown>,
		login: string,
		now: string,
	): Response | undefined {
		const drop = this.dropWrites;
		let match: RegExpExecArray | null;

		if (rest === "/issues" && method === "POST") {
			const number = Math.max(0, ...this.itemsIn(repo.id).map((i) => i.number)) + 1;
			const milestone = repo.milestones.find((m) => m.number === body.milestone);
			const item: FakeItem = {
				number,
				kind: "issue",
				title: String(body.title),
				body: typeof body.body === "string" ? body.body : "",
				updatedAt: now,
				createdAt: now,
				labels: ((body.labels as string[] | undefined) ?? []).map((name) => this.label(repo, name)),
				assignees: ((body.assignees as string[] | undefined) ?? []).filter((l) =>
					repo.assignable.has(l),
				),
				milestone: milestone?.title ?? null,
			};
			if (!drop) this.setItem(repo.id, item);
			return json(this.restIssue(repo, item), 201);
		}

		if (rest === "/git/trees" && method === "POST") {
			const base = this.trees.get(String(body.base_tree)) ?? new Map<string, string>();
			const files = new Map(base);
			for (const entry of body.tree as { path: string; content: string }[]) {
				files.set(entry.path, entry.content);
			}
			return json({ sha: this.storeTree(files) }, 201);
		}
		if (rest === "/git/commits" && method === "POST") {
			const sha = this.storeCommit(
				String(body.tree),
				body.parents as string[],
				String(body.message),
			);
			return json({ sha }, 201);
		}
		if (rest === "/git/refs" && method === "POST") {
			const branch = String(body.ref).replace(/^refs\/heads\//, "");
			if (this.refs.has(`${repo.id}:${branch}`)) {
				return json({ message: "Reference already exists" }, 422);
			}
			if (!drop) this.refs.set(`${repo.id}:${branch}`, String(body.sha));
			return json({ ref: body.ref, object: { sha: body.sha } }, 201);
		}
		if (rest === "/pulls" && method === "POST") {
			const branch = String(body.head);
			if (!this.refs.has(`${repo.id}:${branch}`)) {
				return json({ message: "Validation Failed", errors: [{ message: "No head branch" }] }, 422);
			}
			const number = Math.max(0, ...this.itemsIn(repo.id).map((i) => i.number)) + 1;
			const item: FakeItem = {
				number,
				kind: "pull",
				title: String(body.title),
				body: typeof body.body === "string" ? body.body : "",
				state: "open",
				updatedAt: now,
				createdAt: now,
				headRef: branch,
			};
			if (!drop) this.setItem(repo.id, item);
			return json(this.restPull(repo, item), 201);
		}

		// Reactions on comments (#58). Reacting twice with the same content
		// returns the reaction already there, as GitHub does.
		const reacting = /^\/issues\/comments\/(\d+)\/reactions(?:\/(\d+))?$/.exec(rest);
		if (reacting) {
			const commentId = Number(reacting[1]);
			if (!this.comments.some((c) => c.id === commentId && c.repoId === repo.id)) {
				return json({ message: "Not Found" }, 404);
			}
			if (method === "POST" && !reacting[2]) {
				const content = String(body.content);
				if (
					!["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"].includes(content)
				) {
					return json({ message: "Validation Failed" }, 422);
				}
				const existing = this.reactions.find(
					(r) => r.comment === commentId && r.content === content && r.login === login,
				);
				if (existing) return json({ id: existing.id, content }, 200);
				const reaction = { id: ++this.reactionIds, comment: commentId, content, login };
				if (!drop) this.reactions.push(reaction);
				return json({ id: reaction.id, content }, 201);
			}
			if (method === "DELETE" && reacting[2]) {
				const index = this.reactions.findIndex(
					(r) => r.id === Number(reacting[2]) && r.comment === commentId,
				);
				if (index < 0) return json({ message: "Not Found" }, 404);
				if (!drop) this.reactions.splice(index, 1);
				return new Response(null, { status: 204 });
			}
			return undefined;
		}

		const issueMatch = /^\/issues\/(\d+)(\/.*)?$/.exec(rest);
		const item = issueMatch ? this.items.get(`${repo.id}#${issueMatch[1]}`) : undefined;
		if (!issueMatch || !item) return undefined;
		const sub = issueMatch[2] ?? "";
		const key = `${repo.id}#${item.number}`;
		const touch = () => {
			if (!drop)
				item.updatedAt = new Date(
					Math.max(this.now(), Date.parse(item.updatedAt) + 1),
				).toISOString();
		};

		if (sub === "" && method === "PATCH") {
			if (!drop) {
				if (body.state === "closed") {
					item.state = "closed";
					item.stateReason =
						typeof body.state_reason === "string" ? body.state_reason : "completed";
				} else if (body.state === "open") {
					item.state = "open";
					item.stateReason = null;
				}
				if ("milestone" in body) {
					item.milestone =
						body.milestone === null
							? null
							: (repo.milestones.find((m) => m.number === body.milestone)?.title ?? null);
				}
			}
			touch();
			return json(this.restIssue(repo, item));
		}
		if (sub === "/labels" && method === "POST") {
			if (!drop) {
				const labels = item.labels ?? [];
				for (const name of body.labels as string[]) {
					if (!labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
						labels.push(this.label(repo, name));
					}
				}
				item.labels = labels;
			}
			touch();
			return json(item.labels ?? []);
		}
		if ((match = /^\/labels\/(.+)$/.exec(sub)) && method === "DELETE") {
			const name = decodeURIComponent(match[1] ?? "");
			if (!(item.labels ?? []).some((l) => l.name === name)) {
				return json({ message: "Label does not exist" }, 404);
			}
			if (!drop) item.labels = (item.labels ?? []).filter((l) => l.name !== name);
			touch();
			return json(item.labels ?? []);
		}
		if (sub === "/assignees") {
			const logins = (body.assignees as string[]) ?? [];
			if (!drop) {
				const current = new Set(item.assignees ?? []);
				for (const login of logins) {
					if (method === "POST" && repo.assignable.has(login)) current.add(login);
					if (method === "DELETE") current.delete(login);
				}
				item.assignees = [...current];
			}
			touch();
			return json(this.restIssue(repo, item), method === "POST" ? 201 : 200);
		}
		if (sub === "/comments" && method === "POST") {
			const comment: FakeComment = {
				id: this.comments.length + 1,
				repoId: repo.id,
				number: item.number,
				body: String(body.body),
				login,
				createdAt: now,
			};
			if (!drop) this.comments.push(comment);
			return json(this.restComment(repo, comment), 201);
		}
		if ((sub === "/sub_issues" || sub === "/dependencies/blocked_by") && method === "POST") {
			const id = Number(sub === "/sub_issues" ? body.sub_issue_id : body.issue_id);
			if (!this.issueByDatabaseId(id)) return json({ message: "Not Found" }, 404);
			const links = sub === "/sub_issues" ? this.subIssues : this.blockedBy;
			const list = links.get(key) ?? [];
			if (list.includes(id)) {
				return json({ message: "Validation Failed", errors: [{ message: "already linked" }] }, 422);
			}
			if (sub === "/sub_issues") {
				for (const children of this.subIssues.values()) {
					if (children.includes(id)) {
						return json(
							{ message: "Validation Failed", errors: [{ message: "Issue already has a parent" }] },
							422,
						);
					}
				}
			}
			if (!drop) links.set(key, [...list, id]);
			return json(this.restIssue(repo, item), 201);
		}
		return undefined;
	}

	private label(repo: FakeRepo, name: string): { name: string; color: string } {
		const known = repo.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
		return { name: known?.name ?? name, color: known?.color ?? "ededed" };
	}

	private issueByDatabaseId(id: number) {
		const repo = this.repos.get(Math.floor(id / 1_000_000));
		const item = repo && this.items.get(`${repo.id}#${id % 1_000_000}`);
		return repo && item ? this.restIssue(repo, item) : null;
	}

	private restComment(repo: FakeRepo, comment: FakeComment) {
		return {
			id: comment.id,
			body: comment.body,
			user: { login: comment.login, type: comment.login.endsWith("[bot]") ? "Bot" : "User" },
			created_at: comment.createdAt,
			html_url: `https://github.com/${repo.name}/issues/${comment.number}#issuecomment-${comment.id}`,
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
			const created = url.searchParams.get("sort") === "created";
			const list = [...this.items.entries()]
				.filter(([key, item]) => key.startsWith(`${repo.id}#`) && item.updatedAt >= since)
				.map(([, item]) => item)
				.sort((a, b) =>
					created
						? (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt)
						: b.updatedAt.localeCompare(a.updatedAt),
				)
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
		const discussions = this.discussionsGraphQL(body.operationName, body.variables, auth);
		if (discussions) return discussions;
		if (body.operationName === "TackSearch") {
			const failure = this.searchFailures.shift();
			if (failure) return failed(failure);
			const found = this.search(
				typeof body.variables.q === "string" ? body.variables.q : "",
				auth,
				Number(body.variables.first ?? 10),
			);
			return json({
				data: {
					search: {
						issueCount: found.total,
						nodes: found.items.map(({ repo, item }) => this.gqlItem(repo, item)),
					},
				},
			});
		}
		return json({ data: this.graphql(body.operationName, body.query, body.variables, auth) });
	}

	/** The discussion queries and mutation Tack makes (src/server/forges/github-write.ts). */
	private discussionsGraphQL(
		operation: string,
		variables: Record<string, unknown>,
		auth: string,
	): Response | undefined {
		const named = (owner: unknown, name: unknown) => {
			const repo = this.repoByName(`${String(owner)}/${String(name)}`);
			return repo && this.canSee(repo, auth) ? repo : undefined;
		};
		const categories = (repo: FakeRepo) =>
			repo.discussionCategories.map((name, i) => ({
				id: `DC_${repo.id}_${i}`,
				name,
				slug: name.toLowerCase().replace(/\s+/g, "-"),
			}));
		const url = (repo: FakeRepo, d: FakeDiscussion) =>
			`https://github.com/${repo.name}/discussions/${d.number}`;
		if (operation === "TackDiscussionTarget" || operation === "TackDiscussionCategories") {
			const repo = named(variables.owner, variables.name);
			return json({
				data: {
					repository: repo
						? {
								id: `R_${repo.id}`,
								hasDiscussionsEnabled: repo.discussionCategories.length > 0,
								discussionCategories: { nodes: categories(repo) },
							}
						: null,
				},
			});
		}
		if (operation === "TackRecentDiscussions") {
			const repo = named(variables.owner, variables.name);
			return json({
				data: {
					repository: repo
						? {
								discussions: {
									nodes: this.discussions
										.filter((d) => d.repoId === repo.id)
										.reverse()
										.map((d) => ({ title: d.title, url: url(repo, d), createdAt: d.createdAt })),
								},
							}
						: null,
				},
			});
		}
		if (operation === "TackCreateDiscussion") {
			const input = variables.input as Record<string, string>;
			const repo = this.repos.get(Number(String(input.repositoryId).replace(/^R_/, "")));
			if (!repo || !this.writer(repo, auth)) {
				return json({
					data: null,
					errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }],
				});
			}
			const failure = this.takeFailure("TackCreateDiscussion");
			if (failure) {
				return new Response(JSON.stringify({ message: failure.message ?? "Failed" }), {
					status: failure.status,
					headers: { "content-type": "application/json", ...failure.headers },
				});
			}
			const category = categories(repo).find((c) => c.id === input.categoryId);
			const discussion: FakeDiscussion = {
				repoId: repo.id,
				number: 1000 + this.discussions.length,
				title: input.title ?? "",
				body: input.body ?? "",
				category: category?.name ?? "",
				createdAt: new Date(this.now()).toISOString(),
			};
			if (!this.dropWrites) this.discussions.push(discussion);
			return json({
				data: {
					createDiscussion: {
						discussion: { url: url(repo, discussion), number: discussion.number },
					},
				},
			});
		}
		return undefined;
	}

	/** The next searches fail like this, in order (rate limits, outages). */
	failSearches(...failures: FakeFailure[]): void {
		this.searchFailures.push(...failures);
	}

	private searchFailures: FakeFailure[] = [];

	/**
	 * Issue search, as far as Tack's matcher can evaluate it (src/shared/search.ts):
	 * items in repositories the token can see, newest first. `@me` is the
	 * token's user; anything the matcher can't tell rules an item out.
	 */
	private search(
		q: string,
		auth: string | null,
		limit: number,
	): { total: number; items: { repo: FakeRepo; item: FakeItem }[] } {
		const parsed = parseSearch(q);
		const viewer = auth ? this.userFor(auth)?.login : undefined;
		const found: { repo: FakeRepo; item: FakeItem }[] = [];
		for (const [key, item] of this.items) {
			const repo = this.repos.get(Number(key.split("#")[0]));
			if (!repo || !this.canSee(repo, auth)) continue;
			const card: Card = {
				key: `github.com/${repo.name}#${item.number}`.toLowerCase(),
				forge: "github",
				host: "github.com",
				repo: repo.name.toLowerCase(),
				item: `#${item.number}`,
				kind: item.kind,
				title: item.title,
				state:
					item.kind === "pull" && item.state === "merged"
						? "merged"
						: item.state === "closed"
							? "closed"
							: item.draft
								? "draft"
								: "open",
				stateReason: item.state === "closed" ? (item.stateReason ?? "completed") : null,
				labels: item.labels ?? [],
				assignees: (item.assignees ?? []).map((login) => ({ login, avatarUrl: "" })),
				author: { login: "octocat", avatarUrl: "" },
				comments: 0,
				reactions: 0,
				url: "",
				updatedAt: item.updatedAt,
				visibility: repo.private ? "private" : "public",
			};
			const verdict = matchSearch(card, parsed, {
				viewer,
				milestoneOf: () => item.milestone ?? null,
			});
			if (verdict === "yes") found.push({ repo, item });
		}
		found.sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt));
		return { total: found.length, items: found.slice(0, limit) };
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
		if (operation === "TackRelated") return this.relatedGraphQL(variables, auth);
		if (operation === "TackRelease") return this.releaseGraphQL(variables, auth);
		if (operation === "TackMergedSince") return this.mergedSinceGraphQL(variables, auth);
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

	/** An item by database id, as GraphQL shows it, if `auth` can see it. */
	private gqlByDatabaseId(id: number, auth: string) {
		const repo = this.repos.get(Math.floor(id / 1_000_000));
		const item = repo && this.items.get(`${repo.id}#${id % 1_000_000}`);
		return repo && item && this.canSee(repo, auth) ? this.gqlItem(repo, item) : null;
	}

	/** What's related to an item (src/server/forges/github-related.ts). */
	private relatedGraphQL(variables: Record<string, unknown>, auth: string) {
		const repo = this.repoByName(`${String(variables.owner)}/${String(variables.name)}`);
		if (!repo || !this.canSee(repo, auth)) return { repository: null };
		const number = Number(variables.number);
		const item = this.items.get(`${repo.id}#${number}`);
		if (!item) return { repository: { issueOrPullRequest: null } };
		const self = this.databaseId(repo.id, number);
		const key = `${repo.id}#${number}`;
		const nodes = (ids: number[]) => ({
			nodes: ids.map((id) => this.gqlByDatabaseId(id, auth)).filter(Boolean),
		});
		const pulls = [...this.items.entries()].filter(([, other]) => other.kind === "pull");
		const mentions = {
			nodes: pulls
				.filter(([, pull]) => pull.mentions?.includes(number))
				.map(([k]) => ({
					__typename: "CrossReferencedEvent",
					source: this.gqlByDatabaseId(
						this.databaseId(Number(k.split("#")[0]), Number(k.split("#")[1])),
						auth,
					),
				})),
		};
		if (item.kind === "pull") {
			return {
				repository: {
					issueOrPullRequest: {
						__typename: "PullRequest",
						closingIssuesReferences: nodes(
							(item.closes ?? []).map((n) => this.databaseId(repo.id, n)),
						),
						timelineItems: mentions,
					},
				},
			};
		}
		const parent = [...this.subIssues].find(([, children]) => children.includes(self))?.[0];
		const parentId = parent
			? this.databaseId(Number(parent.split("#")[0]), Number(parent.split("#")[1]))
			: null;
		return {
			repository: {
				issueOrPullRequest: {
					__typename: "Issue",
					parent: parentId === null ? null : this.gqlByDatabaseId(parentId, auth),
					subIssues: nodes(this.subIssues.get(key) ?? []),
					blockedBy: nodes(this.blockedBy.get(key) ?? []),
					blocking: nodes(
						[...this.blockedBy].flatMap(([blocked, blockers]) =>
							blockers.includes(self)
								? [this.databaseId(Number(blocked.split("#")[0]), Number(blocked.split("#")[1]))]
								: [],
						),
					),
					closedByPullRequestsReferences: nodes(
						pulls
							.filter(([k, pull]) => k.startsWith(`${repo.id}#`) && pull.closes?.includes(number))
							.map(([, pull]) => this.databaseId(repo.id, pull.number)),
					),
					timelineItems: mentions,
				},
			},
		};
	}

	/** A repository's latest release (src/server/forges/github-related.ts). */
	private releaseGraphQL(variables: Record<string, unknown>, auth: string) {
		const repo = this.repoByName(`${String(variables.owner)}/${String(variables.name)}`);
		if (!repo || !this.canSee(repo, auth)) return { repository: null };
		const latest = this.releases.get(repo.id)?.at(-1) ?? null;
		return {
			repository: {
				nameWithOwner: repo.name,
				defaultBranchRef: { name: "main" },
				latestRelease: latest && {
					...latest,
					url: `https://github.com/${repo.name}/releases/tag/${latest.tagName}`,
				},
			},
		};
	}

	/** Search for merged pull requests: `repo:`, `is:pr is:merged`, `base:` and `merged:>`. */
	private mergedSinceGraphQL(variables: Record<string, unknown>, auth: string) {
		const q = String(variables.q);
		const term = (name: string) => new RegExp(`(?:^| )${name}:(\\S+)`).exec(q)?.[1];
		const repo = this.repoByName(term("repo") ?? "");
		if (!repo || !this.canSee(repo, auth) || !/is:pr/.test(q) || !/is:merged/.test(q)) {
			return { search: { nodes: [] } };
		}
		const base = term("base");
		const since = term("merged")?.replace(/^>/, "");
		return {
			search: {
				nodes: this.itemsIn(repo.id)
					.filter((item) => item.kind === "pull" && item.state === "merged")
					.filter((item) => !base || (item.base ?? "main") === base)
					.filter((item) => !since || (item.mergedAt ?? item.updatedAt) > since)
					.map((item) => this.gqlItem(repo, item)),
			},
		};
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

	/** When a closed item was closed (or a pull request merged): `mergedAt`, else `updatedAt`. */
	private closedAt(item: FakeItem): string {
		return (item.state === "merged" ? item.mergedAt : undefined) ?? item.updatedAt;
	}

	private gqlItem(repo: Pick<FakeRepo, "id" | "name" | "private">, item: FakeItem) {
		const common = {
			__typename: item.kind === "pull" ? "PullRequest" : "Issue",
			id: `${item.kind === "pull" ? "PR" : "I"}_${repo.id}_${item.number}`,
			number: item.number,
			title: item.title,
			url: `https://github.com/${repo.name}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`,
			updatedAt: item.updatedAt,
			createdAt: item.createdAt ?? item.updatedAt,
			closedAt: item.state === "closed" || item.state === "merged" ? this.closedAt(item) : null,
			milestone: item.milestone
				? {
						title: item.milestone,
						dueOn:
							this.repos.get(repo.id)?.milestones.find((m) => m.title === item.milestone)?.due_on ??
							null,
					}
				: null,
			repository: { nameWithOwner: repo.name, isPrivate: repo.private },
			author: { login: "octocat", avatarUrl: "https://avatars.example/octocat" },
			labels: { nodes: item.labels ?? [] },
			assignees: {
				nodes: (item.assignees ?? []).map((login) => ({
					login,
					avatarUrl: `https://avatars.example/${login}`,
				})),
			},
			comments: { totalCount: 0 },
			reactions: { totalCount: item.thumbsUp?.length ?? 0 },
			thumbsUp: {
				totalCount: item.thumbsUp?.length ?? 0,
				nodes: (item.thumbsUp ?? []).map((login) => ({ user: { login } })),
			},
		};
		if (item.kind === "issue") {
			return {
				...common,
				issueState: item.state === "closed" ? "CLOSED" : "OPEN",
				stateReason:
					item.state === "closed" ? (item.stateReason ?? "completed").toUpperCase() : null,
			};
		}
		return {
			...common,
			pullState: item.state === "merged" ? "MERGED" : item.state === "closed" ? "CLOSED" : "OPEN",
			mergedAt: item.state === "merged" ? this.closedAt(item) : null,
			isDraft: item.draft ?? false,
			mergeable: item.mergeable ?? "MERGEABLE",
			additions: item.additions ?? 0,
			deletions: item.deletions ?? 0,
			changedFiles: item.changedFiles ?? 0,
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
			id: this.databaseId(repo.id, item.number),
			number: item.number,
			title: item.title,
			body: item.body ?? "",
			state: item.state === "open" || !item.state ? "open" : "closed",
			state_reason: item.state === "closed" ? (item.stateReason ?? "completed") : null,
			created_at: item.createdAt ?? item.updatedAt,
			closed_at: item.state === "closed" || item.state === "merged" ? this.closedAt(item) : null,
			milestone: item.milestone ? { title: item.milestone } : null,
			html_url: `https://github.com/${repo.name}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`,
			repository_url: `https://api.github.com/repos/${repo.name}`,
			updated_at: item.updatedAt,
			node_id: `${item.kind === "pull" ? "PR" : "I"}_${repo.id}_${item.number}`,
			comments: 0,
			reactions: { total_count: item.thumbsUp?.length ?? 0, "+1": item.thumbsUp?.length ?? 0 },
			labels: item.labels ?? [],
			assignees: (item.assignees ?? []).map((login) => ({
				login,
				avatar_url: `https://avatars.example/${login}`,
			})),
			user: null,
			...(item.kind === "pull"
				? { pull_request: { merged_at: item.state === "merged" ? this.closedAt(item) : null } }
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
						{ id: 0, name: repo, private: true },
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
		this.userTokens.set(access, { user, expiresAt: this.now() + this.userTokenTtl * 1000 });
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
		return entry && entry.expiresAt > this.now() ? entry.user : null;
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
		const now = this.now() / 1000;
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
