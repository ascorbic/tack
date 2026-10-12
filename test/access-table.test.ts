// Every route and board message, and who may use it: the table in AGENTS.md
// ("Access table"), checked row by row (#60). Each row says who's let in and
// who's turned away; a request someone is turned away from never reaches
// what it would change. Keep this in step with the table when adding routes
// or message types.

import type { Miniflare, Response as MfResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { sign } from "../src/server/forges/hmac.ts";
import { shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

/** Who's asking. */
type Actor = "stranger" | "outsider" | "user" | "viewer" | "editor" | "owner" | "admin";
const ACTORS: Actor[] = ["stranger", "outsider", "user", "viewer", "editor", "owner", "admin"];

let mf: Miniflare;
const github = new FakeGitHub();
const cookies: Record<Actor, string> = {
	stranger: "",
	outsider: "",
	user: "",
	viewer: "",
	editor: "",
	owner: "",
	admin: "",
};
/** A private board (viewer and editor are members), a public one, and a template the owner saved. */
let privateBoard = "";
let publicBoard = "";
let template = "";
/** An image on each board. */
let image = "";
const clients: BoardClient[] = [];

function call(actor: Actor, method: string, path: string, body?: unknown, type?: string) {
	const headers = new Headers();
	if (cookies[actor]) headers.set("cookie", cookies[actor]);
	if (method !== "GET") headers.set("origin", ORIGIN);
	if (body !== undefined) headers.set("content-type", type ?? "application/json");
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method,
		headers,
		...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
	} as never);
}

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	cookies.owner = await signIn(mf, "olive", { name: "Olive" });
	cookies.editor = await signIn(mf, "eddie", { name: "Eddie" });
	cookies.viewer = await signIn(mf, "vera", { name: "Vera" });
	cookies.user = await signIn(mf, "oscar", { name: "Oscar" });
	cookies.admin = await signIn(mf, "adam", { name: "Adam", admin: true });
	cookies.outsider = await signIn(mf, "mallory", { name: "Mallory", allowed: false });

	const made = async (title: string, visibility: string) =>
		(
			(await (await call("owner", "POST", "/api/boards", { title, visibility })).json()) as {
				id: string;
			}
		).id;
	privateBoard = await made("Private", "private");
	publicBoard = await made("Public", "public");
	for (const [login, role] of [
		["eddie", "editor"],
		["vera", "viewer"],
	] as const) {
		const invited = await call("owner", "POST", `/api/boards/${privateBoard}/members`, {
			logins: [login],
			role,
		});
		expect(invited.status).toBe(200);
	}
	template = (
		(await (
			await call("owner", "POST", "/api/templates", { board: privateBoard, title: "Mine" })
		).json()) as { id: string }
	).id;
});

/** A real 1×1 PNG, uploaded to both boards. */
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

async function uploadImage(board: string): Promise<string> {
	const form = new FormData();
	form.set("image", new Blob([PNG]), "image");
	// Miniflare's fetch doesn't know Node's FormData: send it as bytes.
	const encoded = new Response(form);
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards/${board}/images`, {
		method: "POST",
		headers: {
			cookie: cookies.owner,
			origin: ORIGIN,
			"content-type": encoded.headers.get("content-type") ?? "",
		},
		body: await encoded.arrayBuffer(),
	} as never);
	expect(response.status).toBe(201);
	return ((await response.json()) as { hash: string }).hash;
}

beforeAll(async () => {
	image = await uploadImage(privateBoard);
	await uploadImage(publicBoard);
});

afterAll(async () => {
	for (const client of clients) client.close();
	await mf.dispose();
});

/** Statuses that mean "not you". */
const REFUSED = [401, 403, 404];

interface Row {
	route: string;
	/** Who's let in; everyone else is turned away. */
	allowed: Actor[];
	request: (actor: Actor) => Promise<MfResponse>;
	/** For allowed actors, a status beyond the access check (bad input, say) is fine. */
	refusedAs?: number[];
}

const everyone = ACTORS;
const signedIn: Actor[] = ["outsider", "user", "viewer", "editor", "owner", "admin"];
const instanceUsers: Actor[] = ["user", "viewer", "editor", "owner", "admin"];
const privateReaders: Actor[] = ["viewer", "editor", "owner"];
const privateEditors: Actor[] = ["editor", "owner"];

const ROWS: Row[] = [
	{ route: "GET /api/me", allowed: everyone, request: (a) => call(a, "GET", "/api/me") },
	{ route: "GET /api/boards", allowed: everyone, request: (a) => call(a, "GET", "/api/boards") },
	{
		route: "POST /api/boards",
		allowed: instanceUsers,
		request: (a) => call(a, "POST", "/api/boards", { title: "x", visibility: "private" }),
	},
	{
		route: "GET /api/boards/:id (private)",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}`),
	},
	{
		route: "GET /api/boards/:id (public)",
		allowed: everyone,
		request: (a) => call(a, "GET", `/api/boards/${publicBoard}`),
	},
	{
		route: "PATCH /api/boards/:id (rename)",
		allowed: privateEditors,
		request: (a) => call(a, "PATCH", `/api/boards/${privateBoard}`, { title: "Private" }),
	},
	{
		route: "PATCH /api/boards/:id (visibility, archive)",
		allowed: ["owner"],
		request: (a) => call(a, "PATCH", `/api/boards/${privateBoard}`, { visibility: "private" }),
	},
	{
		route: "PATCH /api/boards/:id (custom widgets)",
		allowed: ["owner"],
		request: (a) => call(a, "PATCH", `/api/boards/${privateBoard}`, { customWidgets: false }),
	},
	{
		route: "GET /sandbox/widget",
		allowed: everyone,
		request: (a) => call(a, "GET", "/sandbox/widget"),
	},
	{
		route: "GET /api/boards/:id/members (private)",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/members`),
	},
	{
		route: "GET /api/boards/:id/members (public)",
		allowed: signedIn,
		request: (a) => call(a, "GET", `/api/boards/${publicBoard}/members`),
	},
	{
		route: "POST /api/boards/:id/members",
		allowed: ["owner"],
		request: (a) =>
			call(a, "POST", `/api/boards/${privateBoard}/members`, { logins: ["vera"], role: "viewer" }),
	},
	{
		route: "PATCH /api/boards/:id/members/:login",
		allowed: ["owner"],
		request: (a) =>
			call(a, "PATCH", `/api/boards/${privateBoard}/members/vera`, { role: "viewer" }),
	},
	{
		route: "DELETE /api/boards/:id/members/:login (someone else)",
		allowed: ["owner"],
		// Nobody by that name: the owner gets past the check to a 404 of a different kind.
		request: (a) => call(a, "DELETE", `/api/boards/${privateBoard}/members/nobody-here`),
		refusedAs: [401, 403],
	},
	{
		// Signed out, only its members, to show mentions by name (not who's been looking, #56).
		route: "GET /api/boards/:id/people (public)",
		allowed: everyone,
		request: (a) => call(a, "GET", `/api/boards/${publicBoard}/people`),
	},
	{
		route: "GET /api/boards/:id/people (private)",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/people`),
	},
	{
		route: "GET /api/boards/:id/history",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/history`),
	},
	{
		route: "GET /api/boards/:id/pushes",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/pushes`),
	},
	{
		route: "GET /api/boards/:id/search",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/search?host=fake.tack&q=acme`),
	},
	{
		route: "GET /api/boards/:id/related",
		allowed: privateReaders,
		request: (a) =>
			call(a, "GET", `/api/boards/${privateBoard}/related?key=fake.tack/acme/app%231`),
	},
	{
		// Reading a page for a link card: editors, signed in. A private address is
		// refused without fetching anything, so the answer is a `blocked` preview.
		route: "POST /api/boards/:id/unfurl",
		allowed: privateEditors,
		request: (a) =>
			call(a, "POST", `/api/boards/${privateBoard}/unfurl`, { url: "http://127.0.0.1/" }),
	},
	{
		// Without an address: whoever can open it gets past the check to a 400.
		route: "GET /api/boards/:id/links/image (private)",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/links/image?src=`),
	},
	{
		route: "GET /api/boards/:id/links/image (public)",
		allowed: everyone,
		request: (a) => call(a, "GET", `/api/boards/${publicBoard}/links/image?src=`),
	},
	{
		route: "POST /api/boards/:id/push",
		allowed: privateEditors,
		request: (a) => call(a, "POST", `/api/boards/${privateBoard}/push`, { ids: [], as: "app" }),
	},
	{
		route: "POST /api/boards/:id/snapshots",
		allowed: privateEditors,
		// Not a PNG: editors get past the check to a 415.
		request: (a) => call(a, "POST", `/api/boards/${privateBoard}/snapshots`, "x", "image/png"),
	},
	{
		route: "POST /api/boards/:id/images",
		allowed: privateEditors,
		// Not a form: editors get past the check to a 400.
		request: (a) =>
			call(a, "POST", `/api/boards/${privateBoard}/images`, "x", "multipart/form-data; boundary=x"),
	},
	{
		// Editors here, from a board they can open (anyone can open a public one).
		route: "POST /api/boards/:id/images/copy",
		allowed: privateEditors,
		request: (a) =>
			call(a, "POST", `/api/boards/${privateBoard}/images/copy`, {
				from: publicBoard,
				hashes: [image],
			}),
	},
	{
		route: "GET /api/boards/:id/images/:hash",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/images/${image}`),
	},
	{
		route: "GET /api/boards/:id/images/:hash (public)",
		allowed: everyone,
		request: (a) => call(a, "GET", `/api/boards/${publicBoard}/images/${image}`),
	},
	{
		// Editors only: what it drafts is for them to place. Answered by the harness's fake Workers AI.
		route: "POST /api/boards/:id/ai",
		allowed: privateEditors,
		request: (a) =>
			call(a, "POST", `/api/boards/${privateBoard}/ai`, { task: "widget", prompt: "Open bugs" }),
	},
	{
		// Instance users edit a public board (its `instanceRole`); strangers only read it.
		route: "POST /api/boards/:id/ai (public)",
		allowed: instanceUsers,
		request: (a) =>
			call(a, "POST", `/api/boards/${publicBoard}/ai`, { task: "widget", prompt: "Open bugs" }),
	},
	{
		route: "POST /api/boards/:id/carry",
		allowed: privateEditors,
		request: (a) => call(a, "POST", `/api/boards/${publicBoard}/carry`, { to: privateBoard }),
	},
	{
		route: "GET /api/templates",
		allowed: instanceUsers,
		request: (a) => call(a, "GET", "/api/templates"),
	},
	{
		route: "POST /api/templates",
		allowed: privateEditors,
		request: (a) => call(a, "POST", "/api/templates", { board: privateBoard, title: "Copy" }),
	},
	{
		route: "DELETE /api/templates/:id",
		allowed: ["owner", "admin"],
		// Checked without deleting: a template that isn't there is past the check.
		request: (a) => call(a, "DELETE", `/api/templates/${template}x`),
		refusedAs: [401, 403],
	},
	{
		route: "GET /api/repos/meta",
		allowed: instanceUsers,
		request: (a) => call(a, "GET", "/api/repos/meta?repo=fake.tack/acme/app"),
	},
	{
		route: "GET /api/people",
		allowed: instanceUsers,
		request: (a) => call(a, "GET", "/api/people?q=ol"),
	},
	{
		route: "GET /api/notifications",
		allowed: signedIn,
		request: (a) => call(a, "GET", "/api/notifications"),
	},
	{
		route: "POST /api/notifications/read",
		allowed: signedIn,
		request: (a) => call(a, "POST", "/api/notifications/read", { all: true }),
	},
	{
		route: "GET /api/setup/installations",
		allowed: ["admin"],
		request: (a) => call(a, "GET", "/api/setup/installations"),
		// GitHub's answer may fail in tests; admins get past the check either way.
		refusedAs: [401, 403],
	},
	{
		route: "PUT /api/setup/access",
		allowed: ["admin"],
		request: (a) => call(a, "PUT", "/api/setup/access", { users: [], orgs: [], admins: [] }),
		refusedAs: [401, 403],
	},
	{
		route: "POST /api/boards/legacy",
		allowed: instanceUsers,
		request: (a) => call(a, "POST", "/api/boards/legacy", { name: `legacy-${a}` }),
	},
	{
		route: "POST /api/boards/import",
		allowed: instanceUsers,
		// Not an export: people allowed in get past the check to a 422.
		request: (a) => call(a, "POST", "/api/boards/import", { board: { nope: true } }),
	},
	{
		route: "GET /api/boards/:id/backup",
		allowed: privateEditors,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/backup`),
	},
	{
		route: "PUT /api/boards/:id/backup",
		allowed: ["owner"],
		// Not a repository: the owner gets past the check to a 422.
		request: (a) =>
			call(a, "PUT", `/api/boards/${privateBoard}/backup`, {
				repo: "not a repo",
				branch: "tack-backups",
				every: "daily",
			}),
		refusedAs: [401, 403],
	},
	{
		route: "POST /api/boards/:id/backup/run",
		allowed: ["owner"],
		// Nothing set up: the owner gets past the check to a 400.
		request: (a) => call(a, "POST", `/api/boards/${privateBoard}/backup/run`),
		refusedAs: [401, 403],
	},
	{
		route: "DELETE /api/boards/:id/backup",
		allowed: ["owner"],
		request: (a) => call(a, "DELETE", `/api/boards/${privateBoard}/backup`),
	},
	{
		route: "GET /api/boards/:id/digest",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/digest`),
	},
	{
		route: "PUT /api/boards/:id/digest",
		allowed: ["owner"],
		// Nowhere to send it: the owner gets past the check to a 400.
		request: (a) =>
			call(a, "PUT", `/api/boards/${privateBoard}/digest`, {
				discussion: null,
				email: false,
				weekday: 1,
				hour: 9,
				timeZone: "UTC",
			}),
		refusedAs: [401, 403],
	},
	{
		route: "DELETE /api/boards/:id/digest",
		allowed: ["owner"],
		request: (a) => call(a, "DELETE", `/api/boards/${privateBoard}/digest`),
	},
	{
		route: "PUT /api/boards/:id/digest/subscription",
		allowed: privateReaders,
		// Email isn't set up here: people let in get past the check to a 409.
		request: (a) =>
			call(a, "PUT", `/api/boards/${privateBoard}/digest/subscription`, {
				email: "someone@example.com",
			}),
		refusedAs: [401, 403],
	},
	{
		route: "PUT /api/boards/:id/digest/subscription (public board)",
		// People not allowed on the instance can see a public board, not get email from it.
		allowed: instanceUsers,
		request: (a) =>
			call(a, "PUT", `/api/boards/${publicBoard}/digest/subscription`, {
				email: "someone@example.com",
			}),
		refusedAs: [401, 403],
	},
	{
		route: "DELETE /api/boards/:id/digest/subscription",
		allowed: privateReaders,
		request: (a) => call(a, "DELETE", `/api/boards/${privateBoard}/digest/subscription`),
	},
	{
		route: "POST /api/digests/confirm, /api/digests/unsubscribe",
		// Whoever holds a token from an email: without one, everyone gets the same 410.
		allowed: everyone,
		request: (a) => call(a, "POST", "/api/digests/confirm", { token: "nope" }),
		refusedAs: [401, 403],
	},
	{
		route: "GET /api/boards/:id/history/segment",
		allowed: privateReaders,
		request: (a) => call(a, "GET", `/api/boards/${privateBoard}/history/segment?step=0`),
		// A step that isn't there is past the check.
		refusedAs: [401, 403],
	},
	{
		route: "GET /api/repos/files",
		allowed: instanceUsers,
		request: (a) => call(a, "GET", "/api/repos/files?repo=fake.tack/acme/app&path=docs"),
	},
	{
		route: "GET /api/people/:login",
		allowed: instanceUsers,
		request: (a) => call(a, "GET", "/api/people/olive"),
	},
	{
		route: "GET /api/setup/webhooks",
		allowed: ["admin"],
		request: (a) => call(a, "GET", "/api/setup/webhooks"),
		refusedAs: [401, 403],
	},
	{
		route: "POST /api/client-errors",
		allowed: everyone,
		request: (a) =>
			call(a, "POST", "/api/client-errors", { message: "test", source: "error", path: "/" }),
	},
	{
		route: "GET /embed/:id.svg (public)",
		allowed: everyone,
		request: (a) => call(a, "GET", `/embed/${publicBoard}.svg`),
	},
	{
		route: "GET /embed/:id.svg (private)",
		allowed: [],
		request: (a) => call(a, "GET", `/embed/${privateBoard}.svg`),
	},
	{
		route: "GET /og/:id.png (private)",
		allowed: [],
		request: (a) => call(a, "GET", `/og/${privateBoard}.png`),
	},
	{
		route: "WS /parties/board/:id (private)",
		allowed: privateReaders,
		request: (a) => upgrade(a, privateBoard),
	},
	{
		route: "WS /parties/board/:id (public)",
		allowed: everyone,
		request: (a) => upgrade(a, publicBoard),
	},
];

async function upgrade(actor: Actor, board: string): Promise<MfResponse> {
	const response = await mf.dispatchFetch(`${ORIGIN}/parties/board/${board}`, {
		headers: {
			upgrade: "websocket",
			origin: ORIGIN,
			...(cookies[actor] ? { cookie: cookies[actor] } : {}),
		},
	});
	if (response.webSocket) {
		response.webSocket.accept();
		response.webSocket.close();
	}
	return response;
}

describe("the access table: routes", () => {
	for (const row of ROWS) {
		it(row.route, async () => {
			const refused = row.refusedAs ?? REFUSED;
			for (const actor of ACTORS) {
				const response = await row.request(actor);
				await response.body?.cancel();
				if (row.allowed.includes(actor)) {
					expect(refused, `${actor} is let in`).not.toContain(response.status);
				} else {
					expect(REFUSED, `${actor} is turned away (${response.status})`).toContain(
						response.status,
					);
				}
			}
		});
	}

	it("GET /api/setup: anyone, with access settings for admins only", async () => {
		for (const actor of ACTORS) {
			const body = (await (await call(actor, "GET", "/api/setup")).json()) as { access: unknown };
			expect(body.access === null, actor).toBe(actor !== "admin");
		}
	});

	it("GET /auth/dev: only with dev sign-in on, from this machine", async () => {
		const away = await mf.dispatchFetch("http://tack.example/auth/dev?login=x", {
			redirect: "manual",
		});
		expect(away.status).toBe(404);
		const here = await mf.dispatchFetch(`${ORIGIN}/auth/dev?login=x`, { redirect: "manual" });
		expect(here.status).toBe(302);
		const production = startWorker();
		try {
			const off = await production.dispatchFetch(`${ORIGIN}/auth/dev?login=x`, {
				redirect: "manual",
			});
			expect(off.status).toBe(404);
		} finally {
			await production.dispose();
		}
	});

	it("POST /webhooks/:forge: only with the forge's signature", async () => {
		const body = JSON.stringify({ zen: "hi" });
		const unsigned = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
			method: "POST",
			body,
			headers: { "x-github-event": "ping", "x-hub-signature-256": await sign("wrong", body) },
		});
		expect(unsigned.status).toBe(401);
		const signed = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
			method: "POST",
			body,
			headers: {
				"x-github-event": "ping",
				"x-hub-signature-256": await sign(github.app.webhook_secret, body),
			},
		});
		expect(signed.status).toBe(200);
		// Other forges (#65): only from a host with a webhook secret configured
		// (none here, so none at all; test/forges-worker.test.ts has the rest),
		// and Tangled sends none.
		const gitlab = await mf.dispatchFetch(`${ORIGIN}/webhooks/gitlab`, {
			method: "POST",
			body: JSON.stringify({
				object_kind: "issue",
				project: { id: 1, path_with_namespace: "a/b", web_url: "https://gitlab.com/a/b" },
				object_attributes: { iid: 1 },
			}),
			headers: { "x-gitlab-token": "" },
		});
		expect(gitlab.status).toBe(403);
		const forgejoBody = JSON.stringify({
			issue: { number: 1 },
			repository: { id: 1, full_name: "a/b", html_url: "https://codeberg.org/a/b" },
		});
		const forgejo = await mf.dispatchFetch(`${ORIGIN}/webhooks/forgejo`, {
			method: "POST",
			body: forgejoBody,
			headers: { "x-forgejo-signature": (await sign("guess", forgejoBody)).slice(7) },
		});
		expect(forgejo.status).toBe(403);
		const tangled = await mf.dispatchFetch(`${ORIGIN}/webhooks/tangled`, {
			method: "POST",
			body: "{}",
		});
		expect(tangled.status).toBe(404);
	});
});

describe("the access table: board messages", () => {
	async function open(actor: Actor, board = privateBoard): Promise<BoardClient> {
		const result = await connectBoard(mf, board, cookies[actor] || undefined);
		if (!result.ok) throw new Error(`${actor} couldn't connect: ${result.status}`);
		clients.push(result.client);
		return result.client;
	}

	function received(client: BoardClient, type: string) {
		return client.messages.filter(
			(message): message is { type: string; reason?: string; request?: string } =>
				(message as { type?: string }).type === type,
		);
	}

	it("document sync: editors write; viewers' and strangers' writes are dropped", async () => {
		const owner = await open("owner");
		for (const actor of ["viewer", "editor"] as const) {
			const client = await open(actor);
			shapesMap(client.doc).set(`from-${actor}`, new Y.Map());
			await client.roundTrip();
		}
		const stranger = await open("stranger", publicBoard);
		shapesMap(stranger.doc).set("from-stranger", new Y.Map());
		await stranger.roundTrip();
		await owner.roundTrip();
		await eventually(() => shapesMap(owner.doc).has("from-editor"));
		expect(shapesMap(owner.doc).has("from-viewer")).toBe(false);
		const publicOwner = await open("owner", publicBoard);
		expect(shapesMap(publicOwner.doc).has("from-stranger")).toBe(false);
	});

	it("timer, spotlight and silent mode: editors only", async () => {
		const viewer = await open("viewer");
		viewer.send({ type: "timer", action: "start", ms: 60_000, by: { name: "V", color: "" } });
		viewer.send({ type: "spotlight", on: true, clientId: 1, user: { name: "V", color: "" } });
		viewer.send({ type: "silent-start", section: "nowhere", by: { name: "V", color: "" } });
		await eventually(() => received(viewer, "facilitation-refused").length === 2);
		expect(received(viewer, "facilitation-refused").map((r) => r.reason)).toEqual([
			"not_editor",
			"not_editor",
		]);
		await eventually(() => received(viewer, "silent-refused").length === 1);
		expect(received(viewer, "silent-refused")[0]?.reason).toBe("not_editor");
	});

	it("stack-group (Auto-stack): editors only; strangers and viewers are refused", async () => {
		const viewer = await open("viewer");
		viewer.send({ type: "stack-group", request: "r1", ids: ["a", "b", "c"] });
		const stranger = await open("stranger", publicBoard);
		stranger.send({ type: "stack-group", request: "r2", ids: ["a", "b", "c"] });
		for (const client of [viewer, stranger]) {
			await eventually(() => received(client, "stack-group-failed").length === 1);
			expect(received(client, "stack-group-failed")[0]?.reason).toBe("not_editor");
		}
		// An editor is asked, not refused: too few stickies with words here.
		const editor = await open("editor");
		editor.send({ type: "stack-group", request: "r3", ids: ["a", "b", "c"] });
		await eventually(() => received(editor, "stack-group-failed").length === 1);
		expect(received(editor, "stack-group-failed")[0]?.reason).toBe("too_few");
		// Whether suggestions are on goes to everyone connected.
		expect(received(stranger, "stacks-ai")).toHaveLength(1);
	});

	it("clock, since and widgets: anyone connected, strangers on public boards too", async () => {
		const stranger = await open("stranger", publicBoard);
		stranger.send({ type: "clock", t: 1 });
		stranger.send({ type: "since-request", since: Date.now() - 60_000 });
		stranger.send({ type: "widget-watch", ids: ["nothing"] });
		// A proposed widget's preview runs at the stranger's own (public) access.
		stranger.send({
			type: "widget-preview",
			id: "proposal",
			widget: "list",
			config: { host: "fake.tack", q: "repo:acme/app is:open" },
		});
		stranger.send({ type: "widget-query", id: "nothing", queries: { all: { q: "is:open" } } });
		stranger.send({ type: "recheck" });
		await eventually(() => received(stranger, "clock").length === 1);
		await eventually(() => received(stranger, "since").length === 1);
		await eventually(() =>
			stranger.messages.some(
				(message) => (message as { id?: string }).id === "preview:widget:proposal",
			),
		);
		expect(stranger.closed).toBeNull();
	});

	it("comments: anyone signed in who can open the board; strangers read only", async () => {
		const stranger = await open("stranger", publicBoard);
		stranger.send({
			type: "comment-start",
			thread: "thread-one",
			message: "message-one",
			body: "Hello",
			anchor: { x: 0, y: 0 },
		});
		await eventually(() => received(stranger, "comment-refused").length === 1);
		const outsider = await open("outsider", publicBoard);
		outsider.send({
			type: "comment-start",
			thread: "thread-two",
			message: "message-two",
			body: "Hello",
			anchor: { x: 0, y: 0 },
		});
		await eventually(() => received(outsider, "comment-thread").length >= 1);
		expect(received(outsider, "comment-refused")).toHaveLength(0);
	});
});
