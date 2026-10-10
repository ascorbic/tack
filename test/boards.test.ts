// Boards end to end: the index, membership and visibility, and access
// enforced on real WebSocket connections through the Worker.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type * as Y from "yjs";
import type {
	BoardInfo,
	BoardList,
	BoardMembers,
	Role,
	Thumbnail,
	UpdateBoardRequest,
} from "../src/shared/boards.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

let mf: Miniflare;
const github = new FakeGitHub();
let olive = ""; // owns the boards
let eddie = ""; // invited as an editor
let vera = ""; // invited as a viewer
let oscar = ""; // allowed on the instance, but not a member
let mallory = ""; // signed in, but not allowed on the instance

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	// Set the instance up, which turns access control on.
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	olive = await signIn(mf, "olive", { name: "Olive Owner" });
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
	oscar = await signIn(mf, "oscar");
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
	if (init.body) {
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

async function create(cookie: string, title: string, visibility?: string): Promise<BoardInfo> {
	return json<BoardInfo>("/api/boards", cookie, {
		method: "POST",
		body: JSON.stringify({ title, visibility }),
	});
}

function update(cookie: string, id: string, body: UpdateBoardRequest) {
	return api(`/api/boards/${id}`, cookie, { method: "PATCH", body: JSON.stringify(body) });
}

function invite(cookie: string, id: string, logins: string[], role: Role) {
	return api(`/api/boards/${id}/members`, cookie, {
		method: "POST",
		body: JSON.stringify({ logins, role }),
	});
}

async function open(id: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`Connecting to ${id} failed: ${result.status} ${result.error}`);
	clients.push(result.client);
	return result.client;
}

async function refused(id: string, cookie?: string) {
	const result = await connectBoard(mf, id, cookie);
	if (result.ok) {
		result.client.close();
		return null;
	}
	return { status: result.status, error: result.error };
}

let seq = 0;
function sticky(doc: Y.Doc, text: string): string {
	const id = `shape-${++seq}`;
	addShape(doc, id, { type: "sticky", text, x: seq * 10, y: 0, z: `a${seq}`, color: "pink" });
	return id;
}

/** Whether the board's document on the server has this shape, as a fresh connection sees it. */
async function serverHas(id: string, shape: string): Promise<boolean> {
	const probe = await open(id, olive);
	const has = shapesMap(probe.doc).has(shape);
	probe.close();
	return has;
}

describe("the board index", () => {
	it("creates boards for people allowed on the instance", async () => {
		const board = await create(olive, "  Q3   planning: unpic! ");
		expect(board).toMatchObject({
			title: "Q3 planning: unpic!",
			slug: "q3-planning-unpic",
			owner: { login: "olive", name: "Olive Owner" },
			visibility: "instance",
			instanceRole: "editor",
			archivedAt: null,
			role: "owner",
			canManage: true,
			memberCount: 1,
		});
		expect(board.id).toMatch(/^[a-z0-9]{10}$/);
	});

	it("turns away creating boards signed out, or when not allowed", async () => {
		const body = JSON.stringify({ title: "Nope" });
		expect((await api("/api/boards", "", { method: "POST", body })).status).toBe(401);
		expect((await api("/api/boards", mallory, { method: "POST", body })).status).toBe(403);
	});

	it("refuses cross-site changes", async () => {
		const response = await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
			method: "POST",
			headers: {
				cookie: olive,
				origin: "https://evil.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({ title: "Phish" }),
		});
		expect(response.status).toBe(403);
	});

	it("renames, with the slug following the title, and old links still resolving by id", async () => {
		const board = await create(olive, "Roadmap");
		const renamed = (await (
			await update(olive, board.id, { title: "Roadmap 2027" })
		).json()) as BoardInfo;
		expect(renamed).toMatchObject({ id: board.id, title: "Roadmap 2027", slug: "roadmap-2027" });
		expect(renamed.updatedAt).toBeGreaterThanOrEqual(board.updatedAt);
		// Any slug (or none) finds the board; the client redirects to the current one.
		expect(await json<BoardInfo>(`/api/boards/${board.id}`, olive)).toMatchObject({
			slug: "roadmap-2027",
		});
	});

	it("lists my boards, boards shared with me, recent and archived ones", async () => {
		const mine = await create(olive, "Listing: mine");
		const shared = await create(olive, "Listing: shared");
		await invite(olive, shared.id, ["eddie"], "editor");
		(await open(mine.id, eddie)).close();

		const eddies = await json<BoardList>("/api/boards", eddie);
		expect(eddies.shared.map((b) => b.id)).toContain(shared.id);
		expect(eddies.mine.map((b) => b.id)).not.toContain(shared.id);
		expect(eddies.recent[0]?.id).toBe(mine.id);
		expect(eddies.recent[0]?.visitedAt).toBeTypeOf("number");
		expect(eddies.open.map((b) => b.id)).toContain(mine.id);
		expect(eddies.canCreate).toBe(true);

		expect((await update(olive, mine.id, { archived: true })).status).toBe(200);
		const olives = await json<BoardList>("/api/boards", olive);
		expect(olives.mine.map((b) => b.id)).toContain(shared.id);
		expect(olives.mine.map((b) => b.id)).not.toContain(mine.id);
		expect(olives.archived.map((b) => b.id)).toContain(mine.id);
		expect(olives.archived[0]?.archivedAt).toBeTypeOf("number");
		expect((await json<BoardList>("/api/boards", eddie)).recent.map((b) => b.id)).not.toContain(
			mine.id,
		);

		expect((await update(olive, mine.id, { archived: false })).status).toBe(200);
		expect((await json<BoardList>("/api/boards", olive)).mine.map((b) => b.id)).toContain(mine.id);
	});

	it("only lists public boards for people who can't use the instance", async () => {
		const open = await create(olive, "Listing: instance");
		const pub = await create(olive, "Listing: public", "public");
		for (const cookie of ["", mallory]) {
			const list = await json<BoardList>("/api/boards", cookie);
			const ids = list.open.map((b) => b.id);
			expect(ids).toContain(pub.id);
			expect(ids).not.toContain(open.id);
			expect(list).toMatchObject({
				recent: [],
				mine: [],
				shared: [],
				archived: [],
				canCreate: false,
			});
		}
	});

	it("lets editors rename but only owners archive or change visibility", async () => {
		const board = await create(olive, "Permissions");
		await invite(olive, board.id, ["eddie"], "editor");
		await invite(olive, board.id, ["vera"], "viewer");
		expect((await update(eddie, board.id, { title: "Renamed by Eddie" })).status).toBe(200);
		expect((await update(vera, board.id, { title: "Renamed by Vera" })).status).toBe(403);
		expect((await update(eddie, board.id, { archived: true })).status).toBe(403);
		expect((await update(eddie, board.id, { visibility: "public" })).status).toBe(403);
		expect((await invite(eddie, board.id, ["oscar"], "editor")).status).toBe(403);
		expect((await update(olive, board.id, { visibility: "private" })).status).toBe(200);
		expect((await update(oscar, board.id, { title: "Hijack" })).status).toBe(403);
	});

	it("validates input", async () => {
		const board = await create(olive, "Validation");
		expect((await update(olive, board.id, { visibility: "everyone" as never })).status).toBe(400);
		expect((await invite(olive, board.id, ["not a login"], "editor")).status).toBe(422);
		expect((await invite(olive, board.id, ["eddie"], "owner" as never)).status).toBe(400);
		expect((await api("/api/boards/no-such-board", olive)).status).toBe(404);
		expect((await api("/api/boards/..", olive)).status).toBe(404);
	});

	it("gives empty titles a default, numbered so fresh boards can be told apart", async () => {
		expect((await create(olive, "   ")).title).toBe("Untitled board");
		expect((await create(olive, "")).title).toBe("Untitled board 2");
		const third = await create(olive, "");
		expect(third).toMatchObject({ title: "Untitled board 3", slug: "untitled-board-3" });
		// Only your own count.
		expect((await create(eddie, "")).title).toBe("Untitled board");
		// Naming one yourself is up to you.
		expect((await create(olive, "Untitled board")).title).toBe("Untitled board");
	});
});

describe("membership", () => {
	it("invites by login, resolving to a GitHub id when they first sign in", async () => {
		const board = await create(olive, "Invites", "private");
		const invited = (await (
			await invite(olive, board.id, ["@Priya-S", "eddie"], "editor")
		).json()) as BoardMembers;
		const priya = invited.members.find((m) => m.login === "priya-s");
		expect(priya).toEqual({ login: "priya-s", person: null, role: "editor" });
		// Eddie has signed in before, so he resolves straight away.
		expect(invited.members.find((m) => m.login === "eddie")?.person?.login).toBe("eddie");

		const cookie = await signIn(mf, "Priya-S", { name: "Priya Shah" });
		expect((await json<BoardList>("/api/boards", cookie)).shared.map((b) => b.id)).toContain(
			board.id,
		);
		const members = await json<BoardMembers>(`/api/boards/${board.id}/members`, olive);
		expect(members.members.find((m) => m.login === "priya-s")?.person).toMatchObject({
			login: "Priya-S",
			name: "Priya Shah",
		});
		expect(members.members[0]).toMatchObject({ login: "olive", role: "owner" });
		expect((await open(board.id, cookie)).doc).toBeTruthy();
	});

	it("changes roles, removes members, and lets people leave", async () => {
		const board = await create(olive, "Roles", "private");
		await invite(olive, board.id, ["eddie", "vera"], "viewer");
		const changed = await api(`/api/boards/${board.id}/members/eddie`, olive, {
			method: "PATCH",
			body: JSON.stringify({ role: "editor" }),
		});
		expect(((await changed.json()) as BoardMembers).members).toContainEqual(
			expect.objectContaining({ login: "eddie", role: "editor" }),
		);

		// Vera leaves on her own; Eddie can't remove the owner.
		expect(
			(await api(`/api/boards/${board.id}/members/vera`, vera, { method: "DELETE" })).status,
		).toBe(200);
		expect(
			(await api(`/api/boards/${board.id}/members/olive`, eddie, { method: "DELETE" })).status,
		).toBe(403);
		expect((await refused(board.id, vera))?.status).toBe(403);
	});

	it("hands ownership over", async () => {
		const board = await create(olive, "Handover", "private");
		await invite(olive, board.id, ["eddie"], "editor");
		const response = await api(`/api/boards/${board.id}/members/eddie`, olive, {
			method: "PATCH",
			body: JSON.stringify({ role: "owner" }),
		});
		expect(response.status).toBe(200);
		expect(await json<BoardInfo>(`/api/boards/${board.id}`, eddie)).toMatchObject({
			owner: { login: "eddie" },
			role: "owner",
			canManage: true,
		});
		expect(await json<BoardInfo>(`/api/boards/${board.id}`, olive)).toMatchObject({
			role: "editor",
			canManage: false,
		});
	});
});

describe("access over live connections", () => {
	it("refuses non-members on a private board, and asks signed-out people to sign in", async () => {
		const board = await create(olive, "Secret", "private");
		expect(await refused(board.id, oscar)).toEqual({ status: 403, error: "forbidden" });
		expect(await refused(board.id)).toEqual({ status: 401, error: "sign_in_required" });
		expect(await refused(board.id, mallory)).toEqual({ status: 403, error: "forbidden" });
		expect((await api(`/api/boards/${board.id}`, oscar)).status).toBe(403);
	});

	it("lets editors write", async () => {
		const board = await create(olive, "Editors", "private");
		await invite(olive, board.id, ["eddie"], "editor");
		const client = await open(board.id, eddie);
		const shape = sticky(client.doc, "from eddie");
		await client.roundTrip();
		expect(await serverHas(board.id, shape)).toBe(true);
	});

	it("never lets viewers write, but shows them everyone else's changes", async () => {
		const board = await create(olive, "Viewers", "private");
		await invite(olive, board.id, ["vera"], "viewer");
		const viewer = await open(board.id, vera);
		const owner = await open(board.id, olive);

		const attempt = sticky(viewer.doc, "from vera");
		await viewer.roundTrip();
		expect(await serverHas(board.id, attempt)).toBe(false);
		expect(shapesMap(owner.doc).has(attempt)).toBe(false);

		const shape = sticky(owner.doc, "from olive");
		await eventually(() => shapesMap(viewer.doc).has(shape));
	});

	it("ignores a forged access header", async () => {
		const board = await create(olive, "Forged", "private");
		await invite(olive, board.id, ["vera"], "viewer");
		const forged = JSON.stringify({ userId: 1, allowed: true, role: "owner" });
		const response = await mf.dispatchFetch(`${ORIGIN}/parties/board/${board.id}`, {
			headers: { upgrade: "websocket", cookie: oscar, "x-tack-access": forged },
		});
		expect(response.status).toBe(403);

		// A viewer claiming to be the owner is still a viewer.
		const result = await connectBoard(mf, board.id, vera);
		if (!result.ok) throw new Error("vera should connect");
		clients.push(result.client);
		const attempt = sticky(result.client.doc, "forged");
		await result.client.roundTrip();
		expect(await serverHas(board.id, attempt)).toBe(false);
	});

	it("opens public boards signed out, read-only", async () => {
		const board = await create(olive, "Open source roadmap", "public");
		const owner = await open(board.id, olive);
		const shape = sticky(owner.doc, "hello world");
		await owner.roundTrip();

		const anonymous = await open(board.id);
		expect(shapesMap(anonymous.doc).has(shape)).toBe(true);
		const attempt = sticky(anonymous.doc, "graffiti");
		await anonymous.roundTrip();
		expect(await serverHas(board.id, attempt)).toBe(false);

		// Signed in but not allowed on the instance: the same as the public.
		const outsider = await open(board.id, mallory);
		const again = sticky(outsider.doc, "graffiti");
		await outsider.roundTrip();
		expect(await serverHas(board.id, again)).toBe(false);

		expect(await json<BoardInfo>(`/api/boards/${board.id}`, "")).toMatchObject({
			role: "viewer",
			canManage: false,
		});
	});

	it("gives everyone on the instance the board's instance role", async () => {
		const board = await create(olive, "Team board");
		const teammate = await open(board.id, oscar);
		const shape = sticky(teammate.doc, "from oscar");
		await teammate.roundTrip();
		expect(await serverHas(board.id, shape)).toBe(true);
		expect(await refused(board.id)).toEqual({ status: 401, error: "sign_in_required" });
		expect(await refused(board.id, mallory)).toEqual({ status: 403, error: "forbidden" });

		// Down to view-only, live: the open connection is told, and stops writing.
		expect((await update(olive, board.id, { instanceRole: "viewer" })).status).toBe(200);
		await eventually(() =>
			teammate.messages.some((m) => (m as { type: string }).type === "access"),
		);
		expect(teammate.messages).toContainEqual({ type: "access", role: "viewer" });
		const attempt = sticky(teammate.doc, "too late");
		await teammate.roundTrip();
		expect(await serverHas(board.id, attempt)).toBe(false);
	});

	it("updates live connections when roles change, and disconnects people who lose access", async () => {
		const board = await create(olive, "Live roles", "private");
		await invite(olive, board.id, ["vera", "eddie"], "viewer");
		const viewer = await open(board.id, vera);
		const removed = await open(board.id, eddie);

		await api(`/api/boards/${board.id}/members/vera`, olive, {
			method: "PATCH",
			body: JSON.stringify({ role: "editor" }),
		});
		await eventually(() => viewer.messages.some((m) => (m as { role?: string }).role === "editor"));
		const shape = sticky(viewer.doc, "promoted");
		await viewer.roundTrip();
		expect(await serverHas(board.id, shape)).toBe(true);

		await api(`/api/boards/${board.id}/members/eddie`, olive, { method: "DELETE" });
		await eventually(() => removed.closed !== null);
		expect(removed.closed?.code).toBe(4403);
	});

	it("tells everyone on the board when it's renamed", async () => {
		const board = await create(olive, "Before");
		const teammate = await open(board.id, oscar);
		await update(olive, board.id, { title: "After the rename" });
		await eventually(() =>
			teammate.messages.some((m) => (m as { type: string }).type === "renamed"),
		);
		expect(teammate.messages).toContainEqual({
			type: "renamed",
			title: "After the rename",
			slug: "after-the-rename",
		});
	});

	it("makes archived boards read-only, even for their owner", async () => {
		const board = await create(olive, "Archived");
		await update(olive, board.id, { archived: true });
		const owner = await open(board.id, olive);
		const attempt = sticky(owner.doc, "after archiving");
		await owner.roundTrip();
		expect(await serverHas(board.id, attempt)).toBe(false);
		expect(await json<BoardInfo>(`/api/boards/${board.id}`, olive)).toMatchObject({
			role: "viewer",
			canManage: true,
		});
	});

	it("only connects to boards in the index", async () => {
		expect(await refused("never-created", olive)).toEqual({ status: 404, error: "not_found" });
		const other = await mf.dispatchFetch(`${ORIGIN}/parties/instance/instance`, {
			headers: { upgrade: "websocket", cookie: olive },
		});
		expect(other.status).toBe(404);
		const http = await mf.dispatchFetch(`${ORIGIN}/parties/board/never-created`);
		expect(http.status).toBe(404);
	});
});

describe("boards from before the index", () => {
	it("adopts a ?board= name as the board's id, keeping its document", async () => {
		const claim = (cookie: string, name: string) =>
			api("/api/boards/legacy", cookie, { method: "POST", body: JSON.stringify({ name }) });
		const response = await claim(eddie, "demo");
		const board = (await response.json()) as BoardInfo;
		expect(board).toMatchObject({
			id: "demo",
			slug: "demo",
			title: "demo",
			owner: { login: "eddie" },
			visibility: "instance",
		});
		// Someone else following an old link finds the same board.
		expect(await (await claim(oscar, "demo")).json()).toMatchObject({ id: "demo" });
		expect((await claim("", "demo")).status).toBe(401);
		expect((await claim(olive, "../etc")).status).toBe(404);
		expect((await open("demo", oscar)).doc).toBeTruthy();
	});
});

describe("thumbnails", () => {
	it("are sketched from the document when the board saves", async () => {
		const board = await create(olive, "Sketch");
		const client = await open(board.id, olive);
		sticky(client.doc, "one");
		addShape(client.doc, "card-1", {
			type: "card",
			ref: "fake.tack/a/b#1",
			x: 400,
			y: 300,
			z: "b0",
		});
		await client.roundTrip();
		const sketched = async () =>
			(await json<BoardInfo>(`/api/boards/${board.id}`, olive)).thumbnail;
		await eventually(async () => (await sketched()) !== null, 12_000);
		const sketch = (await sketched()) as Thumbnail;
		expect(sketch.shapes.map(([kind]) => kind).sort()).toEqual(["card", "sticky"]);
		expect(Math.max(sketch.width, sketch.height)).toBe(1000);
	}, 15_000);
});

describe("without TACK_SECRET (Previews)", () => {
	let preview: Miniflare;
	beforeAll(() => {
		preview = startWorker({ bindings: { TACK_SECRET: "" } });
	});
	afterAll(() => preview.dispose());

	it("lets guests create and open boards, open to everyone", async () => {
		const response = await preview.dispatchFetch(`${ORIGIN}/api/boards`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ title: "Preview board", visibility: "private" }),
		});
		const board = (await response.json()) as BoardInfo;
		expect(board).toMatchObject({
			owner: null,
			visibility: "instance",
			role: "editor",
			canManage: true,
		});
		const result = await connectBoard(preview, board.id);
		expect(result.ok).toBe(true);
		if (result.ok) result.client.close();
		const list = (await (await preview.dispatchFetch(`${ORIGIN}/api/boards`)).json()) as BoardList;
		expect(list.open.map((b) => b.id)).toContain(board.id);
		expect(list.canCreate).toBe(true);
	});
});
