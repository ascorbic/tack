// Board snapshots for backlinks (#33): uploads by editors, served publicly
// by an unguessable id.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { BoardInfo } from "../src/shared/boards.ts";
import { pngSize } from "../src/shared/backlinks.ts";
import { FakeGitHub } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";

// A real 1×1 PNG.
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

let mf: Miniflare;
const github = new FakeGitHub();
let olive = "";
let eddie = "";
let vera = "";
let board: BoardInfo;

function api(path: string, cookie: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers as HeadersInit);
	if (cookie) headers.set("cookie", cookie);
	if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
	return mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
}

function upload(
	cookie: string,
	body: BodyInit = PNG,
	headers: Record<string, string> = {},
	id = board.id,
) {
	return api(`/api/boards/${id}/snapshots`, cookie, {
		method: "POST",
		body,
		headers: { "content-type": "image/png", ...headers },
	});
}

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: github.fetch });
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	olive = await signIn(mf, "olive");
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
	const created = await api("/api/boards", olive, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "Snapshots", visibility: "private" }),
	});
	board = (await created.json()) as BoardInfo;
	for (const [login, role] of [
		["eddie", "editor"],
		["vera", "viewer"],
	]) {
		const invited = await api(`/api/boards/${board.id}/members`, olive, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ logins: [login], role }),
		});
		expect(invited.status).toBe(200);
	}
});
afterAll(() => mf.dispose());

describe("snapshots", () => {
	it("stores an editor's PNG and serves it publicly, cached for good", async () => {
		const response = await upload(eddie);
		expect(response.status).toBe(201);
		const { url } = (await response.json()) as { url: string };
		const path = new URL(url).pathname;
		expect(path).toMatch(/^\/snapshots\/[0-9a-f]{96}\.png$/);
		// Nothing in the id gives the board away.
		expect(path).not.toContain(board.id);

		const image = await mf.dispatchFetch(`${ORIGIN}${path}`);
		expect(image.status).toBe(200);
		expect(image.headers.get("content-type")).toBe("image/png");
		expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(image.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);

		// Each upload gets its own id.
		const again = (await (await upload(olive)).json()) as { url: string };
		expect(again.url).not.toBe(url);
	});

	it("is for editors only", async () => {
		expect((await upload(vera)).status).toBe(403);
		expect((await upload("")).status).toBe(401);
		expect((await upload(olive, PNG, {}, "nope-not-a-board")).status).toBe(404);
	});

	it("only takes PNGs, and not huge ones", async () => {
		expect((await upload(olive, PNG, { "content-type": "image/jpeg" })).status).toBe(415);
		expect((await upload(olive, new TextEncoder().encode("<svg></svg>"))).status).toBe(415);
		const big = new Uint8Array(1_600_000);
		big.set(PNG);
		expect((await upload(olive, big)).status).toBe(413);
		const wide = PNG.slice();
		new DataView(wide.buffer).setUint32(16, 10_000);
		expect((await upload(olive, wide)).status).toBe(413);
	});

	it("refuses cross-site uploads", async () => {
		expect((await upload(olive, PNG, { origin: "https://evil.example" })).status).toBe(403);
	});

	it("says not found for unknown or malformed ids", async () => {
		const unknown = await mf.dispatchFetch(`${ORIGIN}/snapshots/${"a".repeat(96)}.png`);
		expect(unknown.status).toBe(404);
		const short = await mf.dispatchFetch(`${ORIGIN}/snapshots/abc.png`);
		expect(short.status).toBe(404);
		const { url } = (await (await upload(olive)).json()) as { url: string };
		const guessed = url.replace(/[0-9a-f]{4}\.png$/, "0000.png");
		expect((await mf.dispatchFetch(guessed.replace(/^https?:\/\/[^/]+/, ORIGIN))).status).toBe(
			guessed === url ? 200 : 404,
		);
	});
});

describe("pngSize", () => {
	it("reads a PNG's size, and nothing else", () => {
		expect(pngSize(PNG)).toEqual({ width: 1, height: 1 });
		expect(pngSize(new Uint8Array(40))).toBeNull();
	});
});
