// The boards UI's pure logic: reading the invite field, finding boards from
// the home page, which tab it opens on, who a board's open to in words, and
// whether a board's repositories are ready for a session.

import { describe, expect, it } from "vite-plus/test";
import { accessDescription, accessLabel } from "../src/client/boards/access.ts";
import { defaultTab, renameIn, tabLists, unseenShared } from "../src/client/boards/homeTabs.ts";
import {
	completeInvite,
	describeInvitee,
	finishedLogins,
	notOnGitHub,
	parseInvite,
	refused,
} from "../src/client/boards/invites.ts";
import { boardRepos } from "../src/client/boards/repoStatus.ts";
import { matchScore, searchBoards } from "../src/client/boards/search.ts";
import type { BoardInfo, BoardList, PersonLookup } from "../src/shared/boards.ts";
import type { Card, MissingCard } from "../src/shared/cards.ts";

function board(id: string, title: string, extra: Partial<BoardInfo> = {}): BoardInfo {
	return {
		id,
		slug: id,
		title,
		owner: null,
		visibility: "instance",
		instanceRole: "editor",
		createdAt: 0,
		updatedAt: 0,
		archivedAt: null,
		thumbnail: null,
		members: [],
		memberCount: 1,
		role: "owner",
		canManage: true,
		visitedAt: 1,
		...extra,
	};
}

const list = (parts: Partial<BoardList>): BoardList => ({
	recent: [],
	mine: [],
	shared: [],
	archived: [],
	open: [],
	canCreate: true,
	...parts,
});

describe("the invite field", () => {
	it("reads logins separated by spaces or commas, @ optional, each once", () => {
		expect(parseInvite("@alice, bob  Alice,carol")).toEqual({
			logins: ["alice", "bob", "carol"],
			invalid: [],
			current: "carol",
			currentRepeats: false,
		});
		expect(parseInvite("alice, not a login!")).toMatchObject({
			logins: ["alice", "not", "a"],
			invalid: ["login!"],
		});
		expect(parseInvite("alice, ")).toMatchObject({ current: null });
		expect(parseInvite("")).toEqual({
			logins: [],
			invalid: [],
			current: null,
			currentRepeats: false,
		});
	});

	it("previews only the logins that are done being typed", () => {
		expect(finishedLogins(parseInvite("alice, bo"))).toEqual(["alice"]);
		expect(finishedLogins(parseInvite("alice, bob "))).toEqual(["alice", "bob"]);
		// Typing a repeat of one that's done: the done one stays.
		expect(finishedLogins(parseInvite("alice, alice"))).toEqual(["alice"]);
	});

	it("completes the login being typed with a suggestion", () => {
		expect(completeInvite("pri", "priya-s")).toBe("priya-s, ");
		expect(completeInvite("alice, pri", "priya-s")).toBe("alice, priya-s, ");
		expect(completeInvite("alice ", "priya-s")).toBe("alice, priya-s, ");
	});

	it("refuses logins GitHub has nobody by, and organisations", () => {
		const lookups: (PersonLookup | null)[] = [
			{ login: "typo", status: "unknown", person: null, allowed: null },
			{ login: "emdash-cms", status: "organization", person: null, allowed: null },
			{ login: "ok", status: "github", person: null, allowed: null },
			{ login: "dev", status: "unchecked", person: null, allowed: null },
			null,
		];
		expect(refused(lookups)).toEqual(["typo", "emdash-cms"]);
		expect(notOnGitHub(["typo"])).toBe("“typo” isn’t a GitHub user. Check the spelling?");
		expect(notOnGitHub(["a", "b"])).toBe("“a”, “b” aren’t GitHub users. Check the spelling?");
	});

	it("says what each invitee's lookup found", () => {
		const person = { id: 1, login: "kai", name: "Kai", avatarUrl: "" };
		expect(describeInvitee("kai", "checking", undefined)).toMatchObject({ tone: "quiet" });
		expect(
			describeInvitee("kai", { login: "kai", status: "known", person, allowed: true }, undefined),
		).toEqual({ note: "On this Tack", tone: "ok" });
		expect(
			describeInvitee("kai", { login: "kai", status: "known", person, allowed: false }, undefined)
				.tone,
		).toBe("warn");
		expect(
			describeInvitee(
				"x",
				{ login: "x", status: "unknown", person: null, allowed: null },
				undefined,
			),
		).toEqual({ note: "No GitHub user by that name", tone: "bad" });
		expect(
			describeInvitee("kai", undefined, { login: "kai", person, role: "viewer" }).note,
		).toContain("Already here");
	});
});

describe("finding a board", () => {
	it("forgives a missing letter or two, and ranks substrings first", () => {
		expect(matchScore("EmDash planning", "emdsh")).not.toBeNull();
		expect(matchScore("EmDash planning", "planning")).not.toBeNull();
		expect(matchScore("Release triage roadmap", "retro")).toBeNull();
		expect(matchScore("Sprint 42 retro", "zz")).toBeNull();
		expect(matchScore("Sprint 42 retro", "retro")).toBeGreaterThan(
			matchScore("Retrospectives", "rtro") ?? 0,
		);
		// Every word has to match.
		expect(matchScore("Sprint 42 retro", "sprint retro")).not.toBeNull();
		expect(matchScore("Sprint 42 retro", "sprint planning")).toBeNull();
		expect(matchScore("Café roadmap", "cafe")).not.toBeNull();
	});

	it("searches every tab at once, each board once, with archived ones apart", () => {
		const retro = board("a", "Sprint 42 retro");
		const old = board("b", "Retro (2024)", { archivedAt: 5 });
		const team = board("c", "Team retro", { role: "editor" });
		const result = searchBoards(
			list({ recent: [retro], mine: [retro], open: [team, retro], archived: [old] }),
			"retro",
		);
		// Closer to the start of the title ranks higher.
		expect(result.boards.map((b) => b.id)).toEqual(["c", "a"]);
		expect(result.archived.map((b) => b.id)).toEqual(["b"]);
	});
});

describe("the home page's tabs", () => {
	const mine = board("m", "Mine");
	const invited = board("s", "EmDash planning", { role: "editor", visitedAt: null });
	const seen = board("t", "Seen", { role: "editor" });
	const team = board("o", "Team board", { role: "editor" });

	it("opens an invitee who's never been here on the board shared with them", () => {
		const lists = tabLists(list({ shared: [invited], open: [invited] }));
		expect(lists.recent.map((b) => b.id)).toEqual(["s"]);
		expect(defaultTab(lists)).toBe("recent");
		expect(unseenShared(list({ shared: [invited, seen] })).map((b) => b.id)).toEqual(["s"]);
	});

	it("leads Recent with what's new, and opens on what's yours otherwise", () => {
		const lists = tabLists(list({ recent: [seen], shared: [invited, seen] }));
		expect(lists.recent.map((b) => b.id)).toEqual(["s", "t"]);
		expect(defaultTab(tabLists(list({ mine: [mine] })))).toBe("mine");
		expect(defaultTab(tabLists(list({ shared: [seen] })))).toBe("shared");
		expect(defaultTab(tabLists(list({})))).toBe("mine");
	});

	it("keeps your boards and those shared with you out of the team's", () => {
		const lists = tabLists(list({ mine: [mine], shared: [seen], open: [mine, seen, team] }));
		expect(lists.open.map((b) => b.id)).toEqual(["o"]);
	});

	it("renames a board in place, everywhere it's listed", () => {
		const renamed = renameIn(list({ recent: [seen, mine], mine: [mine] }), "m", "New", "new");
		expect(renamed.recent.map((b) => b.title)).toEqual(["Seen", "New"]);
		expect(renamed.mine[0]).toMatchObject({ title: "New", slug: "new" });
	});
});

describe("who a board is open to", () => {
	it("says who can edit, in a few words and in full", () => {
		expect(accessLabel("instance", "editor")).toBe("Anyone here can edit");
		expect(accessLabel("instance", "viewer")).toBe("Anyone here can view");
		expect(accessLabel("private", "editor")).toBe("Invite only");
		expect(accessLabel("public", "editor")).toBe("Public");
		expect(accessDescription("public", "editor")).toBe(
			"Anyone with the link can view, and everyone on this Tack can edit",
		);
	});
});

describe("a board's repositories", () => {
	const card = (key: string, extra: Partial<Card>): Card =>
		({ key, live: true, writable: true, ...extra }) as Card;

	it("says which are live and can be pushed to, the ones needing something first", () => {
		const cards = new Map<string, Card | MissingCard>([
			["github.com/emdash-cms/emdash#1", card("github.com/emdash-cms/emdash#1", {})],
			["github.com/emdash-cms/emdash#2", card("github.com/emdash-cms/emdash#2", {})],
			[
				"github.com/lovell/sharp#9",
				card("github.com/lovell/sharp#9", { live: false, writable: false }),
			],
			[
				"github.com/acme/vault#3",
				{ key: "github.com/acme/vault#3", missing: true, reason: "private" },
			],
			[
				"github.com/acme/gone#4",
				{ key: "github.com/acme/gone#4", missing: true, reason: "not_found" },
			],
		]);
		const repos = boardRepos([...cards.keys(), "github.com/new/repo#1"], (key) => cards.get(key));
		expect(repos.map((r) => [r.name, r.state, r.cards])).toEqual([
			["lovell/sharp", "readonly", 1],
			["acme/vault", "unreadable", 1],
			["acme/gone", "loading", 1],
			["new/repo", "loading", 1],
			["emdash-cms/emdash", "ready", 2],
		]);
	});
});
