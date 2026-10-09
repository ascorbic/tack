// GitHub App user authorization: the OAuth web flow with state and PKCE,
// and refresh-token rotation for expiring user-to-server tokens.

import { WEB } from "../github/api.ts";
import { base64url, randomToken } from "./crypto.ts";

export interface UserTokens {
	accessToken: string;
	/** Milliseconds since the epoch, or null if the token doesn't expire. */
	expiresAt: number | null;
	refreshToken: string | null;
	refreshExpiresAt: number | null;
}

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	refresh_token_expires_in?: number;
	error?: string;
	error_description?: string;
}

export class OAuthError extends Error {
	constructor(readonly code: string) {
		super(`GitHub OAuth error: ${code}`);
		this.name = "OAuthError";
	}
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = randomToken(32);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
}): string {
	const url = new URL(`${WEB}/login/oauth/authorize`);
	url.searchParams.set("client_id", options.clientId);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("state", options.state);
	url.searchParams.set("code_challenge", options.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	// No scopes: GitHub App user tokens take their permissions from the app.
	url.searchParams.set("allow_signup", "false");
	return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<UserTokens> {
	const response = await fetch(`${WEB}/login/oauth/access_token`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": "tack",
		},
		body: new URLSearchParams(params),
	});
	// GitHub reports OAuth errors with a 200 and an `error` field.
	const body = await response.json<TokenResponse>().catch(() => ({}) as TokenResponse);
	if (!response.ok || body.error || !body.access_token) {
		throw new OAuthError(body.error ?? `http_${response.status}`);
	}
	const now = Date.now();
	return {
		accessToken: body.access_token,
		expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
		refreshToken: body.refresh_token ?? null,
		refreshExpiresAt: body.refresh_token_expires_in
			? now + body.refresh_token_expires_in * 1000
			: null,
	};
}

export function exchangeCode(options: {
	clientId: string;
	clientSecret: string;
	code: string;
	verifier: string;
	redirectUri: string;
}): Promise<UserTokens> {
	return tokenRequest({
		client_id: options.clientId,
		client_secret: options.clientSecret,
		code: options.code,
		code_verifier: options.verifier,
		redirect_uri: options.redirectUri,
	});
}

/** Refresh a user token. GitHub rotates the refresh token every time. */
export function refreshTokens(options: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<UserTokens> {
	return tokenRequest({
		client_id: options.clientId,
		client_secret: options.clientSecret,
		grant_type: "refresh_token",
		refresh_token: options.refreshToken,
	});
}
