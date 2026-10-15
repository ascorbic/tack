import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	editStagedIssue,
	stageParentIssue,
	stageSetEdits,
	stageStickyIssues,
} from "../src/shared/actions.ts";
import { type Stager, changesMap, listChanges } from "../src/shared/changes.ts";
import { LOCAL_ORIGIN, addShape, transactLocal } from "../src/shared/shapes.ts";
import {
	MAX_ASSIGNEES,
	type Volunteer,
	assignsByLogin,
	moveVolunteers,
	namesInWords,
	planAssignments,
	readVolunteers,
	staleVolunteers,
	stickyAssignees,
	toggleVolunteer,
	unstageVolunteered,
	volunteersMap,
	volunteersOn,
} from "../src/shared/volunteers.ts";

const KAI = { login: "kai", name: "Kai Andersen", color: "#1f7a6b" };
const PRIYA = { login: "Priya", name: "Priya Shah", color: "#b4467a" };
const TOM = { login: "tom", name: "Tom Okafor", color: "#a35a12" };
const STAGER: Stager = { login: "jo", name: "Jo Rivera" };
const REPO = "github.com/emdash/emdash";

function sticky(doc: Y.Doc, id: string, text: string, x = 0): void {
	addShape(doc, id, { type: "sticky", text, x, y: 0, z: "a0" });
}

const volunteer = (person: typeof KAI, at = "2026-10-14T10:00:00Z"): Volunteer => ({
	shape: "card",
	...person,
	at,
});

describe("volunteering", () => {
	it("puts a hand up, and takes it down again", () => {
		const doc = new Y.Doc();
		expect(toggleVolunteer(doc, "card", KAI)).toBe(true);
		expect(volunteersOn(doc, "card").map((v) => v.login)).toEqual(["kai"]);
		expect(toggleVolunteer(doc, "card", KAI)).toBe(false);
		expect(volunteersOn(doc, "card")).toEqual([]);
	});

	it("is for people signed in only: a volunteer is a login", () => {
		const doc = new Y.Doc();
		expect(toggleVolunteer(doc, "card", { name: "A guest", color: "#000" })).toBe(false);
		expect(volunteersMap(doc).size).toBe(0);
	});

	it("keys hands by login whatever its case, so two tabs don't make two", () => {
		const doc = new Y.Doc();
		toggleVolunteer(doc, "card", PRIYA);
		expect(toggleVolunteer(doc, "card", { ...PRIYA, login: "priya" })).toBe(false);
		expect(volunteersMap(doc).size).toBe(0);
	});

	it("keeps only https avatars", () => {
		const doc = new Y.Doc();
		toggleVolunteer(doc, "a", { ...KAI, avatarUrl: "https://avatars.example/kai.png" });
		toggleVolunteer(doc, "b", { ...KAI, avatarUrl: "javascript:alert(1)" });
		expect(volunteersOn(doc, "a")[0]?.avatar).toBe("https://avatars.example/kai.png");
		expect(volunteersOn(doc, "b")[0]?.avatar).toBeUndefined();
	});

	it("lists each shape's in the order hands went up, and skips anything malformed", () => {
		const doc = new Y.Doc();
		toggleVolunteer(doc, "card", TOM, "2026-10-14T10:05:00Z");
		toggleVolunteer(doc, "card", KAI, "2026-10-14T10:01:00Z");
		toggleVolunteer(doc, "other", PRIYA, "2026-10-14T10:02:00Z");
		volunteersMap(doc).set("junk", { shape: "card" } as unknown as Volunteer);
		const read = readVolunteers(volunteersMap(doc).entries());
		expect(read.get("card")?.map((v) => v.login)).toEqual(["kai", "tom"]);
		expect(read.get("other")?.map((v) => v.login)).toEqual(["Priya"]);
	});

	it("two people volunteering at once both count", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		toggleVolunteer(a, "card", KAI);
		toggleVolunteer(b, "card", TOM);
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		expect(
			volunteersOn(a, "card")
				.map((v) => v.login)
				.sort(),
		).toEqual(["kai", "tom"]);
		expect(volunteersOn(b, "card")).toEqual(volunteersOn(a, "card"));
	});

	it("moves a sticky's volunteers onto the card it became, keeping the earlier hand", () => {
		const doc = new Y.Doc();
		toggleVolunteer(doc, "sticky", KAI, "2026-10-14T10:00:00Z");
		toggleVolunteer(doc, "sticky", TOM, "2026-10-14T10:03:00Z");
		toggleVolunteer(doc, "card", TOM, "2026-10-14T10:01:00Z");
		expect(moveVolunteers(doc, new Set(["sticky"]), "card")).toBe(2);
		expect(volunteersOn(doc, "sticky")).toEqual([]);
		const moved = volunteersOn(doc, "card");
		expect(moved.map((v) => [v.login, v.at])).toEqual([
			["kai", "2026-10-14T10:00:00Z"],
			["tom", "2026-10-14T10:01:00Z"],
		]);
	});

	it("finds the volunteers of shapes that are gone", () => {
		const doc = new Y.Doc();
		toggleVolunteer(doc, "here", KAI);
		toggleVolunteer(doc, "gone", KAI);
		expect(staleVolunteers(doc, new Set(["here"]))).toEqual(["gone\n@kai"]);
	});

	it("names you first", () => {
		expect(namesInWords([volunteer(KAI), volunteer(TOM)], "TOM")).toBe("You, Kai Andersen");
		expect(namesInWords([volunteer(KAI)], null)).toBe("Kai Andersen");
	});
});

describe("assigning volunteers", () => {
	it("only maps logins onto GitHub (and the test forge that stands in for it)", () => {
		expect(assignsByLogin("github.com/emdash/emdash")).toBe(true);
		expect(assignsByLogin("fake.tack/acme/unpic#4")).toBe(true);
		expect(assignsByLogin("gitlab.com/emdash/emdash")).toBe(false);
		expect(assignsByLogin("codeberg.org/emdash/emdash")).toBe(false);
	});

	it("adds every volunteer the item doesn't have, and never takes anyone off", () => {
		const plan = planAssignments([
			{
				key: `${REPO}#4`,
				shape: "card",
				volunteers: [volunteer(KAI), volunteer(PRIYA), volunteer(TOM)],
				current: ["ana"],
				staged: ["ana", "priya"],
				assignable: null,
			},
		]);
		expect(plan.edits).toEqual([
			{ key: `${REPO}#4`, shape: "card", add: ["kai", "tom"], current: ["ana"] },
		]);
		expect(plan.leftOut).toEqual([]);
	});

	it("leaves out who the repository won't let be assigned, and says so", () => {
		const plan = planAssignments([
			{
				key: `${REPO}#4`,
				shape: "card",
				volunteers: [volunteer(KAI), volunteer(TOM)],
				current: [],
				staged: [],
				assignable: ["KAI"],
			},
		]);
		expect(plan.edits[0]?.add).toEqual(["kai"]);
		expect(plan.leftOut.map((l) => [l.volunteer.login, l.reason])).toEqual([
			["tom", "unassignable"],
		]);
	});

	it("stops at GitHub's limit", () => {
		const already = Array.from({ length: MAX_ASSIGNEES - 1 }, (_, i) => `p${i}`);
		const plan = planAssignments([
			{
				key: `${REPO}#4`,
				shape: "card",
				volunteers: [volunteer(KAI), volunteer(TOM)],
				current: already,
				staged: already,
				assignable: null,
			},
		]);
		expect(plan.edits[0]?.add).toEqual(["kai"]);
		expect(plan.leftOut.map((l) => l.reason)).toEqual(["full"]);
	});

	it("has nothing to do when everyone's assigned", () => {
		const plan = planAssignments([
			{
				key: `${REPO}#4`,
				shape: "card",
				volunteers: [volunteer(KAI)],
				current: ["Kai"],
				staged: ["Kai"],
				assignable: null,
			},
		]);
		expect(plan).toEqual({ edits: [], leftOut: [] });
	});

	it("makes a sticky's issue with its volunteers, after who was picked", () => {
		const volunteers = [volunteer(KAI), volunteer(TOM), volunteer(PRIYA)];
		expect(stickyAssignees(volunteers, REPO, ["ana", "kai"], ["kai", "tom", "ana"])).toEqual([
			"ana",
			"kai",
			"tom",
		]);
		// Unknown: everyone's tried.
		expect(stickyAssignees(volunteers, REPO, [], null)).toEqual(["kai", "tom", "Priya"]);
		// Not GitHub: logins there could be someone else's.
		expect(stickyAssignees(volunteers, "gitlab.com/emdash/emdash", ["ana"], null)).toEqual(["ana"]);
	});

	it("carries a sticky's volunteers into Make issues", () => {
		const doc = new Y.Doc();
		sticky(doc, "s1", "Write the migration guide");
		sticky(doc, "s2", "A provider playground", 300);
		toggleVolunteer(doc, "s1", KAI);
		toggleVolunteer(doc, "s1", TOM);
		stageStickyIssues(
			doc,
			[
				{ id: "s1", text: "Write the migration guide" },
				{ id: "s2", text: "A provider playground" },
			],
			REPO,
			STAGER,
			{ labels: ["docs"], assignees: ["ana"] },
			{ assignable: ["ana", "kai"] },
		);
		const ops = listChanges(doc).map((change) => change.op);
		expect(ops).toEqual([
			{
				kind: "issue.create",
				repo: REPO,
				title: "Write the migration guide",
				labels: ["docs"],
				assignees: ["ana", "kai"],
			},
			{
				kind: "issue.create",
				repo: REPO,
				title: "A provider playground",
				labels: ["docs"],
				assignees: ["ana"],
			},
		]);
	});

	it("carries a sticky's volunteers into a parent issue's new sub-issues", () => {
		const doc = new Y.Doc();
		sticky(doc, "s1", "Write the migration guide");
		toggleVolunteer(doc, "s1", KAI);
		stageParentIssue(
			doc,
			{ repo: REPO, title: "5.0", shapes: ["s1"], near: "children" },
			[{ shape: "s1", sticky: "Write the migration guide" }],
			STAGER,
		);
		const created = listChanges(doc).find(
			(change) => change.op.kind === "issue.create" && change.op.title !== "5.0",
		);
		expect(created?.op).toMatchObject({ assignees: ["kai"] });
	});
});

describe("withdrawing", () => {
	const KEY = `${REPO}#412`;

	function board(): Y.Doc {
		const doc = new Y.Doc();
		addShape(doc, "card", { type: "card", ref: KEY, x: 0, y: 0, z: "a0" });
		toggleVolunteer(doc, "card", KAI, "2026-10-14T10:00:00Z");
		toggleVolunteer(doc, "card", PRIYA, "2026-10-14T10:01:00Z");
		return doc;
	}

	/** "Assign volunteers", as the card's chip and the selection bar stage it. */
	function assignVolunteers(doc: Y.Doc, stager = STAGER): void {
		const add = volunteersOn(doc, "card").map((v) => v.login);
		stageSetEdits(
			doc,
			"item.assignees",
			[{ key: KEY, shape: "card", add, remove: [], volunteered: add }],
			stager,
		);
	}

	/** Withdraw, as the hand does: one transaction. */
	function withdraw(doc: Y.Doc, shape: string, person: typeof KAI) {
		return transactLocal(doc, () => {
			toggleVolunteer(doc, shape, person);
			return unstageVolunteered(doc, shape, person.login);
		});
	}

	it("takes only you out of the staged assignment, and the whole change with the last", () => {
		const doc = board();
		assignVolunteers(doc);
		const [change] = listChanges(doc);
		expect(change?.op).toMatchObject({ add: ["kai", "Priya"] });
		expect(change?.volunteered).toEqual(["kai", "Priya"]);

		expect(withdraw(doc, "card", KAI)).toEqual([{ change: change!.id, key: KEY, unstaged: false }]);
		expect(listChanges(doc).map((c) => [c.op, c.volunteered])).toEqual([
			[{ kind: "item.assignees", target: { key: KEY }, add: ["Priya"] }, ["Priya"]],
		]);

		// Logins aren't case-sensitive.
		expect(withdraw(doc, "card", { ...PRIYA, login: "priya" })).toEqual([
			{ change: change!.id, key: KEY, unstaged: true },
		]);
		expect(listChanges(doc)).toEqual([]);
	});

	it("is one undo step with the withdrawal, bringing back both", () => {
		const doc = board();
		assignVolunteers(doc);
		const undo = new Y.UndoManager(doc, {
			trackedOrigins: new Set([LOCAL_ORIGIN]),
			captureTimeout: 0,
		});
		withdraw(doc, "card", KAI);
		withdraw(doc, "card", PRIYA);
		expect(listChanges(doc)).toEqual([]);
		undo.undo();
		expect(volunteersOn(doc, "card").map((v) => v.login)).toEqual(["Priya"]);
		expect(listChanges(doc).map((c) => c.op)).toMatchObject([{ add: ["Priya"] }]);
		undo.undo();
		expect(volunteersOn(doc, "card").map((v) => v.login)).toEqual(["kai", "Priya"]);
		expect(listChanges(doc).map((c) => [c.op, c.volunteered])).toMatchObject([
			[{ add: ["kai", "Priya"] }, ["kai", "Priya"]],
		]);
	});

	it("leaves an assignment picked in the Assign picker", () => {
		const doc = board();
		// Someone else picked Kai, without his volunteering coming into it.
		stageSetEdits(doc, "item.assignees", [{ key: KEY, add: ["kai"], remove: [] }], {
			login: "ana",
			name: "Ana",
		});
		expect(withdraw(doc, "card", KAI)).toEqual([]);
		expect(listChanges(doc).map((c) => c.op)).toMatchObject([{ add: ["kai"] }]);
	});

	it("keeps the picked and takes out the volunteered from one merged change", () => {
		const doc = board();
		stageSetEdits(doc, "item.assignees", [{ key: KEY, add: ["ana"], remove: [] }], STAGER);
		assignVolunteers(doc);
		const [change] = listChanges(doc);
		expect(change?.op).toMatchObject({ add: ["ana", "kai", "Priya"] });
		expect(change?.volunteered).toEqual(["kai", "Priya"]);
		// Picking Priya herself makes her picked, not volunteered.
		stageSetEdits(doc, "item.assignees", [{ key: KEY, add: ["Priya"], remove: [] }], STAGER);
		expect(listChanges(doc)[0]?.volunteered).toEqual(["kai"]);

		withdraw(doc, "card", KAI);
		withdraw(doc, "card", PRIYA);
		expect(listChanges(doc).map((c) => [c.op, c.volunteered])).toEqual([
			[{ kind: "item.assignees", target: { key: KEY }, add: ["ana", "Priya"] }, undefined],
		]);
	});

	it("updates whoever staged it: it's the board's", () => {
		const doc = board();
		assignVolunteers(doc, { login: "ana", name: "Ana" });
		withdraw(doc, "card", KAI);
		expect(listChanges(doc).map((c) => c.op)).toMatchObject([{ add: ["Priya"] }]);
	});

	it("leaves what's on its way or pushed", () => {
		const doc = board();
		assignVolunteers(doc);
		const [change] = listChanges(doc);
		for (const status of ["sending", "sent", "applied"]) {
			changesMap(doc).get(change!.id)?.set("status", status);
			expect(withdraw(doc, "card", KAI)).toEqual([]);
			toggleVolunteer(doc, "card", KAI);
		}
		expect(listChanges(doc)[0]?.op).toMatchObject({ add: ["kai", "Priya"] });
		// A failed push wrote nothing: still yours to take back.
		changesMap(doc).get(change!.id)?.set("status", "failed");
		expect(withdraw(doc, "card", KAI)).toHaveLength(1);
	});

	it("keeps it while you're still volunteering on another card for the item", () => {
		const doc = board();
		addShape(doc, "again", { type: "card", ref: KEY, x: 400, y: 0, z: "a1" });
		toggleVolunteer(doc, "again", KAI);
		assignVolunteers(doc);
		expect(withdraw(doc, "card", KAI)).toEqual([]);
		expect(withdraw(doc, "again", KAI)).toHaveLength(1);
		expect(listChanges(doc)[0]?.op).toMatchObject({ add: ["Priya"] });
	});

	it("takes you out of a sticky's staged issue, not the issue, and leaves who was picked", () => {
		const doc = new Y.Doc();
		sticky(doc, "s1", "Write the migration guide");
		toggleVolunteer(doc, "s1", KAI);
		toggleVolunteer(doc, "s1", TOM);
		stageStickyIssues(doc, [{ id: "s1", text: "Write the migration guide" }], REPO, STAGER, {
			assignees: ["ana", "tom"],
		});
		const [issue] = listChanges(doc);
		expect(issue?.op).toMatchObject({ assignees: ["ana", "tom", "kai"] });
		expect(issue?.volunteered).toEqual(["kai"]);

		expect(withdraw(doc, "s1", KAI)).toEqual([{ change: issue!.id, key: null, unstaged: false }]);
		// Tom was picked as well as volunteering: picked stays.
		expect(withdraw(doc, "s1", TOM)).toEqual([]);
		expect(listChanges(doc).map((c) => [c.op, c.volunteered])).toEqual([
			[
				{
					kind: "issue.create",
					repo: REPO,
					title: "Write the migration guide",
					assignees: ["ana", "tom"],
				},
				undefined,
			],
		]);
	});

	it("leaves the issue with nobody assigned once its last volunteer withdraws", () => {
		const doc = new Y.Doc();
		sticky(doc, "s1", "Write the migration guide");
		toggleVolunteer(doc, "s1", KAI);
		stageParentIssue(
			doc,
			{ repo: REPO, title: "5.0", shapes: ["s1"], near: "children" },
			[{ shape: "s1", sticky: "Write the migration guide" }],
			STAGER,
		);
		withdraw(doc, "s1", KAI);
		const created = listChanges(doc).find(
			(change) => change.op.kind === "issue.create" && change.op.title !== "5.0",
		);
		expect(created?.op).toEqual({
			kind: "issue.create",
			repo: REPO,
			title: "Write the migration guide",
		});
		expect(listChanges(doc)).toHaveLength(3);
	});

	it("forgets a volunteer taken off in review, so adding them back counts as picked", () => {
		const doc = new Y.Doc();
		sticky(doc, "s1", "Write the migration guide");
		toggleVolunteer(doc, "s1", KAI);
		stageStickyIssues(doc, [{ id: "s1", text: "Write the migration guide" }], REPO, STAGER);
		const [issue] = listChanges(doc);
		editStagedIssue(doc, issue!.id, { assignees: [] });
		expect(listChanges(doc)[0]?.volunteered).toBeUndefined();
		editStagedIssue(doc, issue!.id, { assignees: ["kai"] });
		expect(withdraw(doc, "s1", KAI)).toEqual([]);
		expect(listChanges(doc)[0]?.op).toMatchObject({ assignees: ["kai"] });
	});
});
