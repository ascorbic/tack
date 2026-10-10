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
github.addRepo(3, "lovell/sharp");
github.addRepo(4, "acme/old");
github.install(11, "emdash-cms", ["emdash-cms/emdash", "emdash-cms/docs"]);
// Installed before Tack asked for write access, and never updated.
github.install(12, "lovell", ["lovell/sharp"], {
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
		expect(byAccount.lovell).toMatchObject({
			writable: false,
			repositories: [{ name: "lovell/sharp" }],
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
