// Templates (#53) and carrying action items over (#52) end to end: boards
// made from templates through the Worker, templates saved per instance with
// who may save and delete them, and carry over between real boards.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { addActionItem, setActionDone } from "../src/shared/actionItems.ts";
import type { BoardInfo, CarryResponse, CreatedBoard } from "../src/shared/boards.ts";
import { readPrepared } from "../src/shared/prepared.ts";
import { listRules } from "../src/shared/rules.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection, readShapes } from "../src/shared/structure.ts";
import type { TemplateInfo, TemplateList } from "../src/shared/templates.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

let mf: Miniflare;
const github = new FakeGitHub();
let olive = ""; // makes boards and templates
let eddie = ""; // an editor of olive's board
let vera = ""; // a viewer of it
let adam = ""; // an admin
let mallory = ""; // signed in, not allowed on the instance

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	olive = await signIn(mf, "olive", { name: "Olive Owner" });
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
	adam = await signIn(mf, "adam", { admin: true });
	mallory = await signIn(mf, "mallory", { allowed: false });
});
afterAll(() => mf.dispose());

const clients: BoardClient[] = [];
afterAll(() => {
	for (const client of clients) client.close();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.body || init.method === "DELETE") {
		headers.set("content-type", "application/json");
		headers.set("origin", ORIGIN);
	}
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

async function json<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
	const response = await api(path, cookie, init);
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function open(id: string, cookie: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`Connecting to ${id} failed: ${result.status}`);
	clients.push(result.client);
	return result.client;
}

describe("making a board from a template", () => {
	it("lays out a built-in, with its repositories filled in", async () => {
		const board = await json<CreatedBoard>(
			"/api/boards",
			olive,
			post({ title: "Triage", template: "tack:triage", repos: ["github.com/emdash-cms/emdash"] }),
		);
		expect(board.seeded).toBe(true);
		expect(board.title).toBe("Triage");
		// The index has its thumbnail straight away.
		expect(board.thumbnail?.shapes.length).toBeGreaterThan(3);

		const client = await open(board.id, olive);
		const shapes = readShapes(client.doc);
		const incoming = [...shapes.values()].find((shape) => shape.title === "Incoming");
		expect(incoming?.inbox?.query.q).toBe("repo:emdash-cms/emdash is:issue is:open no:label");
		const rules = listRules(client.doc);
		expect(rules).toHaveLength(2);
		expect(rules.every((rule) => rule.createdBy.login === "olive")).toBe(true);
		expect(readPrepared(client.doc)).toHaveLength(1);
	});

	it("refuses templates that don't exist, and makes no board", async () => {
		const before = (await json<{ mine: BoardInfo[] }>("/api/boards", olive)).mine.length;
		const response = await api("/api/boards", olive, post({ template: "tack:nope" }));
		expect(response.status).toBe(404);
		const missing = await api("/api/boards", olive, post({ template: "abcdefghjk" }));
		expect(missing.status).toBe(404);
		expect((await json<{ mine: BoardInfo[] }>("/api/boards", olive)).mine.length).toBe(before);
	});

	it("makes a blank board as before without a template", async () => {
		const board = await json<CreatedBoard>("/api/boards", olive, post({ title: "Blank" }));
		expect(board.seeded).toBeUndefined();
		const client = await open(board.id, olive);
		expect(shapesMap(client.doc).size).toBe(0);
	});
});

describe("saved templates", () => {
	let board: BoardInfo;
	let saved: TemplateInfo;

	beforeAll(async () => {
		board = await json<BoardInfo>("/api/boards", olive, post({ title: "Our retro" }));
		await api(
			`/api/boards/${board.id}/members`,
			olive,
			post({ logins: ["eddie"], role: "editor" }),
		);
		await api(`/api/boards/${board.id}/members`, olive, post({ logins: ["vera"], role: "viewer" }));
		const client = await open(board.id, olive);
		const section = addSection(client.doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Kudos" });
		addShape(client.doc, "list", {
			type: "widget",
			widget: "list",
			x: 700,
			y: 0,
			z: "b0",
			config: { host: "github.com", q: "repo:emdash-cms/emdash is:open", title: "" },
		});
		addShape(client.doc, "note", {
			type: "sticky",
			x: 40,
			y: 80,
			z: "b1",
			text: "Secret",
			parent: section,
		});
		await client.roundTrip();
	});

	it("saves a board's structure for everyone on the instance", async () => {
		saved = await json<TemplateInfo>(
			"/api/templates",
			olive,
			post({ board: board.id, title: "  Team   retro ", description: "Ours" }),
		);
		expect(saved).toMatchObject({
			title: "Team retro",
			description: "Ours",
			builtIn: false,
			owner: { login: "olive" },
			canDelete: true,
			repos: { min: 0, max: 1, defaults: ["github.com/emdash-cms/emdash"] },
			summary: { sections: 1, widgets: 1, stickies: 0, sectionTitles: ["Kudos"] },
		});
		expect(saved.thumbnail?.shapes.length).toBe(2);

		const list = await json<TemplateList>("/api/templates", eddie);
		expect(list.templates.map((t) => t.id)).toContain(saved.id);
		const theirs = list.templates.find((t) => t.id === saved.id);
		expect(theirs?.canDelete).toBe(false);
	});

	it("only lets people who can edit the board save it, and only people on the instance use them", async () => {
		const viewer = await api("/api/templates", vera, post({ board: board.id, title: "Mine now" }));
		expect(viewer.status).toBe(403);
		const editor = await api("/api/templates", eddie, post({ board: board.id, title: "Eddie's" }));
		expect(editor.status).toBe(201);
		expect((await api("/api/templates", mallory)).status).toBe(403);
		expect((await api("/api/templates", "")).status).toBe(401);
		const untitled = await api("/api/templates", olive, post({ board: board.id, title: "  " }));
		expect(untitled.status).toBe(400);
	});

	it("makes boards from a saved template, leaving the stickies behind", async () => {
		const made = await json<CreatedBoard>(
			"/api/boards",
			eddie,
			post({ title: "Next retro", template: saved.id, repos: ["github.com/acme/widgets"] }),
		);
		expect(made.seeded).toBe(true);
		const client = await open(made.id, eddie);
		const shapes = [...readShapes(client.doc).values()];
		expect(shapes.map((shape) => shape.type).sort()).toEqual(["section", "widget"]);
		expect(shapes.find((shape) => shape.type === "widget")?.config).toMatchObject({
			q: "repo:acme/widgets is:open",
		});
	});

	it("keeps everything when asked", async () => {
		const all = await json<TemplateInfo>(
			"/api/templates",
			olive,
			post({ board: board.id, title: "Everything", keepContent: true }),
		);
		expect(all.summary.stickies).toBe(1);
	});

	it("lets whoever saved it, or an admin, delete it", async () => {
		const other = await api(`/api/templates/${saved.id}`, eddie, { method: "DELETE" });
		expect(other.status).toBe(403);
		expect((await api(`/api/templates/${saved.id}`, olive, { method: "DELETE" })).status).toBe(200);
		expect((await api(`/api/templates/${saved.id}`, olive, { method: "DELETE" })).status).toBe(404);

		const eddies = (await json<TemplateList>("/api/templates", adam)).templates.find(
			(t) => t.title === "Eddie's",
		);
		expect(eddies?.canDelete).toBe(true);
		expect((await api(`/api/templates/${eddies?.id}`, adam, { method: "DELETE" })).status).toBe(
			200,
		);
		const left = (await json<TemplateList>("/api/templates", olive)).templates.map((t) => t.title);
		expect(left).not.toContain("Team retro");
		expect(left).not.toContain("Eddie's");
	});
});

describe("carrying action items over", () => {
	let last: BoardInfo;

	beforeAll(async () => {
		last = await json<BoardInfo>(
			"/api/boards",
			olive,
			post({ title: "Retro, September", visibility: "private" }),
		);
		await api(`/api/boards/${last.id}/members`, olive, post({ logins: ["vera"], role: "viewer" }));
		const client = await open(last.id, olive);
		addActionItem(client.doc, "open", {
			x: 0,
			y: 0,
			text: "Fix flaky CI",
			owner: { login: "eddie" },
		});
		addActionItem(client.doc, "later", { x: 0, y: 200, text: "Write docs", due: "2026-10-20" });
		addActionItem(client.doc, "done", { x: 0, y: 100, text: "Already done" });
		setActionDone(client.doc, "done", true);
		await client.roundTrip();
	});

	it("brings the open ones into the next retro, made from the template", async () => {
		const next = await json<CreatedBoard>(
			"/api/boards",
			olive,
			post({ title: "Retro, October", template: "tack:retro", carryFrom: last.id }),
		);
		expect(next.carried).toBe(2);
		const client = await open(next.id, olive);
		const shapes = readShapes(client.doc);
		const actions = [...shapes].find(([, shape]) => shape.title === "Actions")?.[0];
		const carried = [...shapes.values()].filter((shape) => shape.type === "action");
		expect(carried.map((shape) => shape.text)).toEqual(["Fix flaky CI", "Write docs"]);
		for (const shape of carried) {
			expect(shape.parent).toBe(actions);
			expect(shape.carried).toMatchObject({ board: last.id, title: "Retro, September" });
		}
		expect(carried[0]?.owner).toEqual({ login: "eddie" });

		// Again, from the board: nothing doubles up.
		const again = await json<CarryResponse>(
			`/api/boards/${last.id}/carry`,
			olive,
			post({ to: next.id }),
		);
		expect(again).toMatchObject({ carried: 0, skipped: 2 });
	});

	it("carries just the items picked", async () => {
		const target = await json<BoardInfo>("/api/boards", olive, post({ title: "Planning" }));
		const result = await json<CarryResponse>(
			`/api/boards/${last.id}/carry`,
			olive,
			post({ to: target.id, shapes: ["later", "done"] }),
		);
		expect(result.carried).toBe(1);
		const client = await open(target.id, olive);
		await eventually(() => readShapes(client.doc).size > 0);
		const shapes = [...readShapes(client.doc).values()];
		expect(shapes.find((shape) => shape.type === "section")?.title).toBe(
			"Carried over from Retro, September",
		);
		expect(shapes.filter((shape) => shape.type === "action").map((shape) => shape.text)).toEqual([
			"Write docs",
		]);
	});

	it("needs edit access to the board they go to", async () => {
		const olives = await json<BoardInfo>("/api/boards", olive, post({ title: "Olive's" }));
		await api(
			`/api/boards/${olives.id}/members`,
			olive,
			post({ logins: ["vera"], role: "viewer" }),
		);
		// Vera can read the old retro, but only view this one.
		const viewer = await api(`/api/boards/${last.id}/carry`, vera, post({ to: olives.id }));
		expect(viewer.status).toBe(403);
		// Her own board is fine.
		const hers = await json<BoardInfo>("/api/boards", vera, post({ title: "Vera's" }));
		const result = await json<CarryResponse>(
			`/api/boards/${last.id}/carry`,
			vera,
			post({ to: hers.id }),
		);
		expect(result.carried).toBe(2);
		// Someone who can't open the old retro can't carry from it.
		const eddies = await json<BoardInfo>("/api/boards", eddie, post({ title: "Eddie's" }));
		const outsider = await api(`/api/boards/${last.id}/carry`, eddie, post({ to: eddies.id }));
		expect(outsider.status).toBe(403);
		expect((await api(`/api/boards/${last.id}/carry`, olive, post({ to: last.id }))).status).toBe(
			400,
		);
	});
});
