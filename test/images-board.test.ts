// Images on boards, through the Worker: uploads by editors, checked and
// stored once per file, served only to people who can open the board,
// copied between boards, and let go of once nothing shows or mentions them.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { BoardInfo, Role } from "../src/shared/boards.ts";
import { addImageShape, hashImage } from "../src/shared/images.ts";
import { shapesMap } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

// A real 1×1 PNG.
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

/** A GIF's header, 3 × 2: enough for the server, which never decodes. */
function gif(width = 3, height = 2): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes.set(new TextEncoder().encode("GIF89a"));
	new DataView(bytes.buffer).setUint16(6, width, true);
	new DataView(bytes.buffer).setUint16(8, height, true);
	return bytes;
}

let mf: Miniflare;
const github = new FakeGitHub();
let olive = "";
let eddie = "";
let vera = "";
let mallory = "";
let board = "";
let other = "";
let public_ = "";
const clients: BoardClient[] = [];

function api(path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

/** A multipart body as bytes: Miniflare's fetch doesn't know Node's own FormData. */
async function multipart(form: FormData): Promise<{ body: ArrayBuffer; type: string }> {
	const encoded = new Response(form);
	return { body: await encoded.arrayBuffer(), type: encoded.headers.get("content-type") ?? "" };
}

async function upload(
	cookie: string,
	bytes: Uint8Array,
	id = board,
	headers: Record<string, string> = {},
) {
	const form = new FormData();
	form.set("image", new Blob([bytes as Uint8Array<ArrayBuffer>]), "image");
	const { body, type } = await multipart(form);
	return api(`/api/boards/${id}/images`, cookie, {
		method: "POST",
		body,
		headers: { "content-type": type, ...headers },
	});
}

async function makeBoard(owner: string, title: string, visibility: string): Promise<string> {
	const created = await api("/api/boards", owner, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title, visibility }),
	});
	return ((await created.json()) as BoardInfo).id;
}

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	olive = await signIn(mf, "olive");
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
	mallory = await signIn(mf, "mallory");
	board = await makeBoard(olive, "Moodboard", "private");
	other = await makeBoard(olive, "Elsewhere", "private");
	public_ = await makeBoard(olive, "Out in the open", "public");
	for (const [login, role] of [
		["eddie", "editor"],
		["vera", "viewer"],
	] as [string, Role][]) {
		const invited = await api(`/api/boards/${board}/members`, olive, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ logins: [login], role }),
		});
		expect(invited.status).toBe(200);
	}
	// Opening the board takes up an invite, as the app does before anything else.
	for (const cookie of [eddie, vera]) {
		expect((await api(`/api/boards/${board}`, cookie)).status).toBe(200);
	}
});
afterAll(async () => {
	for (const client of clients) client.close();
	await mf.dispose();
});

describe("uploading", () => {
	it("stores an editor's image, named by its hash", async () => {
		const response = await upload(eddie, PNG);
		expect(response.status).toBe(201);
		const body = (await response.json()) as { hash: string; type: string; width: number };
		expect(body).toEqual({ hash: await hashImage(PNG), type: "image/png", width: 1, height: 1 });
	});

	it("keeps the same file once, however often it's uploaded", async () => {
		const stub = await boardStub(mf, board);
		const before = await stub.imageUsage();
		const again = await upload(olive, PNG);
		expect(again.status).toBe(201);
		expect(((await again.json()) as { hash: string }).hash).toBe(await hashImage(PNG));
		expect(await stub.imageUsage()).toEqual(before);
	});

	it("is for editors of the board", async () => {
		expect((await upload(vera, PNG)).status).toBe(403);
		expect((await upload(mallory, PNG)).status).toBe(404);
		expect((await upload("", PNG)).status).toBe(404);
		expect((await upload(olive, PNG, "not-a-board")).status).toBe(404);
	});

	it("takes the raster formats it keeps, and says why it won't take others", async () => {
		expect((await upload(olive, gif())).status).toBe(201);
		const svg = await upload(
			olive,
			new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
		);
		expect(svg.status).toBe(415);
		expect(((await svg.json()) as { message: string }).message).toMatch(/SVG/);
		const text = await upload(olive, new TextEncoder().encode("just some words"));
		expect(text.status).toBe(415);
		expect(((await text.json()) as { message: string }).message).toMatch(/PNG, JPEG, GIF, WebP/);
	});

	it("refuses files that are too big, or too big to decode", async () => {
		const big = new Uint8Array(10 * 1024 * 1024 + 1);
		big.set(PNG);
		const tooBig = await upload(olive, big);
		expect(tooBig.status).toBe(413);
		expect(((await tooBig.json()) as { message: string }).message).toMatch(/10 MB/);
		const huge = await upload(olive, gif(20_000, 20_000));
		expect(huge.status).toBe(413);
		expect(((await huge.json()) as { error: string }).error).toBe("dimensions");
	});

	it("refuses uploads from other sites", async () => {
		const response = await upload(olive, PNG, board, { origin: "https://evil.example" });
		expect(response.status).toBe(403);
	});
});

describe("serving", () => {
	it("serves a file to anyone who can open the board, cached for good", async () => {
		const hash = await hashImage(PNG);
		for (const cookie of [olive, eddie, vera]) {
			const response = await api(`/api/boards/${board}/images/${hash}`, cookie);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/png");
			expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
			expect(response.headers.get("etag")).toBe(`"${hash}"`);
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
		}
		const cached = await api(`/api/boards/${board}/images/${hash}`, vera, {
			headers: { "if-none-match": `"${hash}"` },
		});
		expect(cached.status).toBe(304);
	});

	it("is the same not found for people who can't open the board as for files that aren't there", async () => {
		const hash = await hashImage(PNG);
		expect((await api(`/api/boards/${board}/images/${hash}`, mallory)).status).toBe(404);
		expect((await api(`/api/boards/${board}/images/${hash}`, "")).status).toBe(404);
		// Not even a 304 for someone who can't open it.
		const sneaky = await api(`/api/boards/${board}/images/${hash}`, mallory, {
			headers: { "if-none-match": `"${hash}"` },
		});
		expect(sneaky.status).toBe(404);
		expect((await api(`/api/boards/${board}/images/${"0".repeat(64)}`, olive)).status).toBe(404);
		expect((await api(`/api/boards/${board}/images/nope`, olive)).status).toBe(404);
		// A file on one board isn't on another just because the same person can open both.
		expect((await api(`/api/boards/${other}/images/${hash}`, olive)).status).toBe(404);
	});

	it("serves a public board's images to anyone", async () => {
		expect((await upload(olive, PNG, public_)).status).toBe(201);
		const hash = await hashImage(PNG);
		expect((await api(`/api/boards/${public_}/images/${hash}`, "")).status).toBe(200);
		expect((await api(`/api/boards/${public_}/images/${hash}`, mallory)).status).toBe(200);
	});
});

describe("copying between boards", () => {
	it("copies files from a board you can open to one you can edit", async () => {
		const hash = await hashImage(PNG);
		const missing = "f".repeat(64);
		const response = await api(`/api/boards/${other}/images/copy`, olive, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: board, hashes: [hash, missing] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ copied: [hash], missing: [missing] });
		expect((await api(`/api/boards/${other}/images/${hash}`, olive)).status).toBe(200);
	});

	it("never copies from a board you can't open, or to one you can't edit", async () => {
		const hash = await hashImage(PNG);
		const mine = await makeBoard(mallory, "Mallory's", "private");
		const steal = await api(`/api/boards/${mine}/images/copy`, mallory, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: board, hashes: [hash] }),
		});
		expect(steal.status).toBe(404);
		expect((await api(`/api/boards/${mine}/images/${hash}`, mallory)).status).toBe(404);
		const viewer = await api(`/api/boards/${board}/images/copy`, vera, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ from: other, hashes: [hash] }),
		});
		expect(viewer.status).toBe(403);
	});
});

describe("letting go", () => {
	it("keeps files the board shows or its history mentions, and lets go of the rest after a week", async () => {
		const id = await makeBoard(olive, "Sweeping", "private");
		const shown = await hashImage(PNG);
		const removed = await hashImage(gif(5, 5));
		const never = await hashImage(gif(7, 7));
		for (const bytes of [PNG, gif(5, 5), gif(7, 7)]) {
			expect((await upload(olive, bytes, id)).status).toBe(201);
		}
		const result = await connectBoard(mf, id, olive);
		if (!result.ok) throw new Error("connect");
		const client = result.client;
		clients.push(client);
		client.doc.transact(() => {
			for (const [shape, hash] of [
				["a", shown],
				["b", removed],
			] as const) {
				addImageShape(client.doc, shape, {
					x: 0,
					y: 0,
					w: 10,
					h: 10,
					iw: 1,
					ih: 1,
					mime: "image/png",
					image: hash,
				});
			}
		});
		await client.roundTrip();
		// History records them (reading it saves).
		expect((await api(`/api/boards/${id}/history`, olive)).status).toBe(200);
		client.doc.transact(() => shapesMap(client.doc).delete("b"));
		await client.roundTrip();
		const stub = await boardStub(mf, id);
		// Nothing goes within the week.
		expect(await stub.sweepImages(Date.now())).toEqual([]);
		// A week on: only the file nothing ever showed.
		const later = Date.now() + 8 * 24 * 60 * 60_000;
		expect(await stub.sweepImages(later)).toEqual([never]);
		expect((await api(`/api/boards/${id}/images/${shown}`, olive)).status).toBe(200);
		expect((await api(`/api/boards/${id}/images/${removed}`, olive)).status).toBe(200);
		expect((await api(`/api/boards/${id}/images/${never}`, olive)).status).toBe(404);
	});
});
