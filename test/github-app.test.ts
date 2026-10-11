// A fresh instance, end to end against a fake GitHub: create the app from
// its manifest, sign in, mint installation tokens, and enforce access.

import type { Miniflare, Response } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import type { AccessUpdateResponse, Me, SetupInfo } from "../src/shared/auth.ts";
import { appName } from "../src/server/github/app.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, repoStub, startWorker } from "./harness.ts";

const ORIGIN = "https://tack.test";

const github = new FakeGitHub();
let mf: Miniflare;
beforeAll(() => {
	mf = startWorker({ outboundService: github.fetch });
});
afterAll(() => mf.dispose());

function user(id: number, login: string): FakeUser {
	return { id, login, name: null, avatar_url: `https://avatars.example/${id}` };
}

const ADMIN = { ...user(100, "Octo-Admin"), name: "Octo Admin" };
const MALLORY = user(200, "mallory");
const EVE = user(300, "eve");
const TRENT = user(400, "trent");

/** Cookies from a response's Set-Cookie headers, as a `name=value` map. */
function cookies(response: Response): Record<string, string> {
	const jar: Record<string, string> = {};
	for (const header of response.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const eq = pair.indexOf("=");
		jar[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return jar;
}

function cookieHeader(jar: Record<string, string>): string {
	return Object.entries(jar)
		.filter(([, value]) => value)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function get(path: string, jar: Record<string, string> = {}) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		headers: { cookie: cookieHeader(jar) },
		redirect: "manual",
	});
}

/** Go through GitHub sign-in as `who`, returning the session cookie jar. */
async function signInWithGitHub(who: FakeUser, jar: Record<string, string> = {}) {
	const start = await get("/auth/signin?return_to=/b/1/plan", jar);
	expect(start.status).toBe(302);
	const callbackUrl = new URL(github.authorize(start.headers.get("location") ?? "", who));
	const done = await get(callbackUrl.pathname + callbackUrl.search, { ...jar, ...cookies(start) });
	expect(done.status).toBe(302);
	return { response: done, jar: { tack_session: cookies(done).tack_session ?? "" } };
}

async function me(jar: Record<string, string>): Promise<Me> {
	return (await get("/api/me", jar)).json() as Promise<Me>;
}

function connect(jar: Record<string, string> = {}) {
	return mf.dispatchFetch(`${ORIGIN}/parties/board/plan`, {
		headers: { upgrade: "websocket", cookie: cookieHeader(jar) },
	});
}

function putAccess(jar: Record<string, string>, body: unknown, origin = ORIGIN) {
	return mf.dispatchFetch(`${ORIGIN}/api/setup/access`, {
		method: "PUT",
		headers: { cookie: cookieHeader(jar), origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function deliver(event: string, payload: unknown, secret: string) {
	const body = JSON.stringify(payload);
	return mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign(secret, body),
		},
	});
}

let admin: Record<string, string> = {};

describe("setup", () => {
	it("acknowledges GitHub's first ping, sent before the app's secret is saved", async () => {
		// A fresh deploy: no app yet, and no hand-set webhook secret.
		const fresh = startWorker({ bindings: { GITHUB_WEBHOOK_SECRET: "" } });
		try {
			const body = JSON.stringify({ zen: "Keep it logically awesome." });
			const response = await fresh.dispatchFetch(`${ORIGIN}/webhooks/github`, {
				method: "POST",
				body,
				headers: {
					"x-github-event": "ping",
					"x-github-delivery": crypto.randomUUID(),
					"x-hub-signature-256": await sign("not-saved-yet", body),
				},
			});
			expect(response.status).toBe(202);
		} finally {
			await fresh.dispose();
		}
	});

	it("offers a manifest for a fresh instance", async () => {
		const response = await get("/api/setup");
		const info = (await response.json()) as SetupInfo;
		if (info.status !== "unconfigured") throw new Error(`Unexpected ${info.status}`);
		expect(info.manifest).toMatchObject({
			url: ORIGIN,
			hook_attributes: { url: `${ORIGIN}/webhooks/github`, active: true },
			redirect_url: `${ORIGIN}/setup/callback`,
			callback_urls: [`${ORIGIN}/auth/callback`],
			setup_url: `${ORIGIN}/setup/installed`,
			public: false,
			default_permissions: {
				issues: "write",
				pull_requests: "write",
				metadata: "read",
				contents: "write",
				checks: "read",
				statuses: "read",
				discussions: "write",
			},
		});
		expect(info.manifest.default_events).toEqual(
			expect.arrayContaining([
				"issues",
				"issue_comment",
				"pull_request",
				"pull_request_review",
				"check_run",
				"check_suite",
				"status",
				"workflow_run",
				"discussion",
				"repository",
			]),
		);
		expect(cookies(response).tack_setup).toBeTruthy();
	});

	it("rejects a callback without the matching state", async () => {
		await get("/api/setup");
		const response = await get(`/setup/callback?code=${github.manifestCode}&state=forged`);
		expect(response.headers.get("location")).toBe("/setup?error=state");
		expect(await (await instanceStub(mf)).isConfigured()).toBe(false);
	});

	it("leaves boards open until the app exists", async () => {
		// A guest can adopt a board from before the index, which stays open to the instance.
		const claim = await mf.dispatchFetch(`${ORIGIN}/api/boards/legacy`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ name: "plan" }),
		});
		expect(claim.status).toBe(200);
		expect((await connect()).status).toBe(101);
	});

	it("creates the app, and makes its creator the admin", async () => {
		const setup = await get("/api/setup");
		const { state } = (await setup.json()) as { state: string };
		const callback = await get(
			`/setup/callback?code=${github.manifestCode}&state=${state}`,
			cookies(setup),
		);
		expect(callback.headers.get("location")).toBe("/auth/signin?return_to=%2Fsetup%3Fcreated%3D1");
		expect(github.log).toContain(
			`POST https://api.github.com/app-manifests/${github.manifestCode}/conversions`,
		);
		const claim = cookies(callback);
		expect(claim.tack_claim).toBeTruthy();

		// Straight into sign-in with the new app, carrying the claim.
		const start = await get("/auth/signin?return_to=%2Fsetup%3Fcreated%3D1", claim);
		const authorize = new URL(start.headers.get("location") ?? "");
		expect(authorize.searchParams.get("client_id")).toBe(github.app.client_id);
		expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
		expect(authorize.searchParams.get("code_challenge")).toBeTruthy();

		const back = new URL(github.authorize(authorize.toString(), ADMIN));
		const done = await get(back.pathname + back.search, { ...claim, ...cookies(start) });
		expect(done.headers.get("location")).toBe("/setup?created=1");
		admin = { tack_session: cookies(done).tack_session ?? "" };

		expect(await me(admin)).toEqual({
			viewer: {
				id: ADMIN.id,
				login: "Octo-Admin",
				name: "Octo Admin",
				avatarUrl: ADMIN.avatar_url,
			},
			admin: true,
			allowed: true,
			signIn: "ready",
			devAuth: false,
		});
	});

	it("stores the app's credentials encrypted", async () => {
		const info = await (await instanceStub(mf)).appInfo();
		expect(info).toEqual({
			id: github.app.id,
			slug: github.app.slug,
			name: github.app.name,
			clientId: github.app.client_id,
			htmlUrl: github.app.html_url,
		});
	});

	it("can't be run twice", async () => {
		const instance = await instanceStub(mf);
		expect(await instance.completeSetup(github.manifestCode)).toEqual({
			ok: false,
			error: "already_configured",
		});
		const info = (await (await get("/api/setup", admin)).json()) as SetupInfo;
		expect(info).toMatchObject({
			status: "configured",
			app: { slug: "tack-test", installUrl: "https://github.com/apps/tack-test/installations/new" },
			admin: true,
			access: { users: [], orgs: [], admins: [{ login: "Octo-Admin" }] },
		});
	});
});

describe("sign-in", () => {
	it("rejects a callback whose state doesn't match", async () => {
		const start = await get("/auth/signin");
		const back = new URL(github.authorize(start.headers.get("location") ?? "", ADMIN));
		back.searchParams.set("state", "forged");
		const done = await get(back.pathname + back.search, cookies(start));
		expect(done.headers.get("location")).toBe("/signin?error=state&return_to=%2F");
		expect(cookies(done).tack_session).toBeUndefined();
	});

	it("rejects a code without the PKCE verifier that started it", async () => {
		const first = await get("/auth/signin");
		const second = await get("/auth/signin");
		// GitHub's code is bound to the first sign-in's challenge.
		const back = new URL(github.authorize(first.headers.get("location") ?? "", ADMIN));
		const secondState = new URL(second.headers.get("location") ?? "").searchParams.get("state");
		back.searchParams.set("state", secondState ?? "");
		const done = await get(back.pathname + back.search, cookies(second));
		expect(done.headers.get("location")).toBe("/signin?error=invalid_grant&return_to=%2F");
	});

	it("handles people declining on GitHub", async () => {
		const start = await get("/auth/signin?return_to=/b/1");
		const done = await get("/auth/callback?error=access_denied&state=x", cookies(start));
		expect(done.headers.get("location")).toBe("/signin?error=denied&return_to=%2Fb%2F1");
	});

	it("refreshes expiring user tokens, rotating the refresh token", async () => {
		const instance = await instanceStub(mf);
		github.userTokenTtl = 60;
		const { jar } = await signInWithGitHub(user(500, "refresher"));
		github.userTokenTtl = 8 * 60 * 60;
		expect((await me(jar)).viewer?.login).toBe("refresher");

		const exchanges = () =>
			github.log.filter((line) => line.endsWith("/login/oauth/access_token")).length;
		const before = exchanges();
		// Inside the five-minute margin, so this refreshes.
		const first = await instance.userToken(500);
		expect(first).toMatch(/^ghu_/);
		expect(exchanges()).toBe(before + 1);
		// Fresh for eight hours now: no more refreshes.
		expect(await instance.userToken(500)).toBe(first);
		expect(exchanges()).toBe(before + 1);
	});

	it("drops tokens GitHub has revoked", async () => {
		const instance = await instanceStub(mf);
		github.userTokenTtl = 60;
		await signInWithGitHub(user(600, "revoked"));
		github.userTokenTtl = 8 * 60 * 60;
		github.revokeRefreshTokens();
		expect(await instance.userToken(600)).toBeNull();
		expect(await instance.userToken(600)).toBeNull();
	});
});

describe("installation tokens", () => {
	it("verifies webhooks with the app's stored secret, or the configured one", async () => {
		expect((await deliver("ping", {}, github.app.webhook_secret)).status).toBe(200);
		expect((await deliver("ping", {}, "test-secret")).status).toBe(200);
		expect((await deliver("ping", {}, "wrong")).status).toBe(401);
	});

	it("maps repositories from installation events, and mints tokens for them", async () => {
		github.installations.set(11, { account: "acme", repos: ["acme/secret"] });
		github.issues.set("acme/secret#1", { title: "Secret plans" });
		const response = await deliver(
			"installation",
			{
				action: "created",
				installation: { id: 11, account: { login: "acme" }, repository_selection: "selected" },
				repositories: [{ full_name: "acme/secret" }],
			},
			github.app.webhook_secret,
		);
		expect(response.status).toBe(202);

		const repo = await repoStub(mf, "github.com/acme/secret");
		const [card] = await repo.subscribe("board-1", ["github.com/acme/secret#1"]);
		expect(card).toMatchObject({ title: "Secret plans", state: "open" });
		expect(github.minted.map((minted) => minted.installation)).toEqual([11]);
		// Mapped by the webhook, so no lookup was needed.
		expect(github.log).not.toContain("GET https://api.github.com/repos/acme/secret/installation");
	});

	it("reuses tokens until they're close to expiry", async () => {
		const instance = await instanceStub(mf);
		const first = await instance.repoToken("acme/secret");
		const second = await instance.repoToken("ACME/Secret");
		expect(first?.token).toBe(github.minted[0]?.token);
		expect(second?.token).toBe(first?.token);
		expect(github.minted).toHaveLength(1);
	});

	it("looks up repositories it hasn't heard about", async () => {
		github.installations.set(12, { account: "globex", repos: ["globex/vault"] });
		github.issues.set("globex/vault#7", { title: "Vault door" });
		const repo = await repoStub(mf, "github.com/globex/vault");
		const [card] = await repo.subscribe("board-1", ["github.com/globex/vault#7"]);
		expect(card).toMatchObject({ title: "Vault door" });
		expect(github.log).toContain("GET https://api.github.com/repos/globex/vault/installation");
		expect(await (await instanceStub(mf)).isInstalled("globex/vault")).toBe(true);
	});

	it("remembers repositories without the app, for a while", async () => {
		const instance = await instanceStub(mf);
		expect(await instance.repoToken("someone/public")).toBeNull();
		expect(await instance.repoToken("someone/public")).toBeNull();
		const lookups = github.log.filter((line) =>
			line.endsWith("/repos/someone/public/installation"),
		);
		expect(lookups).toHaveLength(1);
	});

	it("forgets repositories removed from an installation", async () => {
		await deliver(
			"installation_repositories",
			{
				action: "removed",
				installation: { id: 11, account: { login: "acme" }, repository_selection: "selected" },
				repositories_removed: [{ full_name: "acme/secret" }],
			},
			github.app.webhook_secret,
		);
		expect(await (await instanceStub(mf)).isInstalled("acme/secret")).toBe(false);
	});

	it("forgets deleted installations", async () => {
		await deliver(
			"installation",
			{ action: "deleted", installation: { id: 12, account: { login: "globex" } } },
			github.app.webhook_secret,
		);
		github.installations.delete(12);
		expect(await (await instanceStub(mf)).repoToken("globex/vault")).toBeNull();
	});

	it("syncs an installation when GitHub sends someone back from installing", async () => {
		github.installations.set(13, { account: "initech", repos: ["initech/tps"] });
		const response = await get("/setup/installed?installation_id=13&setup_action=install");
		expect(response.headers.get("location")).toBe("/setup?installed=1");
		const instance = await instanceStub(mf);
		expect(await instance.isInstalled("initech/tps")).toBe(true);
		expect(github.log).not.toContain("GET https://api.github.com/repos/initech/tps/installation");

		const back = await get("/setup/installed?installation_id=13&state=%2Fb%2F9%2Froadmap");
		expect(back.headers.get("location")).toBe("/b/9/roadmap");
		const evil = await get("/setup/installed?installation_id=13&state=%2F%2Fevil.example");
		expect(evil.headers.get("location")).toBe("/setup?installed=1");
	});

	it("signs app JWTs GitHub accepts", async () => {
		// The fake verifies every JWT against the app's public key.
		const jwt = await (await instanceStub(mf)).appJwt();
		expect(jwt?.split(".")).toHaveLength(3);
	});
});

describe("access control", () => {
	let mallory: Record<string, string> = {};

	it("signs in people outside the allowlist, but doesn't let them in", async () => {
		({ jar: mallory } = await signInWithGitHub(MALLORY));
		expect(await me(mallory)).toMatchObject({
			viewer: { login: "mallory" },
			admin: false,
			allowed: false,
		});
	});

	it("turns away board connections from anyone not allowed", async () => {
		expect((await connect()).status).toBe(401);
		expect((await connect(mallory)).status).toBe(403);
		const allowed = await connect(admin);
		expect(allowed.status).toBe(101);
		allowed.webSocket?.accept();
		allowed.webSocket?.close();
	});

	it("only lets admins change access", async () => {
		const update = { users: ["mallory"], orgs: [], admins: ["octo-admin"] };
		expect((await putAccess(mallory, update)).status).toBe(403);
		expect((await putAccess({}, update)).status).toBe(403);
		expect((await putAccess(admin, update, "https://evil.example")).status).toBe(403);
		expect(await me(mallory)).toMatchObject({ allowed: false });
	});

	it("lets people in as soon as an admin adds them", async () => {
		const response = await putAccess(admin, {
			users: ["@Mallory", "mallory"],
			orgs: [],
			admins: ["octo-admin"],
		});
		const result = (await response.json()) as AccessUpdateResponse;
		expect(result).toMatchObject({ ok: true, access: { users: ["mallory"], orgs: [] } });
		expect(await me(mallory)).toMatchObject({ allowed: true });
		expect((await connect(mallory)).status).toBe(101);
	});

	it("validates logins and admins", async () => {
		const invalid = await putAccess(admin, {
			users: ["not a login"],
			orgs: [],
			admins: ["octo-admin"],
		});
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toEqual({
			ok: false,
			error: "invalid_login",
			logins: ["not a login"],
		});

		const unknown = await putAccess(admin, {
			users: [],
			orgs: [],
			admins: ["octo-admin", "ghost"],
		});
		expect(await unknown.json()).toEqual({ ok: false, error: "unknown_admins", logins: ["ghost"] });

		const none = await putAccess(admin, { users: [], orgs: [], admins: [] });
		expect(await none.json()).toMatchObject({ ok: false, error: "no_admins" });

		const garbage = await putAccess(admin, { users: "mallory" });
		expect(garbage.status).toBe(400);
	});

	it("checks org membership at sign-in", async () => {
		github.orgMembers.set("acme", new Set(["eve"]));
		await putAccess(admin, { users: ["mallory"], orgs: ["acme"], admins: ["octo-admin"] });

		const { jar: eve } = await signInWithGitHub(EVE);
		expect(await me(eve)).toMatchObject({ viewer: { login: "eve" }, allowed: true });
		const { jar: trent } = await signInWithGitHub(TRENT);
		expect(await me(trent)).toMatchObject({ viewer: { login: "trent" }, allowed: false });
	});

	it("can promote someone who has signed in to admin", async () => {
		const response = await putAccess(admin, {
			users: ["mallory"],
			orgs: ["acme"],
			admins: ["octo-admin", "mallory"],
		});
		expect(await response.json()).toMatchObject({
			ok: true,
			access: { admins: [{ login: "mallory" }, { login: "Octo-Admin" }] },
		});
		expect(await me(mallory)).toMatchObject({ admin: true });
	});
});

describe("the app's default name", () => {
	it("fits GitHub's 34 characters without cutting a word", () => {
		expect(appName("tack.example.com")).toBe("Tack (tack.example.com)");
		expect(appName("tack-deploy-test.ascorbic.workers.dev")).toBe(
			"Tack (tack-deploy-test.ascorbic)",
		);
		expect(appName("planning.a-long-organisation-name.example.org")).toBe("Tack (planning)");
		for (const host of ["localhost", "a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s", "x".repeat(60)]) {
			expect(appName(host).length).toBeLessThanOrEqual(34);
		}
	});
});
