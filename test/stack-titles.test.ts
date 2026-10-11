// Cards in stacks (#73) and what their names may say: a stack's suggested
// name is seen by everyone who can see the board, so a card's title goes
// into it only if every one of them can read it: a public repository's, or
// on a board only its members can open, a private repository's that every
// member can read (checked with their own tokens). Otherwise the card still
// counts toward its stack, and its title is never sent. Silent mode's
// hidden text never is either (stacks-board.test.ts).

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type * as Y from "yjs";
import type { SetupInfo } from "../src/shared/auth.ts";
import type { BoardInfo, Visibility } from "../src/shared/boards.ts";
import type { Card, CardMessage, MissingCard } from "../src/shared/cards.ts";
import { stackUp } from "../src/shared/stackEdits.ts";
import type { StackMessage } from "../src/shared/stackNamer.ts";
import { addShape } from "../src/shared/shapes.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeAi } from "./fake-ai.ts";
import { FakeGitHub, type FakeUser } from "./fake-github.ts";
import { boardStub, instanceStub, signInWithGitHub, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const PUBLIC_REPO = 11;
const PRIVATE_REPO = 12;
const PUBLIC_CARD = "github.com/tackfixtures/open#1";
const PRIVATE_CARD = "github.com/tackfixtures/vault#5";
const PUBLIC_TITLE = "Rename the wobbly widget";
const SECRET_TITLE = "Quietly sunset the turnip importer";

const ALICE: FakeUser = { id: 701, login: "alice", name: "Alice", avatar_url: "https://a/alice" };
const BOB: FakeUser = { id: 702, login: "bob", name: "Bob", avatar_url: "https://a/bob" };

let mf: Miniflare;
const ai = new FakeAi();
const github = new FakeGitHub();
let alice = "";
let bob = "";

beforeAll(async () => {
	github.addRepo(PUBLIC_REPO, "tackfixtures/open");
	github.setItem(PUBLIC_REPO, {
		number: 1,
		kind: "issue",
		title: PUBLIC_TITLE,
		updatedAt: "2026-10-01T00:00:00Z",
	});
	github.addRepo(PRIVATE_REPO, "tackfixtures/vault", { private: true, collaborators: ["alice"] });
	github.setItem(PRIVATE_REPO, {
		number: 5,
		kind: "issue",
		title: SECRET_TITLE,
		updatedAt: "2026-10-01T00:00:00Z",
	});
	github.install(7, "tackfixtures", ["tackfixtures/open", "tackfixtures/vault"]);
	// On GitHub, but never signed in here: an invite to her waits.
	github.addUser({ id: 703, login: "carol", name: "Carol", avatar_url: "https://a/carol" });
	mf = startWorker({ devAuth: true, outboundService: github.fetch, ai });
	const setup = await (await instanceStub(mf)).completeSetup(github.manifestCode);
	expect(setup.ok).toBe(true);
	alice = await signInWithGitHub(mf, github, ALICE);
	bob = await signInWithGitHub(mf, github, BOB);
	// Bob's opened a board here, so he's someone an invite can name.
	const known = await board("instance");
	(await open(known, bob)).close();
	const info = (await (await api("/api/setup", alice)).json()) as Extract<
		SetupInfo,
		{ status: "configured" }
	>;
	expect(info.ai).toMatchObject({ state: "on" });
});
afterAll(() => mf.dispose());

const clients: BoardClient[] = [];
afterAll(() => {
	for (const client of clients) client.close();
});

function api(path: string, cookie: string, method = "GET", body?: unknown) {
	return mf.dispatchFetch(`${ORIGIN}${path}`, {
		method,
		headers: {
			cookie,
			...(body ? { "content-type": "application/json", origin: ORIGIN } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function board(visibility: Visibility): Promise<string> {
	const response = await api("/api/boards", alice, "POST", { title: "Themes", visibility });
	expect(response.status).toBe(201);
	return ((await response.json()) as BoardInfo).id;
}

async function invite(id: string, login: string) {
	const response = await api(`/api/boards/${id}/members`, alice, "POST", {
		logins: [login],
		role: "editor",
	});
	expect(response.status, await response.clone().text()).toBe(200);
}

async function open(id: string, cookie: string): Promise<BoardClient> {
	const result = await connectBoard(mf, id, cookie);
	if (!result.ok) throw new Error(`connect: ${result.status} ${result.error}`);
	clients.push(result.client);
	return result.client;
}

/** The cards this client has been sent, latest first. */
function cardsOf(client: BoardClient): Map<string, Card | MissingCard> {
	const out = new Map<string, Card | MissingCard>();
	for (const message of client.messages as CardMessage[]) {
		if (message.type === "cards") for (const card of message.cards) out.set(card.key, card);
		else if (message.type === "card" || message.type === "card-missing") {
			out.set(message.card.key, message.card);
		}
	}
	return out;
}

function sticky(doc: Y.Doc, id: string, text: string) {
	addShape(doc, id, { type: "sticky", text, x: 40, y: 40, z: `b${id}` });
}

function card(doc: Y.Doc, id: string, ref: string) {
	addShape(doc, id, { type: "card", ref, x: 400, y: 40, z: `c${id}` });
}

/** A stack of a sticky and both cards, on a board, with the board's cards loaded. */
async function themed(visibility: Visibility, members: string[] = []) {
	const id = await board(visibility);
	for (const login of members) await invite(id, login);
	const client = await open(id, alice);
	sticky(client.doc, "s", "Importers nobody uses");
	card(client.doc, "pub", PUBLIC_CARD);
	card(client.doc, "priv", PRIVATE_CARD);
	stackUp(client.doc, "s", ["pub", "priv"], undefined, () => "stack");
	await client.roundTrip();
	// Alice can read both, so both reach her with their titles.
	await eventually(() => {
		const cards = cardsOf(client);
		return [PUBLIC_CARD, PRIVATE_CARD].every((key) => {
			const entry = cards.get(key);
			return entry !== undefined && !("missing" in entry);
		});
	});
	return { id, client };
}

const lastNamed = () => {
	const call = [...ai.calls]
		.reverse()
		.find((c) => c.input.response_format?.json_schema?.name === "stack_name");
	return JSON.stringify(call?.input.messages ?? []);
};

describe("names from cards", () => {
	it("use a private card's title when every member of a members-only board can read it", async () => {
		const { id } = await themed("private");
		const before = ai.calls.length;
		await (await boardStub(mf, id)).nameStacks();
		expect(ai.calls.length).toBe(before + 1);
		expect(lastNamed()).toContain(PUBLIC_TITLE);
		expect(lastNamed()).toContain(SECRET_TITLE);
		expect(lastNamed()).toContain("Importers nobody uses");
	});

	it("never send it while an invite is waiting to be taken up", async () => {
		const { id } = await themed("private", ["carol"]);
		await (await boardStub(mf, id)).nameStacks();
		expect(lastNamed()).toContain(PUBLIC_TITLE);
		expect(lastNamed()).not.toContain(SECRET_TITLE);
	});

	it("never send it once a member who can't read it joins, and rename without it", async () => {
		const { id, client } = await themed("private");
		await (await boardStub(mf, id)).nameStacks();
		expect(lastNamed()).toContain(SECRET_TITLE);
		await invite(id, "bob");
		const before = ai.calls.length;
		await (await boardStub(mf, id)).nameStacks();
		expect(ai.calls.length).toBe(before + 1);
		expect(lastNamed()).not.toContain(SECRET_TITLE);
		expect(lastNamed()).toContain(PUBLIC_TITLE);
		// The card still counts: it's in the stack, its title just isn't sent.
		expect(client.doc.getMap("shapes").get("priv")).toBeDefined();
	});

	it("never send a private card's title on a board the instance or the public can open", async () => {
		for (const visibility of ["instance", "public"] as const) {
			const { id } = await themed(visibility);
			const before = ai.calls.length;
			await (await boardStub(mf, id)).nameStacks();
			expect(ai.calls.length).toBe(before + 1);
			expect(lastNamed()).toContain(PUBLIC_TITLE);
			expect(lastNamed()).not.toContain(SECRET_TITLE);
		}
	});

	it("Group these sends only the titles that may be shared, and says how many weren't", async () => {
		const id = await board("private");
		await invite(id, "bob");
		const client = await open(id, alice);
		sticky(client.doc, "a", "Importers nobody uses");
		sticky(client.doc, "b", "The turnip importer is flaky");
		sticky(client.doc, "c", "Docs for importers are thin");
		card(client.doc, "pub", PUBLIC_CARD);
		card(client.doc, "priv", PRIVATE_CARD);
		await client.roundTrip();
		await eventually(() => cardsOf(client).size === 2);
		client.send({ type: "stack-group", request: "g1", ids: ["a", "b", "c", "pub", "priv"] });
		await eventually(() =>
			(client.messages as StackMessage[]).some((m) => "request" in m && m.request === "g1"),
		);
		const answer = (client.messages as StackMessage[]).find(
			(m): m is Extract<StackMessage, { type: "stack-groups" }> =>
				m.type === "stack-groups" && m.request === "g1",
		);
		expect(answer?.withheld).toBe(1);
		expect(answer?.stacks.flatMap((s) => s.ids)).toContain("pub");
		expect(answer?.stacks.flatMap((s) => s.ids)).not.toContain("priv");
		const grouping = [...ai.calls]
			.reverse()
			.find((call) => call.input.response_format?.json_schema?.name === "stack_groups");
		expect(JSON.stringify(grouping?.input.messages)).toContain(PUBLIC_TITLE);
		expect(JSON.stringify(grouping?.input.messages)).not.toContain(SECRET_TITLE);
	});
});
