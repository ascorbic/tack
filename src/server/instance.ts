import { DurableObject } from "cloudflare:workers";
import { decrypt, encrypt, randomToken, sha256 } from "./auth/crypto.ts";
import { devUserId, normaliseLogins } from "./auth/logins.ts";
import { OAuthError, type UserTokens, exchangeCode, refreshTokens } from "./auth/oauth.ts";
import { gh, ghJson } from "./github/api.ts";
import {
	type AppCredentials,
	type ManifestConversion,
	credentialsFromConversion,
	importPrivateKey,
	signAppJwt,
} from "./github/app.ts";
import type {
	AccessList,
	AccessSettings,
	AccessUpdateRequest,
	AccessUpdateResponse,
} from "../shared/auth.ts";
import type { Viewer } from "./identity.ts";
import { log } from "./log.ts";

const DAY = 24 * 60 * 60_000;
export const SESSION_TTL = 30 * DAY;
/** Refresh tokens this long before they expire. */
const REFRESH_MARGIN = 5 * 60_000;
/** How long to remember that a repository has no installation. */
const NOT_INSTALLED_TTL = 10 * 60_000;
/** How long the person who created the app has to sign in and claim admin. */
const CLAIM_TTL = DAY;

export interface SessionInfo {
	viewer: Viewer;
	admin: boolean;
	allowed: boolean;
}

export interface Lookup {
	/** Whether a GitHub App has been set up, which turns access control on. */
	configured: boolean;
	session: SessionInfo | null;
}

export interface AppInfo {
	id: number;
	slug: string;
	name: string;
	clientId: string;
	htmlUrl: string;
}

export type SetupResult =
	| { ok: true; claim: string }
	| { ok: false; error: "already_configured" | "in_progress" | "conversion_failed" };

export type SignInResult =
	| { ok: true; sessionId: string; expiresAt: number; session: SessionInfo }
	| { ok: false; error: string };

export interface InstallationPayload {
	action?: string;
	installation?: {
		id: number;
		account?: { login: string } | null;
		repository_selection?: string;
	};
	repositories?: { full_name: string }[];
	repositories_added?: { full_name: string }[];
	repositories_removed?: { full_name: string }[];
}

interface UserRow extends Record<string, SqlStorageValue> {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
	admin: number;
	orgs: string;
}

interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
}

interface InstallationToken {
	token: string;
	expiresAt: number;
}

/**
 * The one instance-wide Durable Object: the GitHub App's credentials,
 * installations and their tokens, users and sessions, and the access
 * allowlist. Every credential is encrypted at rest with `TACK_SECRET`.
 */
export class Instance extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;
	private appCache: AppCredentials | null | undefined;
	private appKey: Promise<CryptoKey> | undefined;
	private jwt: InstallationToken | undefined;
	private setupInFlight = false;
	private tokens = new Map<number, InstallationToken>();
	private minting = new Map<number, Promise<InstallationToken>>();
	private refreshing = new Map<number, Promise<string | null>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS users (
				id INTEGER PRIMARY KEY,
				login TEXT NOT NULL,
				name TEXT,
				avatar_url TEXT NOT NULL,
				admin INTEGER NOT NULL DEFAULT 0,
				orgs TEXT NOT NULL DEFAULT '[]',
				tokens TEXT,
				created_at INTEGER NOT NULL,
				signed_in_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sessions (
				hash TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS installations (
				id INTEGER PRIMARY KEY,
				account TEXT NOT NULL,
				selection TEXT NOT NULL,
				suspended INTEGER NOT NULL DEFAULT 0,
				token TEXT,
				token_expires_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS repositories (
				repo TEXT PRIMARY KEY,
				installation_id INTEGER,
				checked_at INTEGER NOT NULL
			);
		`);
	}

	private get secret(): string {
		const secret = this.env.TACK_SECRET;
		if (!secret) throw new Error("TACK_SECRET is not set");
		return secret;
	}

	private setting(key: string): string | null {
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)
			.toArray()[0];
		return row?.value ?? null;
	}

	private setSetting(key: string, value: string | null): void {
		if (value === null) this.sql.exec("DELETE FROM settings WHERE key = ?", key);
		else this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, value);
	}

	// ---------------------------------------------------------------------
	// The GitHub App

	isConfigured(): boolean {
		return this.setting("app") !== null;
	}

	private async app(): Promise<AppCredentials | null> {
		if (this.appCache !== undefined) return this.appCache;
		const stored = this.setting("app");
		this.appCache = stored
			? (JSON.parse(await decrypt(this.secret, stored, "app")) as AppCredentials)
			: null;
		return this.appCache;
	}

	/** The app's public details, or null before setup. */
	async appInfo(): Promise<AppInfo | null> {
		const app = await this.app();
		return app
			? { id: app.id, slug: app.slug, name: app.name, clientId: app.clientId, htmlUrl: app.htmlUrl }
			: null;
	}

	/**
	 * Finish the manifest flow: exchange GitHub's code for the new app's
	 * credentials and store them. Returns a claim token that makes whoever
	 * holds it (the person who just created the app) the first admin.
	 */
	async completeSetup(code: string): Promise<SetupResult> {
		if (this.isConfigured()) return { ok: false, error: "already_configured" };
		if (this.setupInFlight) return { ok: false, error: "in_progress" };
		this.setupInFlight = true;
		try {
			const conversion = await ghJson<ManifestConversion>(
				`/app-manifests/${encodeURIComponent(code)}/conversions`,
				{ method: "POST" },
			);
			const app = credentialsFromConversion(conversion);
			this.setSetting("app", await encrypt(this.secret, JSON.stringify(app), "app"));
			this.appCache = app;
			const claim = randomToken();
			this.setSetting(
				"admin_claim",
				JSON.stringify({ hash: await sha256(claim), expiresAt: Date.now() + CLAIM_TTL }),
			);
			log.info("setup.completed", { app: app.slug, appId: app.id, owner: app.owner?.login });
			return { ok: true, claim };
		} catch (error) {
			log.error("setup.failed", { error });
			return { ok: false, error: "conversion_failed" };
		} finally {
			this.setupInFlight = false;
		}
	}

	async webhookSecret(): Promise<string | null> {
		return (await this.app())?.webhookSecret ?? null;
	}

	/** A JWT for calling GitHub as the app, reused until it's close to expiry. */
	async appJwt(): Promise<string | null> {
		const app = await this.app();
		if (!app) return null;
		if (this.jwt && this.jwt.expiresAt - Date.now() > 60_000) return this.jwt.token;
		this.appKey ??= importPrivateKey(app.pem);
		this.jwt = await signAppJwt(await this.appKey, app.clientId);
		return this.jwt.token;
	}

	// ---------------------------------------------------------------------
	// Installations

	/** An installation token for a repository (`owner/name`), or null if the app isn't installed. */
	async repoToken(repo: string): Promise<InstallationToken | null> {
		try {
			const id = await this.installationFor(repo);
			return id === null ? null : await this.installationToken(id);
		} catch (error) {
			log.warn("github.token.failed", { repo, error });
			return null;
		}
	}

	async isInstalled(repo: string): Promise<boolean> {
		try {
			return (await this.installationFor(repo)) !== null;
		} catch {
			return false;
		}
	}

	private async installationFor(repo: string): Promise<number | null> {
		repo = repo.toLowerCase();
		const known = this.sql
			.exec<{ installation_id: number | null; checked_at: number; suspended: number | null }>(
				`SELECT r.installation_id, r.checked_at, i.suspended FROM repositories r
				LEFT JOIN installations i ON i.id = r.installation_id
				WHERE r.repo = ?`,
				repo,
			)
			.toArray()[0];
		if (known?.installation_id != null) return known.suspended ? null : known.installation_id;
		if (known && Date.now() - known.checked_at < NOT_INSTALLED_TTL) return null;
		if (!this.isConfigured()) return null;

		// An installation on the whole account covers repositories created since.
		const owner = repo.split("/")[0] ?? "";
		const all = this.sql
			.exec<{ id: number }>(
				"SELECT id FROM installations WHERE account = ? AND selection = 'all' AND suspended = 0",
				owner,
			)
			.toArray()[0];
		if (all) {
			this.mapRepos([repo], all.id);
			return all.id;
		}

		const jwt = await this.appJwt();
		if (!jwt) return null;
		const response = await gh(`/repos/${repo}/installation`, { auth: `Bearer ${jwt}` });
		if (response.status === 404) {
			this.mapRepos([repo], null);
			return null;
		}
		if (!response.ok) throw new Error(`Installation lookup for ${repo} failed: ${response.status}`);
		const installation = await response.json<NonNullable<InstallationPayload["installation"]>>();
		this.upsertInstallation(installation);
		this.mapRepos([repo], installation.id);
		return installation.id;
	}

	private async installationToken(id: number): Promise<InstallationToken> {
		const cached = this.tokens.get(id) ?? (await this.storedInstallationToken(id));
		if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN) return cached;

		let minting = this.minting.get(id);
		if (!minting) {
			minting = this.mintInstallationToken(id).finally(() => this.minting.delete(id));
			this.minting.set(id, minting);
		}
		return minting;
	}

	private async storedInstallationToken(id: number): Promise<InstallationToken | null> {
		const row = this.sql
			.exec<{ token: string | null; token_expires_at: number | null }>(
				"SELECT token, token_expires_at FROM installations WHERE id = ?",
				id,
			)
			.toArray()[0];
		if (!row?.token || !row.token_expires_at) return null;
		const token = {
			token: await decrypt(this.secret, row.token, `installation:${id}`),
			expiresAt: row.token_expires_at,
		};
		this.tokens.set(id, token);
		return token;
	}

	private async mintInstallationToken(id: number): Promise<InstallationToken> {
		const jwt = await this.appJwt();
		if (!jwt) throw new Error("No GitHub App configured");
		const minted = await ghJson<{ token: string; expires_at: string }>(
			`/app/installations/${id}/access_tokens`,
			{ method: "POST", auth: `Bearer ${jwt}` },
		);
		const token = { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
		this.sql.exec(
			"UPDATE installations SET token = ?, token_expires_at = ? WHERE id = ?",
			await encrypt(this.secret, token.token, `installation:${id}`),
			token.expiresAt,
			id,
		);
		this.tokens.set(id, token);
		return token;
	}

	private upsertInstallation(installation: NonNullable<InstallationPayload["installation"]>): void {
		this.sql.exec(
			`INSERT INTO installations (id, account, selection, suspended) VALUES (?, ?, ?, 0)
			ON CONFLICT (id) DO UPDATE SET account = excluded.account, selection = excluded.selection`,
			installation.id,
			installation.account?.login.toLowerCase() ?? "",
			installation.repository_selection ?? "selected",
		);
	}

	private mapRepos(repos: string[], installationId: number | null): void {
		const now = Date.now();
		for (const repo of repos) {
			this.sql.exec(
				"INSERT OR REPLACE INTO repositories (repo, installation_id, checked_at) VALUES (?, ?, ?)",
				repo.toLowerCase(),
				installationId,
				now,
			);
		}
	}

	private forgetInstallation(id: number): void {
		this.tokens.delete(id);
		this.sql.exec("DELETE FROM installations WHERE id = ?", id);
		this.sql.exec("DELETE FROM repositories WHERE installation_id = ?", id);
	}

	/** Keep installations and their repositories current from webhooks. */
	installationEvent(event: string, payload: InstallationPayload): void {
		const installation = payload.installation;
		if (!installation) return;
		log.info("github.installation", {
			event,
			action: payload.action,
			installation: installation.id,
			account: installation.account?.login,
		});
		const names = (list?: { full_name: string }[]) => (list ?? []).map((repo) => repo.full_name);

		if (event === "installation") {
			switch (payload.action) {
				case "deleted":
					this.forgetInstallation(installation.id);
					return;
				case "suspend":
					this.tokens.delete(installation.id);
					this.sql.exec(
						"UPDATE installations SET suspended = 1, token = NULL, token_expires_at = NULL WHERE id = ?",
						installation.id,
					);
					return;
				case "unsuspend":
					this.upsertInstallation(installation);
					this.sql.exec("UPDATE installations SET suspended = 0 WHERE id = ?", installation.id);
					return;
				default:
					// created, new_permissions_accepted
					this.upsertInstallation(installation);
					this.mapRepos(names(payload.repositories), installation.id);
					return;
			}
		}

		if (event === "installation_repositories") {
			this.upsertInstallation(installation);
			this.mapRepos(names(payload.repositories_added), installation.id);
			// Removed repositories are remembered as not installed, then rechecked later.
			this.mapRepos(names(payload.repositories_removed), null);
		}
	}

	/**
	 * Someone just installed (or changed) the app and GitHub sent them back.
	 * Webhooks will follow, but sync now so the change shows up immediately,
	 * and in local development, where webhooks can't arrive.
	 */
	async installationCompleted(id: number): Promise<boolean> {
		try {
			const jwt = await this.appJwt();
			if (!jwt) return false;
			const installation = await ghJson<NonNullable<InstallationPayload["installation"]>>(
				`/app/installations/${id}`,
				{ auth: `Bearer ${jwt}` },
			);
			this.upsertInstallation(installation);
			this.sql.exec("UPDATE installations SET suspended = 0 WHERE id = ?", id);
			const { token } = await this.installationToken(id);
			for (let page = 1; page <= 10; page++) {
				const { repositories } = await ghJson<{ repositories: { full_name: string }[] }>(
					`/installation/repositories?per_page=100&page=${page}`,
					{ auth: `Bearer ${token}` },
				);
				this.mapRepos(
					repositories.map((repo) => repo.full_name),
					id,
				);
				if (repositories.length < 100) break;
			}
			return true;
		} catch (error) {
			log.error("github.installation.failed", { installation: id, error });
			return false;
		}
	}

	// ---------------------------------------------------------------------
	// Users and sessions

	/** Finish signing in: exchange the OAuth code, look the user up, start a session. */
	async signIn(options: {
		code: string;
		verifier: string;
		redirectUri: string;
		claim: string | null;
	}): Promise<SignInResult> {
		const app = await this.app();
		if (!app) return { ok: false, error: "not_configured" };

		let tokens: UserTokens;
		try {
			tokens = await exchangeCode({
				clientId: app.clientId,
				clientSecret: app.clientSecret,
				code: options.code,
				verifier: options.verifier,
				redirectUri: options.redirectUri,
			});
		} catch (error) {
			log.warn("auth.signin.failed", { reason: "exchange", error });
			return { ok: false, error: error instanceof OAuthError ? error.code : "exchange_failed" };
		}

		let user: GitHubUser;
		try {
			user = await ghJson<GitHubUser>("/user", { auth: `Bearer ${tokens.accessToken}` });
		} catch (error) {
			log.warn("auth.signin.failed", { reason: "user", error });
			return { ok: false, error: "user_failed" };
		}

		const orgs = await this.orgMemberships(user.login, tokens.accessToken);
		const claimed = await this.redeemClaim(options.claim);
		const owner = app.owner?.type === "User" && app.owner.id === user.id;
		const admin = this.hasNoAdmins() && (claimed || owner);

		await this.upsertUser(user, { orgs, tokens, admin });
		const result = await this.startSession(user.id);
		log.info("auth.signin", {
			login: user.login,
			user: user.id,
			admin: result.ok && result.session.admin,
			allowed: result.ok && result.session.allowed,
			orgs,
		});
		return result;
	}

	/**
	 * Sign in as a made-up user, without GitHub. Only for local development
	 * and tests: the Worker only routes here when `TACK_DEV_AUTH` is "1", and
	 * this checks again.
	 */
	async devSignIn(options: {
		login: string;
		name?: string | null;
		admin?: boolean;
		/** Add them to the allowlist too. */
		allow?: boolean;
		/** Allowlisted orgs to pretend they're a member of. */
		orgs?: string[];
	}): Promise<SignInResult> {
		if ((this.env as { TACK_DEV_AUTH?: string }).TACK_DEV_AUTH !== "1") {
			return { ok: false, error: "dev_auth_disabled" };
		}
		const login = normaliseLogins([options.login]).valid[0];
		if (!login) return { ok: false, error: "invalid_login" };
		const user: GitHubUser = {
			id: devUserId(login),
			login: options.login.trim().replace(/^@/, ""),
			name: options.name ?? null,
			avatar_url: `https://github.com/${login}.png?size=96`,
		};
		const access = this.accessList();
		if (options.allow && !access.users.includes(login)) {
			const users = [...access.users, login].sort();
			this.setSetting("access", JSON.stringify({ ...access, users }));
		}
		const orgs = normaliseLogins(options.orgs ?? []).valid.filter((org) =>
			access.orgs.includes(org),
		);
		await this.upsertUser(user, { orgs, tokens: null, admin: options.admin === true });
		log.info("auth.signin.dev", { login: user.login, user: user.id });
		return this.startSession(user.id);
	}

	/** Look up a session (by its raw id from the cookie) and whether access control is on. */
	async lookup(sessionId: string | null): Promise<Lookup> {
		const configured = this.isConfigured();
		if (!sessionId) return { configured, session: null };
		const row = this.sql
			.exec<UserRow>(
				`SELECT u.id, u.login, u.name, u.avatar_url, u.admin, u.orgs FROM sessions s
				JOIN users u ON u.id = s.user_id
				WHERE s.hash = ? AND s.expires_at > ?`,
				await sha256(sessionId),
				Date.now(),
			)
			.toArray()[0];
		return { configured, session: row ? this.sessionInfo(row) : null };
	}

	async signOut(sessionId: string): Promise<void> {
		this.sql.exec("DELETE FROM sessions WHERE hash = ?", await sha256(sessionId));
	}

	/** Start a session for a user. `ttl` is only shortened by tests. */
	async startSession(userId: number, ttl = SESSION_TTL): Promise<SignInResult> {
		const row = this.userRow(userId);
		if (!row) return { ok: false, error: "unknown_user" };
		const now = Date.now();
		this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
		const sessionId = randomToken();
		const expiresAt = now + ttl;
		this.sql.exec(
			"INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
			await sha256(sessionId),
			userId,
			now,
			expiresAt,
		);
		return { ok: true, sessionId, expiresAt, session: this.sessionInfo(row) };
	}

	/** Whether a user may use the instance right now. */
	canUse(userId: number): boolean {
		const row = this.userRow(userId);
		return row ? this.sessionInfo(row).allowed : false;
	}

	/** The user's own GitHub token, refreshed if it's about to expire. */
	async userToken(userId: number): Promise<string | null> {
		const tokens = await this.storedUserTokens(userId);
		if (!tokens) return null;
		if (tokens.expiresAt === null || tokens.expiresAt - Date.now() > REFRESH_MARGIN) {
			return tokens.accessToken;
		}

		let refreshing = this.refreshing.get(userId);
		if (!refreshing) {
			refreshing = this.refreshUserToken(userId, tokens).finally(() =>
				this.refreshing.delete(userId),
			);
			this.refreshing.set(userId, refreshing);
		}
		return refreshing;
	}

	private async refreshUserToken(userId: number, tokens: UserTokens): Promise<string | null> {
		const app = await this.app();
		const stillValid = tokens.expiresAt !== null && tokens.expiresAt > Date.now();
		if (
			!app ||
			!tokens.refreshToken ||
			(tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= Date.now())
		) {
			if (!stillValid) await this.storeUserTokens(userId, null);
			return stillValid ? tokens.accessToken : null;
		}
		try {
			const fresh = await refreshTokens({
				clientId: app.clientId,
				clientSecret: app.clientSecret,
				refreshToken: tokens.refreshToken,
			});
			await this.storeUserTokens(userId, fresh);
			return fresh.accessToken;
		} catch (error) {
			log.warn("auth.refresh.failed", { user: userId, error });
			// A rejected refresh token is dead for good; a network blip isn't.
			if (error instanceof OAuthError) {
				await this.storeUserTokens(userId, null);
				return null;
			}
			return stillValid ? tokens.accessToken : null;
		}
	}

	private async storedUserTokens(userId: number): Promise<UserTokens | null> {
		const row = this.sql
			.exec<{ tokens: string | null }>("SELECT tokens FROM users WHERE id = ?", userId)
			.toArray()[0];
		if (!row?.tokens) return null;
		return JSON.parse(await decrypt(this.secret, row.tokens, `user:${userId}`)) as UserTokens;
	}

	private async storeUserTokens(userId: number, tokens: UserTokens | null): Promise<void> {
		this.sql.exec(
			"UPDATE users SET tokens = ? WHERE id = ?",
			tokens ? await encrypt(this.secret, JSON.stringify(tokens), `user:${userId}`) : null,
			userId,
		);
	}

	private async upsertUser(
		user: GitHubUser,
		options: { orgs: string[]; tokens: UserTokens | null; admin: boolean },
	): Promise<void> {
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO users (id, login, name, avatar_url, admin, orgs, created_at, signed_in_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				login = excluded.login,
				name = excluded.name,
				avatar_url = excluded.avatar_url,
				admin = max(users.admin, excluded.admin),
				orgs = excluded.orgs,
				signed_in_at = excluded.signed_in_at`,
			user.id,
			user.login,
			user.name,
			user.avatar_url,
			options.admin ? 1 : 0,
			JSON.stringify(options.orgs),
			now,
			now,
		);
		await this.storeUserTokens(user.id, options.tokens);
	}

	private userRow(userId: number): UserRow | undefined {
		return this.sql
			.exec<UserRow>(
				"SELECT id, login, name, avatar_url, admin, orgs FROM users WHERE id = ?",
				userId,
			)
			.toArray()[0];
	}

	private sessionInfo(row: UserRow): SessionInfo {
		const admin = row.admin === 1;
		const access = this.accessList();
		const orgs = JSON.parse(row.orgs) as string[];
		const allowed =
			admin ||
			access.users.includes(row.login.toLowerCase()) ||
			orgs.some((org) => access.orgs.includes(org));
		return { viewer: toViewer(row), admin, allowed };
	}

	private hasNoAdmins(): boolean {
		return this.sql.exec("SELECT 1 FROM users WHERE admin = 1 LIMIT 1").toArray().length === 0;
	}

	private async redeemClaim(claim: string | null): Promise<boolean> {
		const stored = this.setting("admin_claim");
		if (!claim || !stored) return false;
		const { hash, expiresAt } = JSON.parse(stored) as { hash: string; expiresAt: number };
		if (expiresAt <= Date.now() || hash !== (await sha256(claim))) return false;
		this.setSetting("admin_claim", null);
		return true;
	}

	/**
	 * Which allowlisted orgs the user belongs to. Private membership is only
	 * visible through an installation on the org (with Members permission)
	 * or the user's own token; public membership is visible to anyone.
	 */
	private async orgMemberships(login: string, userToken: string): Promise<string[]> {
		const checks = await Promise.all(
			this.accessList().orgs.map(async (org) => {
				const installation = this.sql
					.exec<{ id: number }>(
						"SELECT id FROM installations WHERE account = ? AND suspended = 0",
						org,
					)
					.toArray()[0];
				const attempts: (() => Promise<Response>)[] = [
					...(installation
						? [
								async () =>
									gh(`/orgs/${org}/members/${login}`, {
										auth: `Bearer ${(await this.installationToken(installation.id)).token}`,
										redirect: "manual",
									}),
							]
						: []),
					() =>
						gh(`/orgs/${org}/members/${login}`, {
							auth: `Bearer ${userToken}`,
							redirect: "manual",
						}),
					() => gh(`/orgs/${org}/public_members/${login}`),
				];
				for (const attempt of attempts) {
					try {
						if ((await attempt()).status === 204) return org;
					} catch (error) {
						log.warn("auth.orgcheck.failed", { login, org, error });
					}
				}
				return null;
			}),
		);
		return checks.filter((org): org is string => org !== null);
	}

	// ---------------------------------------------------------------------
	// Access

	private accessList(): AccessList {
		const stored = this.setting("access");
		return stored ? (JSON.parse(stored) as AccessList) : { users: [], orgs: [] };
	}

	accessSettings(): AccessSettings {
		const admins = this.sql
			.exec<UserRow>(
				"SELECT id, login, name, avatar_url, admin, orgs FROM users WHERE admin = 1 ORDER BY lower(login)",
			)
			.toArray()
			.map(toViewer);
		return { ...this.accessList(), admins };
	}

	/**
	 * Replace the allowlist and the set of admins. Admins are named by login
	 * and must have signed in at least once, so they're tied to a GitHub id.
	 */
	updateAccess(update: AccessUpdateRequest): AccessUpdateResponse {
		const users = normaliseLogins(update.users);
		const orgs = normaliseLogins(update.orgs);
		const admins = normaliseLogins(update.admins);
		const invalid = [...users.invalid, ...orgs.invalid, ...admins.invalid];
		if (invalid.length > 0) return { ok: false, error: "invalid_login", logins: invalid };
		if (admins.valid.length === 0) return { ok: false, error: "no_admins", logins: [] };

		const ids = new Map<string, number>();
		for (const login of admins.valid) {
			const row = this.sql
				.exec<{ id: number }>(
					"SELECT id FROM users WHERE lower(login) = ? ORDER BY signed_in_at DESC LIMIT 1",
					login,
				)
				.toArray()[0];
			if (row) ids.set(login, row.id);
		}
		const unknown = admins.valid.filter((login) => !ids.has(login));
		if (unknown.length > 0) return { ok: false, error: "unknown_admins", logins: unknown };

		this.ctx.storage.transactionSync(() => {
			this.setSetting("access", JSON.stringify({ users: users.valid, orgs: orgs.valid }));
			this.sql.exec("UPDATE users SET admin = 0");
			for (const id of ids.values()) this.sql.exec("UPDATE users SET admin = 1 WHERE id = ?", id);
		});
		log.info("access.updated", {
			users: users.valid.length,
			orgs: orgs.valid,
			admins: admins.valid,
		});
		return { ok: true, access: this.accessSettings() };
	}
}

function toViewer(row: UserRow): Viewer {
	return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}
