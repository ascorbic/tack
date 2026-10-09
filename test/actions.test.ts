import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	blockEnds,
	boardRepos,
	canWrite,
	issueFromText,
	pendingIssueFor,
	presenceOf,
	setEdits,
	stageBlockedBy,
	stageComments,
	stageParentIssue,
	stageSetEdits,
	stageStickyIssues,
	stageTriage,
} from "../src/shared/actions.ts";
import {
	type Operation,
	type Stager,
	changesMap,
	listChanges,
	pendingDependencies,
	unstageChanges,
} from "../src/shared/changes.ts";
import { addShape, transactLocal } from "../src/shared/shapes.ts";
import { History } from "../src/client/undo.ts";

const PRIYA: Stager = { login: "priya", name: "Priya Shah", color: "#b4467a" };
const KAI: Stager = { login: "kai", name: "Kai Andersen" };
const REPO = "github.com/acme/imagekit";

function board() {
	const doc = new Y.Doc();
	const add = (id: string, props: Parameters<typeof addShape>[2]) =>
		transactLocal(doc, () => addShape(doc, id, props));
	return { doc, add };
}

const sticky = (text: string) => ({ type: "sticky" as const, text, x: 0, y: 0, z: "a0" });
const card = (ref: string) => ({ type: "card" as const, ref, x: 0, y: 0, z: "a0" });
const ops = (doc: Y.Doc): Operation[] => listChanges(doc).map((change) => change.op);

const histories: History[] = [];
afterEach(() => {
	for (const h of histories.splice(0)) h.destroy();
});

describe("issueFromText", () => {
	it("takes the first line as the title and the rest as the body", () => {
		expect(issueFromText("Drop Node 18\nIt's EOL in April.\n\nLet's go.")).toEqual({
			title: "Drop Node 18",
			body: "It's EOL in April.\n\nLet's go.",
		});
		expect(issueFromText("  Just a title  ")).toEqual({ title: "Just a title" });
	});

	it("skips blank lines and list or heading markers", () => {
		expect(issueFromText("\n\n- Fix the docs\n")).toEqual({ title: "Fix the docs" });
		expect(issueFromText("## Ideas\n* one")).toEqual({ title: "Ideas", body: "* one" });
		expect(issueFromText("[ ] Ship it")).toEqual({ title: "Ship it" });
	});

	it("is null for an empty sticky", () => {
		expect(issueFromText("")).toBeNull();
		expect(issueFromText(" \n \n")).toBeNull();
	});

	it("cuts long titles at a word, keeping the whole line in the body", () => {
		const line = `${"word ".repeat(80)}end`;
		const issue = issueFromText(`${line}\nmore`);
		expect(issue?.title.length).toBeLessThanOrEqual(256);
		expect(issue?.title.endsWith("word…")).toBe(true);
		expect(issue?.body).toBe(`${line}\n\nmore`);
	});
});

describe("stickies to issues", () => {
	it("stages an issue for each sticky that replaces it in place", () => {
		const { doc, add } = board();
		add("s1", sticky("Better errors\nWith codes"));
		add("s2", sticky("A logo?"));
		const result = stageStickyIssues(
			doc,
			[
				{ id: "s1", text: "Better errors\nWith codes" },
				{ id: "s2", text: "A logo?" },
			],
			REPO,
			PRIYA,
		);
		expect(result.staged).toHaveLength(2);
		const changes = listChanges(doc);
		expect(changes.map((c) => c.op)).toEqual([
			{ kind: "issue.create", repo: REPO, title: "Better errors", body: "With codes" },
			{ kind: "issue.create", repo: REPO, title: "A logo?" },
		]);
		expect(changes[0]?.effect).toEqual({ kind: "replace", shapes: ["s1"] });
		expect(changes[0]?.shapes).toEqual(["s1"]);
		expect(changes[0]?.stagedBy).toEqual(PRIYA);
		expect(changes.every((c) => c.status === "staged" && c.included)).toBe(true);
		expect(pendingIssueFor(doc, "s2")?.id).toBe(result.staged[1]);
	});

	it("skips empty stickies and stickies already staged", () => {
		const { doc } = board();
		stageStickyIssues(doc, [{ id: "s1", text: "Once" }], REPO, PRIYA);
		const again = stageStickyIssues(
			doc,
			[
				{ id: "s1", text: "Once" },
				{ id: "s2", text: "  " },
			],
			REPO,
			KAI,
		);
		expect(again.staged).toEqual([]);
		expect(again.skipped).toEqual([
			{ shape: "s1", reason: "staged" },
			{ shape: "s2", reason: "empty" },
		]);
		expect(listChanges(doc)).toHaveLength(1);
	});

	it("is one undo step", () => {
		const { doc } = board();
		const history = new History(doc);
		histories.push(history);
		stageStickyIssues(
			doc,
			[
				{ id: "s1", text: "One" },
				{ id: "s2", text: "Two" },
			],
			REPO,
			PRIYA,
		);
		expect(listChanges(doc)).toHaveLength(2);
		history.undo();
		expect(listChanges(doc)).toHaveLength(0);
		history.redo();
		expect(listChanges(doc)).toHaveLength(2);
	});
});

describe("parent issues", () => {
	it("stages a parent, issues for stickies and sub-issue links for everything", () => {
		const { doc } = board();
		const result = stageParentIssue(
			doc,
			{ repo: REPO, title: " Now ", shapes: ["section"] },
			[
				{ shape: "c1", card: { key: `${REPO}#412`, kind: "issue" } },
				{ shape: "c2", card: { key: `${REPO}#418`, kind: "pull" } },
				{ shape: "s1", sticky: "Write the migration guide\nfirst" },
				{ shape: "s2", sticky: "" },
			],
			PRIYA,
		);
		expect(result.children).toBe(2);
		expect(result.skipped).toEqual([
			{ shape: "c2", reason: "pull" },
			{ shape: "s2", reason: "empty" },
		]);
		const changes = listChanges(doc);
		const parent = changes.find((c) => c.id === result.parent);
		expect(parent?.op).toEqual({ kind: "issue.create", repo: REPO, title: "Now" });
		expect(parent?.shapes).toEqual(["section"]);
		expect(parent?.effect).toBeUndefined();
		const child = changes.find(
			(c) => c.op.kind === "issue.create" && c.op.title === "Write the migration guide",
		);
		expect(child?.effect).toEqual({ kind: "replace", shapes: ["s1"] });
		const links = changes.filter((c) => c.op.kind === "item.subIssue").map((c) => c.op);
		expect(links).toEqual([
			{ kind: "item.subIssue", parent: { pending: result.parent }, child: { key: `${REPO}#412` } },
			{ kind: "item.subIssue", parent: { pending: result.parent }, child: { pending: child?.id } },
		]);
		// Links can only be pushed with the issues they need.
		expect(pendingDependencies(links[1] as Operation)).toEqual([result.parent, child?.id]);
	});

	it("reuses stickies already staged as issues", () => {
		const { doc } = board();
		const [staged] = stageStickyIssues(doc, [{ id: "s1", text: "Docs" }], REPO, PRIYA).staged;
		const result = stageParentIssue(
			doc,
			{ repo: REPO, title: "Parent" },
			[{ shape: "s1", sticky: "Docs" }],
			PRIYA,
		);
		expect(result.staged).toHaveLength(2);
		const link = ops(doc).find((op) => op.kind === "item.subIssue");
		expect(link).toMatchObject({ child: { pending: staged } });
	});

	it("needs a title", () => {
		const { doc } = board();
		const result = stageParentIssue(doc, { repo: REPO, title: "  " }, [], PRIYA);
		expect(result.parent).toBeNull();
		expect(listChanges(doc)).toEqual([]);
	});
});

describe("blocked-by", () => {
	function connected(from: string, to: string, arrow?: "both") {
		const b = board();
		b.add("conn", {
			type: "connector",
			x: 0,
			y: 0,
			z: "a1",
			from: { x: 0, y: 0, shape: from },
			to: { x: 0, y: 0, shape: to },
			arrow,
		});
		return b;
	}

	it("reads a connector's ends as items", () => {
		const { doc, add } = connected("c1", "c2", "both");
		add("c1", card(`${REPO}#412`));
		add("c2", card(`${REPO}#418`));
		const kinds: Record<string, "issue" | "pull"> = { [`${REPO}#412`]: "issue" };
		const ends = blockEnds(doc, "conn", (key) => kinds[key]);
		expect(ends?.arrow).toBe("both");
		expect(ends?.from).toEqual({
			shape: "c1",
			key: `${REPO}#412`,
			label: "#412",
			target: { key: `${REPO}#412` },
		});
		// Still loading: no kind yet.
		expect(ends?.to.problem).toBe("loading");
		kinds[`${REPO}#418`] = "pull";
		expect(blockEnds(doc, "conn", (key) => kinds[key])?.to.problem).toBe("pull");
	});

	it("takes stickies once they're staged as issues", () => {
		const { doc, add } = connected("c1", "s1");
		add("c1", card(`${REPO}#412`));
		add("s1", sticky("Benchmarks in CI"));
		const kindOf = () => "issue" as const;
		expect(blockEnds(doc, "conn", kindOf)?.to).toEqual({
			shape: "s1",
			label: "Benchmarks in CI",
			problem: "sticky",
		});
		const [pending] = stageStickyIssues(
			doc,
			[{ id: "s1", text: "Benchmarks in CI" }],
			REPO,
			PRIYA,
		).staged;
		expect(blockEnds(doc, "conn", kindOf)?.to.target).toEqual({ pending });
	});

	it("reads loose ends and other shapes as unusable", () => {
		const { doc, add } = connected("t1", "gone");
		add("t1", { type: "text", text: "hi", x: 0, y: 0, z: "a0" });
		const ends = blockEnds(doc, "conn", () => "issue");
		expect(ends?.from.problem).toBe("unsupported");
		expect(ends?.to.problem).toBe("loose");
		expect(blockEnds(doc, "missing", () => "issue")).toBeNull();
	});

	it("stages the link once, with the connector as its effect", () => {
		const { doc } = board();
		const link = {
			blocked: { key: `${REPO}#418` },
			blocker: { key: `${REPO}#412` },
			connector: "conn",
			shapes: ["c1", "c2"],
		};
		const id = stageBlockedBy(doc, link, PRIYA);
		expect(stageBlockedBy(doc, link, KAI)).toBe(id);
		const [change] = listChanges(doc);
		expect(change?.op).toEqual({
			kind: "item.blockedBy",
			target: { key: `${REPO}#418` },
			blockedBy: { key: `${REPO}#412` },
		});
		expect(change?.effect).toEqual({ kind: "connect", shape: "conn" });
		// The other way round is a different link.
		expect(
			stageBlockedBy(doc, { ...link, blocked: link.blocker, blocker: link.blocked }, PRIYA),
		).not.toBe(id);
	});
});

describe("triage", () => {
	const A = `${REPO}#1`;
	const B = `${REPO}#2`;

	it("stages one change per item", () => {
		const { doc } = board();
		stageTriage(
			doc,
			[{ key: A, shape: "c1" }, { key: B }],
			{ kind: "item.milestone", milestone: "5.0" },
			PRIYA,
		);
		expect(ops(doc)).toEqual([
			{ kind: "item.milestone", target: { key: A }, milestone: "5.0" },
			{ kind: "item.milestone", target: { key: B }, milestone: "5.0" },
		]);
		expect(listChanges(doc)[0]?.shapes).toEqual(["c1"]);
	});

	it("replaces your own staged milestone or state rather than adding another", () => {
		const { doc } = board();
		stageTriage(
			doc,
			[{ key: A }],
			{ kind: "item.state", state: "closed", reason: "not_planned" },
			PRIYA,
		);
		stageTriage(
			doc,
			[{ key: A }],
			{ kind: "item.state", state: "closed", reason: "completed" },
			PRIYA,
		);
		expect(ops(doc)).toEqual([
			{ kind: "item.state", target: { key: A }, state: "closed", reason: "completed" },
		]);
		// Someone else's edit is their own.
		stageTriage(doc, [{ key: A }], { kind: "item.state", state: "open", reason: "duplicate" }, KAI);
		expect(ops(doc)[1]).toEqual({ kind: "item.state", target: { key: A }, state: "open" });
	});

	it("merges label edits, and unstages edits that cancel out", () => {
		const { doc } = board();
		stageTriage(doc, [{ key: A }], { kind: "item.labels", add: ["bug", "docs"] }, PRIYA);
		stageTriage(
			doc,
			[{ key: A }],
			{ kind: "item.labels", add: ["breaking"], remove: ["docs"] },
			PRIYA,
		);
		expect(ops(doc)).toEqual([
			{ kind: "item.labels", target: { key: A }, add: ["bug", "breaking"], remove: ["docs"] },
		]);
		stageTriage(doc, [{ key: A }], { kind: "item.labels", remove: ["bug", "breaking"] }, PRIYA);
		stageTriage(doc, [{ key: A }], { kind: "item.labels", add: ["docs"] }, PRIYA);
		expect(ops(doc)).toEqual([
			{ kind: "item.labels", target: { key: A }, add: ["docs"], remove: ["bug", "breaking"] },
		]);
	});

	it("doesn't stage empty edits", () => {
		const { doc } = board();
		expect(stageTriage(doc, [{ key: A }], { kind: "item.assignees" }, PRIYA)).toEqual([]);
		expect(listChanges(doc)).toEqual([]);
	});

	it("leaves pushed changes alone", () => {
		const { doc } = board();
		const [id] = stageTriage(
			doc,
			[{ key: A }],
			{ kind: "item.milestone", milestone: "5.0" },
			PRIYA,
		);
		changesMap(doc)
			.get(id as string)
			?.set("status", "sending");
		stageTriage(doc, [{ key: A }], { kind: "item.milestone", milestone: null }, PRIYA);
		expect(ops(doc)).toHaveLength(2);
		unstageChanges(doc, [id as string]);
		expect(ops(doc)).toHaveLength(2);
	});

	it("works out set edits from what each item has", () => {
		const items = [
			{ key: A, names: ["bug", "docs"] },
			{ key: B, names: ["docs"] },
		];
		expect(
			presenceOf(
				items.map((i) => i.names),
				"docs",
			),
		).toBe("all");
		expect(
			presenceOf(
				items.map((i) => i.names),
				"bug",
			),
		).toBe("some");
		expect(
			presenceOf(
				items.map((i) => i.names),
				"provider",
			),
		).toBe("none");
		const chosen = new Map([
			["bug", "some" as const],
			["docs", "none" as const],
			["provider", "all" as const],
		]);
		expect(setEdits(items, chosen)).toEqual([
			{ key: A, add: ["provider"], remove: ["docs"] },
			{ key: B, add: ["provider"], remove: ["docs"] },
		]);
		expect(setEdits(items, new Map([["docs", "all" as const]]))).toEqual([]);
		const { doc } = board();
		stageSetEdits(doc, "item.assignees", [{ key: A, add: ["kai"], remove: [] }], PRIYA);
		expect(ops(doc)).toEqual([{ kind: "item.assignees", target: { key: A }, add: ["kai"] }]);
	});
});

describe("other helpers", () => {
	it("stages comments", () => {
		const { doc } = board();
		stageComments(doc, [{ key: `${REPO}#1`, body: "hi", shape: "c1" }], PRIYA);
		expect(listChanges(doc)[0]).toMatchObject({
			op: { kind: "item.comment", target: { key: `${REPO}#1` }, body: "hi" },
			shapes: ["c1"],
		});
	});

	it("lists the board's repositories, most cards first", () => {
		const { doc, add } = board();
		add("a", card("github.com/b/two#1"));
		add("b", card("github.com/a/one#1"));
		add("c", card("github.com/b/two#2"));
		add("d", sticky("x"));
		expect(boardRepos(doc)).toEqual([
			{ repo: "github.com/b/two", cards: 2 },
			{ repo: "github.com/a/one", cards: 1 },
		]);
	});

	it("only offers writes the forge supports", () => {
		expect(canWrite(null, "item.labels")).toBe(true);
		expect(canWrite({}, "item.labels")).toBe(true);
		expect(canWrite({ writes: ["issue.create"] }, "item.labels")).toBe(false);
		expect(canWrite({ writes: ["issue.create"] }, "issue.create")).toBe(true);
	});
});
