// First-run setup and instance settings.
//
//   GET /api/setup            the setup page's state (and a manifest, before setup)
//   PUT /api/setup/access     admins: replace the allowlist and admins
//   GET /setup/callback       GitHub sends the new app's code here
//   GET /setup/installed      GitHub sends people here after installing the app
//   GET /setup/install        off to GitHub to install the app (from a card that
//                             isn't live), returning to `state`, a board path
//
// The `/setup` page itself is client-side.

import * as v from "valibot";
import type { SetupInfo } from "../../shared/auth.ts";
import { clearCookie, readCookie, serializeCookie } from "../auth/cookies.ts";
import { randomToken, sign, unsign } from "../auth/crypto.ts";
import { isCrossSite, json, redirect, safeReturnTo } from "../auth/http.ts";
import { CLAIM_COOKIE } from "../auth/routes.ts";
import { lookupRequest } from "../auth/session.ts";
import { log } from "../log.ts";
import { instance } from "../namespaces.ts";
import { appManifest } from "./app.ts";

const SETUP_COOKIE = "tack_setup";
const SETUP_TTL = 60 * 60;
const CLAIM_TTL = 24 * 60 * 60;

const Logins = v.pipe(v.array(v.pipe(v.string(), v.maxLength(100))), v.maxLength(1000));
const AccessBody = v.object({ users: Logins, orgs: Logins, admins: Logins });

export async function handleSetup(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	switch (`${request.method} ${url.pathname}`) {
		case "GET /api/setup":
			return setupInfo(request, env);
		case "PUT /api/setup/access":
			return updateAccess(request, env);
		case "GET /setup/callback":
			return setupCallback(request, env, url);
		case "GET /setup/installed":
			return installed(env, url);
		case "GET /setup/install":
			return install(env, url);
	}
	return null;
}

/**
 * `GET /setup/install?state=/b/…`: off to GitHub to install the app, from a
 * card that isn't live (#9). GitHub hands `state` back to `/setup/installed`,
 * which returns to the board.
 */
async function install(env: Env, url: URL): Promise<Response> {
	const app = env.TACK_SECRET ? await instance(env).appInfo() : null;
	if (!app) return redirect("/setup");
	const target = new URL(`https://github.com/apps/${app.slug}/installations/new`);
	const state = safeReturnTo(url.searchParams.get("state"), "");
	if (state) target.searchParams.set("state", state);
	return redirect(target.toString());
}

async function setupInfo(request: Request, env: Env): Promise<Response> {
	const secret = env.TACK_SECRET;
	if (!secret) return json({ status: "unavailable" } satisfies SetupInfo);

	const app = await instance(env).appInfo();
	if (!app) {
		const state = randomToken(16);
		const cookie = serializeCookie(
			request,
			SETUP_COOKIE,
			await sign(secret, "setup", state, SETUP_TTL),
			{ maxAge: SETUP_TTL, path: "/setup/" },
		);
		return json(
			{
				status: "unconfigured",
				state,
				manifest: appManifest(new URL(request.url).origin),
			} satisfies SetupInfo,
			{ headers: { "set-cookie": cookie } },
		);
	}

	const { session } = await lookupRequest(request, env);
	const admin = session?.admin ?? false;
	return json({
		status: "configured",
		app: {
			name: app.name,
			slug: app.slug,
			htmlUrl: app.htmlUrl,
			installUrl: `https://github.com/apps/${app.slug}/installations/new`,
		},
		viewer: session?.viewer ?? null,
		admin,
		access: admin ? await instance(env).accessSettings() : null,
	} satisfies SetupInfo);
}

async function updateAccess(request: Request, env: Env): Promise<Response> {
	if (isCrossSite(request)) return json({ error: "forbidden" }, { status: 403 });
	const { session } = await lookupRequest(request, env);
	if (!session?.admin) {
		log.warn("access.denied", { path: "/api/setup/access", login: session?.viewer.login });
		return json({ error: "forbidden" }, { status: 403 });
	}

	const body = v.safeParse(AccessBody, await request.json().catch(() => null));
	if (!body.success) return json({ error: "invalid_body" }, { status: 400 });
	const result = await instance(env).updateAccess(body.output);
	return json(result, { status: result.ok ? 200 : 422 });
}

async function setupCallback(request: Request, env: Env, url: URL): Promise<Response> {
	const secret = env.TACK_SECRET;
	if (!secret) return redirect("/setup");
	const expected = await unsign<string>(secret, "setup", readCookie(request, SETUP_COOKIE));
	const code = url.searchParams.get("code");
	if (!expected || !code || url.searchParams.get("state") !== expected) {
		log.warn("setup.failed", { reason: "state" });
		return redirect("/setup?error=state");
	}

	const result = await instance(env).completeSetup(code);
	if (!result.ok) return redirect(`/setup?error=${result.error}`);

	// Sign straight in with the new app; holding the claim makes this person the admin.
	const claim = serializeCookie(
		request,
		CLAIM_COOKIE,
		await sign(secret, "claim", result.claim, CLAIM_TTL),
		{ maxAge: CLAIM_TTL, path: "/auth/" },
	);
	return redirect(`/auth/signin?return_to=${encodeURIComponent("/setup?created=1")}`, [
		claim,
		clearCookie(request, SETUP_COOKIE, "/setup/"),
	]);
}

async function installed(env: Env, url: URL): Promise<Response> {
	const id = Number(url.searchParams.get("installation_id"));
	if (env.TACK_SECRET && Number.isSafeInteger(id) && id > 0) {
		await instance(env).installationCompleted(id);
	}
	// The install flow from a board passes the board's path as `state`.
	const action = url.searchParams.get("setup_action") === "request" ? "requested" : "1";
	return redirect(safeReturnTo(url.searchParams.get("state"), `/setup?installed=${action}`));
}
