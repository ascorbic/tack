// Link cards through the Worker: reading a page (who may, what's refused,
// caching, rate limits) and the image proxy (only images a link card on the
// board shows, checked and passed on with a strict policy). Outbound fetches,
// DNS over HTTPS included, are answered by a fake web here.

import { type Miniflare, type Request, Response } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { addLinkShape } from "../src/shared/links.ts";
import { transactLocal } from "../src/shared/shapes.ts";
import { UNFURL_LIMITS } from "../src/server/links/budget.ts";
import { connectBoard, eventually } from "./board-client.ts";
import { signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);

/** Every outbound request, and how the fake web answers. */
const requests: string[] = [];
const ADDRESSES: Record<string, string> = {
	"unpic.pics": "104.21.32.1",
	"tack.social": "104.21.0.9",
	"private.tack.social": "10.0.0.7",
};

function outbound(request: Request): Response {
	const url = new URL(request.url);
	requests.push(request.url);
	if (url.hostname === "cloudflare-dns.com") {
		const name = url.searchParams.get("name") ?? "";
		const type = url.searchParams.get("type");
		const address = ADDRESSES[name];
		return Response.json({
			Status: address ? 0 : 3,
			Answer: address && type === "A" ? [{ type: 1, data: address }] : [],
		});
	}
	if (request.url === "https://unpic.pics/") {
		return new Response(
			`<head><title>Unpic</title><meta property="og:title" content="Unpic: responsive images"><meta property="og:image" content="/og.png"></head>`,
			{ headers: { "content-type": "text/html" } },
		);
	}
	if (request.url === "https://unpic.pics/og.png") {
		return new Response(PNG, { headers: { "content-type": "image/png" } });
	}
	if (request.url === "https://tack.social/go") {
		return new Response(null, {
			status: 302,
			headers: { location: "https://private.tack.social/" },
		});
	}
	if (url.hostname === "tack.social") {
		return new Response(`<title>${url.pathname}</title>`, {
			headers: { "content-type": "text/html" },
		});
	}
	return new Response("Not found", { status: 404 });
}

let mf: Miniflare;
let owner = "";
let viewer = "";
let board = "";

function call(cookie: string, method: string, path: string, body?: unknown) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method,
		headers: {
			...(cookie ? { cookie } : {}),
			...(method !== "GET" ? { origin: ORIGIN, "content-type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	} as never);
}

const unfurl = (cookie: string, url: string) =>
	call(cookie, "POST", `/api/boards/${board}/unfurl`, { url });

beforeAll(async () => {
	mf = startWorker({ devAuth: true, outboundService: outbound });
	owner = await signIn(mf, "olive", { name: "Olive" });
	viewer = await signIn(mf, "vera", { name: "Vera" });
	const made = await call(owner, "POST", "/api/boards", { title: "Links", visibility: "private" });
	board = ((await made.json()) as { id: string }).id;
	await call(owner, "POST", `/api/boards/${board}/members`, { logins: ["vera"], role: "viewer" });
});

afterAll(async () => {
	await mf.dispose();
});

describe("POST /api/boards/:id/unfurl", () => {
	it("reads a page's preview for an editor, then answers from the cache", async () => {
		const first = await unfurl(owner, "https://unpic.pics");
		expect(first.status).toBe(200);
		expect(((await first.json()) as { preview: unknown }).preview).toMatchObject({
			status: "ok",
			title: "Unpic: responsive images",
			image: "https://unpic.pics/og.png",
			icon: "https://unpic.pics/favicon.ico",
		});
		const pages = requests.filter((url) => url === "https://unpic.pics/").length;
		const again = await unfurl(owner, "https://unpic.pics/");
		expect(((await again.json()) as { preview: { title: string } }).preview.title).toBe(
			"Unpic: responsive images",
		);
		expect(requests.filter((url) => url === "https://unpic.pics/").length).toBe(pages);
	});

	it("blocks private addresses, and redirects to them, without fetching them", async () => {
		const before = requests.length;
		const literal = await unfurl(owner, "http://169.254.169.254/latest/meta-data/");
		expect(((await literal.json()) as { preview: unknown }).preview).toMatchObject({
			status: "blocked",
		});
		expect(requests.slice(before).some((url) => url.includes("169.254"))).toBe(false);

		const redirected = await unfurl(owner, "https://tack.social/go");
		expect(((await redirected.json()) as { preview: unknown }).preview).toMatchObject({
			status: "blocked",
		});
		expect(requests.some((url) => url.startsWith("https://private.tack.social"))).toBe(false);
	});

	it("is for editors, signed in, with a web address", async () => {
		expect((await unfurl(viewer, "https://unpic.pics/")).status).toBe(403);
		expect((await unfurl("", "https://unpic.pics/")).status).toBe(401);
		expect((await unfurl(owner, "javascript:alert(1)")).status).toBe(400);
		expect((await unfurl(owner, "see https://unpic.pics")).status).toBe(400);
	});

	it("limits how many pages one person reads a minute", async () => {
		const statuses: number[] = [];
		for (let i = 0; i <= UNFURL_LIMITS.person.minute; i++) {
			statuses.push((await unfurl(owner, `https://tack.social/page-${i}`)).status);
		}
		expect(statuses).toContain(429);
		const refused = await unfurl(owner, "https://tack.social/one-more");
		expect(refused.status).toBe(429);
		expect(((await refused.json()) as { retryAt: number }).retryAt).toBeGreaterThan(Date.now());
		// What's cached still answers.
		expect((await unfurl(owner, "https://unpic.pics/")).status).toBe(200);
	});
});

describe("GET /api/boards/:id/links/image", () => {
	const image = (cookie: string, src: string) =>
		call(cookie, "GET", `/api/boards/${board}/links/image?src=${encodeURIComponent(src)}`);

	it("only passes on images a link card on the board shows", async () => {
		const before = requests.length;
		const refused = await image(owner, "https://unpic.pics/og.png");
		expect(refused.status).toBe(404);
		expect(requests.slice(before)).toEqual([]);

		const connected = await connectBoard(mf, board, owner);
		if (!connected.ok) throw new Error("couldn't connect");
		const { client } = connected;
		transactLocal(client.doc, () =>
			addLinkShape(client.doc, "link-1", {
				url: "https://unpic.pics/",
				x: 0,
				y: 0,
				preview: {
					status: "ok",
					title: "Unpic",
					image: "https://unpic.pics/og.png",
					fetchedAt: new Date().toISOString(),
				},
			}),
		);
		await client.roundTrip();

		await eventually(async () => (await image(viewer, "https://unpic.pics/og.png")).status === 200);
		const shown = await image(viewer, "https://unpic.pics/og.png");
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(shown.headers.get("content-security-policy")).toContain("sandbox");
		expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
		expect(shown.headers.get("cache-control")).toContain("private");
		expect(new Uint8Array(await shown.arrayBuffer())).toEqual(PNG);
		// Someone without access gets nothing, whatever's cached.
		expect((await image("", "https://unpic.pics/og.png")).status).toBe(404);
		client.close();
	});

	it("refuses an image address that isn't one", async () => {
		expect((await image(owner, "javascript:alert(1)")).status).toBe(400);
	});
});
