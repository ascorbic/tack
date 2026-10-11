// The security review's fixes (#60, docs/security-review.md): headers on
// every response, cross-site requests, webhook replays, repository paths,
// and presence that can't be forged.

import { readFileSync } from "node:fs";
import { type Miniflare, Response as MfResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import { sanitizeAwareness } from "../src/server/awareness.ts";
import {
	API_CSP,
	SVG_CSP,
	appCsp,
	headersFile,
	inlineHashes,
	withSecurityHeaders,
} from "../src/server/securityHeaders.ts";
import { isRepoPath, parseKey, parseRepoKey, parseRef } from "../src/shared/refs.ts";
import { awarenessMessage, connectBoard, eventually } from "./board-client.ts";
import { BUNDLE, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const ASSETS = BUNDLE.replace("bundle/index.js", "assets");

describe("security headers", () => {
	it("allow the app's own scripts and its inline theme script, by hash, and nothing else", async () => {
		const html = `<head><script>var a = 1;</script><script type="module" src="/x.js"></script></head>`;
		const hashes = await inlineHashes(html);
		expect(hashes.scripts).toHaveLength(1);
		const csp = appCsp(hashes);
		expect(csp).toContain(`script-src 'self' '${hashes.scripts[0]}'`);
		expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'self'");
		expect(headersFile(hashes)).toContain(`Content-Security-Policy: ${csp}`);
	});

	it("are written for the built app, with the hash of every inline script in its index.html", async () => {
		const html = readFileSync(`${ASSETS}/index.html`, "utf8");
		const headers = readFileSync(`${ASSETS}/_headers`, "utf8");
		const { scripts } = await inlineHashes(html);
		expect(scripts.length).toBeGreaterThan(0);
		for (const hash of scripts) expect(headers).toContain(`'${hash}'`);
		expect(headers).toMatch(/^\/\*$/m);
		expect(headers).toContain("X-Content-Type-Options: nosniff");
		expect(headers).toContain("X-Frame-Options: DENY");
		expect(headers).toContain("Strict-Transport-Security: max-age=31536000");
	});

	it("go on Worker responses, keeping what a route set, and leave WebSocket upgrades alone", async () => {
		const request = new Request("https://tack.example/api/me");
		const json = await withSecurityHeaders(request, Response.json({}));
		expect(json.headers.get("content-security-policy")).toBe(API_CSP);
		expect(json.headers.get("x-content-type-options")).toBe("nosniff");
		expect(json.headers.get("strict-transport-security")).toBe("max-age=31536000");
		expect(json.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		const svg = await withSecurityHeaders(
			new Request("https://tack.example/embed/x.svg"),
			new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
		);
		expect(svg.headers.get("content-security-policy")).toBe(SVG_CSP);
		const own = await withSecurityHeaders(
			request,
			new Response("", { headers: { "content-security-policy": "default-src 'self'" } }),
		);
		expect(own.headers.get("content-security-policy")).toBe("default-src 'self'");
		const plain = await withSecurityHeaders(
			new Request("http://localhost/api/me"),
			new Response(""),
		);
		expect(plain.headers.has("strict-transport-security")).toBe(false);
	});

	it("give pages the Worker serves the app's policy, with their own inline scripts' hashes", async () => {
		// The dev server's page has Vite's inline scripts as well as the theme script.
		const html = `<head><script>var theme = 1;</script><script type="module">import "/@react-refresh";</script></head><body></body>`;
		const { scripts } = await inlineHashes(html);
		const page = await withSecurityHeaders(
			new Request("https://tack.example/b/abc/plan"),
			new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
		);
		expect(page.headers.get("content-security-policy")).toBe(appCsp({ scripts }));
		expect(await page.text()).toBe(html);
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect(page.headers.has("cross-origin-resource-policy")).toBe(false);
		// HEAD (no body) gets the same policy as the last page.
		const head = await withSecurityHeaders(
			new Request("https://tack.example/b/abc/plan", { method: "HEAD" }),
			new Response(null, { headers: { "content-type": "text/html" } }),
		);
		expect(head.headers.get("content-security-policy")).toBe(appCsp({ scripts }));
		// A 304 updates the cached page's headers, so it carries no policy to replace its own.
		const unchanged = await withSecurityHeaders(
			new Request("https://tack.example/b/abc/plan"),
			new Response(null, { status: 304 }),
		);
		expect(unchanged.headers.has("content-security-policy")).toBe(false);
		expect(unchanged.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("on the Worker", () => {
	let mf: Miniflare;
	beforeAll(() => {
		mf = startWorker({ devAuth: true });
	});
	afterAll(() => mf.dispose());

	it("sends the headers with every answer: JSON, errors and webhooks", async () => {
		for (const [path, init] of [
			["/api/me", {}],
			["/api/nothing-here", {}],
			["/webhooks/github", { method: "POST", body: "{}" }],
			["/snapshots/nope.png", {}],
		] as const) {
			const response = await mf.dispatchFetch(`${ORIGIN}${path}`, init);
			expect(response.headers.get("content-security-policy"), path).toBe(API_CSP);
			expect(response.headers.get("x-frame-options"), path).toBe("DENY");
			expect(response.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
		}
	});

	it("turns away every state change from another site, and live connections too", async () => {
		const cookie = await signIn(mf, "olive");
		const board = (await (
			await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ title: "Cross-site" }),
			})
		).json()) as { id: string };
		const unsafe: [string, string][] = [
			["POST", "/api/boards"],
			["PATCH", `/api/boards/${board.id}`],
			["POST", `/api/boards/${board.id}/members`],
			["DELETE", `/api/boards/${board.id}/members/someone`],
			["POST", `/api/boards/${board.id}/push`],
			["POST", `/api/boards/${board.id}/snapshots`],
			["POST", `/api/boards/${board.id}/carry`],
			["POST", "/api/templates"],
			["DELETE", "/api/templates/abc"],
			["POST", "/api/notifications/read"],
			["PUT", "/api/setup/access"],
			["POST", "/auth/signout"],
			["POST", "/api/client-errors"],
			["POST", "/api/boards/legacy"],
			["POST", "/api/boards/import"],
			["PUT", `/api/boards/${board.id}/backup`],
			["DELETE", `/api/boards/${board.id}/backup`],
			["POST", `/api/boards/${board.id}/backup/run`],
		];
		for (const [method, path] of unsafe) {
			for (const headers of [
				{ origin: "https://evil.example" },
				{ "sec-fetch-site": "cross-site" },
			]) {
				const response = await mf.dispatchFetch(`${ORIGIN}${path}`, {
					method,
					headers: { cookie, "content-type": "application/json", ...headers },
					body: "{}",
				});
				expect(response.status, `${method} ${path}`).toBe(403);
			}
		}
		const foreign = await mf.dispatchFetch(`${ORIGIN}/parties/board/${board.id}`, {
			headers: { upgrade: "websocket", cookie, origin: "https://evil.example" },
		});
		expect(foreign.status).toBe(403);
		const own = await mf.dispatchFetch(`${ORIGIN}/parties/board/${board.id}`, {
			headers: { upgrade: "websocket", cookie, origin: ORIGIN },
		});
		expect(own.status).toBe(101);
		own.webSocket?.accept();
		own.webSocket?.close();
	});
});

describe("pages the Worker serves", () => {
	const PAGE = `<!doctype html><html><head><title>Tack</title><script>var theme = "light";</script></head><body><script type="module" src="/assets/app.js"></script></body></html>`;
	let mf: Miniflare;
	beforeAll(() => {
		mf = startWorker({
			devAuth: true,
			assets: () =>
				new MfResponse(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
		});
	});
	afterAll(() => mf.dispose());

	it("get the app's policy, not the API's, with board pages public or not", async () => {
		const { scripts } = await inlineHashes(PAGE);
		const cookie = await signIn(mf, "olive");
		const made = async (visibility: string) =>
			(
				(await (
					await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
						method: "POST",
						headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
						body: JSON.stringify({ title: "Page", visibility }),
					})
				).json()) as { id: string }
			).id;
		for (const path of [
			`/b/${await made("public")}/page`,
			`/b/${await made("private")}/page`,
			"/b/nothing-here",
		]) {
			const response = await mf.dispatchFetch(`${ORIGIN}${path}`);
			expect(response.status, path).toBe(200);
			expect(response.headers.get("content-security-policy"), path).toBe(appCsp({ scripts }));
			expect(response.headers.get("x-frame-options"), path).toBe("DENY");
			expect(await response.text(), path).toContain(`var theme = "light"`);
		}
	});
});

describe("webhook replays", () => {
	let mf: Miniflare;
	beforeAll(() => {
		mf = startWorker();
	});
	afterAll(() => mf.dispose());

	const REPOSITORY = { id: 77, node_id: "R_77", full_name: "acme/replay" };

	async function deliver(event: string, payload: unknown, id = crypto.randomUUID()) {
		const body = JSON.stringify(payload);
		const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
			method: "POST",
			body,
			headers: {
				"x-github-event": event,
				"x-github-delivery": id,
				"x-hub-signature-256": await sign("test-secret", body),
			},
		});
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	}

	it("go by the signed body, not the delivery id anyone can change", async () => {
		const issue = {
			action: "edited",
			repository: REPOSITORY,
			issue: {
				number: 1,
				title: "Replay me",
				state: "open",
				html_url: "https://github.com/acme/replay/issues/1",
				updated_at: new Date().toISOString(),
				created_at: new Date().toISOString(),
				user: { login: "someone" },
				labels: [],
				assignees: [],
				comments: 0,
			},
		};
		expect((await deliver("issues", issue, "first")).body).toMatchObject({ status: "processed" });
		// GitHub's own redelivery: the same id.
		expect((await deliver("issues", issue, "first")).body).toEqual({ status: "duplicate" });
		// A replay under a new id.
		expect((await deliver("issues", issue)).body).toEqual({ status: "duplicate" });
		// A different body is a different delivery, whatever its id says.
		const next = { ...issue, issue: { ...issue.issue, title: "Replayed?" } };
		expect((await deliver("issues", next, "first")).body).toEqual({ status: "duplicate" });
		expect((await deliver("issues", next)).body).toMatchObject({ status: "processed" });
	});

	it("count an installation event once, and only an installation's own body as one", async () => {
		const removed = {
			action: "removed",
			installation: { id: 5, account: { login: "acme" }, repository_selection: "selected" },
			repositories_added: [],
			repositories_removed: [{ full_name: "acme/replay" }],
		};
		expect((await deliver("installation_repositories", removed)).body).toEqual({
			status: "processed",
		});
		expect((await deliver("installation_repositories", removed)).body).toEqual({
			status: "duplicate",
		});
		// An issue's payload names its installation too: as an "installation" event it does nothing.
		const deletedIssue = {
			action: "deleted",
			installation: { id: 5 },
			repository: REPOSITORY,
			issue: { number: 2 },
		};
		expect((await deliver("installation", deletedIssue)).body).toEqual({ status: "ignored" });
	});

	it("never run a command from a comment last written over a week ago", async () => {
		const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
		const comment = {
			action: "created",
			repository: REPOSITORY,
			issue: { number: 1 },
			comment: {
				id: 9,
				html_url: "https://github.com/acme/replay/issues/1#issuecomment-9",
				body: "@tack help",
				user: { login: "someone", id: 3, type: "User" },
				created_at: old,
				updated_at: old,
			},
		};
		expect((await deliver("issue_comment", comment)).body).toEqual({
			status: "ignored",
			reason: "stale",
		});
	});
});

describe("repository paths", () => {
	it("never walk out of the forge's repository paths", () => {
		expect(isRepoPath("acme/widgets")).toBe(true);
		expect(isRepoPath("group/sub/project")).toBe(true);
		expect(isRepoPath("acme/.github")).toBe(true);
		for (const bad of [
			"../..",
			"acme/..",
			"./x",
			"acme/w?x=1",
			"acme/w#1",
			"acme//w",
			"a b/c",
			"",
		]) {
			expect(isRepoPath(bad), bad).toBe(false);
		}
		expect(parseKey("github.com/acme/widgets#1")).not.toBeNull();
		expect(parseKey("github.com/../../user#1")).toBeNull();
		expect(parseKey("github.com/acme/w?per_page=1#1")).toBeNull();
		expect(parseRepoKey("github.com/../../user")).toBeNull();
		expect(parseRef("github.com/acme/../../x#1")).toBeNull();
	});
});

describe("presence", () => {
	const olive = {
		login: "olive",
		name: "Olive",
		avatarUrl: "https://avatars.githubusercontent.com/u/1",
	};

	function decode(update: Uint8Array | null): Record<number, unknown> {
		// The update without its message header, as awarenessMessage writes one.
		if (!update) return {};
		const states: Record<number, unknown> = {};
		let offset = 0;
		const read = () => {
			let value = 0;
			let shift = 0;
			for (;;) {
				const byte = update[offset++]!;
				value += (byte & 0x7f) * 2 ** shift;
				if (byte < 0x80) return value;
				shift += 7;
			}
		};
		const count = read();
		for (let i = 0; i < count; i++) {
			const id = read();
			read();
			const length = read();
			states[id] = JSON.parse(new TextDecoder().decode(update.slice(offset, offset + length)));
			offset += length;
		}
		return states;
	}

	function update(states: Record<number, [number, unknown]>): Uint8Array {
		// awarenessMessage's bytes after the type and length prefix.
		const message = awarenessMessage(states);
		let offset = 1;
		while (message[offset]! >= 0x80) offset++;
		return message.slice(offset + 1);
	}

	it("says who people are from their sign-in, and strips guests of anyone else's", () => {
		const claim = {
			user: { name: "Matt Kane", color: "#123", login: "ascorbic", avatarUrl: "https://x/" },
		};
		const signedIn = sanitizeAwareness(
			update({ 7: [1, claim] }),
			{ connection: "a", person: olive },
			() => undefined,
		);
		expect(decode(signedIn.update)[7]).toEqual({
			user: { name: "Olive", color: "#123", login: "olive", avatarUrl: olive.avatarUrl },
		});
		const guest = sanitizeAwareness(
			update({ 8: [1, claim] }),
			{ connection: "b" },
			() => undefined,
		);
		expect(decode(guest.update)[8]).toEqual({ user: { name: "Matt Kane", color: "#123" } });
	});

	it("only lets a connection speak for its own clients, and drops what isn't JSON or is too big", () => {
		const theirs = sanitizeAwareness(update({ 7: [5, null] }), { connection: "b" }, () => "a");
		expect(theirs).toMatchObject({ update: null, dropped: 1 });
		const big = sanitizeAwareness(
			update({ 9: [1, { cursor: "x".repeat(40_000) }] }),
			{ connection: "b" },
			() => undefined,
		);
		expect(big).toMatchObject({ update: null, dropped: 1 });
		expect(
			sanitizeAwareness(new Uint8Array([5, 1]), { connection: "b" }, () => undefined),
		).toMatchObject({
			update: null,
		});
	});

	it("reaches others as the server says, over a real connection", async () => {
		const mf = startWorker({ devAuth: true });
		try {
			const cookie = await signIn(mf, "olive", { name: "Olive" });
			const board = (await (
				await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
					method: "POST",
					headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ title: "Presence" }),
				})
			).json()) as { id: string };
			const a = await connectBoard(mf, board.id, cookie);
			const b = await connectBoard(mf, board.id, cookie);
			if (!a.ok || !b.ok) throw new Error("couldn't connect");
			a.client.sendAwareness({
				1001: [1, { user: { name: "Someone else", login: "mallory", color: "" } }],
			});
			await eventually(() => b.client.awareness.has(1001));
			expect(b.client.awareness.get(1001)).toMatchObject({
				user: { name: "Olive", login: "olive" },
			});
			// B can't move or remove A's presence.
			b.client.sendAwareness({ 1001: [9, null] });
			b.client.sendAwareness({ 2002: [1, { user: { name: "B", color: "" } }] });
			await eventually(() => a.client.awareness.has(2002));
			expect(a.client.awareness.get(1001)).not.toBeNull();
			a.client.close();
			b.client.close();
		} finally {
			await mf.dispose();
		}
	});
});
