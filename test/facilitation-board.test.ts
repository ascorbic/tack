// Facilitation (#50) and silent mode (#49) on a real board in Miniflare:
// people connected over WebSockets with their own roles, and above all the
// silent-mode guarantee, that hidden text never reaches anyone but its
// author until it's revealed.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { BoardInfo, Role } from "../src/shared/boards.ts";
import type { CardMessage } from "../src/shared/cards.ts";
import { type FacilitationMessage, readTimer } from "../src/shared/facilitation.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import { type SilentMessage, joinSilentSession, parseSession } from "../src/shared/silent.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { instanceStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const SECRET = "a cunning plan involving turnips";

let mf: Miniflare;
const github = new FakeGitHub();
github.addRepo(42, "acme/widgets");
github.setItem(42, {
	number: 7,
	kind: "issue",
	title: "Faster widgets",
	updatedAt: "2026-10-01T00:00:00Z",
	thumbsUp: ["Priya", "jo"],
});
let olive = ""; // owns the board, and facilitates
let eddie = ""; // an editor
let vera = ""; // a viewer

beforeAll(async () => {
	mf = startWorker({
		devAuth: true,
		outboundService: github.fetch,
		bindings: { GITHUB_TOKEN: "t" },
	});
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	olive = await signIn(mf, "olive", { name: "Olive Owner" });
	eddie = await signIn(mf, "eddie");
	vera = await signIn(mf, "vera");
});
afterAll(() => mf.dispose());

const clients: BoardClient[] = [];
afterAll(() => {
	for (const client of clients) client.close();
});

function api(path: string, cookie: string, body?: unknown) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			cookie,
			...(body ? { "content-type": "application/json", origin: ORIGIN } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function boardWithMembers(): Promise<string> {
	const board = (await (await api("/api/boards", olive, { title: "Retro" })).json()) as BoardInfo;
	for (const [login, role] of [
		["eddie", "editor"],
		["vera", "viewer"],
	] as [string, Role][]) {
		const invited = await api(`/api/boards/${board.id}/members`, olive, { logins: [login], role });
		expect(invited.status).toBe(200);
	}
	return board.id;
}

async function open(id: string, cookie?: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status} ${result.error}`);
	clients.push(result.client);
	return result.client;
}

type Message = FacilitationMessage | SilentMessage | CardMessage;
const messages = (client: BoardClient) => client.messages as Message[];
const ofType = <T extends Message["type"]>(client: BoardClient, type: T) =>
	messages(client).filter((m): m is Extract<Message, { type: T }> => m.type === type);

/** Whether `text` appears anywhere in what a client has received: messages, updates, awareness. */
function received(client: BoardClient, text: string): boolean {
	const bytes = new TextEncoder().encode(text);
	return client.raw.some((data) =>
		typeof data === "string" ? data.includes(text) : includesBytes(data, bytes),
	);
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

function section(doc: Y.Doc, id = "ideas") {
	addShape(doc, id, { type: "section", x: 0, y: 0, w: 800, h: 600, z: "a0", title: "Ideas" });
}

function silentSticky(doc: Y.Doc, id: string) {
	doc.transact(() => {
		addShape(doc, id, {
			type: "sticky",
			x: 40,
			y: 40,
			z: `b${id}`,
			parent: "ideas",
			text: "",
			author: { name: "Eddie", color: "#1f7a6b" },
		});
		joinSilentSession(doc, id);
	});
}

const sessionOf = (client: BoardClient) =>
	parseSession(shapesMap(client.doc).get("ideas")?.get("silent"));

describe("silent mode", () => {
	it("never sends hidden text to anyone but its author, until it's revealed", async () => {
		const id = await boardWithMembers();
		const facilitator = await open(id, olive);
		const writer = await open(id, eddie);
		const writerTab = await open(id, eddie);
		const viewer = await open(id, vera);
		section(facilitator.doc);
		await facilitator.roundTrip();

		facilitator.send({ type: "silent-start", section: "ideas", by: { name: "Olive", color: "" } });
		await eventually(() => sessionOf(writer) !== null);
		const session = sessionOf(writer)!;
		expect(session.by.name).toBe("Olive");

		silentSticky(writer.doc, "s1");
		await writer.roundTrip();
		writer.send({ type: "silent-text", shape: "s1", text: SECRET });
		await writer.roundTrip();

		// The writer's other tab hears it; nobody else does, in any form.
		await eventually(() => received(writerTab, SECRET));
		await facilitator.roundTrip();
		await viewer.roundTrip();
		expect(received(facilitator, SECRET)).toBe(false);
		expect(received(viewer, SECRET)).toBe(false);
		// The shape is there for everyone, face down, with no text.
		expect(shapesMap(viewer.doc).get("s1")?.get("silent")).toBe(session.id);
		expect(shapesMap(viewer.doc).get("s1")?.has("text")).toBe(false);

		// Coming back, the writer gets their text again; a newcomer gets nothing.
		const again = await open(id, eddie);
		again.send({ type: "silent-hello" });
		await eventually(() => ofType(again, "silent-texts").length > 0);
		expect(ofType(again, "silent-texts")[0]).toEqual({
			type: "silent-texts",
			texts: { s1: SECRET },
			replace: true,
		});
		const newcomer = await open(id, olive);
		newcomer.send({ type: "silent-hello" });
		await eventually(() => ofType(newcomer, "silent-texts").length > 0);
		expect(received(newcomer, SECRET)).toBe(false);

		// Viewers can't reveal; editors can't while the facilitator's here.
		viewer.send({ type: "silent-reveal", session: session.id });
		writer.send({ type: "silent-reveal", session: session.id });
		await eventually(() => ofType(writer, "silent-refused").length > 0);
		await eventually(() => ofType(viewer, "silent-refused").length > 0);
		expect(ofType(writer, "silent-refused")[0]?.reason).toBe("not_facilitator");
		expect(ofType(viewer, "silent-refused")[0]?.reason).toBe("not_editor");
		expect(received(viewer, SECRET)).toBe(false);

		facilitator.send({ type: "silent-reveal", session: session.id });
		await eventually(() => shapesMap(viewer.doc).get("s1")?.get("text") === SECRET);
		expect(shapesMap(viewer.doc).get("s1")?.has("silent")).toBe(false);
		expect(sessionOf(viewer)).toBeNull();
	});

	it("keeps someone's sticky theirs, and viewers out", async () => {
		const id = await boardWithMembers();
		const facilitator = await open(id, olive);
		const writer = await open(id, eddie);
		const viewer = await open(id, vera);
		section(facilitator.doc);
		await facilitator.roundTrip();

		viewer.send({ type: "silent-start", section: "ideas", by: { name: "Vera", color: "" } });
		await eventually(() => ofType(viewer, "silent-refused").length > 0);
		expect(sessionOf(facilitator)).toBeNull();

		facilitator.send({ type: "silent-start", section: "ideas", by: { name: "Olive", color: "" } });
		await eventually(() => sessionOf(writer) !== null);
		silentSticky(writer.doc, "s2");
		await writer.roundTrip();
		writer.send({ type: "silent-text", shape: "s2", text: "mine" });
		await writer.roundTrip();
		facilitator.send({ type: "silent-text", shape: "s2", text: "overwritten" });
		await eventually(() => ofType(facilitator, "silent-refused").length > 0);
		expect(ofType(facilitator, "silent-refused")[0]).toMatchObject({
			reason: "not_yours",
			shape: "s2",
		});
		// A section marked silent by hand, without the server, is put right.
		section(writer.doc, "fake");
		shapesMap(writer.doc)
			.get("fake")
			?.set("silent", { id: "x", by: { name: "Eve", color: "" }, at: "" });
		await writer.roundTrip();
		await eventually(() => shapesMap(facilitator.doc).get("fake")?.has("silent") === false);
	});

	it("finds a guest's text by their secret, and only theirs", async () => {
		// Before setup (as on Previews) anyone may edit, signed out.
		const worker = startWorker();
		try {
			const name = "guest-board";
			const adopted = await worker.dispatchFetch(`${ORIGIN}/api/boards/legacy`, {
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ name }),
			});
			expect(adopted.status).toBe(200);
			const connect = async () => {
				const result = await connectBoard(worker, name);
				if (!result.ok) throw new Error(`connect: ${result.status}`);
				clients.push(result.client);
				return result.client;
			};
			const guest = await connect();
			const other = await connect();
			section(guest.doc);
			await guest.roundTrip();
			guest.send({ type: "silent-hello", secret: "guest secret, long enough" });
			guest.send({ type: "silent-start", section: "ideas", by: { name: "Otter", color: "" } });
			await eventually(() => sessionOf(guest) !== null);
			silentSticky(guest.doc, "g1");
			await guest.roundTrip();
			guest.send({ type: "silent-text", shape: "g1", text: SECRET });
			await guest.roundTrip();

			// The same browser (same secret) after a reload finds it again.
			const reloaded = await connect();
			reloaded.send({ type: "silent-hello", secret: "guest secret, long enough" });
			await eventually(() => ofType(reloaded, "silent-texts").length > 0);
			expect(ofType(reloaded, "silent-texts")[0]?.texts).toEqual({ g1: SECRET });
			// Anyone else, with another secret or one too short to trust, doesn't.
			other.send({ type: "silent-hello", secret: "another guest's secret" });
			const short = await connect();
			short.send({ type: "silent-hello", secret: "short" });
			await eventually(() => ofType(other, "silent-texts").length > 0);
			await eventually(() => ofType(short, "silent-texts").length > 0);
			expect(received(other, SECRET)).toBe(false);
			expect(received(short, SECRET)).toBe(false);
		} finally {
			await worker.dispose();
		}
	});
});

describe("the timer", () => {
	it("is started by editors in the server's clock, and seen by everyone", async () => {
		const id = await boardWithMembers();
		const writer = await open(id, eddie);
		const viewer = await open(id, vera);

		viewer.send({ type: "timer", action: "start", ms: 60_000, by: { name: "Vera", color: "" } });
		await eventually(() => ofType(viewer, "facilitation-refused").length > 0);
		expect(readTimer(viewer.doc)).toBeNull();

		const before = Date.now();
		writer.send({
			type: "timer",
			action: "start",
			ms: 60_000,
			by: { name: "Eddie", color: "#1f7a6b" },
		});
		await eventually(() => readTimer(viewer.doc) !== null);
		const timer = readTimer(viewer.doc)!;
		expect(timer.by.name).toBe("Eddie");
		expect(timer.endsAt).toBeGreaterThanOrEqual(before + 60_000 - 1_000);
		expect(timer.endsAt).toBeLessThanOrEqual(Date.now() + 60_000 + 1_000);

		writer.send({ type: "timer", action: "pause", by: { name: "Eddie", color: "" } });
		await eventually(() => readTimer(viewer.doc)?.state === "paused");
		writer.send({ type: "timer", action: "stop", by: { name: "Eddie", color: "" } });
		await eventually(() => readTimer(viewer.doc) === null);
	});

	it("answers clock pings with the server's time", async () => {
		const id = await boardWithMembers();
		const viewer = await open(id, vera);
		viewer.send({ type: "clock", t: 123 });
		await eventually(() => ofType(viewer, "clock").length > 0);
		const [clock] = ofType(viewer, "clock");
		expect(clock?.t).toBe(123);
		expect(Math.abs((clock?.now ?? 0) - Date.now())).toBeLessThan(5_000);
	});
});

describe("spotlight", () => {
	it("brings everyone along, joins latecomers, and ends when its holder leaves", async () => {
		const id = await boardWithMembers();
		const viewer = await open(id, vera);
		viewer.send({ type: "spotlight", on: true, clientId: 9 });
		await eventually(() => ofType(viewer, "facilitation-refused").length > 0);

		const facilitator = await open(id, olive);
		facilitator.send({
			type: "spotlight",
			on: true,
			clientId: 42,
			user: { name: "Olive", color: "#b4467a" },
		});
		await eventually(() => ofType(viewer, "spotlight").length > 0);
		expect(ofType(viewer, "spotlight")[0]?.spotlight).toMatchObject({
			clientId: 42,
			user: { name: "Olive" },
		});
		const late = await open(id, eddie);
		await eventually(() => ofType(late, "spotlight").length > 0);
		expect(ofType(late, "spotlight")[0]?.spotlight?.clientId).toBe(42);

		facilitator.close();
		await eventually(() => ofType(viewer, "spotlight").at(-1)?.spotlight === null);
	});
});

describe("reactions on cards", () => {
	it("arrive with who reacted, for dot votes to count", async () => {
		const id = await boardWithMembers();
		const client = await open(id, olive);
		addShape(client.doc, "card", {
			type: "card",
			ref: "github.com/acme/widgets#7",
			x: 0,
			y: 0,
			z: "a0",
		});
		await eventually(() =>
			ofType(client, "cards").some((m) =>
				m.cards.some((c) => c.key.endsWith("#7") && !("missing" in c)),
			),
		);
		const card = ofType(client, "cards")
			.flatMap((m) => m.cards)
			.find((c) => c.key.endsWith("#7") && !("missing" in c));
		expect(card && "thumbsUp" in card && card.thumbsUp).toEqual({
			count: 2,
			logins: ["priya", "jo"],
		});
	});
});
