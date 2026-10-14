import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { stageParentIssue, stageStickyIssues } from "../src/shared/actions.ts";
import { type Stager, listChanges } from "../src/shared/changes.ts";
import { addShape } from "../src/shared/shapes.ts";
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
