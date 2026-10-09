// A fake GitHub for integration tests, served to the Worker through
// Miniflare's `outboundService`: app manifest conversion, the OAuth web flow
// (with PKCE and refresh-token rotation), users and org membership, and
// installation tokens minted against app JWTs that it really verifies.

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

	/** Forget every refresh token, as when people revoke the app. */
	revokeRefreshTokens(): void {
		this.refreshTokens.clear();
	}

	readonly fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		this.log.push(`${request.method} ${url.origin}${url.pathname}`);
		try {
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

		if ((match = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path))) {
			const repo = match[1] ?? "";
			const issue = this.issues.get(`${repo}#${match[2]}`);
			const installation = this.installationForRepo(repo);
			const tokenInstallation = auth ? this.installationTokens.get(auth) : undefined;
			if (!issue || !installation || tokenInstallation !== installation.id) return undefined;
			return json({
				number: Number(match[2]),
				title: issue.title,
				state: "open",
				html_url: `https://github.com/${repo}/issues/${match[2]}`,
				updated_at: "2026-10-01T00:00:00Z",
			});
		}

		return undefined;
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
