// Planning pushes and confirming them: which staged changes can go, in what
// order, how they're described, and whether a card shows what was written.

import { describe, expect, it } from "vite-plus/test";
import type { Card, MissingCard } from "../src/shared/cards.ts";
import type { Operation, PendingChange } from "../src/shared/changes.ts";
import { confirmationKey, reflects } from "../src/shared/confirm.ts";
import { checkOperation, planPush, summarize, writeRepo } from "../src/server/push/plan.ts";

const REPO = "github.com/acme/widgets";
const ITEM = `${REPO}#12`;

let clock = 0;
function change(
	id: string,
	op: Operation,
	status: PendingChange["status"] = "staged",
): PendingChange {
	return {
		id,
		op,
		status,
		stagedBy: { name: "Alice" },
		stagedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString(),
	};
}

const create = (title: string): Operation => ({ kind: "issue.create", repo: REPO, title });

describe("new issues from stickies that changed", () => {
	it("pushes an edited sticky as it reads now, and refuses a deleted or empty one", () => {
		const edited = { ...change("a", create("Now")), drift: "edited" as const };
		const deleted = { ...change("b", create("Gone")), drift: "deleted" as const };
		const empty = { ...change("c", create("Blank")), drift: "empty" as const };
		const plan = planPush([edited, deleted, empty], ["a", "b", "c"], new Set(), new Map());
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.ordered.map((item) => [item.change.id, item.op?.kind ?? item.error])).toEqual([
			["a", "issue.create"],
			["b", "Its sticky was deleted from the board, so there's nothing to make this issue from."],
			[
				"c",
				"Its sticky is empty now, so this issue would have no title. Write on it, or unstage this.",
			],
		]);
	});
});

function card(overrides: Partial<Card> = {}): Card {
	return {
		key: ITEM,
		forge: "github",
		host: "github.com",
		repo: "acme/widgets",
		item: "#12",
		kind: "issue",
		title: "Widgets wobble",
		state: "open",
		stateReason: null,
		labels: [{ name: "bug", color: "d73a4a" }],
		assignees: [{ login: "alice", avatarUrl: "" }],
		author: null,
		comments: 0,
		reactions: 0,
		url: "https://github.com/acme/widgets/issues/12",
		updatedAt: "2026-10-01T00:00:00Z",
		...overrides,
	};
}

const none = new Set<string>();
const noneCreated = new Map<string, string>();

describe("planPush", () => {
	it("puts creates before the changes that need them, otherwise keeping staging order", () => {
		const changes = [
			change("sub", { kind: "item.subIssue", parent: { pending: "parent" }, child: { key: ITEM } }),
			change("label", { kind: "item.labels", target: { key: ITEM }, add: ["bug"] }),
			change("parent", create("Parent")),
			change("comment", { kind: "item.comment", target: { pending: "parent" }, body: "Hi" }),
		];
		const plan = planPush(changes, ["sub", "label", "parent", "comment"], none, noneCreated);
		expect(plan.ok && plan.ordered.map((item) => item.change.id)).toEqual([
			"label",
			"parent",
			"sub",
			"comment",
		]);
		expect(plan.ok && plan.ordered.map((item) => item.repo)).toEqual([REPO, REPO, REPO, REPO]);
	});

	it("refuses a change whose pending dependency isn't in the push", () => {
		const changes = [
			change("parent", create("Parent")),
			change("sub", { kind: "item.subIssue", parent: { pending: "parent" }, child: { key: ITEM } }),
		];
		expect(planPush(changes, ["sub"], none, noneCreated)).toMatchObject({
			ok: false,
			reason: "missing_dependency",
			message: expect.stringContaining("Create issue “Parent”"),
		});
		// Unless an earlier push already created it.
		const created = new Map([["parent", `${REPO}#40`]]);
		expect(planPush(changes, ["sub"], none, created)).toMatchObject({ ok: true });
	});

	it("only pushes staged and failed changes, and never one the server is already pushing", () => {
		const changes = [
			change("a", create("A")),
			change("b", create("B"), "failed"),
			change("c", create("C"), "sent"),
		];
		expect(planPush(changes, ["a", "b"], none, noneCreated)).toMatchObject({ ok: true });
		expect(planPush(changes, ["c"], none, noneCreated)).toMatchObject({
			ok: false,
			reason: "busy",
		});
		// The document says staged, but the server knows better.
		expect(planPush(changes, ["a"], new Set(["a"]), noneCreated)).toMatchObject({
			ok: false,
			reason: "busy",
		});
		expect(planPush(changes, ["gone"], none, noneCreated)).toMatchObject({
			ok: false,
			reason: "busy",
		});
	});

	it("refuses changes that depend on each other in a circle", () => {
		const changes = [
			change("a", { kind: "item.subIssue", parent: { pending: "b" }, child: { key: ITEM } }),
			change("b", { kind: "item.blockedBy", target: { pending: "a" }, blockedBy: { key: ITEM } }),
		];
		expect(planPush(changes, ["a", "b"], none, noneCreated)).toMatchObject({
			ok: false,
			reason: "missing_dependency",
		});
	});

	it("keeps malformed changes in the plan, marked as not pushable", () => {
		const bad = change("bad", { kind: "issue.create", repo: REPO, title: "" });
		const worse = change("worse", { kind: "item.labels" } as unknown as Operation);
		const plan = planPush([bad, worse], ["bad", "worse"], none, noneCreated);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.ordered.map((item) => [item.op, item.error])).toEqual([
			[null, expect.stringContaining("title")],
			[null, expect.stringContaining("Tack can't push this change")],
		]);
	});
});

describe("checkOperation", () => {
	it("accepts every kind of operation", () => {
		const ops: Operation[] = [
			{
				kind: "issue.create",
				repo: REPO,
				title: "T",
				body: "B",
				labels: ["bug"],
				assignees: ["alice"],
			},
			{ kind: "item.labels", target: { key: ITEM }, add: ["a"], remove: ["b"] },
			{ kind: "item.milestone", target: { key: ITEM }, milestone: null },
			{ kind: "item.assignees", target: { pending: "x" }, add: ["alice"] },
			{ kind: "item.state", target: { key: ITEM }, state: "closed", reason: "not_planned" },
			{ kind: "item.subIssue", parent: { key: ITEM }, child: { key: `${REPO}#13` } },
			{ kind: "item.blockedBy", target: { key: ITEM }, blockedBy: { key: `${REPO}#13` } },
			{ kind: "item.comment", target: { key: ITEM }, body: "Hello" },
			{
				kind: "pr.create",
				repo: REPO,
				title: "ADR",
				body: "",
				branch: "tack/adr-1",
				files: [{ path: "docs/decisions/0001-x.md", content: "# X" }],
			},
			{ kind: "discussion.create", repo: REPO, category: "Ideas", title: "T", body: "B" },
		];
		for (const op of ops) expect(checkOperation(op)).toMatchObject({ ok: true });
	});

	it("rejects what GitHub would, or what isn't an operation", () => {
		expect(checkOperation({ kind: "item.labels", target: { key: "nope" } })).toMatchObject({
			ok: false,
		});
		expect(
			checkOperation({ kind: "item.assignees", target: { key: ITEM }, add: ["-bad"] }),
		).toMatchObject({
			ok: false,
		});
		expect(checkOperation({ kind: "repo.delete", repo: REPO })).toMatchObject({ ok: false });
		expect(checkOperation(null)).toMatchObject({ ok: false });
	});
});

describe("writeRepo and summarize", () => {
	it("finds the repository of a change about an issue the push creates", () => {
		const byId = new Map([["p", { op: create("Parent") }]]);
		const op: Operation = { kind: "item.comment", target: { pending: "p" }, body: "Hi" };
		expect(writeRepo(op, byId)).toBe(REPO);
		expect(summarize(op, byId)).toBe("Comment on new issue “Parent”");
	});

	it("describes each kind in one line", () => {
		expect(summarize(create("Fix it"))).toBe("Create issue “Fix it” in acme/widgets");
		expect(
			summarize({ kind: "item.labels", target: { key: ITEM }, add: ["a"], remove: ["b"] }),
		).toBe("Label acme/widgets#12: +a, −b");
		expect(
			summarize({
				kind: "item.state",
				target: { key: ITEM },
				state: "closed",
				reason: "not_planned",
			}),
		).toBe("Close acme/widgets#12 as not planned");
		expect(summarize({ kind: "item.labels" } as unknown as Operation)).toBe("A change");
	});
});

describe("reflects", () => {
	it("confirms labels and assignees once added ones show and removed ones don't", () => {
		const op: Operation = {
			kind: "item.labels",
			target: { key: ITEM },
			add: ["Bug"],
			remove: ["wontfix"],
		};
		expect(reflects(op, card())).toBe(true);
		expect(reflects(op, card({ labels: [] }))).toBe(false);
		expect(
			reflects(
				op,
				card({
					labels: [
						{ name: "bug", color: "" },
						{ name: "wontfix", color: "" },
					],
				}),
			),
		).toBe(false);
		const assign: Operation = {
			kind: "item.assignees",
			target: { key: ITEM },
			add: ["alice"],
			remove: ["bob"],
		};
		expect(reflects(assign, card())).toBe(true);
		expect(reflects(assign, card({ assignees: [] }))).toBe(false);
	});

	it("confirms state and close reasons", () => {
		const close: Operation = {
			kind: "item.state",
			target: { key: ITEM },
			state: "closed",
			reason: "not_planned",
		};
		expect(reflects(close, card())).toBe(false);
		expect(reflects(close, card({ state: "closed", stateReason: "not_planned" }))).toBe(true);
		expect(reflects(close, card({ state: "closed", stateReason: "completed" }))).toBe(false);
		// Pull requests have no close reason.
		expect(reflects(close, card({ kind: "pull", state: "closed", stateReason: null }))).toBe(true);
		const reopen: Operation = { kind: "item.state", target: { key: ITEM }, state: "open" };
		expect(reflects(reopen, card({ state: "draft", kind: "pull" }))).toBe(true);
		expect(reflects(reopen, card({ state: "closed" }))).toBe(false);
	});

	it("confirms creates by the created item's card, and says when no card could show a change", () => {
		const missing: MissingCard = { key: ITEM, missing: true, reason: "not_found" };
		expect(reflects(create("New"), card())).toBe(true);
		expect(reflects(create("New"), missing)).toBe(false);
		expect(reflects({ kind: "item.comment", target: { key: ITEM }, body: "x" }, card())).toBeNull();
		expect(
			reflects({ kind: "item.milestone", target: { key: ITEM }, milestone: "v1" }, card()),
		).toBeNull();
	});

	it("watches the created item for creates and the target for changes", () => {
		expect(confirmationKey(create("New"), `${REPO}#40`)).toBe(`${REPO}#40`);
		expect(confirmationKey({ kind: "item.labels", target: { key: ITEM.toUpperCase() } })).toBe(
			ITEM,
		);
		expect(confirmationKey({ kind: "item.comment", target: { key: ITEM }, body: "x" })).toBeNull();
	});
});
