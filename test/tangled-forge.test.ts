// The Tangled adapter (#65), read-only, in Node against a fake tangled.org,
// its index (api.tangled.org) and the PLC directory (no network).

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Card } from "../src/shared/cards.ts";
import { configureForges } from "../src/server/forges/config.ts";
import { forge } from "../src/server/forges/index.ts";
import { gate } from "../src/server/forges/rateLimit.ts";
import { uriInPage } from "../src/server/forges/tangled.ts";
import type { FetchRef, RepoIdentity } from "../src/server/forges/types.ts";
import { FakeTangled, forgesFetch } from "./fake-forges.ts";

const tangled = forge("tangled");
const env = { TACK_FORGES: "" } as Env;
const REPO: RepoIdentity = {
	forge: "tangled",
	host: "tangled.org",
	id: "alice.example/knotty",
	name: "alice.example/knotty",
	private: false,
};
const ref = (item: string, nodeId?: string): FetchRef => ({
	forge: "tangled",
	host: "tangled.org",
	repo: REPO.name,
	item,
	...(nodeId ? { nodeId } : {}),
});

let fake: FakeTangled;

beforeEach(() => {
	configureForges(env);
	fake = new FakeTangled();
	fake.handles.set("did:plc:alice", "alice.example");
	fake.items.push(
		{
			n: 1,
			kind: "issue",
			author: "did:plc:alice",
			rkey: "3laaa",
			title: "Knots drift",
			comments: 2,
		},
		{
			n: 2,
			kind: "issue",
			author: "did:plc:bob",
			rkey: "3lbbb",
			title: "Spindle logs",
			state: "closed",
			stateUpdatedAt: "2026-10-02T00:00:00Z",
		},
		{
			n: 1,
			kind: "pull",
			author: "did:plc:alice",
			rkey: "3lccc",
			title: "Tighten knots",
			state: "merged",
			stateUpdatedAt: "2026-10-03T00:00:00Z",
		},
	);
	vi.stubGlobal("fetch", forgesFetch({ tangled: fake }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	gate.clear();
});

describe("cards", () => {
	it("reads issues: which record a number is from its page, then the index", async () => {
		const [card] = (await tangled.fetchItems([ref("#1")], env, REPO)) as Card[];
		expect(card).toMatchObject({
			key: "tangled.org/alice.example/knotty#1",
			forge: "tangled",
			kind: "issue",
			state: "open",
			title: "Knots drift",
			comments: 2,
			author: { login: "alice.example" },
			url: "https://tangled.org/alice.example/knotty/issues/1",
			nodeId: "at://did:plc:alice/sh.tangled.repo.issue/3laaa",
		});
	});

	it("reads closed issues and merged pulls, numbered separately", async () => {
		const [closed, pull] = (await tangled.fetchItems([ref("#2"), ref("!1")], env, REPO)) as Card[];
		expect(closed).toMatchObject({ state: "closed", closedAt: "2026-10-02T00:00:00.000Z" });
		// Bob's handle isn't known: no author's login rather than a DID.
		expect(closed?.author).toBeNull();
		expect(pull).toMatchObject({
			key: "tangled.org/alice.example/knotty!1",
			kind: "pull",
			state: "merged",
			mergedAt: "2026-10-03T00:00:00.000Z",
		});
	});

	it("reads the page only once: after that, the record's AT-URI is on the card", async () => {
		const [card] = (await tangled.fetchItems([ref("#1")], env, REPO)) as Card[];
		fake.log.length = 0;
		await tangled.fetchItems([ref("#1", card?.nodeId)], env, REPO);
		expect(fake.log.some((line) => line.startsWith("GET tangled.org/"))).toBe(false);
	});

	it("says when an item doesn't exist", async () => {
		const [card] = await tangled.fetchItems([ref("#9")], env, REPO);
		expect(card).toMatchObject({ missing: true, reason: "not_found" });
	});

	it("never asks a host the instance doesn't serve", async () => {
		const off = { TACK_FORGES: JSON.stringify([{ host: "tangled.org", off: true }]) } as Env;
		configureForges(off);
		const [card] = await tangled.fetchItems([ref("#1")], off, REPO);
		expect(card).toMatchObject({ missing: true, reason: "unsupported" });
		expect(fake.log).toEqual([]);
	});
});

describe("polling", () => {
	it("finds what changed: state and comments, read again", async () => {
		const cards = (await tangled.fetchItems([ref("#1"), ref("#2")], env, REPO)) as Card[];
		const quiet = await tangled.poll?.(REPO, cards, env, { etag: null, since: null });
		expect(quiet).toEqual({ status: "changed", etag: null, cards: [] });
		const issue = fake.items[0];
		if (issue) {
			issue.state = "closed";
			issue.stateUpdatedAt = "2026-10-05T00:00:00Z";
		}
		const changed = await tangled.poll?.(REPO, cards, env, { etag: null, since: null });
		expect(changed?.status === "changed" && changed.cards).toMatchObject([
			{ key: "tangled.org/alice.example/knotty#1", state: "closed" },
		]);
	});
});

describe("what it offers", () => {
	it("is read-only, with no webhooks", () => {
		expect(tangled.capabilities.writes).toEqual([]);
		expect("apply" in tangled).toBe(false);
		expect("receiveWebhook" in tangled).toBe(false);
	});

	it("finds an item's own record in its page, not the ones it mentions", () => {
		const own = "at://did:plc:alice/sh.tangled.repo.issue/3laaa";
		const other = "at://did:plc:bob/sh.tangled.repo.issue/3lzzz";
		expect(
			uriInPage(`<a>${other}</a><input name="subject-uri" type="hidden" value="${own}">`, "issue"),
		).toBe(own);
		// Without reactions on the page: the one named most.
		expect(uriInPage(`${other} ${own} ${own}`, "issue")).toBe(own);
		expect(uriInPage(`${own}`, "pull")).toBeNull();
	});
});
