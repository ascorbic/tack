import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	type Operation,
	type PendingChange,
	changesMap,
	listChanges,
	stageChange,
} from "../src/shared/changes.ts";
import type { RepoMeta } from "../src/shared/push.ts";
import { forgeName, forgeNameOf, sentenceCase } from "../src/shared/refs.ts";
import {
	changeForge,
	changeRepo,
	changesForge,
	estimateWatchers,
	failureCopy,
	friendlyError,
	groupByKind,
	groupByRepo,
	indexChanges,
	missingDependencies,
	peopleCount,
	repoName,
	summarize,
	withDependencies,
	withDependents,
} from "../src/client/changes/describe.ts";
import { PushSession, setIncluded, unstage } from "../src/client/changes/session.ts";
import { ChangesStore } from "../src/client/changes/store.ts";
import { History } from "../src/client/undo.ts";

// The pending-changes UI's logic: how changes read, group and depend on
// each other, who a push notifies, what a refusal says, and staging edits
// that keep dependencies whole.

const REPO = "github.com/acme/app";
const OTHER = "github.com/acme/docs";
const by = { login: "ana", name: "Ana" };

function board() {
	const doc = new Y.Doc();
	const create = stageChange(
		doc,
		{ kind: "issue.create", repo: REPO, title: "Better errors" },
		by,
		{
			shapes: ["s1"],
		},
	);
	const sub = stageChange(
		doc,
		{ kind: "item.subIssue", parent: { key: `${REPO}#1` }, child: { pending: create } },
		by,
		{ shapes: ["c1", "s1"] },
	);
	const labels = stageChange(
		doc,
		{ kind: "item.labels", target: { pending: create }, add: ["bug"] },
		by,
	);
	const close = stageChange(
		doc,
		{ kind: "item.state", target: { key: `${OTHER}#7` }, state: "closed", reason: "not_planned" },
		by,
		{ shapes: ["c2"] },
	);
	return { doc, create, sub, labels, close };
}

describe("describing changes", () => {
	it("summarises every kind of change", () => {
		const { doc, create } = board();
		const index = indexChanges(listChanges(doc));
		const lines = (ops: Operation[]) => ops.map((op) => summarize(op, index));
		expect(
			lines([
				{ kind: "issue.create", repo: REPO, title: "Better errors" },
				{ kind: "item.labels", target: { key: `${REPO}#4` }, add: ["bug", "docs"] },
				{ kind: "item.labels", target: { key: `${REPO}#4` }, add: ["bug"], remove: ["wontfix"] },
				{
					kind: "item.state",
					target: { key: `${REPO}#4` },
					state: "closed",
					reason: "not_planned",
				},
				{ kind: "item.state", target: { key: `${REPO}#4` }, state: "open" },
				{ kind: "item.assignees", target: { pending: create }, add: ["kai"] },
				{ kind: "item.milestone", target: { key: `${REPO}#4` }, milestone: "5.0" },
				{ kind: "item.milestone", target: { key: `${REPO}#4` }, milestone: null },
				{ kind: "item.subIssue", parent: { key: `${REPO}#1` }, child: { pending: create } },
				{ kind: "item.blockedBy", target: { key: `${REPO}#2` }, blockedBy: { key: `${REPO}#3` } },
				{ kind: "item.comment", target: { key: `${REPO}#4` }, body: "Hi" },
			]),
		).toEqual([
			"Create issue “Better errors”",
			"Add bug and docs to #4",
			"Add bug, remove wontfix on #4",
			"Close #4 as not planned",
			"Reopen #4",
			"Assign @kai to “Better errors”",
			"Move #4 to 5.0",
			"Clear the milestone on #4",
			"Make “Better errors” a sub-issue of #1",
			"Mark #2 blocked by #3",
			"Comment on #4",
		]);
	});

	it("names repositories without the host on known forges", () => {
		expect(repoName("github.com/acme/app")).toBe("acme/app");
		expect(repoName("fake.tack/acme/app")).toBe("acme/app");
		expect(repoName("gitlab.example.com/acme/app")).toBe("gitlab.example.com/acme/app");
	});

	it("puts changes about a new issue in its repository", () => {
		const { doc, labels } = board();
		const index = indexChanges(listChanges(doc));
		expect(changeRepo(index.get(labels) as PendingChange, index)).toBe(REPO);
		const groups = groupByRepo(listChanges(doc), index);
		expect(groups.map((group) => [group.repo, group.changes.length])).toEqual([
			[REPO, 3],
			[OTHER, 1],
		]);
		expect(groupByKind(groups[0]?.changes ?? []).map((group) => group.kind)).toEqual([
			"issue.create",
			"item.subIssue",
			"item.labels",
		]);
	});

	it("counts people roughly", () => {
		expect(peopleCount(1)).toBe("1 person");
		expect(peopleCount(4)).toBe("4 people");
		expect(peopleCount(42)).toBe("~42 people");
		expect(peopleCount(1290)).toBe("~1.3k people");
		expect(peopleCount(42_000)).toBe("~42k people");
	});

	it("says what went wrong in the forge's words, punctuated", () => {
		expect(friendlyError("Validation Failed")).toBe("Validation Failed.");
		expect(friendlyError("Already closed.")).toBe("Already closed.");
		expect(friendlyError(undefined)).toBe("GitHub didn’t say why.");
		expect(friendlyError("", "the test forge")).toBe("The test forge didn’t say why.");
	});

	it("names the forge changes go to, from their repositories", () => {
		expect(forgeName("github.com")).toBe("GitHub");
		expect(forgeName("fake.tack")).toBe("the test forge");
		expect(forgeName("Git.Example.org")).toBe("git.example.org");
		expect(forgeNameOf([`${REPO}#1`, OTHER])).toBe("GitHub");
		expect(forgeNameOf(["fake.tack/demo/app"])).toBe("the test forge");
		expect(forgeNameOf([REPO, "fake.tack/demo/app"])).toBe("GitHub and the test forge");
		expect(forgeNameOf([REPO, "fake.tack/a/b", "git.example.org/c/d"])).toBe("their forges");
		expect(forgeNameOf([])).toBe("GitHub");
		expect(sentenceCase(forgeName("fake.tack"))).toBe("The test forge");

		const { doc, create } = board();
		const fake = stageChange(
			doc,
			{ kind: "issue.create", repo: "fake.tack/demo/app", title: "Elsewhere" },
			by,
		);
		const index = indexChanges(listChanges(doc));
		expect(changeForge(index.get(create)!, index)).toBe("GitHub");
		expect(changeForge(index.get(fake)!, index)).toBe("the test forge");
		expect(changesForge([...index.values()], index)).toBe("GitHub and the test forge");
		expect(
			failureCopy({
				ok: false,
				reason: "no_write_access",
				repos: ["fake.tack/demo/app"],
				message: "",
			}).body,
		).toMatch(/^The test forge says you can’t write to demo\/app\./);
	});
});

describe("dependencies", () => {
	it("takes the new issue along when including a change about it", () => {
		const { doc, create, sub, labels } = board();
		const index = indexChanges(listChanges(doc));
		expect([...withDependencies([labels], index)].sort()).toEqual([create, labels].sort());
		expect(missingDependencies([sub], index)).toEqual([create]);
		expect(missingDependencies([sub, create], index)).toEqual([]);
	});

	it("takes the changes about a new issue along when leaving it out", () => {
		const { doc, create, sub, labels, close } = board();
		const index = indexChanges(listChanges(doc));
		expect([...withDependents([create], index)].sort()).toEqual([create, sub, labels].sort());
		expect([...withDependents([close], index)]).toEqual([close]);
	});

	it("doesn't need an issue that's already been made", () => {
		const { doc, create, labels } = board();
		changesMap(doc).get(create)?.set("status", "applied");
		const index = indexChanges(listChanges(doc));
		expect([...withDependencies([labels], index)]).toEqual([labels]);
	});
});

describe("staging edits", () => {
	it("includes and leaves out with dependencies, as one undo step", () => {
		const { doc, create, sub, labels, close } = board();
		const history = new History(doc);
		const index = () => indexChanges(listChanges(doc));
		const included = () =>
			listChanges(doc)
				.filter((change) => change.included !== false)
				.map((change) => change.id)
				.sort();

		setIncluded(doc, [create], false, index());
		expect(included()).toEqual([close]);
		setIncluded(doc, [labels], true, index());
		expect(included()).toEqual([create, labels, close].sort());

		history.undo();
		expect(included()).toEqual([close]);
		history.undo();
		expect(included()).toEqual([create, sub, labels, close].sort());
		history.destroy();
	});

	it("unstages the changes that depend on an unstaged issue, and only pending ones", () => {
		const { doc, create, sub, labels, close } = board();
		changesMap(doc).get(close)?.set("status", "sending");
		const removed = unstage(doc, [create, close], indexChanges(listChanges(doc)));
		expect(removed.sort()).toEqual([create, sub, labels].sort());
		expect(listChanges(doc).map((change) => change.id)).toEqual([close]);
	});
});

describe("ChangesStore", () => {
	it("keeps snapshots stable for shapes whose changes didn't change", () => {
		const { doc, close } = board();
		const store = new ChangesStore(doc);
		const s1 = store.forShape("s1");
		const c2 = store.forShape("c2");
		expect(s1).toHaveLength(2);
		expect(store.forShape("nothing")).toHaveLength(0);

		let notified = 0;
		store.subscribe(() => notified++);
		changesMap(doc).get(close)?.set("status", "sending");
		expect(notified).toBe(1);
		expect(store.forShape("s1")).toBe(s1);
		expect(store.forShape("c2")).not.toBe(c2);
		expect(store.forShape("c2")[0]?.status).toBe("sending");
		store.destroy();
	});

	it("highlights shapes, as local state", () => {
		const { doc } = board();
		const store = new ChangesStore(doc);
		let calls = 0;
		store.subscribeHighlight(() => calls++);
		store.highlight(["s1"]);
		expect(store.isHighlighted("s1")).toBe(true);
		store.highlight([]);
		store.highlight([]);
		expect(calls).toBe(2);
		store.destroy();
	});
});

describe("who a push notifies", () => {
	const meta: Record<string, RepoMeta> = {
		[REPO]: {
			repo: REPO,
			labels: [],
			milestones: [],
			assignees: [],
			discussionCategories: [],
			watchers: 40,
			defaultBranch: "main",
			writable: true,
		},
	};

	it("counts watchers of repositories with noisy changes, and assignees", () => {
		const doc = new Y.Doc();
		stageChange(doc, { kind: "issue.create", repo: REPO, title: "New", assignees: ["kai"] }, by);
		stageChange(doc, { kind: "item.labels", target: { key: `${OTHER}#1` }, add: ["bug"] }, by);
		const changes = listChanges(doc);
		const estimate = estimateWatchers(changes, indexChanges(changes), (repo) => meta[repo]);
		expect(estimate).toEqual({
			watchers: 40,
			noisyRepos: [REPO],
			assignees: ["kai"],
			loading: false,
		});
	});

	it("is quiet for labels and milestones", () => {
		const doc = new Y.Doc();
		stageChange(
			doc,
			{ kind: "item.milestone", target: { key: `${REPO}#1` }, milestone: "5.0" },
			by,
		);
		const changes = listChanges(doc);
		expect(estimateWatchers(changes, indexChanges(changes), () => undefined).noisyRepos).toEqual(
			[],
		);
	});
});

describe("refused pushes", () => {
	it("has a message and a way forward for every reason", () => {
		const reasons = [
			"signed_out",
			"no_write_access",
			"not_installed",
			"missing_dependency",
			"busy",
			"offline",
		] as const;
		for (const reason of reasons) {
			const copy = failureCopy({ ok: false, reason, message: "", repos: [REPO] });
			expect(copy.title, reason).not.toBe("");
			expect(copy.actions.length, reason).toBeGreaterThan(0);
		}
		expect(
			failureCopy({ ok: false, reason: "not_installed", repos: [REPO], message: "" }),
		).toMatchObject({
			title: "Install the app on these repos",
			actions: [
				{ kind: "install", repos: [REPO] },
				{ kind: "leave_out", repos: [REPO] },
			],
		});
		expect(failureCopy({ ok: false, reason: "no_write_access", message: "" }).title).toBe(
			"You can stage but not push here",
		);
	});
});

describe("PushSession", () => {
	it("pushes with dependencies, and remembers a refusal", async () => {
		const { doc, create, labels } = board();
		const requests: { ids: string[]; as: string }[] = [];
		let refuse = true;
		const session = new PushSession({
			push: async (request) => {
				requests.push(request);
				return refuse ? { ok: false, reason: "busy", message: "busy" } : { ok: true, pushId: "p1" };
			},
			pushes: async () => ({ ok: true, value: [] }),
			repoMeta: async () => ({ ok: false, error: "nope" }),
		});
		const index = indexChanges(listChanges(doc));
		const refused = await session.push([labels], "app", index);
		expect(refused.phase).toBe("refused");
		expect(requests[0]?.ids.sort()).toEqual([create, labels].sort());
		expect(requests[0]?.as).toBe("app");

		refuse = false;
		const pushing = await session.push([labels], "user", index);
		expect(pushing).toMatchObject({ phase: "pushing", pushIds: ["p1"] });

		// A retry during the push joins it.
		const again = await session.push([create], "user", index);
		expect(again).toMatchObject({ phase: "pushing", pushIds: ["p1", "p1"] });
		session.reset();
		expect(session.getSnapshot().phase).toBe("idle");
	});
});
