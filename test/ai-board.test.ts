// AI on a board (#64), end to end through the Worker with a fake Workers AI:
// who may ask, the instance switch, the board's budget, a widget's config
// checked against its schema (and asked for again once), and what the model
// is sent: never silent mode's hidden text, and never a card from a
// repository the asker can't read (nor, on a public board, any that isn't
// public).

import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AiResponse } from "../src/shared/ai.ts";
import type { Card, MissingCard } from "../src/shared/cards.ts";
import { addShape, nextZ, shapesMap } from "../src/shared/shapes.ts";
import { joinSilentSession, parseSession } from "../src/shared/silent.ts";
import type { WidgetMessage } from "../src/shared/widgets.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeAi } from "./fake-ai.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const SECRET = "nobody may read this until the reveal";
const SECRET_TITLE = "Secret roadmap";
const PUBLIC_CARD = "github.com/acme/widgets#1";
const PRIVATE_CARD = "github.com/acme/secret#5";
const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function start(options: Parameters<typeof startWorker>[0] = {}): Miniflare {
	const mf = startWorker({ devAuth: true, ...options });
	cleanups.push(() => mf.dispose());
	return mf;
}

function post(mf: Miniflare, path: string, cookie: string, body: unknown) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function board(
	mf: Miniflare,
	owner: string,
	members: [string, string][] = [],
	visibility = "private",
): Promise<string> {
	const made = await post(mf, "/api/boards", owner, { title: "Planning", visibility });
	expect(made.status).toBe(201);
	const { id } = (await made.json()) as { id: string };
	for (const [login, role] of members) {
		expect(
			(await post(mf, `/api/boards/${id}/members`, owner, { logins: [login], role })).status,
		).toBe(200);
	}
	return id;
}

async function open(mf: Miniflare, id: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return result.client;
}

async function ask(mf: Miniflare, id: string, cookie: string, body: unknown) {
	const response = await post(mf, `/api/boards/${id}/ai`, cookie, body);
	return { status: response.status, body: (await response.json()) as AiResponse, response };
}

function sticky(client: BoardClient, id: string, text: string, y = 0) {
	addShape(client.doc, id, { type: "sticky", text, x: 0, y, z: nextZ(client.doc) });
}

describe("who may use AI", () => {
	it("is off with TACK_AI=off, and unavailable without the binding", async () => {
		const off = start({ bindings: { TACK_AI: "off" } });
		const olive = await signIn(off, "olive");
		const id = await board(off, olive);
		const refused = await ask(off, id, olive, { task: "widget", prompt: "open bugs" });
		expect(refused.status).toBe(404);
		expect(refused.body).toMatchObject({ kind: "error", reason: "off" });

		const none = start({ ai: null });
		const oscar = await signIn(none, "oscar");
		const other = await board(none, oscar);
		expect((await ask(none, other, oscar, { task: "widget", prompt: "bugs" })).body).toMatchObject({
			reason: "unavailable",
		});
	});

	it("answers from local development's stand-in with TACK_AI=fake, never asking the model", async () => {
		const ai = new FakeAi();
		const mf = start({ ai, bindings: { TACK_AI: "fake" } });
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);
		const client = await open(mf, id, olive);
		sticky(client, "s1", "Search is slow", 0);
		sticky(client, "s2", "Cache search results?", 200);
		await client.roundTrip();
		const widget = await ask(mf, id, olive, { task: "widget", prompt: "Open bugs" });
		expect(widget.body).toMatchObject({ kind: "widget", widget: "list" });
		const decision = await ask(mf, id, olive, { task: "decision", shapes: ["s1", "s2"] });
		expect(decision.body).toMatchObject({
			kind: "decision",
			title: "Cache search results?",
			read: 2,
		});
		expect(ai.calls).toHaveLength(0);
	});

	it("is for the board's editors only, and refuses nonsense", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive");
		const eddie = await signIn(mf, "eddie");
		const vera = await signIn(mf, "vera");
		const oscar = await signIn(mf, "oscar");
		const id = await board(mf, olive, [
			["eddie", "editor"],
			["vera", "viewer"],
		]);
		const request = { task: "widget", prompt: "Open bugs" };
		expect((await ask(mf, id, olive, request)).status).toBe(200);
		expect((await ask(mf, id, eddie, request)).status).toBe(200);
		expect((await ask(mf, id, vera, request)).body).toMatchObject({ reason: "forbidden" });
		expect([403, 404]).toContain((await ask(mf, id, oscar, request)).status);
		const stranger = await mf.dispatchFetch(`${ORIGIN}/api/boards/${id}/ai`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		expect([401, 404]).toContain(stranger.status);
		// Cross-site: turned away before anything else.
		const crossSite = await mf.dispatchFetch(`${ORIGIN}/api/boards/${id}/ai`, {
			method: "POST",
			headers: {
				cookie: olive,
				origin: "https://evil.example",
				"content-type": "application/json",
			},
			body: JSON.stringify(request),
		});
		expect(crossSite.status).toBe(403);
		expect((await ask(mf, id, olive, { task: "poem" })).status).toBe(400);
		expect((await ask(mf, id, olive, { task: "widget", prompt: "x".repeat(600) })).status).toBe(
			400,
		);
		expect((await ask(mf, id, olive, { task: "summary", shapes: [] })).status).toBe(400);
		// Only the requests that got through reached the model.
		expect(ai.calls).toHaveLength(2);
	});

	it("keeps to the board's budget", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);
		await (await boardStub(mf, id)).aiLimits({ perMinute: 2 });
		for (let i = 0; i < 2; i++) {
			expect((await ask(mf, id, olive, { task: "widget", prompt: "bugs" })).status).toBe(200);
		}
		const limited = await ask(mf, id, olive, { task: "widget", prompt: "bugs" });
		expect(limited.status).toBe(429);
		expect(limited.body).toMatchObject({ kind: "error", reason: "rate_limited" });
		expect((limited.body as { retryAt: number }).retryAt).toBeGreaterThan(Date.now());
		expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(ai.calls).toHaveLength(2);
	});
});

describe("asking for a widget", () => {
	it("answers with a config its kind's schema accepts, for the board's repositories", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);
		const client = await open(mf, id, olive);
		addShape(client.doc, "c1", {
			type: "card",
			ref: "github.com/ascorbic/unpic#12",
			x: 0,
			y: 0,
			z: nextZ(client.doc),
		});
		addShape(client.doc, "ideas", {
			type: "section",
			title: "Ideas",
			x: 0,
			y: 300,
			w: 600,
			h: 400,
			z: nextZ(client.doc),
		});
		await client.roundTrip();

		const { status, body } = await ask(mf, id, olive, { task: "widget", prompt: "Open bugs" });
		expect(status).toBe(200);
		expect(body).toMatchObject({
			kind: "widget",
			widget: "list",
			config: {
				title: "Open bugs",
				q: "repo:ascorbic/unpic is:open label:bug",
				host: "github.com",
			},
		});
		// Defaults fill in what it left out.
		expect(body.kind === "widget" && body.config.sort).toBe("updated");
		const call = ai.calls[0]!;
		expect(call.input.response_format).toMatchObject({
			type: "json_schema",
			json_schema: { name: "widget" },
		});
		expect(call.input.messages![1]?.content).toContain("ascorbic/unpic");
		expect(call.input.messages![1]?.content).toContain("ideas: “Ideas”");
		expect(call.input.messages![1]?.content).toContain("<request>Open bugs</request>");
		expect(call.input.messages![1]?.content).toContain("@olive");
		// The board's untouched: nothing's placed until someone places it.
		expect(shapesMap(client.doc).size).toBe(2);
	});

	it("asks again once, saying what was wrong, then gives up", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);

		ai.answer(
			{ explanation: "x", widget: { kind: "list", config: { sort: "loudest", q: "is:open" } } },
			{
				explanation: "Open bugs.",
				widget: { kind: "list", config: { q: "is:open label:bug", sort: "created" } },
			},
		);
		const fixed = await ask(mf, id, olive, { task: "widget", prompt: "bugs" });
		expect(fixed.status).toBe(200);
		expect(fixed.body).toMatchObject({ widget: "list", config: { sort: "created" } });
		expect(ai.calls).toHaveLength(2);
		const retry = ai.calls[1]!.input.messages!;
		expect(retry.at(-2)?.role).toBe("assistant");
		expect(retry.at(-1)?.content).toContain('“sort” can\'t be "loudest"');

		ai.reset();
		ai.answer(
			{ explanation: "x", widget: { kind: "pie-chart", config: {} } },
			{ explanation: "x", widget: { kind: "list", config: { q: "" } } },
		);
		const unusable = await ask(mf, id, olive, { task: "widget", prompt: "a pie chart" });
		expect(unusable.status).toBe(502);
		expect(unusable.body).toMatchObject({ kind: "error", reason: "unusable" });
		expect(ai.calls).toHaveLength(2);
		expect(ai.calls[1]!.input.messages!.at(-1)?.content).toContain("isn't a widget kind");

		ai.reset();
		ai.fail();
		ai.fail();
		expect((await ask(mf, id, olive, { task: "widget", prompt: "bugs" })).body).toMatchObject({
			reason: "failed",
		});
	});

	it("reads answers wrapped in text, and Workers AI's older shape", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);
		ai.answerRaw({
			response: `Here you go:\n\`\`\`json\n${JSON.stringify({
				explanation: "Stale issues.",
				widget: { kind: "stale", config: { q: "repo:a/b is:open", days: 60 } },
			})}\n\`\`\``,
		});
		const { body } = await ask(mf, id, olive, { task: "widget", prompt: "stale" });
		expect(body).toMatchObject({ kind: "widget", widget: "stale", config: { days: 60 } });
	});

	it("previews a proposed widget's results live, as the person looking", async () => {
		const mf = start();
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);
		const client = await open(mf, id, olive);
		client.send({
			type: "widget-preview",
			id: "p1",
			widget: "list",
			config: { host: "fake.tack", q: "repo:demo/preview is:open", limit: 5 },
		});
		await eventually(() =>
			client.messages.some((m) => (m as WidgetMessage).id === "preview:widget:p1"),
		);
		const data = client.messages.find(
			(m) => (m as WidgetMessage).id === "preview:widget:p1",
		) as WidgetMessage;
		expect(data.results.items).toMatchObject({ kind: "search" });
		expect((data.results.items as { items: unknown[] }).items.length).toBeGreaterThan(0);
		// Nothing was added to the board.
		expect(shapesMap(client.doc).size).toBe(0);
	});
});

describe("summaries and decisions", () => {
	it("summarises a section's stickies, and never sends silent mode's hidden text", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive", { name: "Olive" });
		const eddie = await signIn(mf, "eddie", { name: "Eddie" });
		const id = await board(mf, olive, [["eddie", "editor"]]);
		const facilitator = await open(mf, id, olive);
		const writer = await open(mf, id, eddie);
		addShape(facilitator.doc, "ideas", {
			type: "section",
			title: "Ideas",
			x: 0,
			y: 0,
			w: 900,
			h: 700,
			z: nextZ(facilitator.doc),
		});
		addShape(facilitator.doc, "s0", {
			type: "sticky",
			text: "The docs need examples",
			parent: "ideas",
			author: { name: "Olive", color: "" },
			x: 40,
			y: 60,
			z: nextZ(facilitator.doc),
		});
		await facilitator.roundTrip();
		facilitator.send({ type: "silent-start", section: "ideas", by: { name: "Olive", color: "" } });
		await eventually(
			() => parseSession(shapesMap(writer.doc).get("ideas")?.get("silent")) !== null,
		);
		writer.doc.transact(() => {
			addShape(writer.doc, "hidden", {
				type: "sticky",
				x: 300,
				y: 60,
				z: nextZ(writer.doc),
				parent: "ideas",
				text: "",
				author: { name: "Eddie", color: "" },
			});
			joinSilentSession(writer.doc, "hidden");
		});
		await writer.roundTrip();
		writer.send({ type: "silent-text", shape: "hidden", text: SECRET });
		await writer.roundTrip();

		// Even its own author can't send it: what's drafted goes on the board for everyone.
		const { status, body } = await ask(mf, id, eddie, { task: "summary", shapes: ["ideas"] });
		expect(status).toBe(200);
		expect(body).toMatchObject({
			kind: "summary",
			title: "What the board says",
			read: 2,
			leftOut: { faceDown: 1, private: 0 },
		});
		expect(ai.sent).toContain("The docs need examples");
		expect(ai.sent).toContain("(in “Ideas”)");
		expect(ai.sent).not.toContain(SECRET);
		expect(ai.calls[0]!.input.response_format?.json_schema?.name).toBe("summary");

		// Only face-down stickies: nothing to read, and the model's never asked.
		ai.reset();
		const empty = await ask(mf, id, eddie, { task: "summary", shapes: ["hidden"] });
		expect(empty.status).toBe(422);
		expect(empty.body).toMatchObject({
			reason: "empty",
			message: expect.stringContaining("face down"),
		});
		expect(ai.calls).toHaveLength(0);
	});

	it("drafts a decision with its context and options", async () => {
		const ai = new FakeAi();
		const mf = start({ ai });
		const olive = await signIn(mf, "olive");
		const id = await board(mf, olive);
		const client = await open(mf, id, olive);
		sticky(client, "a", "Search is slow");
		sticky(client, "b", "People want filters", 200);
		await client.roundTrip();
		const { body } = await ask(mf, id, olive, {
			task: "decision",
			shapes: ["a", "b"],
			prompt: "fixing search",
		});
		expect(body).toMatchObject({
			kind: "decision",
			title: "How should we fix search?",
			options: [{ name: "Rewrite the index" }, { name: "Add caching" }],
			read: 2,
		});
		expect(ai.calls[0]!.input.messages![1]?.content).toContain(
			"The decision is about: fixing search",
		);
	});

	it("leaves out cards the asker can't read, and on public boards any that aren't public", async () => {
		const github = new FakeGitHub();
		github.addRepo(1, "acme/widgets", { writers: ["alice"] });
		github.setItem(1, {
			number: 1,
			kind: "issue",
			title: "Widgets wobble",
			updatedAt: "2026-10-01T00:00:00Z",
		});
		github.addRepo(2, "acme/secret", {
			private: true,
			collaborators: ["alice"],
			writers: ["alice"],
		});
		github.setItem(2, {
			number: 5,
			kind: "issue",
			title: SECRET_TITLE,
			updatedAt: "2026-10-01T00:00:00Z",
		});
		github.install(7, "acme", ["acme/widgets", "acme/secret"]);
		const ai = new FakeAi();
		const mf = start({ ai, outboundService: github.fetch });
		expect((await (await instanceStub(mf)).completeSetup(github.manifestCode)).ok).toBe(true);
		const alice = await signInWithGitHub(mf, github, ALICE);
		const eddie = await signIn(mf, "eddie");

		for (const visibility of ["private", "public"]) {
			const id = await board(mf, alice, [["eddie", "editor"]], visibility);
			const client = await open(mf, id, alice);
			for (const [i, ref] of [PUBLIC_CARD, PRIVATE_CARD].entries()) {
				addShape(client.doc, `card-${i}`, {
					type: "card",
					ref,
					x: i * 300,
					y: 0,
					z: nextZ(client.doc),
				});
			}
			await client.roundTrip();
			const stub = await boardStub(mf, id);
			await vi.waitFor(
				async () => {
					const cards = (await stub.liveCards()) as (Card | MissingCard)[];
					if (cards.filter((card) => !("missing" in card)).length < 2) throw new Error("waiting");
				},
				{ timeout: 10_000, interval: 50 },
			);
			const shapes = ["card-0", "card-1"];

			ai.reset();
			const theirs = await ask(mf, id, alice, { task: "summary", shapes });
			if (visibility === "private") {
				// Alice can read it: it's hers to summarise.
				expect(theirs.body).toMatchObject({ read: 2, leftOut: { private: 0 } });
				expect(ai.sent).toContain(SECRET_TITLE);
			} else {
				// Whatever's drafted on a public board is public once it's placed.
				expect(theirs.body).toMatchObject({ read: 1, leftOut: { private: 1 } });
				expect(ai.sent).not.toContain(SECRET_TITLE);
				expect(ai.sent).not.toContain("acme/secret");
			}
			expect(ai.sent).toContain("Widgets wobble");

			ai.reset();
			const eddies = await ask(mf, id, eddie, { task: "decision", shapes });
			expect(eddies.body).toMatchObject({ read: 1, leftOut: { private: 1 } });
			expect(ai.sent).not.toContain(SECRET_TITLE);
			expect(ai.sent).not.toContain("acme/secret");

			// Asking for a widget isn't told the repository's name either.
			ai.reset();
			expect((await ask(mf, id, eddie, { task: "widget", prompt: "Open bugs" })).status).toBe(200);
			expect(ai.sent).toContain("acme/widgets");
			expect(ai.sent).not.toContain("acme/secret");
			ai.reset();
			await ask(mf, id, alice, { task: "widget", prompt: "Open bugs" });
			if (visibility === "private") expect(ai.sent).toContain("acme/secret");
			else expect(ai.sent).not.toContain("acme/secret");
		}
	});
});
