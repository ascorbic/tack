// The M2 exit (#36), end to end: one planning session on one board produces
// issues with labels, a parent issue with sub-issues, blocked-by, triage on
// an existing card, a decision written back as an ADR pull request that
// gets merged, and backlink comments with a snapshot on every issue, with
// no copying by hand. Everything is staged with the same functions the
// selection actions and the write-back dialog call, pushed through
// `POST /api/boards/:id/push` by someone signed in through (fake) GitHub,
// written by the real GitHub adapter, and confirmed by webhooks.
//
// docs/m2-exit.md is the same session by hand, against real GitHub.

import type { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import {
	blockEnds,
	sectionTitle,
	stageBlockedBy,
	stageComments,
	stageParentIssue,
	stageSetEdits,
	stageStickyIssues,
	stageTriage,
} from "../src/shared/actions.ts";
import {
	adrMarkdown,
	type AdrInput,
	nextAdrNumber,
	stagedRecordPaths,
	writeBackOperation,
} from "../src/shared/adr.ts";
import { backlinkBody } from "../src/shared/backlinks.ts";
import type { Card } from "../src/shared/cards.ts";
import { listChanges, type PendingChange, type Stager } from "../src/shared/changes.ts";
import {
	addDecision,
	castVote,
	linkedItems,
	setDecisionStatus,
	stageWriteBack,
} from "../src/shared/decisions.ts";
import type { AuditEntry, PushResponse } from "../src/shared/push.ts";
import { addShape, readShape, type ShapeProps, shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = 1;
const REPO = "github.com/acme/widgets";
const EXISTING = `${REPO}#12`;
const T0 = "2026-10-01T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const STAGER: Stager = { id: 501, login: "alice", name: "Alice", color: "#f97316" };

// A real 1×1 PNG, standing in for the snapshot the browser draws.
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function api(mf: Miniflare, path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	headers.set("cookie", cookie);
	if (init.body) {
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
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

/** Every write the fake GitHub took, as `METHOD path`, in order. */
const writes = (github: FakeGitHub) =>
	github.requests
		.filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"))
		.map((r) => `${r.method} ${r.path}`);

function shapeProps(client: BoardClient): Map<string, ShapeProps> {
	return new Map([...shapesMap(client.doc)].map(([id, shape]) => [id, readShape(shape)]));
}

function changes(client: BoardClient): Map<string, PendingChange> {
	return new Map(listChanges(client.doc).map((change) => [change.id, change]));
}

/** Wait until every one of these changes is applied, saying which aren't if they never are. */
async function allApplied(client: BoardClient, ids: string[], timeout = 15_000) {
	await eventually(
		() => ids.every((id) => changes(client).get(id)?.status === "applied"),
		timeout,
	).catch(() => {
		const stuck = ids
			.map((id) => changes(client).get(id))
			.filter((change) => change?.status !== "applied")
			.map((change) => `${change?.op.kind} ${change?.status} ${change?.error ?? ""}`);
		throw new Error(`Not applied: ${stuck.join("; ")}`);
	});
}

async function waitFor(client: BoardClient, id: string, statuses: PendingChange["status"][]) {
	await eventually(() => statuses.includes(changes(client).get(id)?.status ?? "staged"), 15_000);
}

it("one session produces issues, labels, a merged ADR and backlinks, with no copying by hand", async () => {
	// GitHub: a repository with the app installed, an open issue, and one
	// decision record already.
	const github = new FakeGitHub();
	github.addRepo(WIDGETS, "acme/widgets", {
		writers: ["alice"],
		labels: [
			{ name: "bug", color: "d73a4a" },
			{ name: "performance", color: "fbca04" },
		],
		milestones: ["v1"],
		files: { "docs/decisions/0001-record-architecture-decisions.md": "# 1. Record decisions\n" },
	});
	github.setItem(WIDGETS, { number: 12, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	github.install(7, "acme", ["acme/widgets"]);

	const mf = startWorker({ devAuth: true, outboundService: github.fetch });
	cleanups.push(() => mf.dispose());
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	const alice = await signInWithGitHub(mf, github, ALICE);
	const created = await api(mf, "/api/boards", alice, {
		method: "POST",
		body: JSON.stringify({ title: "Planning" }),
	});
	expect(created.status).toBe(201);
	const { id: board, slug } = (await created.json()) as { id: string; slug: string };
	const boardUrl = `${ORIGIN}/b/${board}/${slug}`;
	const connected = await connectBoard(mf, board, alice);
	if (!connected.ok) throw new Error(`connect: ${connected.status}`);
	const client = connected.client;
	cleanups.push(() => client.close());
	const stub = await boardStub(mf, board);
	await stub.pushTiming({ spacingMs: 10, confirmMs: 60_000, backoffMs: 50 });
	const doc = client.doc;

	// --- The session ---------------------------------------------------------------
	// The existing issue, a section of stickies, two loose stickies joined by
	// a connector, and a decision linked to the issue.
	addShape(doc, "card", { type: "card", ref: EXISTING, x: 900, y: 0, z: "a1" });
	addShape(doc, "section", {
		type: "section",
		x: 0,
		y: 0,
		z: "a0",
		w: 800,
		h: 400,
		title: "Resizing",
	});
	addShape(doc, "s1", {
		type: "sticky",
		x: 40,
		y: 60,
		z: "a2",
		parent: "section",
		text: "Wobble on resize\nHappens in Safari when the window narrows",
	});
	addShape(doc, "s2", {
		type: "sticky",
		x: 400,
		y: 60,
		z: "a3",
		parent: "section",
		text: "Snap back after a drag",
	});
	addShape(doc, "l1", { type: "sticky", x: 0, y: 500, z: "a4", text: "Faster cold starts" });
	addShape(doc, "l2", { type: "sticky", x: 300, y: 500, z: "a5", text: "Cache the manifest" });
	addShape(doc, "link", {
		type: "connector",
		x: 0,
		y: 0,
		z: "a6",
		from: { x: 0, y: 500, shape: "l1" },
		to: { x: 300, y: 500, shape: "l2" },
	});
	addDecision(doc, "decision", {
		x: 900,
		y: 300,
		title: "Store boards as Yjs documents",
		text: "Boards need offline edits that merge.",
		author: { name: "Alice", color: "#f97316" },
	});
	addShape(doc, "decided-about", {
		type: "connector",
		x: 0,
		y: 0,
		z: "a7",
		from: { x: 900, y: 300, shape: "decision" },
		to: { x: 900, y: 0, shape: "card" },
	});
	castVote(doc, "decision", { name: "Alice", login: "alice" }, "agree");
	castVote(doc, "decision", { name: "Bob", login: "bob" }, "agree");
	setDecisionStatus(doc, "decision", "decided", { by: { name: "Alice", color: "#f97316" } });
	await client.roundTrip();
	await eventually(async () => (await stub.liveCards()).some((card) => card.key === EXISTING));

	// Loose stickies become issues, labelled as they're made; the section, a
	// parent with the rest as sub-issues.
	const loose = stageStickyIssues(
		doc,
		[
			{ id: "l1", text: "Faster cold starts" },
			{ id: "l2", text: "Cache the manifest" },
		],
		REPO,
		STAGER,
		{ labels: ["performance"], milestone: "v1" },
	);
	expect(loose.staged).toHaveLength(2);
	expect(listChanges(doc).find((c) => c.id === loose.staged[0])?.op).toMatchObject({
		labels: ["performance"],
		milestone: "v1",
	});
	const parent = stageParentIssue(
		doc,
		{ repo: REPO, title: sectionTitle(doc, "section"), shapes: ["section"], near: ["section"] },
		[
			{ shape: "s1", sticky: "Wobble on resize\nHappens in Safari when the window narrows" },
			{ shape: "s2", sticky: "Snap back after a drag" },
		],
		STAGER,
	);
	expect(parent).toMatchObject({ children: 2, skipped: [] });

	// The connector: the arrow points from the blocker to what it blocks.
	const ends = blockEnds(doc, "link", () => "issue");
	expect(ends?.from.target && ends.to.target).toBeTruthy();
	const blocked = stageBlockedBy(
		doc,
		{
			blocked: ends!.to.target!,
			blocker: ends!.from.target!,
			connector: "link",
			shapes: ["l2", "l1"],
		},
		STAGER,
	);

	// Triage on the existing card.
	const triage = [
		...stageTriage(
			doc,
			[{ key: EXISTING, shape: "card", current: [] }],
			{ kind: "item.labels", add: ["bug"] },
			STAGER,
		),
		...stageTriage(
			doc,
			[{ key: EXISTING, shape: "card" }],
			{ kind: "item.milestone", milestone: "v1" },
			STAGER,
		),
		...stageTriage(
			doc,
			[{ key: EXISTING, shape: "card", current: [] }],
			{ kind: "item.assignees", add: ["alice"] },
			STAGER,
		),
	];

	// The decision, written back as the next numbered record, as the
	// write-back dialog does it.
	const files = (await (
		await api(mf, `/api/repos/files?repo=${REPO}&path=docs/decisions`, alice)
	).json()) as string[];
	expect(files).toEqual(["0001-record-architecture-decisions.md"]);
	const number = nextAdrNumber(files, stagedRecordPaths(listChanges(doc), REPO));
	expect(number).toBe(2);
	const existing = (await stub.liveCards()).find((card) => card.key === EXISTING) as Card;
	const decision = shapeProps(client).get("decision")!;
	const record: AdrInput = {
		title: decision.title ?? "",
		status: "decided",
		date: decision.decidedAt?.slice(0, 10) ?? "",
		context: decision.text ?? "",
		decision: "Each board is one Yjs document, saved in its Durable Object.",
		consequences: "Edits merge offline; the server keeps snapshots.",
		links: linkedItems(shapeProps(client), "decision").map((key) => ({
			key,
			title: existing.title,
			url: existing.url,
		})),
		boardUrl,
		votes: { agree: 2, disagree: 0 },
	};
	const pr = writeBackOperation(record, { kind: "pr", repo: REPO, number });
	const writeBack = stageWriteBack(doc, "decision", pr, STAGER)!;
	const adrPath = "docs/decisions/0002-store-boards-as-yjs-documents.md";
	expect(pr).toMatchObject({
		title: "ADR 0002: Store boards as Yjs documents",
		branch: "tack/adr-0002-store-boards-as-yjs-documents",
		files: [{ path: adrPath, content: adrMarkdown({ ...record, number: 2 }) }],
	});
	await client.roundTrip();

	// --- Push ----------------------------------------------------------------------
	const first = listChanges(doc).map((change) => change.id);
	expect(first).toHaveLength(2 + 5 + 1 + 3 + 1);
	const pushed = await api(mf, `/api/boards/${board}/push`, alice, {
		method: "POST",
		body: JSON.stringify({ ids: first, as: "user" }),
	});
	expect(pushed.status).toBe(202);
	const firstPush = ((await pushed.json()) as Extract<PushResponse, { ok: true }>).pushId;

	// GitHub's webhook for the triaged issue confirms its labels and assignee.
	const [labelChange] = triage;
	await waitFor(client, labelChange!, ["sent", "applied"]);
	await waitFor(client, triage[2]!, ["sent", "applied"]);
	await deliver(mf, github, "issues", github.event(WIDGETS, 12, "assigned"));
	await allApplied(client, first);

	// What GitHub has now: each issue once, with its sub-issues and blocker.
	const issues = github.itemsIn(WIDGETS);
	const byTitle = (title: string) => {
		const found = issues.filter((issue) => issue.title === title);
		expect(found, title).toHaveLength(1);
		return found[0]!;
	};
	const cold = byTitle("Faster cold starts");
	const manifest = byTitle("Cache the manifest");
	const resizing = byTitle("Resizing");
	const wobble = byTitle("Wobble on resize");
	const snap = byTitle("Snap back after a drag");
	expect(wobble.body).toBe("Happens in Safari when the window narrows");
	expect(issues).toHaveLength(7);
	const id = (n: number) => github.databaseId(WIDGETS, n);
	expect(new Set(github.subIssues.get(`${WIDGETS}#${resizing.number}`))).toEqual(
		new Set([id(wobble.number), id(snap.number)]),
	);
	expect(github.blockedBy.get(`${WIDGETS}#${manifest.number}`)).toEqual([id(cold.number)]);
	// Labelled in one push: made with them.
	for (const made of [cold, manifest]) {
		expect(github.item(WIDGETS, made.number)).toMatchObject({
			labels: [{ name: "performance", color: "fbca04" }],
			milestone: "v1",
		});
	}
	expect(github.item(WIDGETS, 12)).toMatchObject({
		labels: [{ name: "bug", color: "d73a4a" }],
		milestone: "v1",
		assignees: ["alice"],
	});

	// The ADR: a pull request from its own branch, adding exactly the record.
	const pull = issues.find((issue) => issue.kind === "pull")!;
	expect(pull).toMatchObject({
		title: "ADR 0002: Store boards as Yjs documents",
		state: "open",
		headRef: "tack/adr-0002-store-boards-as-yjs-documents",
	});
	expect(pull.body).toContain(`decided on [the Tack board](${boardUrl})`);
	const branch = github.filesOn(WIDGETS, pull.headRef!);
	expect([...(branch?.keys() ?? [])].sort()).toEqual([
		"docs/decisions/0001-record-architecture-decisions.md",
		adrPath,
	]);
	const adr = branch?.get(adrPath) ?? "";
	expect(adr).toBe(adrMarkdown({ ...record, number: 2 }));
	expect(adr).toMatch(/^# 2\. Store boards as Yjs documents\n/);
	expect(adr).toContain("## Status\n\nAccepted on");
	expect(adr).toContain("(2 agree, 0 disagree)");
	expect(adr).toContain(
		"- [acme/widgets#12: Widgets wobble](https://github.com/acme/widgets/issues/12)",
	);
	expect(adr).toContain(`- Decided on [the Tack board](${boardUrl})`);
	expect(github.filesOn(WIDGETS, "main")?.has(adrPath)).toBe(false);

	// The board caught up: every sticky is now its issue's card, in place,
	// the parent issue has a card above its section, joined to it, the
	// connector joins the cards, and the decision follows its pull request.
	const keyOf = (n: number) => `${REPO}#${n}`;
	await eventually(() => ["s1", "s2", "l1", "l2"].every((s) => !shapesMap(doc).has(s)));
	await eventually(() =>
		[...shapesMap(doc).values()].some((s) => s.get("ref") === keyOf(resizing.number)),
	);
	const shapes = shapeProps(client);
	const cardFor = (n: number) => [...shapes].find(([, s]) => s.ref === keyOf(n));
	const [parentCard, parentShape] = cardFor(resizing.number)!;
	expect(parentShape.type).toBe("card");
	expect(parentShape.parent ?? null).toBeNull();
	// Centred over the 800-wide section, and clear of it.
	expect(parentShape.x + 252 / 2).toBe(400);
	expect(parentShape.y + 124).toBeLessThan(0);
	expect([...shapes.values()]).toContainEqual(
		expect.objectContaining({
			type: "connector",
			from: expect.objectContaining({ shape: parentCard }),
			to: expect.objectContaining({ shape: "section" }),
		}),
	);
	expect(changes(client).get(parent.parent!)?.shapes).toEqual(["section", parentCard]);
	expect(cardFor(wobble.number)?.[1]).toMatchObject({ x: 40, y: 60, parent: "section" });
	expect(cardFor(snap.number)?.[1]).toMatchObject({ x: 400, y: 60, parent: "section" });
	expect(cardFor(cold.number)?.[1]).toMatchObject({ x: 0, y: 500 });
	expect(cardFor(manifest.number)?.[1]).toMatchObject({ x: 300, y: 500 });
	expect(shapes.get("link")).toMatchObject({
		from: { shape: cardFor(cold.number)?.[0] },
		to: { shape: cardFor(manifest.number)?.[0] },
	});
	expect(changes(client).get(blocked)?.result?.url).toBe(
		`https://github.com/acme/widgets/issues/${manifest.number}`,
	);
	await eventually(() => shapesMap(doc).get("decision")?.get("ref") === keyOf(pull.number));
	expect(changes(client).get(writeBack)?.result).toEqual({
		key: keyOf(pull.number),
		url: `https://github.com/acme/widgets/pull/${pull.number}`,
	});

	// --- A label on a sub-issue, and backlinks on every issue ---------------------
	const newIssues = [cold, manifest, wobble, snap];
	const labels = stageSetEdits(
		doc,
		"item.labels",
		[{ key: keyOf(wobble.number), add: ["bug"], remove: [], current: [] }],
		STAGER,
	);
	expect(labels).toHaveLength(1);

	// One snapshot (asked for: backlinks are only a link unless it is; every
	// card's in the same public repository), uploaded as the backlink panel
	// does, and served publicly for GitHub to show.
	const uploaded = await api(mf, `/api/boards/${board}/snapshots`, alice, {
		method: "POST",
		body: PNG,
		headers: { "content-type": "image/png" },
	});
	expect(uploaded.status).toBe(201);
	const snapshotUrl = ((await uploaded.json()) as { url: string }).url;
	const image = await mf.dispatchFetch(snapshotUrl.replace(/^https?:\/\/[^/]+/, ORIGIN));
	expect(image.status).toBe(200);
	expect(image.headers.get("content-type")).toBe("image/png");
	await image.arrayBuffer();
	const body = backlinkBody({ boardUrl, boardTitle: "Planning", snapshotUrl });
	// Every issue: each card on the board, the parent the section became
	// included, read off the board rather than typed in.
	const linked = [...shapeProps(client).values()].flatMap((shape) =>
		shape.type === "card" && shape.ref ? [Number(shape.ref.slice(shape.ref.indexOf("#") + 1))] : [],
	);
	expect(new Set(linked)).toEqual(
		new Set([12, resizing.number, ...newIssues.map((issue) => issue.number)]),
	);
	const backlinks = stageComments(
		doc,
		linked.map((n) => ({ key: keyOf(n), body })),
		STAGER,
	);
	await client.roundTrip();

	const second = [...labels, ...backlinks];
	const again = await api(mf, `/api/boards/${board}/push`, alice, {
		method: "POST",
		body: JSON.stringify({ ids: second, as: "user" }),
	});
	expect(again.status).toBe(202);
	const secondPush = ((await again.json()) as Extract<PushResponse, { ok: true }>).pushId;
	for (const change of labels) await waitFor(client, change, ["sent", "applied"]);
	await deliver(mf, github, "issues", github.event(WIDGETS, wobble.number, "labeled"));
	await allApplied(client, second);

	expect(github.item(WIDGETS, cold.number)?.labels).toEqual([
		{ name: "performance", color: "fbca04" },
	]);
	expect(github.item(WIDGETS, wobble.number)?.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
	// One comment per issue, as Alice (her own token: "via Tack" on GitHub),
	// linking the board and showing the snapshot.
	expect(github.comments.map((c) => c.number).sort((a, b) => a - b)).toEqual(
		[...linked].sort((a, b) => a - b),
	);
	for (const comment of github.comments) {
		expect(comment.login).toBe("alice");
		expect(comment.body).toContain(`[**Planning**](${boardUrl})`);
		expect(comment.body).toContain(`[![The board around this item](${snapshotUrl})](${boardUrl})`);
	}

	// --- The ADR is merged on GitHub -------------------------------------------------
	await deliver(mf, github, "pull_request", github.mergePull(WIDGETS, pull.number));
	await eventually(async () =>
		(await stub.liveCards()).some(
			(card) => card.key === keyOf(pull.number) && "state" in card && card.state === "merged",
		),
	);
	expect(github.filesOn(WIDGETS, "main")?.get(adrPath)).toBe(adr);
	// The next record gets the next number.
	const after = (await (
		await api(mf, `/api/repos/files?repo=${REPO}&path=docs/decisions`, alice)
	).json()) as string[];
	expect(nextAdrNumber(after, stagedRecordPaths(listChanges(doc), REPO))).toBe(3);

	// --- Nothing written twice, and the audit log has it all ---------------------------
	const issue = (n: number) => `/repos/acme/widgets/issues/${n}`;
	expect(writes(github).sort()).toEqual(
		[
			...Array.from({ length: 5 }, () => "POST /repos/acme/widgets/issues"),
			`POST ${issue(resizing.number)}/sub_issues`,
			`POST ${issue(resizing.number)}/sub_issues`,
			`POST ${issue(manifest.number)}/dependencies/blocked_by`,
			`POST ${issue(12)}/labels`,
			`PATCH ${issue(12)}`,
			`POST ${issue(12)}/assignees`,
			"POST /repos/acme/widgets/git/trees",
			"POST /repos/acme/widgets/git/commits",
			"POST /repos/acme/widgets/git/refs",
			"POST /repos/acme/widgets/pulls",
			`POST ${issue(wobble.number)}/labels`,
			...linked.map((n) => `POST ${issue(n)}/comments`),
		].sort(),
	);
	const before = writes(github).length;
	const repeat = await api(mf, `/api/boards/${board}/push`, alice, {
		method: "POST",
		body: JSON.stringify({ ids: [...first, ...second], as: "user" }),
	});
	expect(repeat.status).toBe(409);
	await stub.runPushes();
	expect(writes(github)).toHaveLength(before);

	const log = (await (await api(mf, `/api/boards/${board}/pushes`, alice)).json()) as AuditEntry[];
	expect(log.map((entry) => entry.pushId)).toEqual([secondPush, firstPush]);
	for (const entry of log) {
		expect(entry).toMatchObject({ by: { login: "alice", name: "Alice" }, as: "user" });
		expect(entry.changes.every((change) => change.status === "applied" && change.url)).toBe(true);
	}
	expect(log[1]?.changes.map((change) => change.id).sort()).toEqual([...first].sort());
	expect(log[0]?.changes.map((change) => change.id).sort()).toEqual([...second].sort());
	expect(log[1]?.changes.map((change) => change.summary)).toEqual(
		expect.arrayContaining([
			"Create issue “Faster cold starts” in acme/widgets",
			"Create issue “Resizing” in acme/widgets",
			"Label acme/widgets#12: +bug",
		]),
	);
	expect(listChanges(doc).every((change) => change.status === "applied")).toBe(true);
}, 60_000);
