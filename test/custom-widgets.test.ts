// Custom widgets (#66): the protocol's checks, the sandbox page's headers,
// and, end to end, the owner's switch and a widget's searches running with
// each viewer's own permissions, only while the switch is on.

import type { Miniflare, Response } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { BoardInfo } from "../src/shared/boards.ts";
import {
	CUSTOM_LIMITS,
	PROTOCOL,
	SANDBOX_PATH,
	avatarUrl,
	customQueryOf,
	parseFrameMessage,
	parseSettings,
	searchName,
} from "../src/shared/customWidgets.ts";
import { transactLocal } from "../src/shared/shapes.ts";
import { addWidget } from "../src/shared/widgetRegistry.ts";
import type { SearchQuery, SearchResult, WidgetMessage } from "../src/shared/widgets.ts";
import { SANDBOX_CSP, handleSandbox } from "../src/server/widgets/sandbox.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

describe("the sandbox's messages", () => {
	const message = (data: object) => parseFrameMessage({ tack: PROTOCOL, ...data });

	it("only takes known messages, in this protocol", () => {
		expect(message({ type: "loaded" })).toEqual({ type: "loaded" });
		expect(parseFrameMessage({ type: "loaded" })).toBeNull();
		expect(parseFrameMessage({ tack: 2, type: "loaded" })).toBeNull();
		expect(parseFrameMessage("loaded")).toBeNull();
		expect(parseFrameMessage(null)).toBeNull();
		expect(message({ type: "init", code: "" })).toBeNull();
		expect(message({ type: "request", id: 1, method: "write", data: {} })).toBeNull();
		expect(message({ type: "request", id: -1, method: "cards", keys: [] })).toBeNull();
		expect(message({ type: "request", id: 1, method: "cards", keys: [1] })).toBeNull();
		expect(message({ type: "request", id: 1, method: "cards", keys: ["a"] })).toEqual({
			type: "request",
			id: 1,
			method: "cards",
			keys: ["a"],
		});
	});

	it("shortens long logs and errors", () => {
		const long = "x".repeat(CUSTOM_LIMITS.logText + 50);
		const log = message({ type: "log", level: "warn", text: long });
		expect(log?.type === "log" && log.text.length).toBe(CUSTOM_LIMITS.logText + 1);
		expect(message({ type: "log", level: "debug", text: "" })).toBeNull();
	});

	it("checks avatar sizes", () => {
		expect(message({ type: "request", id: 1, method: "avatar", url: "u" })).toMatchObject({
			size: 64,
		});
		expect(message({ type: "request", id: 1, method: "avatar", url: "u", size: 4096 })).toBeNull();
	});
});

describe("custom widgets' searches", () => {
	it("default sensibly, and cap results", () => {
		expect(customQueryOf({ q: " repo:acme/widgets is:open ", limit: 500 })).toEqual({
			kind: "search",
			host: "github.com",
			q: "repo:acme/widgets is:open",
			sort: "updated",
			order: "desc",
			limit: CUSTOM_LIMITS.searchResults,
		});
	});

	it("refuse what isn't a search", () => {
		for (const raw of [
			null,
			"is:open",
			{ q: "" },
			{ q: "   " },
			{ q: "x".repeat(CUSTOM_LIMITS.query + 1) },
			{ q: "is:open", sort: "stars" },
			{ q: "is:open", limit: 0 },
			{ q: "is:open", host: "evil.example" },
		]) {
			expect(customQueryOf(raw).kind, JSON.stringify(raw)).toBe("error");
		}
	});

	it("name the same search the same way", () => {
		const query = customQueryOf({ q: "is:open" }) as SearchQuery;
		expect(searchName(query)).toBe(searchName({ ...query }));
		expect(searchName(query)).not.toBe(searchName({ ...query, q: "is:closed" }));
		expect(searchName(query)).toMatch(/^[\w-]{1,32}$/);
	});
});

describe("settings and avatars", () => {
	it("settings are a JSON object", () => {
		expect(parseSettings("")).toEqual({ ok: true, value: {} });
		expect(parseSettings('{ "repo": "a/b" }')).toEqual({ ok: true, value: { repo: "a/b" } });
		expect(parseSettings("[]").ok).toBe(false);
		expect(parseSettings("{ nope").ok).toBe(false);
	});

	it("avatars only come from GitHub's avatar host", () => {
		expect(avatarUrl("https://avatars.githubusercontent.com/u/1?v=4", 40)).toBe(
			"https://avatars.githubusercontent.com/u/1?v=4&s=40",
		);
		for (const url of [
			"http://avatars.githubusercontent.com/u/1",
			"https://example.com/u/1",
			"https://avatars.githubusercontent.com.example.com/u/1",
			"https://user:pass@avatars.githubusercontent.com/u/1",
			"https://avatars.githubusercontent.com:8443/u/1",
			"javascript:alert(1)",
			"not a url",
		]) {
			expect(avatarUrl(url, 40), url).toBeNull();
		}
	});
});

describe("the sandbox page", () => {
	const page = (method = "GET") =>
		handleSandbox(
			new Request(`http://localhost${SANDBOX_PATH}`, { method }),
		) as globalThis.Response;

	it("loads nothing, sandboxes itself, and only Tack may frame it", async () => {
		const response = page();
		expect(response.status).toBe(200);
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toBe(SANDBOX_CSP);
		for (const directive of [
			"default-src 'none'",
			"connect-src 'none'",
			"img-src data: blob:",
			"frame-src 'none'",
			"form-action 'none'",
			"base-uri 'none'",
			"frame-ancestors 'self'",
			"sandbox allow-scripts",
		]) {
			expect(csp).toContain(directive);
		}
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).not.toMatch(/https?:/);
		expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("permissions-policy")).toContain("camera=()");
		const html = await response.text();
		// Its bootstrap only ever talks to the window that framed it.
		expect(html).toContain("event.source !== host");
		expect(html).toContain("__tackLoop");
	});

	it("is only ever read", () => {
		expect(page("POST").status).toBe(405);
		expect(page("HEAD").status).toBe(200);
		expect(handleSandbox(new Request("http://localhost/sandbox/other"))).toBeNull();
	});
});

// --- End to end ----------------------------------------------------------------------------

const ORIGIN = "http://localhost";
const WIDGETS = 1;
const SECRET = 2;
const SECRET_TITLE = "Secret roadmap";
const T0 = "2026-10-01T00:00:00Z";
const ALICE: FakeUser = { id: 601, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 602, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(WIDGETS, "acme/widgets");
	github.setItem(WIDGETS, { number: 1, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	github.addRepo(SECRET, "acme/secret", { private: true, collaborators: ["alice"] });
	github.setItem(SECRET, { number: 5, kind: "issue", title: SECRET_TITLE, updatedAt: T0 });
	github.install(7, "acme", ["acme/widgets", "acme/secret"]);
	return github;
}

function cookies(response: Response): Record<string, string> {
	const jar: Record<string, string> = {};
	for (const header of response.headers.getSetCookie()) {
		const [pair = ""] = header.split(";");
		const eq = pair.indexOf("=");
		jar[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return jar;
}

/** Sign in through GitHub, so the person has a real user token. */
async function signInWithGitHub(mf: Miniflare, github: FakeGitHub, who: FakeUser) {
	await signIn(mf, who.login);
	const start = await mf.dispatchFetch(`${ORIGIN}/auth/signin?return_to=/`, { redirect: "manual" });
	const callback = new URL(github.authorize(start.headers.get("location") ?? "", who));
	const jar = cookies(start);
	const done = await mf.dispatchFetch(`${ORIGIN}${callback.pathname}${callback.search}`, {
		headers: {
			cookie: Object.entries(jar)
				.map(([k, v]) => `${k}=${v}`)
				.join("; "),
		},
		redirect: "manual",
	});
	expect(done.status).toBe(302);
	return `tack_session=${cookies(done).tack_session ?? ""}`;
}

async function api(mf: Miniflare, cookie: string, method: string, path: string, body?: unknown) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method,
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function open(mf: Miniflare, board: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, board, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return result.client;
}

/** The latest results for a widget that pass `check`. */
async function latest(
	client: BoardClient,
	id: string,
	check: (message: WidgetMessage) => boolean,
): Promise<WidgetMessage> {
	let found: WidgetMessage | undefined;
	await eventually(() => {
		found = client.messages
			.filter(
				(message): message is WidgetMessage =>
					(message as WidgetMessage).type === "widget-data" && (message as WidgetMessage).id === id,
			)
			.at(-1);
		return Boolean(found && check(found));
	}, 5000);
	return found as WidgetMessage;
}

const titles = (result: unknown) =>
	((result as SearchResult | undefined)?.items ?? []).map((card) => card.title);

async function setup() {
	const github = fakeGitHub();
	const mf = startWorker({ devAuth: true, outboundService: github.fetch });
	cleanups.push(() => mf.dispose());
	expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
	const alice = await signInWithGitHub(mf, github, ALICE);
	const created = await api(mf, alice, "POST", "/api/boards", {
		title: "Custom",
		visibility: "public",
	});
	const board = (await created.json()) as BoardInfo;
	const owner = await open(mf, board.id, alice);
	const widget = transactLocal(owner.doc, () =>
		addWidget(owner.doc, "custom", { x: 0, y: 0 }, { code: "/* draws */", data: "{}" }),
	);
	const list = transactLocal(owner.doc, () =>
		addWidget(owner.doc, "list", { x: 0, y: 600 }, { q: "repo:acme/widgets" }),
	);
	await owner.roundTrip();
	return { github, mf, alice, board, owner, widget, list };
}

const SEARCH = { q: "org:acme is:open" };

describe("custom widgets on a board", () => {
	it("are off until the owner turns them on, and only the owner can", async () => {
		const { github, mf, alice, board, owner, widget } = await setup();
		expect(board.customWidgets).toBe(false);

		// Off: its searches don't run.
		owner.send({ type: "widget-query", id: widget, queries: { all: SEARCH } });
		const off = await latest(owner, widget, (message) => "all" in message.results);
		expect(off.results.all).toMatchObject({ kind: "error", reason: "no_access" });

		// Only the owner may turn them on.
		const bob = await signInWithGitHub(mf, github, BOB);
		expect(
			(await api(mf, bob, "PATCH", `/api/boards/${board.id}`, { customWidgets: true })).status,
		).toBe(403);
		const on = await api(mf, alice, "PATCH", `/api/boards/${board.id}`, { customWidgets: true });
		expect(((await on.json()) as BoardInfo).customWidgets).toBe(true);

		// Everyone connected hears it, and the same search now runs.
		await eventually(() =>
			owner.messages.some(
				(message) =>
					(message as { type?: string }).type === "custom-widgets" &&
					(message as { enabled?: boolean }).enabled === true,
			),
		);
		owner.send({ type: "widget-query", id: widget, queries: { all: SEARCH } });
		const running = await latest(
			owner,
			widget,
			(message) => titles(message.results.all).length > 0,
		);
		expect(titles(running.results.all)).toContain("Widgets wobble");

		// It's the board's setting, for the next visit too.
		const again = (await (
			await api(mf, alice, "GET", `/api/boards/${board.id}`)
		).json()) as BoardInfo;
		expect(again.customWidgets).toBe(true);
	});

	it("search with each viewer's own permissions", async () => {
		const { github, mf, alice, board, owner, widget } = await setup();
		await api(mf, alice, "PATCH", `/api/boards/${board.id}`, { customWidgets: true });
		const bob = await open(mf, board.id, await signInWithGitHub(mf, github, BOB));
		const stranger = await open(mf, board.id);
		for (const client of [owner, bob, stranger]) {
			client.send({ type: "widget-query", id: widget, queries: { all: SEARCH } });
		}
		const has = (message: WidgetMessage) => titles(message.results.all).length > 0;
		expect(titles((await latest(owner, widget, has)).results.all)).toEqual(
			expect.arrayContaining(["Widgets wobble", SECRET_TITLE]),
		);
		for (const client of [bob, stranger]) {
			expect(titles((await latest(client, widget, has)).results.all)).toEqual(["Widgets wobble"]);
			expect(JSON.stringify(client.messages)).not.toContain(SECRET_TITLE);
		}
	});

	it("stop searching when the owner turns them off", async () => {
		const { mf, alice, board, owner, widget } = await setup();
		await api(mf, alice, "PATCH", `/api/boards/${board.id}`, { customWidgets: true });
		await eventually(() =>
			owner.messages.some((message) => (message as { type?: string }).type === "custom-widgets"),
		);
		owner.send({ type: "widget-query", id: widget, queries: { all: SEARCH } });
		await latest(owner, widget, (message) => titles(message.results.all).length > 0);
		await api(mf, alice, "PATCH", `/api/boards/${board.id}`, { customWidgets: false });
		owner.send({ type: "widget-refresh", id: widget });
		owner.send({ type: "widget-query", id: widget, queries: { all: SEARCH } });
		const off = await latest(owner, widget, (message) => message.results.all?.kind === "error");
		expect(off.results.all).toMatchObject({ reason: "no_access" });
	});

	it("only take searches for custom widgets, within limits", async () => {
		const { mf, alice, board, owner, widget, list } = await setup();
		await api(mf, alice, "PATCH", `/api/boards/${board.id}`, { customWidgets: true });
		await eventually(() =>
			owner.messages.some((message) => (message as { type?: string }).type === "custom-widgets"),
		);
		// A list widget's queries are its config's, not whatever's asked.
		owner.send({ type: "widget-query", id: list, queries: { sneaky: SEARCH } });
		owner.send({ type: "widget-query", id: "nothing-here", queries: { sneaky: SEARCH } });
		// Too many searches, and ones that aren't.
		const queries: Record<string, unknown> = { "bad name!": SEARCH, broken: { q: "" } };
		for (let i = 0; i < CUSTOM_LIMITS.queries + 2; i++) queries[`q${i}`] = { q: `is:open ${i}` };
		owner.send({ type: "widget-query", id: widget, queries });
		const message = await latest(owner, widget, (m) => "broken" in m.results);
		expect(message.results.broken).toMatchObject({ kind: "error", reason: "invalid" });
		expect(message.results["bad name!"]).toBeUndefined();
		const refused = Object.values(message.results).filter(
			(result) => result.kind === "error" && /at most/.test(result.message),
		);
		expect(refused.length).toBeGreaterThan(0);
		expect(
			owner.messages.some(
				(m) =>
					(m as WidgetMessage).type === "widget-data" &&
					((m as WidgetMessage).id === "nothing-here" ||
						"sneaky" in ((m as WidgetMessage).results ?? {})),
			),
		).toBe(false);
	});
});
