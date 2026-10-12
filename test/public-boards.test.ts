// Public boards seen by someone who isn't signed in (#56), and images of
// them (#57), end to end: a public board with a card from a private
// repository on it, opened anonymously, and every way the board's data
// leaves Tack checked for the private card's details. Card messages
// themselves are covered in repo-access.test.ts; this covers the rest: the
// digest, pushes, history, Expand related, the card tool's search, link
// previews and images.

import { type Miniflare, Response } from "miniflare";
import type { Board } from "../src/server/board.ts";
import { SVG_CSP } from "../src/server/securityHeaders.ts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import type { Card, MissingCard } from "../src/shared/cards.ts";
import { stageChange } from "../src/shared/changes.ts";
import { addImageShape } from "../src/shared/images.ts";
import type { AuditEntry } from "../src/shared/push.ts";
import { addShape, nextZ, shapesMap } from "../src/shared/shapes.ts";
import type { SinceEvent } from "../src/shared/since.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, signIn, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const PUBLIC_ID = 1;
const PRIVATE_ID = 2;
const PUBLIC_CARD = "github.com/acme/widgets#1";
const PRIVATE_CARD = "github.com/acme/secret#5";
const SECRET_TITLE = "Secret roadmap";
const SECRET_LABEL = "embargoed";
const T0 = "2026-10-01T00:00:00Z";
const T1 = "2026-10-02T00:00:00Z";

const ALICE: FakeUser = { id: 501, login: "alice", name: "Alice", avatar_url: "https://a/alice" };

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Tack</title></head><body><div id="root"></div></body></html>`;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(): FakeGitHub {
	const github = new FakeGitHub();
	github.addRepo(PUBLIC_ID, "acme/widgets", { writers: ["alice"] });
	github.setItem(PUBLIC_ID, { number: 1, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	github.addRepo(PRIVATE_ID, "acme/secret", {
		private: true,
		collaborators: ["alice"],
		writers: ["alice"],
	});
	github.setItem(PRIVATE_ID, {
		number: 5,
		kind: "issue",
		title: SECRET_TITLE,
		updatedAt: T0,
		labels: [{ name: SECRET_LABEL, color: "000000" }],
	});
	github.install(7, "acme", ["acme/widgets", "acme/secret"]);
	return github;
}

async function configured(github: FakeGitHub): Promise<Miniflare> {
	const mf = startWorker({
		devAuth: true,
		outboundService: github.fetch,
		// The app's page, as the assets binding serves it for any `/b/…` path.
		assets: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
	});
	cleanups.push(() => mf.dispose());
	expect(await (await instanceStub(mf)).completeSetup(github.manifestCode)).toMatchObject({
		ok: true,
	});
	return mf;
}

function get(mf: Miniflare, path: string, headers: Record<string, string> = {}) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, { headers });
}

async function createBoard(
	mf: Miniflare,
	cookie: string,
	visibility: "private" | "instance" | "public",
	title = "Roadmap & retro",
): Promise<{ id: string; slug: string }> {
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ title, visibility }),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as { id: string; slug: string };
}

async function open(mf: Miniflare, board: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, board, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return result.client;
}

function addCards(client: BoardClient, ...keys: string[]): void {
	keys.forEach((ref, i) =>
		addShape(client.doc, `card-${i}`, {
			type: "card",
			ref,
			x: i * 300,
			y: 0,
			z: nextZ(client.doc),
		}),
	);
	addShape(client.doc, "note", {
		type: "sticky",
		text: "Ship it",
		color: "pink",
		x: 0,
		y: 220,
		z: nextZ(client.doc),
	});
}

/** Wait until the board holds both cards, as fetched from GitHub. */
async function cardsArrived(mf: Miniflare, board: string): Promise<void> {
	const stub = await boardStub(mf, board);
	await vi.waitFor(
		async () => {
			const cards = (await stub.liveCards()) as (Card | MissingCard)[];
			const fetched = cards.filter((card) => !("missing" in card)).map((card) => card.key);
			if (!fetched.includes(PUBLIC_CARD) || !fetched.includes(PRIVATE_CARD)) {
				throw new Error(JSON.stringify(cards));
			}
		},
		{ timeout: 10_000, interval: 50 },
	);
}

async function deliver(mf: Miniflare, github: FakeGitHub, payload: unknown) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": "issues",
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign(github.app.webhook_secret, body),
		},
	});
	expect(response.status).toBe(202);
}

function edited(
	repo: { id: number; full_name: string; private: boolean },
	number: number,
	title: string,
) {
	return {
		action: "edited",
		repository: repo,
		issue: {
			number,
			title,
			state: "open",
			updated_at: T1,
			html_url: `https://github.com/${repo.full_name}/issues/${number}`,
			labels: [],
			assignees: [],
			// New comments: "since you were here" activity.
			comments: 3,
		},
	};
}

/** A public board of Alice's with a public and a private card on it. */
async function publicBoard() {
	const github = fakeGitHub();
	const mf = await configured(github);
	const alice = await signInWithGitHub(mf, github, ALICE);
	const board = await createBoard(mf, alice, "public");
	const client = await open(mf, board.id, alice);
	addCards(client, PUBLIC_CARD, PRIVATE_CARD);
	await client.roundTrip();
	await cardsArrived(mf, board.id);
	return { github, mf, alice, board, client };
}

// A real 1×1 PNG: an image, and its thumbnail.
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

/** Upload an image with its thumbnail, as the app does; its hash. */
async function uploadImage(mf: Miniflare, cookie: string, board: string): Promise<string> {
	const form = new FormData();
	form.set("image", new Blob([PNG]), "image");
	form.set("thumb", new Blob([PNG]), "thumb");
	// Miniflare's fetch doesn't know Node's own FormData: send it as bytes.
	const encoded = new globalThis.Response(form);
	const response = await mf.dispatchFetch(`${ORIGIN}/api/boards/${board}/images`, {
		method: "POST",
		body: await encoded.arrayBuffer(),
		headers: {
			cookie,
			origin: ORIGIN,
			"content-type": encoded.headers.get("content-type") ?? "",
		},
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { hash: string }).hash;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("board images", () => {
	it("draws public boards as SVG and PNG, cached by what they show", async () => {
		const { mf, board } = await publicBoard();

		const svg = await get(mf, `/embed/${board.id}.svg`);
		expect(svg.status).toBe(200);
		expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
		expect(svg.headers.get("cache-control")).toContain("max-age=60");
		const etag = svg.headers.get("etag");
		expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
		const text = await svg.text();
		expect(text.startsWith("<svg")).toBe(true);
		expect(text).not.toContain("<script");

		// Unchanged: a 304 without drawing it again.
		const again = await get(mf, `/embed/${board.id}.svg`, { "if-none-match": etag! });
		expect(again.status).toBe(304);
		expect(again.headers.get("etag")).toBe(etag);

		// A region of it, dark, as PNG at the width asked for.
		const png = await get(
			mf,
			`/embed/${board.id}.png?x=-20&y=-20&w=600&h=300&theme=dark&width=480`,
		);
		expect(png.status).toBe(200);
		expect(png.headers.get("content-type")).toBe("image/png");
		const bytes = new Uint8Array(await png.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(1, 4))).toBe("PNG");
		expect(pngSize(bytes)).toEqual({ width: 480, height: 240 });

		// The link preview: always 1200 × 630.
		const og = await get(mf, `/og/${board.id}.png`);
		expect(og.status).toBe(200);
		expect(pngSize(new Uint8Array(await og.arrayBuffer()))).toEqual({ width: 1200, height: 630 });

		// Nonsense options are an error, not some other image.
		expect((await get(mf, `/embed/${board.id}.svg?width=5`)).status).toBe(404);
		expect((await get(mf, `/embed/${board.id}.svg?section=a&x=1`)).status).toBe(404);
	}, 30_000);

	it("draws images from their thumbnails, inline in the SVG", async () => {
		const { mf, alice, board, client } = await publicBoard();
		const before = (await get(mf, `/embed/${board.id}.svg`)).headers.get("etag");

		const hash = await uploadImage(mf, alice, board.id);
		addImageShape(client.doc, "picture", {
			x: 0,
			y: 420,
			w: 240,
			h: 160,
			iw: 1,
			ih: 1,
			mime: "image/png",
			image: hash,
			alt: "The team",
		});
		await client.roundTrip();

		const stub = await boardStub(mf, board.id);
		const data = await (stub.embedData() as unknown as ReturnType<Board["embedData"]>);
		expect(Object.keys(data.images)).toEqual([hash]);

		const svg = await get(mf, `/embed/${board.id}.svg`);
		expect(svg.status).toBe(200);
		expect(svg.headers.get("etag")).not.toBe(before);
		// Inline, so the SVG's policy lets it show and it loads nothing else.
		expect(svg.headers.get("content-security-policy")).toBe(SVG_CSP);
		const text = await svg.text();
		expect(text).toContain('href="data:image/png;base64,');
		expect(text).not.toMatch(/href="(?!data:|#)/);
		// And as PNG, which resvg draws from the same SVG.
		expect((await get(mf, `/embed/${board.id}.png`)).status).toBe(200);
	}, 30_000);

	it("draws nothing of any board that isn't public, and says no more than for one that isn't there", async () => {
		const { mf, alice, board } = await publicBoard();
		const hidden = await createBoard(mf, alice, "private");
		const instance = await createBoard(mf, alice, "instance");

		const answers = await Promise.all(
			[hidden.id, instance.id, "no-such-board"].flatMap((id) => [
				get(mf, `/embed/${id}.svg`),
				get(mf, `/embed/${id}.png`),
				get(mf, `/og/${id}.png`),
			]),
		);
		for (const response of answers) {
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not found");
		}

		// Made private: its images go at once.
		const response = await mf.dispatchFetch(`${ORIGIN}/api/boards/${board.id}`, {
			method: "PATCH",
			headers: { cookie: alice, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ visibility: "private" }),
		});
		expect(response.status).toBe(200);
		expect((await get(mf, `/embed/${board.id}.svg`)).status).toBe(404);
	}, 30_000);

	it("shows what someone signed out sees: never a private card's details", async () => {
		const { github, mf, board } = await publicBoard();

		// What images are drawn from: the private card is a bare placeholder.
		const stub = await boardStub(mf, board.id);
		// The RPC types can't follow the document's open-ended shape properties.
		const data = await (stub.embedData() as unknown as ReturnType<Board["embedData"]>);
		expect(data.cards).toContainEqual({ key: PRIVATE_CARD, missing: true, reason: "private" });
		expect(data.cards).toContainEqual(
			expect.objectContaining({ key: PUBLIC_CARD, title: "Widgets wobble" }),
		);
		expect(JSON.stringify(data)).not.toContain(SECRET_TITLE);
		expect(JSON.stringify(data)).not.toContain(SECRET_LABEL);

		// So the private card changing never changes the image…
		const before = (await get(mf, `/embed/${board.id}.svg`)).headers.get("etag");
		await deliver(
			mf,
			github,
			edited({ id: PRIVATE_ID, full_name: "acme/secret", private: true }, 5, `${SECRET_TITLE} v2`),
		);
		await vi.waitFor(
			async () => {
				const cards = (await stub.liveCards()) as Card[];
				expect(cards.find((card) => card.key === PRIVATE_CARD)?.title).toBe(`${SECRET_TITLE} v2`);
			},
			{ timeout: 10_000, interval: 50 },
		);
		expect((await get(mf, `/embed/${board.id}.svg`)).headers.get("etag")).toBe(before);

		// …and the public one does.
		await deliver(
			mf,
			github,
			edited(
				{ id: PUBLIC_ID, full_name: "acme/widgets", private: false },
				1,
				"Widgets wobble less",
			),
		);
		await vi.waitFor(
			async () => {
				const response = await get(mf, `/embed/${board.id}.svg`);
				expect(response.headers.get("etag")).not.toBe(before);
			},
			{ timeout: 10_000, interval: 100 },
		);
	}, 30_000);
});

describe("link previews", () => {
	it("gives public boards' pages a title, description and image", async () => {
		const { mf, board } = await publicBoard();
		const response = await get(mf, `/b/${board.id}/${board.slug}`);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<title>Roadmap &amp; retro · Tack</title>");
		expect(html).toContain('<meta property="og:title" content="Roadmap &amp; retro" />');
		expect(html).toMatch(
			new RegExp(
				`<meta property="og:image" content="${ORIGIN}/og/${board.id}\\.png\\?v=[0-9a-z]+" />`,
			),
		);
		expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
		expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/b/${board.id}/${board.slug}" />`);
		// What's on it, naming only public repositories.
		const description = /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1];
		expect(description).toBe("A board with 2 cards and 1 sticky from acme/widgets, on Tack.");
		expect(html).not.toContain("acme/secret");
		expect(html).not.toContain(SECRET_TITLE);
		expect(response.headers.get("etag")).toBeNull();
	}, 30_000);

	it("leaves every other board's page as it is", async () => {
		const { mf, alice } = await publicBoard();
		const hidden = await createBoard(mf, alice, "private", "Top secret plans");
		const instance = await createBoard(mf, alice, "instance", "Team plans");
		for (const path of [
			`/b/${hidden.id}/${hidden.slug}`,
			`/b/${instance.id}/${instance.slug}`,
			"/b/no-such-board/x",
		]) {
			const response = await get(mf, path);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(PAGE);
		}
	}, 30_000);
});

describe("everything else a signed-out visitor gets from a public board", () => {
	it("leaves out private repositories' items everywhere", async () => {
		const { github, mf, alice, board, client } = await publicBoard();
		const anonymous = await open(mf, board.id);

		// Alice pushes a new issue to the private repository.
		stageChange(
			client.doc,
			{ kind: "issue.create", repo: "github.com/acme/secret", title: "Secret plan" },
			{ id: ALICE.id, login: "alice", name: "Alice" },
			{ id: "plan" },
		);
		await client.roundTrip();
		await (await boardStub(mf, board.id)).pushTiming({ spacingMs: 10, confirmMs: 60_000 });
		const pushed = await mf.dispatchFetch(`${ORIGIN}/api/boards/${board.id}/push`, {
			method: "POST",
			headers: { cookie: alice, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ ids: ["plan"], as: "user" }),
		});
		expect(pushed.status).toBe(202);
		await eventually(async () => {
			const log = (await (
				await get(mf, `/api/boards/${board.id}/pushes`, { cookie: alice })
			).json()) as AuditEntry[];
			return log[0]?.changes[0]?.status !== "sent";
		}, 10_000);

		// The push log: Alice sees what she pushed; the public, only that something was.
		const theirs = (await (
			await get(mf, `/api/boards/${board.id}/pushes`, { cookie: alice })
		).json()) as AuditEntry[];
		expect(theirs[0]?.changes[0]).toMatchObject({
			summary: expect.stringContaining("Secret plan"),
		});
		const publicLog = await (await get(mf, `/api/boards/${board.id}/pushes`)).text();
		expect(publicLog).not.toContain("Secret plan");
		expect(publicLog).not.toContain("acme/secret");
		expect(JSON.parse(publicLog)).toMatchObject([
			{ changes: [{ summary: "A change to a private repository", private: true }] },
		]);

		// What's new since the cards arrived: GitHub activity only on public cards.
		const since = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await deliver(
			mf,
			github,
			edited({ id: PRIVATE_ID, full_name: "acme/secret", private: true }, 5, `${SECRET_TITLE} v3`),
		);
		await deliver(
			mf,
			github,
			edited(
				{ id: PUBLIC_ID, full_name: "acme/widgets", private: false },
				1,
				"Widgets wobble more",
			),
		);
		const ask = () => anonymous.send({ type: "since-request", since });
		let digest: SinceEvent["digest"] | undefined;
		await eventually(() => {
			const events = anonymous.messages.filter(
				(message): message is SinceEvent => (message as { type?: string }).type === "since",
			);
			digest = events.at(-1)?.digest;
			if (digest?.cards.some((card) => card.key === PUBLIC_CARD)) return true;
			ask();
			return false;
		}, 10_000);
		expect(digest?.cards.map((card) => card.key)).not.toContain(PRIVATE_CARD);
		expect(JSON.stringify(digest)).not.toContain("Secret plan");

		// Expand related and the card tool's search, asked anonymously.
		const related = await get(
			mf,
			`/api/boards/${board.id}/related?key=${encodeURIComponent(PRIVATE_CARD)}`,
		);
		expect(related.status).toBe(404);
		expect(await related.text()).not.toContain(SECRET_TITLE);
		const search = await get(
			mf,
			`/api/boards/${board.id}/search?host=github.com&q=${encodeURIComponent("repo:acme/secret roadmap")}`,
		);
		expect(await search.text()).not.toContain(SECRET_TITLE);

		// Who can be mentioned: the board's members, never who's been looking at it.
		const visitor = await signIn(mf, "nosy-neighbour");
		await open(mf, board.id, visitor);
		const people = (await (await get(mf, `/api/boards/${board.id}/people`)).json()) as {
			people: { login: string }[];
		};
		expect(people.people.map((person) => person.login)).toEqual(["alice"]);
		const forAlice = (await (
			await get(mf, `/api/boards/${board.id}/people`, { cookie: alice })
		).json()) as { people: { login: string }[] };
		expect(forAlice.people.map((person) => person.login)).toContain("nosy-neighbour");

		// History: the document over time, which never holds card data.
		const timeline = await get(mf, `/api/boards/${board.id}/history`);
		expect(timeline.status).toBe(200);
		expect(await timeline.text()).not.toContain(SECRET_TITLE);
		const segment = await get(mf, `/api/boards/${board.id}/history/segment?step=1`);
		expect(new TextDecoder().decode(await segment.arrayBuffer())).not.toContain(SECRET_TITLE);

		// And everything that came over the live connection.
		await anonymous.roundTrip();
		const everything = anonymous.raw
			.map((part) => (typeof part === "string" ? part : new TextDecoder().decode(part)))
			.join("\n");
		expect(everything).not.toContain(SECRET_TITLE);
		expect(everything).not.toContain(SECRET_LABEL);
		expect(shapesMap(anonymous.doc).size).toBeGreaterThan(0);
	}, 40_000);
});
