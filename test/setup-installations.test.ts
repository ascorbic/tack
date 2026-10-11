// The setup page's pre-flight: where the GitHub App is installed, which
// repositories each installation covers, and whether it can write, so an
// admin can check before a planning session that every repository is live
// and can be pushed to, rather than finding out when a push fails.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { InstallationList } from "../src/shared/auth.ts";
import { FakeGitHub } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const github = new FakeGitHub();
github.addRepo(1, "emdash-cms/emdash");
github.addRepo(2, "emdash-cms/docs", { private: true });
github.addRepo(3, "pixelmill/pixelmill");
github.addRepo(4, "acme/old");
github.install(11, "emdash-cms", ["emdash-cms/emdash", "emdash-cms/docs"]);
// Installed before Tack asked for write access, and never updated.
github.install(12, "pixelmill", ["pixelmill/pixelmill"], {
	permissions: { issues: "read", pull_requests: "read", metadata: "read" },
});
github.install(13, "acme", ["acme/old"], { suspended: true });

let mf: Miniflare;

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	expect(await (await instanceStub(mf)).completeSetup(github.manifestCode)).toMatchObject({
		ok: true,
	});
});

afterAll(async () => {
	await mf.dispose();
});

async function installations(cookie: string) {
	return mf.dispatchFetch("http://localhost/api/setup/installations", { headers: { cookie } });
}

describe("where the app is installed", () => {
	it("lists every installation and its repositories, and whether it can write", async () => {
		const admin = await signIn(mf, "matt", { admin: true });
		const response = await installations(admin);
		expect(response.status).toBe(200);
		const { installations: list } = (await response.json()) as InstallationList;
		const byAccount = Object.fromEntries(list.map((i) => [i.account, i]));

		expect(byAccount["emdash-cms"]).toMatchObject({
			id: 11,
			accountType: "Organization",
			suspended: false,
			writable: true,
			repositories: [
				{ name: "emdash-cms/docs", private: true },
				{ name: "emdash-cms/emdash", private: false },
			],
			more: 0,
			settingsUrl: "https://github.com/organizations/emdash-cms/settings/installations/11",
		});
		expect(byAccount.pixelmill).toMatchObject({
			writable: false,
			repositories: [{ name: "pixelmill/pixelmill" }],
		});
		// Suspended: nothing flows, so its repositories aren't asked for.
		expect(byAccount.acme).toMatchObject({ suspended: true, repositories: [] });
	});

	it("remembers the repositories it saw, so cards from them go live without a lookup", async () => {
		const instance = await instanceStub(mf);
		expect(await instance.isInstalled("emdash-cms/emdash")).toBe(true);
		expect(github.count((r) => r.path.endsWith("/installation"))).toBe(0);
	});

	it("is only for admins, since repository names can be private", async () => {
		const someone = await signIn(mf, "alice");
		expect((await installations(someone)).status).toBe(403);
		expect((await installations("")).status).toBe(403);
	});
});

describe("repositories the app isn't installed on", () => {
	it("lists the ones Tack looked for it on, so an admin can install it before a session", async () => {
		github.addRepo(5, "emdash-cms/plugins");
		const instance = await instanceStub(mf);
		// A card from it on a board looks the app up, and doesn't find it.
		expect(await instance.isInstalled("emdash-cms/plugins")).toBe(false);
		const admin = await signIn(mf, "matt", { admin: true });
		const list = (await (await installations(admin)).json()) as InstallationList;
		expect(list.notInstalled).toContain("emdash-cms/plugins");
		expect(list.notInstalled).not.toContain("emdash-cms/emdash");

		// Installing it there takes it off the list.
		github.install(14, "emdash-cms", ["emdash-cms/plugins"]);
		const after = (await (await installations(admin)).json()) as InstallationList;
		expect(after.notInstalled).not.toContain("emdash-cms/plugins");
	});
});

describe("whether webhooks reach the instance", () => {
	const ORIGIN = "https://tack.example.com";

	async function webhooks(cookie: string, origin = ORIGIN) {
		return mf.dispatchFetch(`${origin}/api/setup/webhooks`, { headers: { cookie } });
	}

	const delivery = (id: number, status: number) => ({
		id,
		guid: `guid-${id}`,
		delivered_at: "2026-10-11T09:00:00Z",
		redelivery: false,
		status_code: status,
		event: "issues",
	});

	it("says so when GitHub's latest delivery arrived", async () => {
		github.hookDeliveries = [delivery(2, 202), delivery(1, 0)];
		const admin = await signIn(mf, "matt", { admin: true });
		const response = await webhooks(admin);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			state: "ok",
			url: `${ORIGIN}/webhooks/github`,
			expected: `${ORIGIN}/webhooks/github`,
			last: { event: "issues", status: 202, at: "2026-10-11T09:00:00Z" },
			failed: 1,
		});
	});

	it("explains failures: unreachable, refused, or failing", async () => {
		const admin = await signIn(mf, "matt", { admin: true });
		for (const [status, reason] of [
			[0, "unreachable"],
			[401, "rejected"],
			[500, "error"],
		] as const) {
			github.hookDeliveries = [delivery(3, status)];
			expect(await (await webhooks(admin)).json()).toMatchObject({ state: "failing", reason });
		}
	});

	it("notices an app sending its webhooks somewhere else", async () => {
		const admin = await signIn(mf, "matt", { admin: true });
		github.hookDeliveries = [delivery(4, 202)];
		expect(await (await webhooks(admin, "https://tack.other.dev")).json()).toMatchObject({
			state: "elsewhere",
			url: `${ORIGIN}/webhooks/github`,
			expected: "https://tack.other.dev/webhooks/github",
		});
	});

	it("waits for a first delivery, knows GitHub can't reach this machine, and copes with GitHub not answering", async () => {
		const admin = await signIn(mf, "matt", { admin: true });
		github.hookDeliveries = [];
		expect(await (await webhooks(admin)).json()).toMatchObject({ state: "waiting", last: null });
		expect(await (await webhooks(admin, "http://localhost")).json()).toMatchObject({
			state: "local",
		});
		const config = github.hookConfig;
		github.hookConfig = null;
		try {
			expect(await (await webhooks(admin)).json()).toMatchObject({ state: "unknown" });
		} finally {
			github.hookConfig = config;
		}
	});

	it("is only for admins", async () => {
		const someone = await signIn(mf, "alice");
		expect((await webhooks(someone)).status).toBe(403);
		expect((await webhooks("")).status).toBe(403);
	});
});
