// The forges besides GitHub (#65), the parts that need no forge: reading
// their links and keys, the instance's configuration of hosts and
// credentials, signatures, and one rate-limit gate per host.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { mayWrite, readForgeConfig } from "../src/server/forges/config.ts";
import { sameSecret, sign, verifyHexSignature } from "../src/server/forges/hmac.ts";
import { hostBucket } from "../src/server/forges/rateLimit.ts";
import {
	DEFAULT_FORGE_HOSTS,
	forgeForHost,
	forgeName,
	forgeNameOf,
	parseKey,
	parseRef,
	parseRepoKey,
	setForgeHosts,
} from "../src/shared/refs.ts";

afterEach(() => setForgeHosts(DEFAULT_FORGE_HOSTS));

describe("links to other forges", () => {
	it("reads GitLab's issues, merge requests and work items, in nested groups", () => {
		expect(parseRef("https://gitlab.com/inkscape/inkscape/-/issues/4512")).toEqual({
			forge: "gitlab",
			host: "gitlab.com",
			repo: "inkscape/inkscape",
			item: "#4512",
		});
		expect(parseRef("gitlab.com/group/sub/project/-/merge_requests/12/diffs")).toEqual({
			forge: "gitlab",
			host: "gitlab.com",
			repo: "group/sub/project",
			item: "!12",
		});
		expect(parseRef("https://gitlab.com/group/app/-/work_items/3?x=1")?.item).toBe("#3");
		// Older pages, without `-/`.
		expect(parseRef("https://gitlab.com/group/app/issues/9")?.repo).toBe("group/app");
	});

	it("reads Forgejo's and Codeberg's issues and pull requests, which share numbers", () => {
		expect(parseRef("https://codeberg.org/forgejo/forgejo/pulls/7/files")).toEqual({
			forge: "forgejo",
			host: "codeberg.org",
			repo: "forgejo/forgejo",
			item: "#7",
		});
		expect(parseRef("codeberg.org/forgejo/forgejo/issues/8")?.item).toBe("#8");
		// A repository's page isn't an item.
		expect(parseRef("https://codeberg.org/forgejo/forgejo/7")).toBeNull();
	});

	it("reads Tangled's issues and pulls, numbered separately, at its old host too", () => {
		expect(parseRef("https://tangled.org/tangled.org/core/issues/775")).toEqual({
			forge: "tangled",
			host: "tangled.org",
			repo: "tangled.org/core",
			item: "#775",
		});
		expect(parseRef("https://tangled.sh/@alice.example/knotty/pulls/3")).toEqual({
			forge: "tangled",
			host: "tangled.org",
			repo: "alice.example/knotty",
			item: "!3",
		});
	});

	it("keeps GitHub's links as they were", () => {
		expect(parseRef("https://github.com/withastro/astro/pull/5/files")?.item).toBe("#5");
		expect(parseRef("https://github.com/withastro/astro/5")).toBeNull();
		expect(parseRef("withastro/astro#5")?.host).toBe("github.com");
	});

	it("reads a self-hosted forge's links only once the instance serves it", () => {
		const link = "https://git.example.com/acme/app/-/issues/1";
		expect(parseRef(link)).toBeNull();
		setForgeHosts([
			...DEFAULT_FORGE_HOSTS,
			{ host: "git.example.com", forge: "gitlab", name: "Acme GitLab" },
		]);
		expect(parseRef(link)?.forge).toBe("gitlab");
		expect(forgeName("git.example.com")).toBe("Acme GitLab");
		expect(forgeNameOf(["git.example.com/acme/app#1", "github.com/a/b#2"])).toBe(
			"Acme GitLab and GitHub",
		);
	});

	it("never lets a configuration replace GitHub or the test forge", () => {
		setForgeHosts([{ host: "github.com", forge: "gitlab" }]);
		expect(forgeForHost("github.com")).toBe("github");
		expect(forgeForHost("fake.tack")).toBe("fake");
		// Turned off: gitlab.com's links are plain links again.
		expect(forgeForHost("gitlab.com")).toBeNull();
	});
});

describe("keys on other forges", () => {
	it("reads merge requests and nested GitLab projects", () => {
		expect(parseKey("gitlab.com/group/sub/project!12")).toEqual({
			forge: "gitlab",
			host: "gitlab.com",
			repo: "group/sub/project",
			item: "!12",
		});
	});

	it("only takes owner/name on Forgejo and Tangled, so no key names another API path", () => {
		expect(parseKey("codeberg.org/a/b#1")?.forge).toBe("forgejo");
		expect(parseKey("codeberg.org/a/b/issues#1")).toBeNull();
		expect(parseRepoKey("tangled.org/a/b/c")).toBeNull();
		expect(parseKey("gitlab.com/a/../b#1")).toBeNull();
	});
});

describe("configuration", () => {
	it("serves gitlab.com, Codeberg and Tangled out of the box, read-only and anonymous", () => {
		const { hosts, problems } = readForgeConfig(undefined);
		expect(problems).toEqual([]);
		expect(hosts.map((h) => [h.host, h.forge, h.token, h.writes])).toEqual([
			["gitlab.com", "gitlab", null, false],
			["codeberg.org", "forgejo", null, false],
			["tangled.org", "tangled", null, false],
		]);
	});

	it("adds self-hosted forges, gives defaults credentials, and turns them off", () => {
		const { hosts, problems } = readForgeConfig(
			JSON.stringify([
				{
					host: "Git.Example.com/",
					forge: "gitlab",
					name: "Acme GitLab",
					token: "glpat-x",
					webhookSecret: "s",
					writes: true,
					writers: ["Ada", "not a login!"],
				},
				{ host: "codeberg.org", token: "cb", webhookSecret: "w" },
				{ host: "tangled.org", off: true },
			]),
		);
		expect(problems).toEqual([]);
		expect(hosts.map((h) => h.host)).toEqual(["gitlab.com", "codeberg.org", "git.example.com"]);
		const acme = hosts.find((h) => h.host === "git.example.com");
		expect(acme).toMatchObject({ forge: "gitlab", name: "Acme GitLab", writes: true });
		expect(acme?.writers).toEqual(["ada"]);
		// A default keeps its forge and name when given credentials.
		expect(hosts.find((h) => h.host === "codeberg.org")).toMatchObject({
			forge: "forgejo",
			name: "Codeberg",
			token: "cb",
			webhookSecret: "w",
			writes: false,
		});
	});

	it("leaves out what doesn't make sense, says why, and keeps the rest", () => {
		const { hosts, problems } = readForgeConfig(
			JSON.stringify([
				{ host: "https://evil.example/path", forge: "gitlab" },
				{ host: "github.com", forge: "gitlab" },
				{ host: "git.example.org", forge: "bitbucket" },
				{ host: "knot.example", forge: "tangled", writes: true },
			]),
		);
		expect(problems).toHaveLength(3);
		expect(hosts.find((h) => h.host === "knot.example")?.writes).toBe(false);
		expect(readForgeConfig("{").problems).toEqual(["TACK_FORGES isn't JSON"]);
		expect(readForgeConfig("{}").hosts).toHaveLength(3);
	});

	it("lets people push only with writes on, a token, and (if it names any) as a writer", () => {
		const base = {
			host: "git.example.com",
			forge: "gitlab" as const,
			name: "Acme",
			token: "t",
			webhookSecret: null,
			writes: true,
			writers: null,
		};
		expect(mayWrite(base, "ada")).toBe(true);
		expect(mayWrite({ ...base, writes: false }, "ada")).toBe(false);
		expect(mayWrite({ ...base, token: null }, "ada")).toBe(false);
		expect(mayWrite({ ...base, writers: ["grace"] }, "Ada")).toBe(false);
		expect(mayWrite({ ...base, writers: ["grace"] }, "Grace")).toBe(true);
		expect(mayWrite(null, "ada")).toBe(false);
	});
});

describe("signatures", () => {
	it("checks Forgejo's bare-hex HMAC", async () => {
		const body = '{"action":"opened"}';
		const signature = (await sign("secret", body)).replace(/^sha256=/, "");
		expect(await verifyHexSignature("secret", body, signature)).toBe(true);
		expect(await verifyHexSignature("other", body, signature)).toBe(false);
		expect(await verifyHexSignature("secret", `${body} `, signature)).toBe(false);
		expect(await verifyHexSignature("secret", body, null)).toBe(false);
	});

	it("compares GitLab's shared token exactly", async () => {
		expect(await sameSecret("s3cret", "s3cret")).toBe(true);
		expect(await sameSecret("s3cret", "s3cret ")).toBe(false);
		expect(await sameSecret("s3cret", "")).toBe(false);
		expect(await sameSecret("s3cret", null)).toBe(false);
	});
});

describe("rate limits", () => {
	it("are per forge, with GitHub's buckets as they were", () => {
		expect(hostBucket("api.github.com", "anon")).toBe("anon");
		expect(hostBucket("github.com", "t:1")).toBe("t:1");
		expect(hostBucket("GitLab.com", "anon")).toBe("gitlab.com/anon");
		expect(hostBucket("codeberg.org", "t:1")).not.toBe(hostBucket("gitlab.com", "t:1"));
	});
});
