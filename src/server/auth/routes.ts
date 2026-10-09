// Sign-in routes: `/auth/*` and `/api/me`.
//
//   GET  /auth/signin?return_to=   start GitHub sign-in
//   GET  /auth/callback            GitHub sends people back here
//   POST /auth/signout             end the session
//   GET  /auth/dev?login=          fake sign-in, local development only
//                                  (also: name, admin=1, allow=1, orgs=a,b, return_to)
//   GET  /api/me                   who's signed in, and what they can do

import type { Me } from "../../shared/auth.ts";
import { log } from "../log.ts";
import { instance } from "../namespaces.ts";
import { clearCookie, readCookie, serializeCookie } from "./cookies.ts";
import { randomToken, sign, unsign } from "./crypto.ts";
import { isCrossSite, isLoopback, json, redirect, safeReturnTo } from "./http.ts";
import { authorizeUrl, pkcePair } from "./oauth.ts";
import { clearSessionCookie, lookupRequest, sessionCookie, sessionId } from "./session.ts";

const OAUTH_COOKIE = "tack_oauth";
/** Set by `/setup/callback`: whoever holds it becomes the first admin. */
export const CLAIM_COOKIE = "tack_claim";

interface OAuthState {
	state: string;
	verifier: string;
	returnTo: string;
}

/**
 * Fake sign-in is for local development and tests only: it needs
 * `TACK_DEV_AUTH=1` (only ever declared in dev) and a loopback host.
 */
export function devAuthEnabled(request: Request, env: Env): boolean {
	return (
		(env as { TACK_DEV_AUTH?: string }).TACK_DEV_AUTH === "1" &&
		Boolean(env.TACK_SECRET) &&
		isLoopback(request)
	);
}

function signInError(error: string, returnTo = "/"): Response {
	log.warn("auth.signin.failed", { reason: error });
	const params = new URLSearchParams({ error, return_to: returnTo });
	return redirect(`/signin?${params.toString()}`);
}

export async function handleAuth(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const route = `${request.method} ${url.pathname}`;
	switch (route) {
		case "GET /api/me":
			return me(request, env);
		case "GET /auth/signin":
			return signIn(request, env, safeReturnTo(url.searchParams.get("return_to")));
		case "GET /auth/callback":
			return callback(request, env, url);
		case "POST /auth/signout":
			return signOut(request, env);
		case "GET /auth/dev":
			return devSignIn(request, env, url);
	}
	if (url.pathname.startsWith("/auth/")) return new Response("Not found", { status: 404 });
	return null;
}

async function me(request: Request, env: Env): Promise<Response> {
	const devAuth = devAuthEnabled(request, env);
	if (!env.TACK_SECRET) {
		return json({
			viewer: null,
			admin: false,
			allowed: true,
			signIn: "unavailable",
			devAuth,
		} satisfies Me);
	}
	const { configured, session } = await lookupRequest(request, env);
	return json({
		viewer: session?.viewer ?? null,
		admin: session?.admin ?? false,
		allowed: !configured || (session?.allowed ?? false),
		signIn: configured ? "ready" : "unconfigured",
		devAuth,
	} satisfies Me);
}

async function signIn(request: Request, env: Env, returnTo: string): Promise<Response> {
	const secret = env.TACK_SECRET;
	if (!secret) return signInError("unavailable", returnTo);
	const app = await instance(env).appInfo();
	if (!app) return redirect("/setup");

	const { verifier, challenge } = await pkcePair();
	const state = randomToken(16);
	const cookie = serializeCookie(
		request,
		OAUTH_COOKIE,
		await sign<OAuthState>(secret, "oauth", { state, verifier, returnTo }, 600),
		{ maxAge: 600, path: "/auth/" },
	);
	const redirectUri = `${new URL(request.url).origin}/auth/callback`;
	return redirect(authorizeUrl({ clientId: app.clientId, redirectUri, state, challenge }), [
		cookie,
	]);
}

async function callback(request: Request, env: Env, url: URL): Promise<Response> {
	const secret = env.TACK_SECRET;
	if (!secret) return signInError("unavailable");
	const saved = await unsign<OAuthState>(secret, "oauth", readCookie(request, OAUTH_COOKIE));
	const returnTo = saved?.returnTo ?? "/";
	if (url.searchParams.get("error") === "access_denied") return signInError("denied", returnTo);

	const code = url.searchParams.get("code");
	if (!saved || !code || url.searchParams.get("state") !== saved.state) {
		return signInError("state", returnTo);
	}

	const claim = await unsign<string>(secret, "claim", readCookie(request, CLAIM_COOKIE));
	const result = await instance(env).signIn({
		code,
		verifier: saved.verifier,
		redirectUri: `${url.origin}/auth/callback`,
		claim,
	});
	if (!result.ok) return signInError(result.error, returnTo);

	return redirect(returnTo, [
		await sessionCookie(request, secret, result.sessionId),
		clearCookie(request, OAUTH_COOKIE, "/auth/"),
		...(claim ? [clearCookie(request, CLAIM_COOKIE, "/auth/")] : []),
	]);
}

async function signOut(request: Request, env: Env): Promise<Response> {
	if (isCrossSite(request)) {
		log.warn("auth.rejected", { path: "/auth/signout" });
		return new Response("Forbidden", { status: 403 });
	}
	const id = await sessionId(request, env);
	if (id) {
		await instance(env).signOut(id);
		log.info("auth.signout");
	}
	const cookie = clearSessionCookie(request);
	if (request.headers.get("accept")?.includes("application/json")) {
		return json({ ok: true }, { headers: { "set-cookie": cookie } });
	}
	return redirect("/", [cookie], 303);
}

async function devSignIn(request: Request, env: Env, url: URL): Promise<Response> {
	const secret = env.TACK_SECRET;
	// Indistinguishable from a route that doesn't exist.
	if (!secret || !devAuthEnabled(request, env)) return new Response("Not found", { status: 404 });

	const login = url.searchParams.get("login");
	if (!login) return json({ error: "login is required" }, { status: 400 });
	const result = await instance(env).devSignIn({
		login,
		name: url.searchParams.get("name"),
		admin: url.searchParams.get("admin") === "1",
		allow: url.searchParams.get("allow") === "1",
		orgs: url.searchParams.get("orgs")?.split(",") ?? [],
	});
	if (!result.ok) return json({ error: result.error }, { status: 400 });
	return redirect(safeReturnTo(url.searchParams.get("return_to")), [
		await sessionCookie(request, secret, result.sessionId),
	]);
}
