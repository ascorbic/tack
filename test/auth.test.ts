import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Me } from "../src/shared/auth.ts";
import { decrypt, encrypt, sign, unsign } from "../src/server/auth/crypto.ts";
import { devUserId } from "../src/server/auth/logins.ts";
import { TACK_SECRET, instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

async function me(mf: Miniflare, cookie?: string): Promise<Me> {
	const response = await mf.dispatchFetch(`${ORIGIN}/api/me`, {
		headers: cookie ? { cookie } : {},
	});
	return response.json() as Promise<Me>;
}

async function connect(mf: Miniflare, cookie?: string) {
	// Boards must be in the index; this adopts one as a guest would from `/?board=auth-test`.
	await mf.dispatchFetch(`${ORIGIN}/api/boards/legacy`, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ name: "auth-test" }),
	});
	return mf.dispatchFetch(`${ORIGIN}/parties/board/auth-test`, {
		headers: { upgrade: "websocket", ...(cookie ? { cookie } : {}) },
	});
}

describe("crypto", () => {
	it("round-trips encrypted values, bound to their context", async () => {
		const sealed = await encrypt("secret", "ghu_token", "user:1");
		expect(sealed).not.toContain("ghu_token");
		expect(await decrypt("secret", sealed, "user:1")).toBe("ghu_token");
		await expect(decrypt("secret", sealed, "user:2")).rejects.toThrow();
		await expect(decrypt("other", sealed, "user:1")).rejects.toThrow();
	});

	it("rejects signed values that are tampered with, expired, or for another purpose", async () => {
		const value = await sign("secret", "session", "abc", 60);
		expect(await unsign("secret", "session", value)).toBe("abc");
		expect(await unsign("secret", "oauth", value)).toBeNull();
		expect(await unsign("other", "session", value)).toBeNull();
		expect(await unsign("secret", "session", `${value.slice(0, -2)}xx`)).toBeNull();
		expect(
			await unsign("secret", "session", await sign("secret", "session", "abc", -1)),
		).toBeNull();
		expect(await unsign("secret", "session", "garbage")).toBeNull();
	});
});

describe("without TACK_SECRET (Previews)", () => {
	let mf: Miniflare;
	beforeAll(() => {
		mf = startWorker({ devAuth: true, bindings: { TACK_SECRET: "" } });
	});
	afterAll(() => mf.dispose());

	it("says sign-in is unavailable, and boards stay open", async () => {
		expect(await me(mf)).toEqual({
			viewer: null,
			admin: false,
			allowed: true,
			signIn: "unavailable",
			devAuth: false,
		});
		const setup = await mf.dispatchFetch(`${ORIGIN}/api/setup`);
		expect(await setup.json()).toEqual({ status: "unavailable" });
		const signin = await mf.dispatchFetch(`${ORIGIN}/auth/signin`, { redirect: "manual" });
		expect(signin.headers.get("location")).toBe("/signin?error=unavailable&return_to=%2F");
		expect((await connect(mf)).status).toBe(101);
	});

	it("turns dev sign-in off too", async () => {
		const response = await mf.dispatchFetch(`${ORIGIN}/auth/dev?login=octocat`);
		expect(response.status).toBe(404);
	});
});

describe("dev sign-in", () => {
	it("is off by default", async () => {
		const mf = startWorker();
		try {
			const response = await mf.dispatchFetch(`${ORIGIN}/auth/dev?login=octocat`, {
				redirect: "manual",
			});
			expect(response.status).toBe(404);
			expect(response.headers.get("set-cookie")).toBeNull();
			expect((await me(mf)).devAuth).toBe(false);
		} finally {
			await mf.dispose();
		}
	});

	it("only works on loopback hosts, even when on", async () => {
		const mf = startWorker({ devAuth: true });
		try {
			const response = await mf.dispatchFetch("https://tack.example.com/auth/dev?login=octocat", {
				redirect: "manual",
			});
			expect(response.status).toBe(404);
			expect(await (await instanceStub(mf)).devSignIn({ login: "octocat" })).toMatchObject({
				ok: true,
			});
		} finally {
			await mf.dispose();
		}
	});

	it("is refused by the Instance object when TACK_DEV_AUTH isn't set", async () => {
		const mf = startWorker();
		try {
			const instance = await instanceStub(mf);
			expect(await instance.devSignIn({ login: "octocat" })).toEqual({
				ok: false,
				error: "dev_auth_disabled",
			});
		} finally {
			await mf.dispose();
		}
	});
});

describe("sessions", () => {
	let mf: Miniflare;
	beforeAll(() => {
		mf = startWorker({ devAuth: true });
	});
	afterAll(() => mf.dispose());

	it("signs in and reports the viewer", async () => {
		const cookie = await signIn(mf, "octocat", { name: "The Octocat" });
		expect(await me(mf, cookie)).toEqual({
			viewer: {
				id: devUserId("octocat"),
				login: "octocat",
				name: "The Octocat",
				avatarUrl: "https://github.com/octocat.png?size=96",
			},
			admin: false,
			allowed: true,
			signIn: "unconfigured",
			devAuth: true,
		});
	});

	it("sets an HTTP-only, SameSite=Lax cookie, Secure over HTTPS", async () => {
		const response = await mf.dispatchFetch("http://app.localhost/auth/dev?login=octocat", {
			redirect: "manual",
		});
		expect(response.headers.get("set-cookie")).toMatch(
			/^tack_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/,
		);
		expect(response.headers.get("location")).toBe("/");

		const secure = await mf.dispatchFetch("https://localhost/auth/dev?login=octocat", {
			redirect: "manual",
		});
		expect(secure.headers.get("set-cookie")).toMatch(/; HttpOnly; SameSite=Lax; Secure$/);
	});

	it("ignores tampered cookies", async () => {
		const cookie = await signIn(mf, "octocat");
		const [name, value = ""] = cookie.split("=");
		const [body = "", mac = ""] = decodeURIComponent(value).split(".");
		const flipped = `${body}.${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
		expect((await me(mf, `${name}=${encodeURIComponent(flipped)}`)).viewer).toBeNull();
		expect((await me(mf, `${name}=${encodeURIComponent(`${body}x.${mac}`)}`)).viewer).toBeNull();

		// A cookie for a real session, signed with someone else's secret.
		const instance = await instanceStub(mf);
		const session = await instance.startSession(devUserId("octocat"));
		if (!session.ok) throw new Error("no session");
		const forged = await sign("not-the-secret", "session", session.sessionId, 3600);
		expect((await me(mf, `tack_session=${encodeURIComponent(forged)}`)).viewer).toBeNull();
		const genuine = await sign(TACK_SECRET, "session", session.sessionId, 3600);
		expect((await me(mf, `tack_session=${encodeURIComponent(genuine)}`)).viewer?.login).toBe(
			"octocat",
		);
	});

	it("rejects expired sessions, even with a valid cookie", async () => {
		const instance = await instanceStub(mf);
		await signIn(mf, "octocat");
		const session = await instance.startSession(devUserId("octocat"), -1000);
		if (!session.ok) throw new Error("no session");
		const cookie = await sign(TACK_SECRET, "session", session.sessionId, 3600);
		expect((await me(mf, `tack_session=${encodeURIComponent(cookie)}`)).viewer).toBeNull();
	});

	it("rejects cookies past their own expiry", async () => {
		const instance = await instanceStub(mf);
		const session = await instance.startSession(devUserId("octocat"));
		if (!session.ok) throw new Error("no session");
		const cookie = await sign(TACK_SECRET, "session", session.sessionId, -1);
		expect((await me(mf, `tack_session=${encodeURIComponent(cookie)}`)).viewer).toBeNull();
	});

	it("signs out, revoking the session server-side", async () => {
		const cookie = await signIn(mf, "octocat");
		const response = await mf.dispatchFetch(`${ORIGIN}/auth/signout`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN },
			redirect: "manual",
		});
		expect(response.status).toBe(303);
		expect(response.headers.get("set-cookie")).toMatch(/^tack_session=; .*Max-Age=0/);
		// The old cookie no longer works, even if a browser kept it.
		expect((await me(mf, cookie)).viewer).toBeNull();
	});

	it("refuses cross-site sign-out", async () => {
		const cookie = await signIn(mf, "octocat");
		const response = await mf.dispatchFetch(`${ORIGIN}/auth/signout`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example" },
		});
		expect(response.status).toBe(403);
		expect((await me(mf, cookie)).viewer?.login).toBe("octocat");
	});

	it("leaves boards open before the app is set up", async () => {
		expect((await connect(mf)).status).toBe(101);
	});

	it("only follows same-origin return paths", async () => {
		for (const [returnTo, location] of [
			["/b/123/plan", "/b/123/plan"],
			["//evil.example/", "/"],
			["https://evil.example/", "/"],
			["/\\evil.example", "/"],
		]) {
			const url = `${ORIGIN}/auth/dev?login=octocat&return_to=${encodeURIComponent(returnTo ?? "")}`;
			const response = await mf.dispatchFetch(url, { redirect: "manual" });
			expect(response.headers.get("location")).toBe(location);
		}
	});
});
