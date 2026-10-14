// Volunteers, end to end: hands up on an issue's card and on a sticky are
// board data only, until "Assign volunteers" and "Make issue" stage them as
// assignees, and a push through the real GitHub adapter assigns them. The
// sticky's volunteers move onto the card it becomes.

import type { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import { stageSetEdits, stageStickyIssues, withStaged } from "../src/shared/actions.ts";
import { type PendingChange, type Stager, listChanges } from "../src/shared/changes.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import {
	planAssignments,
	toggleVolunteer,
	volunteersMap,
	volunteersOn,
} from "../src/shared/volunteers.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const EMDASH = 1;
const REPO = "github.com/emdash/emdash";
const ISSUE = `${REPO}#4`;

const ANA: FakeUser = { id: 601, login: "ana", name: "Ana Lima", avatar_url: "https://a/ana" };
const STAGER: Stager = { id: 601, login: "ana", name: "Ana Lima", color: "#7444c4" };
const KAI = { login: "kai", name: "Kai Andersen", color: "#1f7a6b" };
const PRIYA = { login: "priya", name: "Priya Shah", color: "#b4467a" };
const TOM = { login: "tom", name: "Tom Okafor", color: "#a35a12" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function api(mf: Miniflare, path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	headers.set("cookie", cookie);
	if (init.body) {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

async function deliver(mf: Miniflare, github: FakeGitHub, event: string, payload: unknown) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign(github.app.webhook_secret, body),
		},
	});
	expect(response.status).toBe(202);
}

const statusOf = (client: BoardClient, id: string): PendingChange["status"] | undefined =>
	listChanges(client.doc).find((change) => change.id === id)?.status;

it("volunteers on a card and a sticky are assigned on GitHub once pushed, and only then", async () => {
	const github = new FakeGitHub();
	github.addRepo(EMDASH, "emdash/emdash", {
		writers: ["ana"],
		// Tom can't be assigned here: he's left a volunteer.
		assignable: ["ana", "kai", "priya"],
	});
	github.setItem(EMDASH, {
		number: 4,
		kind: "issue",
		title: "Slugs for every collection",
		updatedAt: "2026-10-01T00:00:00Z",
		assignees: ["ana"],
	});
	github.install(7, "emdash", ["emdash/emdash"]);

	const mf = startWorker({ devAuth: true, outboundService: github.fetch });
	cleanups.push(() => mf.dispose());
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	const ana = await signInWithGitHub(mf, github, ANA);
	const created = await api(mf, "/api/boards", ana, {
		method: "POST",
		body: JSON.stringify({ title: "Planning" }),
	});
	const { id: board } = (await created.json()) as { id: string };
	const connected = await connectBoard(mf, board, ana);
	if (!connected.ok) throw new Error(`connect: ${connected.status}`);
	const client = connected.client;
	cleanups.push(() => client.close());
	await (
		await boardStub(mf, board)
	).pushTiming({ spacingMs: 10, confirmMs: 60_000, backoffMs: 50 });
	const doc = client.doc;

	addShape(doc, "card", { type: "card", ref: ISSUE, x: 0, y: 0, z: "a0" });
	addShape(doc, "sticky", {
		type: "sticky",
		text: "Write the migration guide",
		x: 400,
		y: 0,
		z: "a1",
	});
	// Hands up: Kai and Priya (and Tom, who can't be assigned) for the
	// issue; Kai for the sticky.
	toggleVolunteer(doc, "card", KAI);
	toggleVolunteer(doc, "card", PRIYA);
	toggleVolunteer(doc, "card", TOM);
	toggleVolunteer(doc, "sticky", KAI);
	await client.roundTrip();
	// Board data only: nothing's gone to GitHub.
	expect(github.requests.filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"))).toEqual(
		[],
	);

	// Assign volunteers: added to who's there, Tom left out.
	const assignable = ["ana", "kai", "priya"];
	const plan = planAssignments([
		{
			key: ISSUE,
			shape: "card",
			volunteers: volunteersOn(doc, "card"),
			current: ["ana"],
			staged: withStaged(doc, ISSUE, "item.assignees", ["ana"]),
			assignable,
		},
	]);
	expect(plan.edits).toEqual([
		{ key: ISSUE, shape: "card", add: ["kai", "priya"], current: ["ana"] },
	]);
	expect(plan.leftOut.map((l) => [l.volunteer.login, l.reason])).toEqual([["tom", "unassignable"]]);
	const [assign] = stageSetEdits(
		doc,
		"item.assignees",
		plan.edits.map((edit) => ({ ...edit, remove: [] })),
		STAGER,
	);
	// Make issue: the sticky's volunteer comes along.
	const made = stageStickyIssues(
		doc,
		[{ id: "sticky", text: "Write the migration guide" }],
		REPO,
		STAGER,
		{},
		{ assignable },
	);
	const [create] = made.staged;
	await client.roundTrip();

	const pushed = await api(mf, `/api/boards/${board}/push`, ana, {
		method: "POST",
		body: JSON.stringify({ ids: [assign, create], as: "user" }),
	});
	expect(pushed.status).toBe(202);
	await eventually(
		() =>
			["sent", "applied"].includes(statusOf(client, assign!) ?? "") && !!statusOf(client, create!),
		15_000,
	);
	await deliver(mf, github, "issues", github.event(EMDASH, 4, "assigned"));
	await eventually(() => statusOf(client, assign!) === "applied", 15_000);
	await eventually(() => !shapesMap(doc).has("sticky"), 15_000);

	// GitHub: Ana kept, Kai and Priya added; the new issue made assigned to Kai.
	expect(new Set(github.item(EMDASH, 4)?.assignees)).toEqual(new Set(["ana", "kai", "priya"]));
	const guide = github.itemsIn(EMDASH).find((item) => item.title === "Write the migration guide");
	expect(guide?.assignees).toEqual(["kai"]);

	// The sticky's card has its volunteer now.
	const card = [...shapesMap(doc)].find(([, shape]) =>
		readShape(shape).ref?.endsWith(`#${guide?.number}`),
	);
	expect(card).toBeDefined();
	expect(volunteersOn(doc, card![0]).map((v) => v.login)).toEqual(["kai"]);
	expect([...volunteersMap(doc).values()].some((v) => v.shape === "sticky")).toBe(false);
});
