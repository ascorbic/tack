import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	LINK_RETRY_MS,
	LINK_STALE_MS,
	type LinkPreview,
	addLinksInRun,
	linkAssets,
	linkText,
	linkUrl,
	needsUnfurl,
	readPreview,
} from "../src/shared/links.ts";
import { type ShapeProps, addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { collectItems } from "../src/shared/aiContext.ts";
import { describeShape } from "../src/shared/a11y.ts";
import { countMembers, namingTexts } from "../src/shared/stacks.ts";
import { PreviewCache, type ResponseStore } from "../src/server/links/cache.ts";
import {
	type Resolver,
	checkUrl,
	guardedFetch,
	isPublicAddress,
	parseV6,
	readCapped,
} from "../src/server/links/guard.ts";
import { decodeEntities, decodePage, parsePage } from "../src/server/links/parse.ts";
import { Budget } from "../src/server/links/budget.ts";
import { MAX_IMAGE_BYTES, fetchImage, sniffImage, unfurl } from "../src/server/links/unfurl.ts";

// Link cards: the address rules, the SSRF guard (private addresses in every
// spelling, DNS answers, redirects, ports), reading a page's head, the image
// proxy's checks, caching, rate limits, and the shape in the document.

/** A resolver from a table of hosts; anything else doesn't resolve. */
function resolver(table: Record<string, string[]>): Resolver {
	return async (host) => table[host] ?? null;
}

/** A fake web: each address answers with a function of the request, and every request is kept. */
function web(routes: Record<string, (request: Request) => Response | Promise<Response>>) {
	const requests: string[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request.url);
		const route = routes[request.url];
		if (!route) throw new TypeError("fetch failed");
		return route(request);
	}) as typeof fetch;
	return { fetch: fetcher, requests };
}

const PUBLIC = resolver({
	"unpic.pics": ["104.21.32.1", "2606:4700:3030::6815:2001"],
	"emdashcms.com": ["172.67.1.1"],
	"tack.social": ["104.21.0.9"],
	"cdn.tack.social": ["104.21.0.10"],
	"evil.tack.social": ["104.21.0.11", "10.0.0.5"],
	"rebind.tack.social": ["127.0.0.1"],
	"metadata.tack.social": ["169.254.169.254"],
	"v6local.tack.social": ["fd00:ec2::254"],
	"mapped.tack.social": ["::ffff:192.168.0.1"],
});

describe("linkUrl", () => {
	it("accepts bare http(s) addresses, normalised", () => {
		expect(linkUrl("https://unpic.pics")).toBe("https://unpic.pics/");
		expect(linkUrl("  http://tack.social/docs?x=1#top ")).toBe("http://tack.social/docs?x=1#top");
		expect(linkUrl("www.emdashcms.com")).toBe("https://www.emdashcms.com/");
		expect(linkUrl("<https://tack.social/>")).toBe("https://tack.social/");
		expect(linkUrl("HTTPS://TACK.SOCIAL/Docs")).toBe("https://tack.social/Docs");
	});

	it("refuses anything else", () => {
		for (const text of [
			"",
			"tack.social",
			"see https://tack.social",
			"https://tack.social https://unpic.pics",
			"javascript:alert(1)",
			"data:text/html,hi",
			"file:///etc/passwd",
			"ftp://tack.social",
			"https://intranet/",
			`https://tack.social/${"a".repeat(2100)}`,
		]) {
			expect(linkUrl(text), text).toBeNull();
		}
	});
});

describe("checkUrl", () => {
	const check = (url: string) => checkUrl(new URL(url));

	it("allows public addresses on standard ports", () => {
		expect(check("https://unpic.pics/")).toBeNull();
		expect(check("http://tack.social:80/")).toBeNull();
		expect(check("https://tack.social:443/x")).toBeNull();
		expect(check("https://104.21.32.1/")).toBeNull();
		expect(check("https://[2606:4700:3030::6815:2001]/")).toBeNull();
	});

	it("refuses other schemes, credentials and ports", () => {
		expect(check("ftp://tack.social/")).toBe("scheme");
		expect(check("https://user:pass@tack.social/")).toBe("credentials");
		expect(check("https://user@tack.social/")).toBe("credentials");
		expect(check("https://tack.social:8443/")).toBe("port");
		expect(check("http://tack.social:443/")).toBe("port");
		expect(check("https://tack.social:22/")).toBe("port");
	});

	it("refuses local names", () => {
		for (const url of [
			"http://localhost/",
			"http://LOCALHOST./",
			"http://app.localhost/",
			"http://printer.local/",
			"http://metadata.google.internal/",
			"http://router.home.arpa/",
			"http://intranet/",
		]) {
			expect(check(url), url).toBe("host");
		}
	});

	it("refuses private IPv4 addresses in every spelling", () => {
		for (const url of [
			"http://127.0.0.1/",
			"http://127.1/",
			"http://2130706433/",
			"http://0x7f000001/",
			"http://017700000001/",
			"http://0.0.0.0/",
			"http://10.1.2.3/",
			"http://172.16.0.1/",
			"http://172.31.255.255/",
			"http://192.168.1.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://100.100.100.200/",
			"http://224.0.0.1/",
			"http://255.255.255.255/",
		]) {
			expect(check(url), url).toBe("private_address");
		}
		expect(check("http://172.32.0.1/")).toBeNull();
	});

	it("refuses private IPv6 addresses, and IPv4 inside IPv6", () => {
		for (const url of [
			"http://[::1]/",
			"http://[::]/",
			"http://[fe80::1]/",
			"http://[fc00::1]/",
			"http://[fd00:ec2::254]/",
			"http://[ff02::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://[::ffff:7f00:1]/",
			"http://[::ffff:a9fe:a9fe]/",
			"http://[64:ff9b::a00:1]/",
			"http://[2002:c0a8:101::1]/",
			"http://[2001:db8::1]/",
			"http://[::127.0.0.1]/",
		]) {
			expect(check(url), url).toBe("private_address");
		}
		// A public IPv4 inside NAT64 is public.
		expect(check("http://[64:ff9b::6815:2001]/")).toBeNull();
	});
});

describe("IP addresses", () => {
	it("reads IPv6 in its shorthand forms", () => {
		expect(parseV6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		expect(parseV6("2606:4700::1")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 1]);
		expect(parseV6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
		expect(parseV6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
		expect(parseV6("1:2:3")).toBeNull();
		expect(parseV6("1::2::3")).toBeNull();
		expect(parseV6("gggg::1")).toBeNull();
	});

	it("knows public from private", () => {
		expect(isPublicAddress("104.21.32.1")).toBe(true);
		expect(isPublicAddress("2606:4700:3030::6815:2001")).toBe(true);
		expect(isPublicAddress("10.0.0.1")).toBe(false);
		expect(isPublicAddress("fd12::1")).toBe(false);
		expect(isPublicAddress("not an address")).toBe(false);
	});
});

describe("guardedFetch", () => {
	const html = (body: string, headers: Record<string, string> = {}) =>
		new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

	it("fetches a public page, resolving its host first", async () => {
		const site = web({ "https://unpic.pics/": () => html("<title>Unpic</title>") });
		const result = await guardedFetch("https://unpic.pics/", {
			fetch: site.fetch,
			resolve: PUBLIC,
			accept: "text/html",
		});
		expect(result.kind).toBe("ok");
		expect(site.requests).toEqual(["https://unpic.pics/"]);
	});

	it("refuses a host with any private DNS answer, before fetching", async () => {
		const site = web({});
		for (const host of [
			"evil.tack.social",
			"rebind.tack.social",
			"metadata.tack.social",
			"v6local.tack.social",
			"mapped.tack.social",
		]) {
			const result = await guardedFetch(`https://${host}/`, {
				fetch: site.fetch,
				resolve: PUBLIC,
				accept: "text/html",
			});
			expect(result, host).toMatchObject({ kind: "blocked", reason: "private_address" });
		}
		expect(site.requests).toEqual([]);
	});

	it("fails a host that doesn't resolve", async () => {
		const result = await guardedFetch("https://nowhere.tack.social/", {
			fetch: web({}).fetch,
			resolve: PUBLIC,
			accept: "text/html",
		});
		expect(result).toMatchObject({ kind: "failed", reason: "dns" });
	});

	it("follows redirects by hand, checking every hop", async () => {
		const site = web({
			"https://tack.social/old": () =>
				new Response(null, { status: 301, headers: { location: "/new" } }),
			"https://tack.social/new": () =>
				new Response(null, { status: 302, headers: { location: "https://cdn.tack.social/page" } }),
			"https://cdn.tack.social/page": () => html("<title>Here</title>"),
		});
		const result = await guardedFetch("https://tack.social/old", {
			fetch: site.fetch,
			resolve: PUBLIC,
			accept: "text/html",
		});
		expect(result).toMatchObject({ kind: "ok", url: "https://cdn.tack.social/page" });
		expect(site.requests).toHaveLength(3);
	});

	it("refuses a redirect to a private address, a local name or another port", async () => {
		for (const location of [
			"http://127.0.0.1/admin",
			"http://169.254.169.254/latest/meta-data/",
			"http://[::1]/",
			"http://localhost:8080/",
			"https://rebind.tack.social/",
			"https://tack.social:8443/",
			"file:///etc/passwd",
		]) {
			const site = web({
				"https://tack.social/go": () => new Response(null, { status: 302, headers: { location } }),
			});
			const result = await guardedFetch("https://tack.social/go", {
				fetch: site.fetch,
				resolve: PUBLIC,
				accept: "text/html",
			});
			expect(result.kind, location).toBe("blocked");
			// Only the first hop was ever requested.
			expect(site.requests).toEqual(["https://tack.social/go"]);
		}
	});

	it("gives up after three redirects", async () => {
		const site = web({
			"https://tack.social/0": () =>
				new Response(null, { status: 302, headers: { location: "/1" } }),
			"https://tack.social/1": () =>
				new Response(null, { status: 302, headers: { location: "/2" } }),
			"https://tack.social/2": () =>
				new Response(null, { status: 302, headers: { location: "/3" } }),
			"https://tack.social/3": () =>
				new Response(null, { status: 302, headers: { location: "/4" } }),
			"https://tack.social/4": () => html("<title>Too far</title>"),
		});
		const result = await guardedFetch("https://tack.social/0", {
			fetch: site.fetch,
			resolve: PUBLIC,
			accept: "text/html",
		});
		expect(result).toMatchObject({ kind: "failed", reason: "redirects" });
		expect(site.requests).toHaveLength(4);
	});

	it("times out a page that never answers", async () => {
		const never = (async (_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as typeof fetch;
		const result = await guardedFetch("https://tack.social/", {
			fetch: never,
			resolve: PUBLIC,
			accept: "text/html",
			timeoutMs: 50,
		});
		expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
	});
});

describe("readCapped", () => {
	it("reads only as much as it's allowed, then stops", async () => {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(64 * 1024).fill(97));
				if (pulled > 1000) controller.close();
			},
		});
		const { bytes, truncated } = await readCapped(new Response(body), 200 * 1024);
		expect(bytes.byteLength).toBe(200 * 1024);
		expect(truncated).toBe(true);
		expect(pulled).toBeLessThan(10);
	});

	it("reads a short body whole", async () => {
		const { bytes, truncated } = await readCapped(new Response("hello"), 1024);
		expect(new TextDecoder().decode(bytes)).toBe("hello");
		expect(truncated).toBe(false);
	});
});

describe("parsePage", () => {
	it("prefers Open Graph, then Twitter, then the page's own tags", () => {
		const meta = parsePage(
			`<!doctype html><html><head>
				<title>Unpic | Home</title>
				<meta name="description" content="Plain description">
				<meta name="twitter:title" content="Twitter title">
				<meta property="og:title" content="Unpic: responsive images">
				<meta property="og:description" content="Image components &amp; more">
				<meta property="og:site_name" content="Unpic">
				<meta property="og:image" content="/og.png">
				<link rel="icon" href="/favicon.svg" type="image/svg+xml">
			</head><body><meta property="og:title" content="Not this"></body></html>`,
			"https://unpic.pics/docs/",
		);
		expect(meta).toEqual({
			title: "Unpic: responsive images",
			description: "Image components & more",
			siteName: "Unpic",
			image: "https://unpic.pics/og.png",
			icon: "https://unpic.pics/favicon.svg",
		});
	});

	it("falls back to the title, the description and /favicon.ico", () => {
		const meta = parsePage(
			`<head><title> EmDash &mdash; docs </title><meta name=description content='Write it once'></head>`,
			"https://emdashcms.com/docs",
		);
		expect(meta).toEqual({
			title: "EmDash — docs",
			description: "Write it once",
			icon: "https://emdashcms.com/favicon.ico",
		});
	});

	it("reads Twitter cards when there's no Open Graph", () => {
		const meta = parsePage(
			`<meta name="twitter:title" content="Tack"><meta name="twitter:image:src" content="https://cdn.tack.social/card.png">`,
			"https://tack.social/",
		);
		expect(meta.title).toBe("Tack");
		expect(meta.image).toBe("https://cdn.tack.social/card.png");
	});

	it("resolves relative addresses against the page, or its <base>", () => {
		const meta = parsePage(
			`<base href="https://cdn.tack.social/assets/"><meta property="og:image" content="og.png"><link rel="apple-touch-icon" href="../touch.png">`,
			"https://tack.social/a/b",
		);
		expect(meta.image).toBe("https://cdn.tack.social/assets/og.png");
		expect(meta.icon).toBe("https://cdn.tack.social/touch.png");
		expect(
			parsePage(
				`<meta property="og:image" content="//cdn.tack.social/x.png">`,
				"https://tack.social/",
			).image,
		).toBe("https://cdn.tack.social/x.png");
	});

	it("never keeps an image or icon that isn't http(s)", () => {
		const meta = parsePage(
			`<meta property="og:image" content="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AAAA">`,
			"https://tack.social/",
		);
		expect(meta.image).toBeUndefined();
		expect(meta.icon).toBe("https://tack.social/favicon.ico");
	});

	it("picks a crisp icon over a tiny one", () => {
		const meta = parsePage(
			`<link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/64.png" sizes="64x64"><link rel="mask-icon" href="/mask.svg">`,
			"https://tack.social/",
		);
		expect(meta.icon).toBe("https://tack.social/64.png");
	});

	it("ignores tags in comments, scripts and the body", () => {
		const meta = parsePage(
			`<head><!-- <meta property="og:title" content="Commented"> --><script>var s = '<meta property="og:title" content="Scripted">';</script><title>Real</title></head>`,
			"https://tack.social/",
		);
		expect(meta.title).toBe("Real");
	});

	it("tidies and clamps what it keeps", () => {
		const meta = parsePage(
			`<meta property="og:title" content="${"Long ".repeat(200)}"><meta property="og:description" content="  two\n\nlines\u0000 ">`,
			"https://tack.social/",
		);
		expect(meta.title?.length).toBeLessThanOrEqual(300);
		expect(meta.title?.endsWith("…")).toBe(true);
		expect(meta.description).toBe("two lines");
	});

	it("copes with a page with nothing in it, and a huge one", () => {
		expect(parsePage("", "https://tack.social/")).toEqual({
			icon: "https://tack.social/favicon.ico",
		});
		const huge = `<head><title>Big</title></head><body>${"<p>words</p>".repeat(200_000)}</body>`;
		const started = performance.now();
		expect(parsePage(huge, "https://tack.social/").title).toBe("Big");
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("decodes entities, and pages in other character sets", () => {
		expect(decodeEntities("&lt;b&gt; &#39;x&#x27; &copy; &unknown;")).toBe("<b> 'x' © &unknown;");
		const latin1 = new Uint8Array([
			...new TextEncoder().encode("<title>Caf"),
			0xe9,
			...new TextEncoder().encode("</title>"),
		]);
		expect(
			parsePage(decodePage("text/html; charset=iso-8859-1", latin1), "https://tack.social/").title,
		).toBe("Café");
	});
});

describe("unfurl", () => {
	const now = () => Date.parse("2026-10-12T10:00:00Z");

	it("reads a page's preview", async () => {
		const site = web({
			"https://unpic.pics/": () =>
				new Response(
					`<head><meta property="og:title" content="Unpic"><meta property="og:image" content="/og.png"></head>`,
					{ headers: { "content-type": "text/html" } },
				),
		});
		expect(
			await unfurl("https://unpic.pics/", { fetch: site.fetch, resolve: PUBLIC, now }),
		).toEqual({
			status: "ok",
			title: "Unpic",
			image: "https://unpic.pics/og.png",
			icon: "https://unpic.pics/favicon.ico",
			fetchedAt: "2026-10-12T10:00:00.000Z",
		});
	});

	it("says a page with no Open Graph is ok, with what it has", async () => {
		const site = web({
			"https://tack.social/plain": () =>
				new Response("<p>Nothing here</p>", { headers: { "content-type": "text/html" } }),
		});
		const preview = await unfurl("https://tack.social/plain", {
			fetch: site.fetch,
			resolve: PUBLIC,
			now,
		});
		expect(preview).toEqual({
			status: "ok",
			icon: "https://tack.social/favicon.ico",
			fetchedAt: "2026-10-12T10:00:00.000Z",
		});
	});

	it("previews a link straight to an image as itself", async () => {
		const site = web({
			"https://cdn.tack.social/shot.png": () =>
				new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } }),
		});
		const preview = await unfurl("https://cdn.tack.social/shot.png", {
			fetch: site.fetch,
			resolve: PUBLIC,
			now,
		});
		expect(preview).toMatchObject({
			status: "ok",
			title: "shot.png",
			image: "https://cdn.tack.social/shot.png",
		});
	});

	it("fails pages that error, and blocks addresses Tack won't read", async () => {
		const site = web({ "https://tack.social/gone": () => new Response("no", { status: 404 }) });
		expect(
			await unfurl("https://tack.social/gone", { fetch: site.fetch, resolve: PUBLIC, now }),
		).toMatchObject({
			status: "failed",
		});
		expect(
			await unfurl("http://192.168.1.1/", { fetch: site.fetch, resolve: PUBLIC, now }),
		).toMatchObject({
			status: "blocked",
		});
		expect(
			await unfurl("https://evil.tack.social/", { fetch: site.fetch, resolve: PUBLIC, now }),
		).toMatchObject({
			status: "blocked",
		});
		expect(site.requests).toEqual(["https://tack.social/gone"]);
	});
});

describe("the image proxy's checks", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

	it("knows images by their bytes, never by what the server says", () => {
		expect(sniffImage(PNG)).toBe("image/png");
		expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffImage(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
		expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
		expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="x"/>'))).toBe(
			"image/svg+xml",
		);
		expect(sniffImage(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
	});

	it("passes on an image, and refuses what isn't one or is too big", async () => {
		const site = web({
			"https://cdn.tack.social/og.png": () =>
				new Response(PNG, { headers: { "content-type": "image/png" } }),
			"https://cdn.tack.social/lie.png": () =>
				new Response("<script>alert(1)</script>", { headers: { "content-type": "image/png" } }),
			"https://cdn.tack.social/page": () =>
				new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }),
			"https://cdn.tack.social/huge.png": () =>
				new Response(new Uint8Array(MAX_IMAGE_BYTES + 10), {
					headers: { "content-type": "image/png" },
				}),
		});
		const deps = { fetch: site.fetch, resolve: PUBLIC };
		expect(await fetchImage("https://cdn.tack.social/og.png", deps)).toMatchObject({
			kind: "ok",
			type: "image/png",
		});
		expect(await fetchImage("https://cdn.tack.social/lie.png", deps)).toEqual({
			kind: "not_image",
		});
		expect(await fetchImage("https://cdn.tack.social/page", deps)).toEqual({ kind: "not_image" });
		expect(await fetchImage("https://cdn.tack.social/huge.png", deps)).toEqual({
			kind: "too_large",
		});
		expect(await fetchImage("http://169.254.169.254/x.png", deps)).toEqual({ kind: "blocked" });
	});
});

describe("PreviewCache", () => {
	function memoryStore(): ResponseStore & { keys: () => string[] } {
		const kept = new Map<string, Response>();
		return {
			async match(key) {
				return kept.get(key)?.clone();
			},
			async put(key, response) {
				kept.set(key, response);
			},
			keys: () => [...kept.keys()],
		};
	}
	const preview = (status: LinkPreview["status"]): LinkPreview => ({
		status,
		title: "Tack",
		fetchedAt: "2026-10-12T10:00:00.000Z",
	});

	it("keeps previews a day, and failures an hour", async () => {
		let now = 0;
		const store = memoryStore();
		const cache = new PreviewCache(store, () => now);
		await cache.put("https://tack.social/", preview("ok"));
		await cache.put("https://tack.social/down", preview("failed"));
		expect(await cache.get("https://tack.social/")).toEqual(preview("ok"));
		now = LINK_RETRY_MS + 1;
		expect(await cache.get("https://tack.social/down")).toBeNull();
		expect(await cache.get("https://tack.social/")).toEqual(preview("ok"));
		now = LINK_STALE_MS + 1;
		expect(await cache.get("https://tack.social/")).toBeNull();
	});

	it("reads back from the shared store in another isolate", async () => {
		const store = memoryStore();
		await new PreviewCache(store, () => 0).put("https://unpic.pics/", preview("ok"));
		expect(store.keys()).toHaveLength(1);
		expect(await new PreviewCache(store, () => 1000).get("https://unpic.pics/")).toEqual(
			preview("ok"),
		);
		expect(await new PreviewCache(store, () => 1000).get("https://emdashcms.com/")).toBeNull();
	});
});

describe("Budget", () => {
	it("allows so many a minute and an hour per key", () => {
		let now = 0;
		const budget = new Budget({ minute: 2, hour: 3 }, () => now);
		expect(budget.take("a")).toBeNull();
		expect(budget.take("a")).toBeNull();
		expect(budget.take("a")).toBe(60_000);
		expect(budget.take("b")).toBeNull();
		now = 61_000;
		expect(budget.take("a")).toBeNull();
		now = 130_000;
		expect(budget.take("a")).toBe(3_600_000);
	});
});

describe("link shapes", () => {
	it("read previews field by field, dropping what isn't ours", () => {
		expect(readPreview(null)).toBeNull();
		expect(readPreview({ status: "ok" })).toBeNull();
		expect(readPreview({ status: "weird", fetchedAt: "2026-10-12T10:00:00Z" })).toBeNull();
		expect(
			readPreview({
				status: "ok",
				fetchedAt: "2026-10-12T10:00:00Z",
				title: 42,
				description: " Hello\nthere ",
				image: "javascript:alert(1)",
				icon: "https://tack.social/i.png",
				extra: "dropped",
			}),
		).toEqual({
			status: "ok",
			fetchedAt: "2026-10-12T10:00:00Z",
			description: "Hello there",
			icon: "https://tack.social/i.png",
		});
	});

	it("are read again when they're stale, or failed an hour ago", () => {
		const at = Date.parse("2026-10-12T10:00:00Z");
		const ok = { status: "ok" as const, fetchedAt: "2026-10-12T10:00:00Z" };
		expect(needsUnfurl(null, at)).toBe(true);
		expect(needsUnfurl(ok, at + 1000)).toBe(false);
		expect(needsUnfurl(ok, at + LINK_STALE_MS + 1)).toBe(true);
		expect(needsUnfurl({ ...ok, status: "failed" }, at + LINK_RETRY_MS + 1)).toBe(true);
		// A clock that's behind never loops.
		expect(needsUnfurl(ok, at - 60_000)).toBe(false);
	});

	it("say what they are in words, with or without a preview", () => {
		expect(linkText({ url: "https://tack.social/docs/boards/" })).toEqual({
			title: "tack.social/docs/boards",
			host: "tack.social",
		});
		expect(
			linkText({
				url: "https://www.unpic.pics/",
				preview: {
					status: "ok",
					title: "Unpic",
					description: "Images",
					siteName: "Unpic",
					fetchedAt: "2026-10-12T10:00:00Z",
				},
			}),
		).toEqual({ title: "Unpic", description: "Images", host: "Unpic" });
	});

	it("are read as text by AI and stack names, and named for screen readers", () => {
		const link: ShapeProps = {
			type: "link",
			x: 0,
			y: 0,
			z: "a0",
			url: "https://unpic.pics/",
			preview: {
				status: "ok",
				title: "Unpic",
				description: "Responsive images",
				fetchedAt: "2026-10-12T10:00:00Z",
			},
		};
		const shapes = new Map<string, ShapeProps>([["l", link]]);
		expect(collectItems(shapes, ["l"], () => null).items).toEqual([
			{ kind: "text", text: "Link: Unpic — Responsive images (unpic.pics)" },
		]);
		expect(namingTexts(shapes, ["l"])).toEqual(["Unpic: Responsive images"]);
		expect(describeShape("l", link)).toBe("Unpic, unpic.pics");
		expect(countMembers(["link", "link"])).toBe("2 links");
		expect(countMembers(["link", "sticky"])).toBe("2 items");
	});

	it("name the images the proxy may fetch for them", () => {
		expect(
			linkAssets({
				type: "link",
				preview: {
					status: "ok",
					image: "https://unpic.pics/og.png",
					icon: "https://unpic.pics/favicon.svg",
					fetchedAt: "2026-10-12T10:00:00Z",
				},
			}),
		).toEqual(["https://unpic.pics/og.png", "https://unpic.pics/favicon.svg"]);
		expect(linkAssets({ type: "sticky" })).toEqual([]);
	});

	it("are added in a run, never twice for the same address unless asked", () => {
		const doc = new Y.Doc();
		const first = addLinksInRun(doc, ["https://unpic.pics/", "https://tack.social/"], {
			origin: { x: 0, y: 0 },
			count: 0,
		});
		expect(first.added).toHaveLength(2);
		const shape = readShape(shapesMap(doc).get(first.added[0]?.id ?? "") as Y.Map<unknown>);
		expect(shape).toMatchObject({ type: "link", url: "https://unpic.pics/", x: 0, y: 0 });
		expect(shape.preview).toBeUndefined();
		const again = addLinksInRun(doc, ["https://unpic.pics/"], first.run);
		expect(again.added).toEqual([]);
		expect(again.existing).toEqual([{ url: "https://unpic.pics/", id: first.added[0]?.id }]);
		expect(
			addLinksInRun(doc, ["https://unpic.pics/"], first.run, { copies: true }).added,
		).toHaveLength(1);
		addShape(doc, "s", { type: "sticky", x: 0, y: 0, z: "a0", text: "https://emdashcms.com/" });
		expect(addLinksInRun(doc, ["https://emdashcms.com/"], first.run).added).toHaveLength(1);
	});
});
