// Inviting people: suggestions from who's signed in here, logins checked
// against GitHub with the inviter's own token, and invites to logins GitHub
// doesn't know refused, so a typo never sits in a board's list for ever.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type {
	BoardInfo,
	BoardMembers,
	PeopleSuggestions,
	PersonLookup,
} from "../src/shared/boards.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, signIn, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const OLIVE: FakeUser = { id: 601, login: "olive", name: "Olive Ng", avatar_url: "https://a/o" };
const OSCAR: FakeUser = { id: 602, login: "oscar", name: "Oscar Diaz", avatar_url: "https://a/x" };

const github = new FakeGitHub();
github.addUser({ id: 700, login: "Priya-S", name: "Priya Shah", avatar_url: "https://a/p" });
github.addUser({ id: 701, login: "emdash-cms", name: "EmDash", avatar_url: "" }, "Organization");

let mf: Miniflare;
let olive = "";
let devOnly = "";

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	expect(await (await instanceStub(mf)).completeSetup(github.manifestCode)).toMatchObject({
		ok: true,
	});
	olive = await signInWithGitHub(mf, github, OLIVE);
	await signInWithGitHub(mf, github, OSCAR);
	// Signed in without GitHub, so there's no token to ask GitHub with.
	devOnly = await signIn(mf, "devon");
});

afterAll(async () => {
	await mf.dispose();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.body) {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

async function lookup(cookie: string, login: string): Promise<PersonLookup> {
	const response = await api(`/api/people/${encodeURIComponent(login)}`, cookie);
	expect(response.status).toBe(200);
	return (await response.json()) as PersonLookup;
}

async function board(cookie: string): Promise<BoardInfo> {
	const response = await api("/api/boards", cookie, {
		method: "POST",
		body: JSON.stringify({ title: "EmDash planning", visibility: "private" }),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as BoardInfo;
}

describe("looking people up", () => {
	it("knows people who've signed in here, and whether they can get in", async () => {
		expect(await lookup(olive, "@Oscar")).toMatchObject({
			login: "oscar",
			status: "known",
			person: { login: "oscar", name: "Oscar Diaz" },
			allowed: true,
		});
	});

	it("asks GitHub about everyone else", async () => {
		expect(await lookup(olive, "priya-s")).toMatchObject({
			status: "github",
			person: { login: "Priya-S", name: "Priya Shah", avatarUrl: "https://a/p" },
			// Not on the allowlist by name: their organisations decide when they sign in.
			allowed: null,
		});
		expect(await lookup(olive, "emdash-mantainer")).toMatchObject({
			status: "unknown",
			person: null,
		});
		expect(await lookup(olive, "emdash-cms")).toMatchObject({ status: "organization" });
	});

	it("can't ask GitHub without a token, and says so", async () => {
		expect(await lookup(devOnly, "emdash-mantainer")).toMatchObject({ status: "unchecked" });
	});

	it("suggests people on this Tack by login or name", async () => {
		const byLogin = (await (await api("/api/people?q=os", olive)).json()) as PeopleSuggestions;
		expect(byLogin.people.map((p) => p.login)).toEqual(["oscar"]);
		const byName = (await (await api("/api/people?q=dia", olive)).json()) as PeopleSuggestions;
		expect(byName.people.map((p) => p.login)).toEqual(["oscar"]);
		const none = (await (await api("/api/people?q=zz", olive)).json()) as PeopleSuggestions;
		expect(none.people).toEqual([]);
	});

	it("is only for people on this Tack", async () => {
		expect((await api("/api/people?q=os", "")).status).toBe(401);
		expect((await api("/api/people/oscar", "")).status).toBe(401);
		const outsider = await signIn(mf, "outsider", { allowed: false });
		expect((await api("/api/people/oscar", outsider)).status).toBe(403);
		expect((await api("/api/people/not%20a%20login", olive)).status).toBe(422);
	});
});

describe("inviting", () => {
	it("refuses logins GitHub doesn't know, and organisations, inviting nobody", async () => {
		const { id } = await board(olive);
		const refused = await api(`/api/boards/${id}/members`, olive, {
			method: "POST",
			body: JSON.stringify({
				logins: ["priya-s", "emdash-mantainer", "emdash-cms"],
				role: "editor",
			}),
		});
		expect(refused.status).toBe(422);
		expect(await refused.json()).toEqual({
			error: "unknown_login",
			logins: ["emdash-cms", "emdash-mantainer"],
		});
		const members = (await (await api(`/api/boards/${id}/members`, olive)).json()) as BoardMembers;
		expect(members.members.map((m) => m.login)).toEqual(["olive"]);

		const invited = await api(`/api/boards/${id}/members`, olive, {
			method: "POST",
			body: JSON.stringify({ logins: ["priya-s", "oscar"], role: "editor" }),
		});
		expect(invited.status).toBe(200);
		const after = (await invited.json()) as BoardMembers;
		expect(after.members.map((m) => m.login).sort()).toEqual(["olive", "oscar", "priya-s"]);
	});

	it("lets invites through when GitHub can't be asked", async () => {
		const { id } = await board(devOnly);
		const invited = await api(`/api/boards/${id}/members`, devOnly, {
			method: "POST",
			body: JSON.stringify({ logins: ["emdash-mantainer"], role: "viewer" }),
		});
		expect(invited.status).toBe(200);
	});
});
