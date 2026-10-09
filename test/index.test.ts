import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeCard } from "../src/server/forges/fake.ts";
import { sign, verifySignature } from "../src/server/forges/hmac.ts";
import { repoStub, startWorker } from "./harness.ts";

let mf: Miniflare;
beforeAll(() => {
	mf = startWorker();
});
afterAll(() => mf.dispose());

const REPO = "github.com/acme/widgets";

function issuePayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "edited",
		repository: { full_name: "Acme/Widgets" },
		issue: {
			number: 7,
			title: "Widgets wobble",
			state: "open",
			html_url: "https://github.com/acme/widgets/issues/7",
			updated_at: "2026-10-01T10:00:00Z",
			labels: [{ name: "bug", color: "d73a4a" }],
			assignees: [],
			comments: 2,
			...overrides,
		},
	};
}

async function deliver(
	payload: unknown,
	opts: { event?: string; id?: string; secret?: string; forge?: string } = {},
) {
	const body = JSON.stringify(payload);
	return mf.dispatchFetch(`https://example.com/webhooks/${opts.forge ?? "github"}`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": opts.event ?? "issues",
			"x-github-delivery": opts.id ?? crypto.randomUUID(),
			"x-hub-signature-256": await sign(opts.secret ?? "test-secret", body),
		},
	});
}

describe("webhook signatures", () => {
	it("accepts a valid signature and rejects a tampered body", async () => {
		const signature = await sign("s3cret", "hello");
		expect(await verifySignature("s3cret", "hello", signature)).toBe(true);
		expect(await verifySignature("s3cret", "hellO", signature)).toBe(false);
		expect(await verifySignature("s3cret", "hello", "sha256=nope")).toBe(false);
		expect(await verifySignature("s3cret", "hello", null)).toBe(false);
	});

	it("rejects deliveries signed with the wrong secret", async () => {
		const response = await deliver(issuePayload(), { secret: "wrong" });
		expect(response.status).toBe(401);
	});

	it("404s forges that don't take webhooks", async () => {
		expect((await deliver(issuePayload(), { forge: "fake" })).status).toBe(404);
		expect((await deliver(issuePayload(), { forge: "nope" })).status).toBe(404);
	});
});

describe("webhook ingest", () => {
	it("normalises and caches an issue", async () => {
		const response = await deliver(issuePayload());
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			status: "processed",
			updated: [`${REPO}#7`],
		});

		const card = await (await repoStub(mf, REPO)).getCard(`${REPO}#7`);
		expect(card).toMatchObject({ title: "Widgets wobble", state: "open", kind: "issue" });
	});

	it("ignores duplicate deliveries", async () => {
		const id = crypto.randomUUID();
		await deliver(issuePayload(), { id });
		const again = await deliver(issuePayload(), { id });
		expect(await again.json()).toEqual({ status: "duplicate" });
	});

	it("never lets an older payload overwrite a newer one", async () => {
		await deliver(issuePayload({ title: "Newer", updated_at: "2026-10-05T00:00:00Z" }));
		const stale = await deliver(
			issuePayload({ title: "Older", updated_at: "2026-10-02T00:00:00Z" }),
		);
		expect(await stale.json()).toMatchObject({ stale: [`${REPO}#7`], updated: [] });
		const card = await (await repoStub(mf, REPO)).getCard(`${REPO}#7`);
		expect(card?.title).toBe("Newer");
	});

	it("marks merged pull requests as merged", async () => {
		await deliver(
			{
				action: "closed",
				repository: { full_name: "acme/widgets" },
				pull_request: {
					number: 8,
					title: "Fix wobble",
					state: "closed",
					merged: true,
					draft: false,
					html_url: "https://github.com/acme/widgets/pull/8",
					updated_at: "2026-10-03T00:00:00Z",
				},
			},
			{ event: "pull_request" },
		);
		const card = await (await repoStub(mf, REPO)).getCard(`${REPO}#8`);
		expect(card).toMatchObject({ kind: "pull", state: "merged" });
	});
});

describe("board subscriptions", () => {
	it("serves cards from any forge and fans updates out to subscribed boards", async () => {
		const key = "fake.tack/stress/cards#2";
		const repo = await repoStub(mf, "fake.tack/stress/cards");

		const [card] = await repo.subscribe("board-a", [key]);
		expect(card).toMatchObject({ key, forge: "fake", state: "closed" });
		expect(await repo.subscribers(key)).toEqual(["board-a"]);

		const reopened = {
			...fakeCard("stress/cards", 2),
			state: "open" as const,
			updatedAt: "2026-10-09T00:00:00Z",
		};
		const result = await repo.ingest({
			id: crypto.randomUUID(),
			event: "test",
			action: null,
			repoKey: "fake.tack/stress/cards",
			payload: "{}",
			cards: [reopened],
		});
		expect(result).toMatchObject({ status: "processed", updated: [key], boards: 1 });

		await repo.unsubscribe("board-a", [key]);
		expect(await repo.subscribers(key)).toEqual([]);
	});
});
